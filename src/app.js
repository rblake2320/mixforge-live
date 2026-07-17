import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import Stripe from "stripe";
import { StemSplit, webhooks as stemsplitWebhooks } from "@stemsplit/sdk";
import { attachUser, signToken, toPublicUser } from "./auth.js";
import { config as defaultConfig } from "./config.js";
import { now } from "./db.js";
import { createStore } from "./store-factory.js";
import { buildLimiter, createRateLimitBackend } from "./rate-limit.js";
import { createStorage } from "./storage.js";
import {
  JsonlLogStore,
  LOG_TYPES,
  hashIdentifier,
  requestLoggerMiddleware,
  timedDependency
} from "./logging.js";
import { evaluateReadiness } from "./readiness.js";

const PLAN_CATALOG = {
  free: {
    id: "free",
    name: "Free",
    monthlyCents: 0,
    stemJobsPerMonth: 0,
    features: ["vocal_recording", "beat_library_demo", "public_profile"]
  },
  creator: {
    id: "creator",
    name: "Creator",
    monthlyCents: 1200,
    stemJobsPerMonth: 20,
    features: ["stem_separation", "multi_track_projects", "beat_selling", "collaboration"]
  },
  dj_pro: {
    id: "dj_pro",
    name: "DJ Pro",
    monthlyCents: 2900,
    stemJobsPerMonth: 999999,
    features: ["dj_mode", "client_folders", "priority_rendering", "unlimited_stems"]
  },
  label: {
    id: "label",
    name: "Label / Agency",
    monthlyCents: 7900,
    stemJobsPerMonth: 999999,
    features: ["multi_seat", "api_access", "white_label", "team_analytics"]
  }
};

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Opaque, single-use tokens for email verification and password reset.
function secureToken() {
  return crypto.randomBytes(32).toString("hex");
}

function isoAfter(ms) {
  return new Date(Date.now() + ms).toISOString();
}

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function planIdFromStripePrice(cfg, priceId) {
  if (!priceId) {
    return "";
  }
  return Object.entries(cfg.stripePrices).find(([, configuredPriceId]) => configuredPriceId === priceId)?.[0] || "";
}

function unixToIso(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function subscriptionPlanId(cfg, subscription) {
  return (
    subscription?.metadata?.planId ||
    planIdFromStripePrice(cfg, subscription?.items?.data?.[0]?.price?.id) ||
    "free"
  );
}

function subscriptionIsActive(subscription) {
  return ["active", "trialing"].includes(subscription?.status);
}

function subscriptionPeriodEnd(subscription) {
  // Stripe API versions from 2025 onward report current_period_end on the
  // subscription ITEM, not the subscription object. Read both so renewal
  // dates survive an API-version upgrade instead of silently going null.
  const seconds =
    subscription?.current_period_end ?? subscription?.items?.data?.[0]?.current_period_end;
  return unixToIso(seconds);
}

async function applyStripeCheckoutSession(store, session) {
  const userId = session.client_reference_id || session.metadata?.userId;
  if (!userId) {
    return null;
  }

  const planId = session.metadata?.planId || "free";
  return store.update("users", userId, {
    planId,
    stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer?.id || null,
    stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : session.subscription?.id || null,
    stripeSubscriptionStatus: "checkout_completed"
  });
}

async function applyStripeSubscription(store, cfg, subscription) {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (!customerId) {
    return null;
  }

  const user = await store.findBy("users", "stripeCustomerId", customerId);
  if (!user) {
    return null;
  }

  return store.update("users", user.id, {
    planId: subscriptionIsActive(subscription) ? subscriptionPlanId(cfg, subscription) : "free",
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id || user.stripeSubscriptionId || null,
    stripeSubscriptionStatus: subscription.status || null,
    currentPeriodEnd: subscriptionPeriodEnd(subscription)
  });
}

async function applyStripeEvent(store, cfg, event) {
  const object = event.data?.object;
  switch (event.type) {
    case "checkout.session.completed":
      return applyStripeCheckoutSession(store, object);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return applyStripeSubscription(store, cfg, object);
    default:
      return null;
  }
}

function safeFileName(originalName, fallbackExt = ".webm") {
  const ext = path.extname(originalName || "") || fallbackExt;
  return `${crypto.randomUUID()}${ext.toLowerCase()}`;
}

function canAccessOwnedRecord(record, user) {
  return !record?.userId || record.userId === user?.id;
}

function audioFileFilter(req, file, cb) {
  const allowedMime = file.mimetype?.startsWith("audio/") || file.mimetype === "video/webm";
  const allowedExt = [".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm"].includes(
    path.extname(file.originalname || "").toLowerCase()
  );
  if (allowedMime || allowedExt) {
    cb(null, true);
    return;
  }
  req.log?.("security_threat", {
    eventType: "input_validation_failed_audio_upload_type",
    severity: "WARN",
    outcome: "failure",
    what: {
      originalName: file.originalname,
      mimetype: file.mimetype
    }
  });
  const rejection = new Error("Only audio uploads are supported.");
  rejection.status = 400;
  rejection.type = "unsupported_upload_type";
  cb(rejection);
}

function publicRecording(recording) {
  return {
    ...recording,
    filePath: undefined,
    audioUrl: `/api/recordings/${recording.id}/audio`
  };
}

function publicStemJob(job) {
  return {
    ...job,
    sourceFilePath: undefined
  };
}

function ensureInside(root, relativePath) {
  const full = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  if (full !== normalizedRoot && !full.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Unsafe file path.");
  }
  return full;
}

function stemsplitClient(cfg) {
  // A factory override lets tests inject a fake StemSplit client (the real API
  // is unreachable without a key). Production always uses the real SDK.
  if (typeof cfg.stemsplitClientFactory === "function") {
    return cfg.stemsplitClientFactory(cfg);
  }
  if (!cfg.stemsplitApiKey) {
    return null;
  }
  return new StemSplit({ apiKey: cfg.stemsplitApiKey });
}

const MAX_SOURCE_URL_LENGTH = 2048;

function normalizeSourceUrl(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_SOURCE_URL_LENGTH) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed;
}

function classifyAudioSource(url) {
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    return "youtube";
  }
  if (host === "soundcloud.com" || host.endsWith(".soundcloud.com")) {
    return "soundcloud";
  }
  return "url";
}

function sourceLabelFromUrl(url) {
  if (url.hostname.replace(/^www\./, "") === "youtu.be") {
    return `YouTube ${url.pathname.replace("/", "") || "link"}`.slice(0, 160);
  }
  const host = url.hostname.replace(/^www\./, "");
  const last = url.pathname.split("/").filter(Boolean).pop() || url.searchParams.get("v") || "link";
  return `${host} ${last}`.slice(0, 160);
}

// The dedicated youtube/soundcloud resources return raw responses while
// jobs.create/get returns a wrapped StemJob; read fields defensively so one
// normalizer covers every source kind.
function normalizeRemoteJob(remote) {
  return {
    id: remote?.id ?? null,
    status: remote?.status ?? null,
    progress: remote?.progress ?? remote?.raw?.progress ?? null,
    outputs: remote?.outputs ?? null,
    createdAt: remote?.createdAt ?? remote?.raw?.createdAt ?? null,
    completedAt: remote?.completedAt ?? remote?.raw?.completedAt ?? null,
    errorMessage: remote?.errorMessage ?? null
  };
}

function stemJobCreateCall(client, kind, { sourcePath, sourceUrl, metadata }) {
  switch (kind) {
    case "youtube":
      return client.youtubeJobs.create(sourceUrl);
    case "soundcloud":
      return client.soundcloudJobs.create(sourceUrl);
    case "url":
      return client.jobs.create({
        sourceUrl,
        outputType: "FOUR_STEMS",
        quality: "BALANCED",
        outputFormat: "MP3",
        metadata
      });
    default:
      return client.jobs.create({
        audio: sourcePath,
        outputType: "FOUR_STEMS",
        quality: "BALANCED",
        outputFormat: "MP3",
        metadata
      });
  }
}

function stemJobGetCall(client, kind, providerJobId) {
  if (kind === "youtube") {
    return client.youtubeJobs.get(providerJobId);
  }
  if (kind === "soundcloud") {
    return client.soundcloudJobs.get(providerJobId);
  }
  return client.jobs.get(providerJobId);
}

async function refreshDemoStemJob(store, job) {
  if (!job || job.provider !== "demo" || job.status === "completed" || job.status === "failed") {
    return job;
  }

  const dueAt = Date.parse(job.completeAfter);
  if (Number.isNaN(dueAt) || Date.now() < dueAt) {
    return job;
  }

  const stems = ["vocals", "drums", "bass", "other"].map((type) => ({
    type,
    status: "demo",
    url: job.recordingId ? `/api/recordings/${job.recordingId}/audio?demoStem=${type}` : null,
    note: "Demo preview only. This is not AI-separated audio; configure StemSplit for real stems."
  }));

  return store.update("stemJobs", job.id, {
    status: "completed",
    progress: 100,
    completedAt: now(),
    stems,
    diagnostic: "MIXFORGE_DEMO_MODE completed a labeled demo stem job without calling StemSplit."
  });
}

function mapStemSplitStatus(status) {
  switch (status) {
    case "PENDING":
      return "queued";
    case "PROCESSING":
      return "processing";
    case "COMPLETED":
      return "completed";
    case "FAILED":
    case "EXPIRED":
      return "failed";
    default:
      return "processing";
  }
}

function publicStemOutputs(outputs) {
  // Completed jobs return an object keyed by stem name. Create responses may
  // return null or (for youtube) a string array of pending stem names — neither
  // is a ready output map, so ignore anything that is not a plain object.
  if (!outputs || Array.isArray(outputs) || typeof outputs !== "object") {
    return [];
  }
  return Object.entries(outputs).map(([type, output]) => ({
    type,
    status: "ready",
    url: output?.url || null,
    expiresAt: output?.expiresAt || null
  }));
}

async function refreshStemSplitJob(store, cfg, job, req = null) {
  if (!job || job.provider !== "stemsplit" || !job.providerJobId) {
    return job;
  }
  if (job.status === "completed" || job.status === "failed") {
    return job;
  }

  const client = stemsplitClient(cfg);
  if (!client) {
    return store.update("stemJobs", job.id, {
      status: "failed",
      errorMessage: "STEMSPLIT_API_KEY is not configured."
    });
  }

  const kind = job.sourceKind || "file";
  const rawRemote = req
    ? await timedDependency(req, "stemsplit", `${kind}.get`, () => stemJobGetCall(client, kind, job.providerJobId))
    : await stemJobGetCall(client, kind, job.providerJobId);
  const remote = normalizeRemoteJob(rawRemote);
  const status = mapStemSplitStatus(remote.status);
  return store.update("stemJobs", job.id, {
    status,
    progress: remote.progress ?? (status === "completed" ? 100 : job.progress),
    completedAt: status === "completed" ? remote.completedAt || now() : job.completedAt || null,
    errorMessage: remote.errorMessage || null,
    stems: status === "completed" ? publicStemOutputs(remote.outputs) : job.stems
  });
}

export function createApp(overrides = {}) {
  const cfg = { ...defaultConfig, ...overrides };
  fs.mkdirSync(cfg.uploadRoot, { recursive: true });
  fs.mkdirSync(cfg.logRoot, { recursive: true });
  const recordingUploadDir = path.join(cfg.uploadRoot, "recordings");
  const stemUploadDir = path.join(cfg.uploadRoot, "stems");
  fs.mkdirSync(recordingUploadDir, { recursive: true });
  fs.mkdirSync(stemUploadDir, { recursive: true });

  const store = overrides.store || createStore(cfg);
  const storage = overrides.storage || createStorage(cfg);
  // One Stripe client per app, with an explicit network timeout and retries so
  // a hung Stripe call can never hold a request open indefinitely.
  const stripe = cfg.stripeSecretKey
    ? new Stripe(cfg.stripeSecretKey, { timeout: 30_000, maxNetworkRetries: 2 })
    : null;
  const logStore =
    overrides.logStore ||
    new JsonlLogStore({
      rootDir: cfg.logRoot,
      serviceName: cfg.serviceName,
      serviceVersion: cfg.serviceVersion,
      retentionDays: cfg.logRetentionDays
    });
  const app = express();
  app.locals.store = store;
  app.locals.storage = storage;
  app.locals.storeReady = Promise.resolve(store.init?.());
  app.locals.config = cfg;
  app.locals.logStore = logStore;
  app.set("trust proxy", cfg.isProduction ? 1 : false);
  app.use(requestLoggerMiddleware(logStore, cfg));

  logStore.log("system_infrastructure", {
    eventType: "app_initialized",
    severity: "INFO",
    outcome: "success",
    what: {
      environment: cfg.isProduction ? "production" : "development",
      dataRoot: cfg.dataRoot,
      uploadRoot: cfg.uploadRoot,
      logRoot: cfg.logRoot
    }
  });
  logStore.log("change_deployment", {
    eventType: "runtime_configuration_loaded",
    severity: "INFO",
    outcome: "success",
    what: {
      demoMode: cfg.demoMode,
      publicBaseUrl: cfg.publicBaseUrl,
      stripeConfigured: Boolean(cfg.stripeSecretKey),
      stemsplitConfigured: Boolean(cfg.stemsplitApiKey),
      logRetentionDays: cfg.logRetentionDays
    }
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The frontend is a no-build single file with an inline <script> and
          // inline event handlers, so script-src needs 'unsafe-inline'. This
          // still blocks loading script from any other origin.
          scriptSrc: ["'self'", "'unsafe-inline'"],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https://user-gen-media-assets.s3.amazonaws.com"],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'self'"]
        }
      },
      crossOriginEmbedderPolicy: false
    })
  );
  // Helmet does not set Permissions-Policy. The recorder needs the microphone
  // on this origin; every other powerful feature is explicitly denied.
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=(), payment=(), usb=()");
    next();
  });
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || !cfg.isProduction) {
          cb(null, true);
          return;
        }
        const allowed = new Set([cfg.publicBaseUrl, ...cfg.allowedOrigins]);
        cb(null, allowed.has(origin));
      }
    })
  );

  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      if (!cfg.stripeSecretKey || !cfg.stripeWebhookSecret) {
        req.log?.("security_threat", {
          eventType: "stripe_webhook_unconfigured",
          severity: "WARN",
          outcome: "failure",
          what: { provider: "stripe" }
        });
        return res.status(501).json({ error: "Stripe webhook is not configured." });
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature"), cfg.stripeWebhookSecret);
      } catch (error) {
        req.log?.("security_threat", {
          eventType: "stripe_webhook_signature_invalid",
          severity: "WARN",
          outcome: "denied",
          what: { provider: "stripe" },
          error
        });
        return res.status(400).json({ error: error.message });
      }

      await store.insert("payments", {
        id: crypto.randomUUID(),
        provider: "stripe",
        eventType: event.type,
        payloadId: event.id,
        objectId: event.data?.object?.id || null,
        createdAt: now()
      });
      const updatedUser = await applyStripeEvent(store, cfg, event);
      req.log?.("dependency_external", {
        eventType: "stripe_webhook_received",
        severity: "INFO",
        outcome: "success",
        what: {
          provider: "stripe",
          eventType: event.type,
          payloadId: event.id,
          objectId: event.data?.object?.id || null
        }
      });
      req.log?.("audit", {
        eventType: "stripe_webhook_applied",
        severity: "INFO",
        outcome: "success",
        actor: { userId: updatedUser?.id || null, userEmailHash: hashIdentifier(updatedUser?.email), authenticated: false },
        what: {
          provider: "stripe",
          eventType: event.type,
          updatedUserId: updatedUser?.id || null
        }
      });
      return res.json({ received: true, updatedUserId: updatedUser?.id || null });
    }
  );

  app.post(
    "/api/stems/webhook",
    express.raw({ type: "*/*" }),
    async (req, res) => {
      if (!cfg.stemsplitWebhookSecret) {
        req.log?.("security_threat", {
          eventType: "stemsplit_webhook_unconfigured",
          severity: "WARN",
          outcome: "failure",
          what: { provider: "stemsplit" }
        });
        return res.status(501).json({ error: "STEMSPLIT_WEBHOOK_SECRET is not configured." });
      }

      try {
        const event = stemsplitWebhooks.verifyAndParse(
          req.body,
          req.get("x-webhook-signature") || "",
          cfg.stemsplitWebhookSecret
        );
        const providerJobId = event.jobId || event.data?.id;
        if (!providerJobId) {
          req.log?.("dependency_external", {
            eventType: "stemsplit_webhook_ignored_missing_job",
            severity: "WARN",
            outcome: "deferred",
            what: { provider: "stemsplit", eventName: event.event || null }
          });
          return res.json({ received: true, ignored: true });
        }

        const localJob = await store.findBy("stemJobs", "providerJobId", providerJobId);
        if (!localJob) {
          req.log?.("dependency_external", {
            eventType: "stemsplit_webhook_unmatched_job",
            severity: "WARN",
            outcome: "deferred",
            what: { provider: "stemsplit", providerJobId }
          });
          return res.json({ received: true, matched: false });
        }

        const eventName = event.event || "";
        if (eventName === "job.completed") {
          await store.update("stemJobs", localJob.id, {
            status: "completed",
            progress: 100,
            completedAt: now(),
            stems: publicStemOutputs(event.data?.outputs)
          });
          req.log?.("transaction_business", {
            eventType: "stemsplit_job_completed_webhook",
            severity: "INFO",
            outcome: "success",
            actor: { userId: localJob.userId || null, userEmailHash: null, authenticated: false },
            what: { jobId: localJob.id, providerJobId }
          });
        } else if (eventName === "job.failed" || eventName === "job.expired") {
          await store.update("stemJobs", localJob.id, {
            status: "failed",
            errorMessage: event.data?.errorMessage || eventName
          });
          req.log?.("error", {
            eventType: "stemsplit_job_failed_webhook",
            severity: "ERROR",
            outcome: "failure",
            actor: { userId: localJob.userId || null, userEmailHash: null, authenticated: false },
            what: { jobId: localJob.id, providerJobId, eventName }
          });
        }

        req.log?.("dependency_external", {
          eventType: "stemsplit_webhook_received",
          severity: "INFO",
          outcome: "success",
          what: { provider: "stemsplit", eventName, providerJobId, matched: true }
        });
        return res.json({ received: true, matched: true });
      } catch (error) {
        req.log?.("security_threat", {
          eventType: "stemsplit_webhook_signature_invalid",
          severity: "WARN",
          outcome: "denied",
          what: { provider: "stemsplit" },
          error
        });
        return res.status(401).json({ error: "Invalid StemSplit webhook signature." });
      }
    }
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  const rateLimitBackend = overrides.rateLimitBackend || createRateLimitBackend(cfg);
  app.locals.rateLimitBackend = rateLimitBackend;
  const authWindowMs = 15 * 60 * 1000;
  const authLimit = 40;
  const writeWindowMs = 60 * 1000;
  const writeLimit = 30;
  app.use(
    "/api/auth",
    buildLimiter({
      windowMs: authWindowMs,
      limit: authLimit,
      prefix: "auth",
      backend: rateLimitBackend,
      handler(req, res) {
        req.log?.("rate_limiting_throttle", {
          eventType: "rate_limit_exceeded_auth",
          severity: "WARN",
          outcome: "denied",
          what: { limit: authLimit, windowMs: authWindowMs }
        });
        req.log?.("security_threat", {
          eventType: "possible_auth_bruteforce_rate_limit",
          severity: "WARN",
          outcome: "denied",
          what: { limit: authLimit, windowMs: authWindowMs }
        });
        res.status(429).json({ error: "Too many authentication attempts. Try again later." });
      }
    })
  );
  app.use(
    ["/api/recordings", "/api/stems/jobs", "/api/billing/checkout", "/api/reports", "/api/dmca", "/api/contact"],
    buildLimiter({
      windowMs: writeWindowMs,
      limit: writeLimit,
      prefix: "write",
      backend: rateLimitBackend,
      handler(req, res) {
        req.log?.("rate_limiting_throttle", {
          eventType: "rate_limit_exceeded_write_api",
          severity: "WARN",
          outcome: "denied",
          what: { limit: writeLimit, windowMs: writeWindowMs }
        });
        req.log?.("security_threat", {
          eventType: "write_api_abuse_rate_limit",
          severity: "WARN",
          outcome: "denied",
          what: { limit: writeLimit, windowMs: writeWindowMs }
        });
        res.status(429).json({ error: "Too many write requests. Try again shortly." });
      }
    })
  );
  app.use(express.static(cfg.publicDir));

  const recordingUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, recordingUploadDir),
      filename: (_req, file, cb) => cb(null, safeFileName(file.originalname))
    }),
    fileFilter: audioFileFilter,
    limits: { fileSize: 100 * 1024 * 1024 }
  });

  const stemUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, stemUploadDir),
      filename: (_req, file, cb) => cb(null, safeFileName(file.originalname, ".mp3"))
    }),
    fileFilter: audioFileFilter,
    limits: { fileSize: 150 * 1024 * 1024 }
  });

  const optionalUser = attachUser(store, cfg.jwtSecret, false);
  const requiredUser = attachUser(store, cfg.jwtSecret, true);

  app.get("/api/health", async (_req, res) => {
    // A liveness probe that can never fail can never detect a wedged process.
    // Verify the two things every request depends on: the store answers queries
    // and log storage accepts writes.
    let storeOk = false;
    try {
      storeOk = Array.isArray(await store.list("beats"));
    } catch {
      storeOk = false;
    }
    const logging = logStore.health();
    const ok = storeOk && logging.ok;
    _req.log?.("health_check_heartbeat", {
      eventType: "health_check_requested",
      severity: ok ? "INFO" : "ERROR",
      outcome: ok ? "success" : "failure",
      what: { endpoint: "/api/health", storeOk, loggingOk: logging.ok }
    });
    res.status(ok ? 200 : 503).json({
      ok,
      service: cfg.serviceName,
      version: cfg.serviceVersion,
      store: store.kind,
      uploads: storage.kind,
      checks: { store: storeOk, logging: logging.ok },
      dataRoot: cfg.dataRoot,
      logRoot: cfg.logRoot,
      timestamp: now()
    });
  });

  app.get("/api/readiness", (req, res) => {
    const readiness = evaluateReadiness(cfg);
    req.log?.("health_check_heartbeat", {
      eventType: "readiness_check_requested",
      severity: readiness.ready ? "INFO" : "WARN",
      outcome: readiness.ready ? "success" : "failure",
      what: {
        endpoint: "/api/readiness",
        ready: readiness.ready,
        failedChecks: readiness.checks.filter((check) => !check.ok && check.required).map((check) => check.id)
      }
    });
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });

  // Diagnostics enumerate config state (which providers are configured, storage
  // paths, failed checks) — useful to operators, reconnaissance to anyone else.
  // Public in development; admin-only in production.
  const diagnosticsGuard = cfg.isProduction ? requireAdmin : (_req, _res, next) => next();
  app.get("/api/diagnostics", diagnosticsGuard, (req, res) => {
    const diagnostics = {
      ...evaluateReadiness(cfg),
      logging: logStore.health(),
      logTaxonomy: LOG_TYPES
    };
    req.log?.("health_check_heartbeat", {
      eventType: "diagnostics_requested",
      severity: diagnostics.ready ? "INFO" : "WARN",
      outcome: diagnostics.ready ? "success" : "failure",
      what: { endpoint: "/api/diagnostics", ready: diagnostics.ready }
    });
    res.json(diagnostics);
  });

  app.get("/api/logs/taxonomy", (req, res) => {
    req.log?.("data_access_query", {
      eventType: "log_taxonomy_read",
      severity: "INFO",
      outcome: "success",
      what: { logTypes: Object.keys(LOG_TYPES).length }
    });
    res.json({
      format: "jsonl",
      root: cfg.logRoot,
      retentionDays: cfg.logRetentionDays,
      logTypes: LOG_TYPES
    });
  });

  app.post("/api/auth/signup", async (req, res, next) => {
    try {
      if (typeof req.body.email !== "string" || typeof req.body.password !== "string") {
        req.log?.("security_threat", {
          eventType: "input_validation_failed_signup_types",
          severity: "WARN",
          outcome: "failure",
          what: { emailType: typeof req.body.email, passwordType: typeof req.body.password }
        });
        return res.status(400).json({ error: "Email and password must be strings." });
      }
      const email = normalizeEmail(req.body.email);
      const password = req.body.password;
      const name = String(req.body.name || email.split("@")[0] || "Creator").trim();

      if (!email.includes("@")) {
        req.log?.("security_threat", {
          eventType: "input_validation_failed_signup_email",
          severity: "WARN",
          outcome: "failure",
          actor: { userId: null, userEmailHash: hashIdentifier(email), authenticated: false },
          what: { field: "email" }
        });
        return res.status(400).json({ error: "A valid email is required." });
      }
      // NIST SP 800-63B-4 minimum for user-chosen passwords.
      if (password.length < 8) {
        req.log?.("security_threat", {
          eventType: "input_validation_failed_signup_password",
          severity: "WARN",
          outcome: "failure",
          actor: { userId: null, userEmailHash: hashIdentifier(email), authenticated: false },
          what: { field: "password", reason: "too_short" }
        });
        return res.status(400).json({ error: "Password must be at least 8 characters." });
      }
      if (await store.findBy("users", "email", email)) {
        req.log?.("authentication", {
          eventType: "signup_duplicate_email",
          severity: "WARN",
          outcome: "failure",
          actor: { userId: null, userEmailHash: hashIdentifier(email), authenticated: false }
        });
        return res.status(409).json({ error: "That email already has a MixForge account." });
      }

      const user = {
        id: crypto.randomUUID(),
        email,
        name,
        passwordHash: await bcrypt.hash(password, 12),
        planId: "free",
        emailVerified: false,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionStatus: null,
        currentPeriodEnd: null,
        createdAt: now(),
        updatedAt: now()
      };

      await store.insert("users", user);

      // Issue an email-verification token. Delivery is by email in production;
      // demo mode returns the token so the flow is fully exercisable locally.
      const verification = {
        id: crypto.randomUUID(),
        userId: user.id,
        token: secureToken(),
        expiresAt: isoAfter(VERIFY_TOKEN_TTL_MS),
        verifiedAt: null,
        createdAt: now()
      };
      await store.insert("emailVerifications", verification);

      req.log?.("audit", {
        eventType: "user_account_created",
        severity: "INFO",
        outcome: "success",
        actor: { userId: user.id, userEmailHash: hashIdentifier(user.email), authenticated: true },
        what: { userId: user.id, planId: user.planId }
      });
      req.log?.("authentication", {
        eventType: "signup_success",
        severity: "INFO",
        outcome: "success",
        actor: { userId: user.id, userEmailHash: hashIdentifier(user.email), authenticated: true }
      });
      req.log?.("session", {
        eventType: "session_created_signup",
        severity: "INFO",
        outcome: "success",
        actor: { userId: user.id, userEmailHash: hashIdentifier(user.email), authenticated: true },
        what: { expiresIn: "14d" }
      });
      return res.status(201).json({
        user: toPublicUser(user),
        token: signToken(user, cfg.jwtSecret),
        ...(cfg.demoMode ? { verificationToken: verification.token } : {})
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      if (typeof req.body.email !== "string" || typeof req.body.password !== "string") {
        req.log?.("security_threat", {
          eventType: "input_validation_failed_login_types",
          severity: "WARN",
          outcome: "failure",
          what: { emailType: typeof req.body.email, passwordType: typeof req.body.password }
        });
        return res.status(400).json({ error: "Email and password must be strings." });
      }
      const email = normalizeEmail(req.body.email);
      const password = req.body.password;
      const user = await store.findBy("users", "email", email);

      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        req.log?.("authentication", {
          eventType: "login_failure",
          severity: "WARN",
          outcome: "failure",
          actor: { userId: user?.id || null, userEmailHash: hashIdentifier(email), authenticated: false }
        });
        req.log?.("security_threat", {
          eventType: "auth_failure_password",
          severity: "WARN",
          outcome: "failure",
          actor: { userId: user?.id || null, userEmailHash: hashIdentifier(email), authenticated: false }
        });
        return res.status(401).json({ error: "Incorrect email or password." });
      }

      req.log?.("authentication", {
        eventType: "login_success",
        severity: "INFO",
        outcome: "success",
        actor: { userId: user.id, userEmailHash: hashIdentifier(user.email), authenticated: true }
      });
      req.log?.("session", {
        eventType: "session_created_login",
        severity: "INFO",
        outcome: "success",
        actor: { userId: user.id, userEmailHash: hashIdentifier(user.email), authenticated: true },
        what: { expiresIn: "14d" }
      });
      return res.json({
        user: toPublicUser(user),
        token: signToken(user, cfg.jwtSecret)
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/auth/verify-email", async (req, res, next) => {
    try {
      const token = typeof req.body.token === "string" ? req.body.token.trim() : "";
      const record = token ? await store.findBy("emailVerifications", "token", token) : null;
      if (!record || record.verifiedAt || Date.parse(record.expiresAt) < Date.now()) {
        req.log?.("security_threat", {
          eventType: "email_verification_invalid_token",
          severity: "WARN",
          outcome: "failure",
          what: { hasToken: Boolean(token) }
        });
        return res.status(400).json({ error: "Invalid or expired verification token." });
      }
      await store.update("emailVerifications", record.id, { verifiedAt: now() });
      await store.update("users", record.userId, { emailVerified: true });
      req.log?.("audit", {
        eventType: "email_verified",
        severity: "INFO",
        outcome: "success",
        actor: { userId: record.userId, userEmailHash: null, authenticated: false },
        what: { userId: record.userId }
      });
      return res.json({ verified: true });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/auth/forgot-password", async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const user = email ? await store.findBy("users", "email", email) : null;
      // Always respond 200 with the same body so the endpoint never reveals
      // whether an account exists (prevents account enumeration).
      const response = { ok: true, message: "If that email has an account, a reset link is on its way." };
      if (user) {
        const reset = {
          id: crypto.randomUUID(),
          userId: user.id,
          token: secureToken(),
          expiresAt: isoAfter(RESET_TOKEN_TTL_MS),
          usedAt: null,
          createdAt: now()
        };
        await store.insert("passwordResets", reset);
        req.log?.("audit", {
          eventType: "password_reset_requested",
          severity: "INFO",
          outcome: "success",
          actor: { userId: user.id, userEmailHash: hashIdentifier(email), authenticated: false },
          what: { userId: user.id }
        });
        if (cfg.demoMode) {
          response.resetToken = reset.token;
        }
      } else {
        req.log?.("authentication", {
          eventType: "password_reset_requested_unknown_email",
          severity: "INFO",
          outcome: "deferred",
          actor: { userId: null, userEmailHash: hashIdentifier(email), authenticated: false }
        });
      }
      return res.json(response);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/auth/reset-password", async (req, res, next) => {
    try {
      const token = typeof req.body.token === "string" ? req.body.token.trim() : "";
      const password = req.body.password;
      if (typeof password !== "string" || password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters." });
      }
      const record = token ? await store.findBy("passwordResets", "token", token) : null;
      if (!record || record.usedAt || Date.parse(record.expiresAt) < Date.now()) {
        req.log?.("security_threat", {
          eventType: "password_reset_invalid_token",
          severity: "WARN",
          outcome: "failure",
          what: { hasToken: Boolean(token) }
        });
        return res.status(400).json({ error: "Invalid or expired reset token." });
      }
      const user = await store.findById("users", record.userId);
      if (!user) {
        return res.status(400).json({ error: "Invalid or expired reset token." });
      }
      await store.update("users", user.id, {
        passwordHash: await bcrypt.hash(password, 12),
        // Bumping the version revokes every session issued before the reset
        // (attachUser compares it against the token's pwv claim); the timestamp
        // is kept for the audit trail.
        passwordVersion: (user.passwordVersion || 0) + 1,
        passwordChangedAt: now()
      });
      await store.update("passwordResets", record.id, { usedAt: now() });
      req.log?.("audit", {
        eventType: "password_reset_completed",
        severity: "INFO",
        outcome: "success",
        actor: { userId: user.id, userEmailHash: hashIdentifier(user.email), authenticated: false },
        what: { userId: user.id }
      });
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/me", requiredUser, (req, res) => {
    req.log?.("audit", {
      eventType: "sensitive_user_profile_read",
      severity: "INFO",
      outcome: "success",
      what: { userId: req.user.id }
    });
    req.log?.("data_access_query", {
      eventType: "user_profile_read",
      severity: "INFO",
      outcome: "success",
      what: { collection: "users", userId: req.user.id }
    });
    res.json({ user: toPublicUser(req.user) });
  });

  app.get("/api/beats", async (_req, res, next) => {
    try {
      res.json({ beats: await store.list("beats") });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/community", async (_req, res, next) => {
    try {
      res.json({ tracks: await store.list("community") });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/recordings", optionalUser, recordingUpload.single("audio"), async (req, res, next) => {
   try {
    if (!req.file) {
      req.log?.("security_threat", {
        eventType: "input_validation_failed_recording_missing_audio",
        severity: "WARN",
        outcome: "failure",
        what: { field: "audio" }
      });
      return res.status(400).json({ error: "Upload an audio file in the 'audio' form field." });
    }

    const activeBeat = req.body.beatId ? await store.findById("beats", req.body.beatId) : null;
    // Hand the multer temp file to the storage backend. Local storage keeps it
    // in place; S3 uploads it and deletes the local copy — without this call
    // S3 mode would serve pre-signed URLs to objects that were never uploaded.
    const uploadedPath = path.relative(cfg.uploadRoot, req.file.path).replaceAll("\\", "/");
    const persistedPath = await storage.persist(req.file.path, uploadedPath);
    const recording = {
      id: crypto.randomUUID(),
      userId: req.user ? req.user.id : null,
      title: String(req.body.title || `Vocal Take ${new Date().toLocaleDateString()}`).slice(0, 120),
      beatId: activeBeat ? activeBeat.id : String(req.body.beatId || ""),
      beatName: activeBeat ? activeBeat.name : String(req.body.beatName || "Unselected Beat"),
      preset: String(req.body.preset || "Natural").slice(0, 80),
      mimeType: req.file.mimetype || "application/octet-stream",
      sizeBytes: req.file.size,
      durationSeconds: Number(req.body.durationSeconds || 0),
      filePath: persistedPath,
      moderationStatus: "active",
      createdAt: now(),
      updatedAt: now()
    };

    await store.insert("recordings", recording);
    req.log?.("audit", {
      eventType: "recording_uploaded",
      severity: "INFO",
      outcome: "success",
      what: {
        recordingId: recording.id,
        userId: recording.userId,
        sizeBytes: recording.sizeBytes,
        mimeType: recording.mimeType
      }
    });
    req.log?.("transaction_business", {
      eventType: "recording_created",
      severity: "INFO",
      outcome: "success",
      what: { recordingId: recording.id, beatId: recording.beatId, durationSeconds: recording.durationSeconds }
    });
    return res.status(201).json({ recording: publicRecording(recording) });
   } catch (error) {
     return next(error);
   }
  });

  app.get("/api/recordings", optionalUser, async (req, res, next) => {
    try {
      // Anonymous callers only ever see ownerless (anonymous) rows; listing
      // every user's recordings without a session was a metadata leak.
      const rows = await store.listByOwner("recordings", req.user ? req.user.id : null);
      const recordings = rows.map(publicRecording);
      req.log?.("data_access_query", {
        eventType: "recordings_list_read",
        severity: "INFO",
        outcome: "success",
        what: { collection: "recordings", count: recordings.length }
      });
      res.json({ recordings });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/recordings/:id/audio", optionalUser, async (req, res, next) => {
    try {
      const recording = await store.findById("recordings", req.params.id);
      if (!recording) {
        req.log?.("access_authorization", {
          eventType: "recording_audio_missing",
          severity: "WARN",
          outcome: "failure",
          what: { recordingId: req.params.id }
        });
        return res.status(404).json({ error: "Recording not found." });
      }
      if (recording.moderationStatus === "removed") {
        req.log?.("audit", {
          eventType: "moderated_recording_audio_blocked",
          severity: "WARN",
          outcome: "denied",
          what: { recordingId: recording.id, moderationStatus: recording.moderationStatus }
        });
        return res.status(410).json({ error: "This content was removed by moderation." });
      }
      if (!canAccessOwnedRecord(recording, req.user)) {
        req.log?.("access_authorization", {
          eventType: "recording_audio_access_denied",
          severity: "WARN",
          outcome: "denied",
          what: { recordingId: recording.id, ownerUserId: recording.userId }
        });
        req.log?.("audit", {
          eventType: "sensitive_recording_audio_read_denied",
          severity: "WARN",
          outcome: "denied",
          what: { recordingId: recording.id, ownerUserId: recording.userId }
        });
        return res.status(403).json({ error: "Recording access denied." });
      }
      req.log?.("audit", {
        eventType: "sensitive_recording_audio_read",
        severity: "INFO",
        outcome: "success",
        what: { recordingId: recording.id, ownerUserId: recording.userId, mimeType: recording.mimeType }
      });
      req.log?.("data_access_query", {
        eventType: "recording_audio_file_read",
        severity: "INFO",
        outcome: "success",
        what: { collection: "recordings", recordingId: recording.id, storage: storage.kind }
      });
      return storage.serve(res, recording);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/projects", optionalUser, async (req, res, next) => {
   try {
    const recording = req.body.recordingId ? await store.findById("recordings", req.body.recordingId) : null;
    if (recording && !canAccessOwnedRecord(recording, req.user)) {
      req.log?.("access_authorization", {
        eventType: "project_recording_attach_denied",
        severity: "WARN",
        outcome: "denied",
        what: { recordingId: recording.id, ownerUserId: recording.userId }
      });
      req.log?.("audit", {
        eventType: "project_create_denied_cross_user_recording",
        severity: "WARN",
        outcome: "denied",
        what: { recordingId: recording.id, ownerUserId: recording.userId }
      });
      return res.status(403).json({ error: "Recording access denied." });
    }

    const project = {
      id: crypto.randomUUID(),
      userId: req.user ? req.user.id : null,
      title: String(req.body.title || "Untitled MixForge Project").slice(0, 120),
      mode: String(req.body.mode || "vocal").slice(0, 40),
      recordingId: recording ? recording.id : null,
      beatId: String(req.body.beatId || recording?.beatId || ""),
      preset: String(req.body.preset || recording?.preset || "Natural").slice(0, 80),
      settings: req.body.settings && typeof req.body.settings === "object" ? req.body.settings : {},
      createdAt: now(),
      updatedAt: now()
    };

    await store.insert("projects", project);
    req.log?.("audit", {
      eventType: "project_created",
      severity: "INFO",
      outcome: "success",
      what: { projectId: project.id, recordingId: project.recordingId, mode: project.mode }
    });
    req.log?.("transaction_business", {
      eventType: "project_workflow_created",
      severity: "INFO",
      outcome: "success",
      what: { projectId: project.id, mode: project.mode }
    });
    return res.status(201).json({ project });
   } catch (error) {
     return next(error);
   }
  });

  app.get("/api/projects", optionalUser, async (req, res, next) => {
    try {
      const projects = await store.listByOwner("projects", req.user ? req.user.id : null);
      req.log?.("data_access_query", {
        eventType: "projects_list_read",
        severity: "INFO",
        outcome: "success",
        what: { collection: "projects", count: projects.length }
      });
      res.json({ projects });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/stems/jobs", optionalUser, stemUpload.single("track"), async (req, res, next) => {
   try {
    const recording = req.body.recordingId ? await store.findById("recordings", req.body.recordingId) : null;

    // A link (YouTube / SoundCloud / direct audio URL) is a third source type
    // alongside an uploaded file and a saved recording. When present it wins,
    // and the actual fetch is done by StemSplit, not by MixForge.
    const rawSourceUrl = req.body.sourceUrl;
    let sourceUrl = null;
    let sourceKind = "file";
    if (rawSourceUrl !== undefined && rawSourceUrl !== null && String(rawSourceUrl).trim() !== "") {
      const parsed = normalizeSourceUrl(rawSourceUrl);
      if (!parsed) {
        req.log?.("security_threat", {
          eventType: "input_validation_failed_stem_source_url",
          severity: "WARN",
          outcome: "failure",
          what: { reason: "invalid_or_unsupported_url" }
        });
        return res.status(400).json({ error: "Provide a valid http(s) link to import." });
      }
      sourceUrl = parsed.toString();
      sourceKind = classifyAudioSource(parsed);
    }

    const sourcePath =
      sourceKind !== "file"
        ? null
        : req.file
          ? req.file.path
          : recording?.filePath
            ? ensureInside(cfg.uploadRoot, recording.filePath)
            : null;
    if (recording && !canAccessOwnedRecord(recording, req.user)) {
      req.log?.("access_authorization", {
        eventType: "stem_job_recording_access_denied",
        severity: "WARN",
        outcome: "denied",
        what: { recordingId: recording.id, ownerUserId: recording.userId }
      });
      req.log?.("audit", {
        eventType: "stem_job_create_denied_cross_user_recording",
        severity: "WARN",
        outcome: "denied",
        what: { recordingId: recording.id, ownerUserId: recording.userId }
      });
      return res.status(403).json({ error: "Recording access denied." });
    }
    if (sourceKind === "file" && !sourcePath) {
      req.log?.("security_threat", {
        eventType: "input_validation_failed_stem_missing_audio",
        severity: "WARN",
        outcome: "failure",
        what: { recordingId: req.body.recordingId || null, hasUpload: Boolean(req.file) }
      });
      return res
        .status(400)
        .json({ error: "Upload audio, select a recording, or paste a link before creating a stem job." });
    }
    if (!cfg.stemsplitApiKey && !cfg.demoMode) {
      req.log?.("error", {
        eventType: "stemsplit_config_missing",
        severity: "ERROR",
        outcome: "failure",
        what: { provider: "stemsplit", demoMode: cfg.demoMode }
      });
      return res.status(503).json({ error: "StemSplit is not configured." });
    }

    const job = {
      id: crypto.randomUUID(),
      userId: req.user ? req.user.id : null,
      provider: cfg.stemsplitApiKey ? "stemsplit" : "demo",
      status: "queued",
      progress: 5,
      providerJobId: null,
      recordingId: recording ? recording.id : null,
      sourceKind,
      sourceUrl,
      sourceName: String(
        req.body.sourceName ||
          req.file?.originalname ||
          recording?.title ||
          (sourceUrl ? sourceLabelFromUrl(new URL(sourceUrl)) : "Mashup Source")
      ).slice(0, 160),
      sourceFilePath: req.file ? path.relative(cfg.uploadRoot, req.file.path).replaceAll("\\", "/") : null,
      requestedStems: Array.isArray(req.body.stems)
        ? req.body.stems
        : String(req.body.stems || "vocals,drums,bass,other")
            .split(",")
            .map((stem) => stem.trim())
            .filter(Boolean),
      bpmSync: req.body.bpmSync !== "false",
      keyMatch: req.body.keyMatch !== "false",
      stems: [],
      errorMessage: null,
      mode: cfg.stemsplitApiKey ? "real" : "demo",
      diagnostic: cfg.stemsplitApiKey
        ? null
        : "Demo stem preview queued because StemSplit is not configured. Configure STEMSPLIT_API_KEY for real separation.",
      createdAt: now(),
      updatedAt: now(),
      completeAfter: cfg.stemsplitApiKey ? null : new Date(Date.now() + 1800).toISOString()
    };

    // Persist the upload BEFORE the job row or any remote work exists: local
    // storage is a no-op, S3 uploads the object and removes the temp file. A
    // persist failure (e.g. S3 outage) therefore aborts cleanly with no
    // half-created state to reconcile.
    if (req.file) {
      await storage.persist(req.file.path, job.sourceFilePath);
    }
    await store.insert("stemJobs", job);
    req.log?.("audit", {
      eventType: "stem_job_created",
      severity: "INFO",
      outcome: "success",
      what: { jobId: job.id, provider: job.provider, recordingId: job.recordingId, mode: job.mode }
    });
    req.log?.("transaction_business", {
      eventType: "stem_job_queued",
      severity: "INFO",
      outcome: "success",
      what: { jobId: job.id, provider: job.provider, mode: job.mode }
    });

    if (job.provider === "demo") {
      req.log?.("agent_decision_reasoning", {
        eventType: "demo_mode_provider_selected",
        severity: "WARN",
        outcome: "deferred",
        what: {
          jobId: job.id,
          selectedProvider: "demo",
          reason: "StemSplit is not configured and MIXFORGE_DEMO_MODE is enabled."
        }
      });
      return res.status(202).json({ mode: "demo", job: publicStemJob(job) });
    }

    const client = stemsplitClient(cfg);
    try {
      // Choose how StemSplit fetches the source. Anything persisted to object
      // storage no longer exists on local disk, so it is handed over as a
      // time-limited signed URL; local storage keeps the file on disk and the
      // SDK uploads it directly.
      let submitKind = sourceKind;
      let submitUrl = sourceUrl;
      let submitPath = null;
      if (sourceKind === "file") {
        const relativeSource = req.file ? job.sourceFilePath : recording?.filePath || null;
        const remoteUrl = relativeSource ? await storage.signedSourceUrl(relativeSource) : null;
        if (remoteUrl) {
          submitKind = "url";
          submitUrl = remoteUrl;
        } else {
          submitPath = req.file ? req.file.path : sourcePath;
        }
      }
      const rawRemote = await timedDependency(req, "stemsplit", `${submitKind}.create`, () =>
        stemJobCreateCall(client, submitKind, {
          sourcePath: submitPath,
          sourceUrl: submitUrl,
          metadata: {
            mixforgeJobId: job.id,
            userId: job.userId,
            sourceName: job.sourceName
          }
        })
      );
      const remote = normalizeRemoteJob(rawRemote);
      const updated = await store.update("stemJobs", job.id, {
        providerJobId: remote.id,
        status: mapStemSplitStatus(remote.status),
        progress: remote.progress ?? 10,
        stems: publicStemOutputs(remote.outputs),
        externalCreatedAt: remote.createdAt || null
      });
      req.log?.("transaction_business", {
        eventType: "stemsplit_job_submitted",
        severity: "INFO",
        outcome: "success",
        what: { jobId: job.id, providerJobId: remote.id, providerStatus: remote.status, sourceKind }
      });
      return res.status(202).json({ job: publicStemJob(updated) });
    } catch (error) {
      const failed = await store.update("stemJobs", job.id, {
        status: "failed",
        errorMessage: error.message
      });
      req.log?.("error", {
        eventType: "stemsplit_job_create_failed",
        severity: "ERROR",
        outcome: "failure",
        what: { jobId: job.id, provider: "stemsplit" },
        error
      });
      return res.status(502).json({
        error: "StemSplit job creation failed.",
        detail: error.message,
        job: publicStemJob(failed)
      });
    }
   } catch (error) {
     return next(error);
   }
  });

  app.get("/api/stems/jobs/:id", optionalUser, async (req, res, next) => {
   try {
    const job = await store.findById("stemJobs", req.params.id);
    if (!job) {
      req.log?.("access_authorization", {
        eventType: "stem_job_missing",
        severity: "WARN",
        outcome: "failure",
        what: { jobId: req.params.id }
      });
      return res.status(404).json({ error: "Stem job not found." });
    }
    if (job.userId && job.userId !== req.user?.id) {
      req.log?.("access_authorization", {
        eventType: "stem_job_access_denied",
        severity: "WARN",
        outcome: "denied",
        what: { jobId: job.id, ownerUserId: job.userId }
      });
      req.log?.("audit", {
        eventType: "stem_job_read_denied",
        severity: "WARN",
        outcome: "denied",
        what: { jobId: job.id, ownerUserId: job.userId }
      });
      return res.status(403).json({ error: "Stem job access denied." });
    }
    const previousStatus = job.status;
    const refreshed =
      job.provider === "stemsplit"
        ? await refreshStemSplitJob(store, cfg, job, req)
        : job.provider === "demo"
          ? await refreshDemoStemJob(store, job)
          : await store.update("stemJobs", job.id, {
              status: "failed",
              errorMessage: `Unsupported stem provider: ${job.provider || "unknown"}`
            });
    req.log?.("data_access_query", {
      eventType: "stem_job_read",
      severity: "INFO",
      outcome: "success",
      what: { jobId: job.id, provider: job.provider, status: refreshed.status }
    });
    if (previousStatus !== refreshed.status) {
      req.log?.("transaction_business", {
        eventType: "stem_job_status_changed",
        severity: refreshed.status === "failed" ? "ERROR" : "INFO",
        outcome: refreshed.status === "failed" ? "failure" : "success",
        what: { jobId: job.id, provider: job.provider, from: previousStatus, to: refreshed.status }
      });
    }
    return res.json({ job: publicStemJob(refreshed) });
   } catch (error) {
     return next(error);
   }
  });

  app.get("/api/plans", (_req, res) => {
    res.json({ plans: Object.values(PLAN_CATALOG) });
  });

  app.post("/api/billing/checkout", optionalUser, async (req, res, next) => {
    try {
      const planId = String(req.body.planId || "").trim();
      const plan = PLAN_CATALOG[planId];
      if (!plan) {
        req.log?.("security_threat", {
          eventType: "input_validation_failed_unknown_plan",
          severity: "WARN",
          outcome: "failure",
          what: { planId }
        });
        return res.status(400).json({ error: "Unknown plan." });
      }

      if (plan.id === "free") {
        if (req.user) {
          await store.update("users", req.user.id, { planId: "free" });
        }
        req.log?.("audit", {
          eventType: "free_plan_activated",
          severity: "INFO",
          outcome: "success",
          what: { planId: "free", userId: req.user?.id || null }
        });
        req.log?.("transaction_business", {
          eventType: "checkout_free_plan_completed",
          severity: "INFO",
          outcome: "success",
          what: { planId: "free" }
        });
        return res.json({ mode: "free", plan, message: "Free plan is active." });
      }

      const priceId = cfg.stripePrices[plan.id];
      if (plan.id !== "free" && !req.user) {
        req.log?.("access_authorization", {
          eventType: "paid_checkout_denied_missing_auth",
          severity: "WARN",
          outcome: "denied",
          what: { planId: plan.id }
        });
        return res.status(401).json({ error: "Authentication is required for paid checkout." });
      }
      if (!cfg.stripeSecretKey || !priceId) {
        if (!cfg.demoMode) {
          req.log?.("error", {
            eventType: "stripe_checkout_config_missing",
            severity: "ERROR",
            outcome: "failure",
            what: { planId: plan.id, stripeSecretConfigured: Boolean(cfg.stripeSecretKey), priceConfigured: Boolean(priceId) }
          });
          return res.status(503).json({ error: "Stripe checkout is not configured." });
        }
        req.log?.("audit", {
          eventType: "demo_checkout_requested",
          severity: "WARN",
          outcome: "deferred",
          what: { planId: plan.id, noPaymentCaptured: true, paidPlanActivated: false }
        });
        req.log?.("transaction_business", {
          eventType: "checkout_demo_mode_response",
          severity: "WARN",
          outcome: "deferred",
          what: { planId: plan.id, provider: "demo" }
        });
        return res.json({
          mode: "demo",
          plan,
          checkoutUrl: null,
          message: "Demo checkout only. Stripe is not configured, so no paid plan was activated.",
          diagnostic:
            "Configure STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and the Stripe price IDs to open real Checkout."
        });
      }
      if (stripe && priceId) {
        const checkoutSession = {
          mode: "subscription",
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${cfg.publicBaseUrl}/?checkout=success&plan=${plan.id}`,
          cancel_url: `${cfg.publicBaseUrl}/?checkout=cancelled&plan=${plan.id}`,
          client_reference_id: req.user ? req.user.id : undefined,
          metadata: {
            userId: req.user ? req.user.id : "",
            planId: plan.id
          },
          subscription_data: {
            metadata: {
              userId: req.user ? req.user.id : "",
              planId: plan.id
            }
          },
          allow_promotion_codes: true
        };

        if (req.user?.stripeCustomerId) {
          checkoutSession.customer = req.user.stripeCustomerId;
        } else {
          checkoutSession.customer_email = req.user ? req.user.email : normalizeEmail(req.body.email);
        }

        const session = await timedDependency(req, "stripe", "checkout.sessions.create", () =>
          stripe.checkout.sessions.create(checkoutSession)
        );

        await store.insert("payments", {
          id: crypto.randomUUID(),
          userId: req.user ? req.user.id : null,
          provider: "stripe",
          planId: plan.id,
          checkoutSessionId: session.id,
          status: "created",
          createdAt: now()
        });

        req.log?.("audit", {
          eventType: "stripe_checkout_session_created",
          severity: "INFO",
          outcome: "success",
          what: { planId: plan.id, checkoutSessionId: session.id, provider: "stripe" }
        });
        req.log?.("transaction_business", {
          eventType: "paid_checkout_started",
          severity: "INFO",
          outcome: "success",
          what: { planId: plan.id, checkoutSessionId: session.id, provider: "stripe" }
        });
        return res.json({ mode: "stripe", plan, checkoutUrl: session.url });
      }
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/contact", async (req, res, next) => {
   try {
    const contact = {
      id: crypto.randomUUID(),
      name: String(req.body.name || "").slice(0, 120),
      email: normalizeEmail(req.body.email),
      message: String(req.body.message || "").slice(0, 2000),
      createdAt: now()
    };
    await store.insert("contacts", contact);
    req.log?.("audit", {
      eventType: "contact_message_created",
      severity: "INFO",
      outcome: "success",
      actor: { userId: req.user?.id || null, userEmailHash: hashIdentifier(contact.email), authenticated: Boolean(req.user) },
      what: { contactId: contact.id, emailHash: hashIdentifier(contact.email) }
    });
    req.log?.("transaction_business", {
      eventType: "contact_lead_created",
      severity: "INFO",
      outcome: "success",
      actor: { userId: req.user?.id || null, userEmailHash: hashIdentifier(contact.email), authenticated: Boolean(req.user) },
      what: { contactId: contact.id }
    });
    req.log?.("user_behavior_analytics", {
      eventType: "contact_form_submitted",
      severity: "INFO",
      outcome: "success",
      actor: { userId: req.user?.id || null, userEmailHash: hashIdentifier(contact.email), authenticated: Boolean(req.user) },
      what: { contactId: contact.id }
    });
    res.status(201).json({ contact });
   } catch (error) {
     return next(error);
   }
  });

  // ---- Trust & Safety: reporting, DMCA, moderation, legal ----

  function requireAdmin(req, res, next) {
    if (!cfg.adminToken) {
      return res.status(503).json({ error: "Admin access is not configured. Set MIXFORGE_ADMIN_TOKEN." });
    }
    const provided = req.get("x-admin-token") || "";
    // Constant-time compare to avoid leaking the token via timing.
    const a = Buffer.from(provided);
    const b = Buffer.from(cfg.adminToken);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      req.log?.("security_threat", {
        eventType: "moderation_admin_auth_failed",
        severity: "WARN",
        outcome: "denied",
        what: { path: req.path }
      });
      return res.status(401).json({ error: "Admin authorization required." });
    }
    return next();
  }

  const REPORT_TARGETS = new Set(["recording", "community", "user"]);

  app.post("/api/reports", optionalUser, async (req, res, next) => {
    try {
      const targetType = String(req.body.targetType || "").trim();
      const targetId = String(req.body.targetId || "").trim();
      const reason = String(req.body.reason || "").trim().slice(0, 80);
      const details = String(req.body.details || "").slice(0, 2000);
      if (!REPORT_TARGETS.has(targetType) || !targetId || !reason) {
        return res.status(400).json({ error: "targetType, targetId, and reason are required." });
      }
      const report = {
        id: crypto.randomUUID(),
        userId: req.user ? req.user.id : null,
        targetType,
        targetId,
        reason,
        details,
        status: "open",
        createdAt: now()
      };
      await store.insert("reports", report);
      req.log?.("audit", {
        eventType: "content_reported",
        severity: "WARN",
        outcome: "success",
        actor: { userId: req.user?.id || null, userEmailHash: null, authenticated: Boolean(req.user) },
        what: { reportId: report.id, targetType, targetId, reason }
      });
      return res.status(201).json({ report: { id: report.id, status: report.status } });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/dmca", async (req, res, next) => {
    try {
      const required = ["claimantName", "claimantEmail", "targetType", "targetId", "workDescription"];
      for (const field of required) {
        if (typeof req.body[field] !== "string" || !req.body[field].trim()) {
          return res.status(400).json({ error: `Field '${field}' is required.` });
        }
      }
      if (req.body.goodFaith !== true || typeof req.body.signature !== "string" || !req.body.signature.trim()) {
        return res
          .status(400)
          .json({ error: "A good-faith statement (goodFaith: true) and an electronic signature are required." });
      }
      const takedown = {
        id: crypto.randomUUID(),
        claimantName: String(req.body.claimantName).slice(0, 160),
        claimantEmail: normalizeEmail(req.body.claimantEmail),
        targetType: String(req.body.targetType).trim(),
        targetId: String(req.body.targetId).trim(),
        workDescription: String(req.body.workDescription).slice(0, 4000),
        signature: String(req.body.signature).slice(0, 160),
        goodFaith: true,
        status: "received",
        createdAt: now()
      };
      // Auto-flag a targeted recording for review (reversible) pending human decision.
      if (takedown.targetType === "recording") {
        const target = await store.findById("recordings", takedown.targetId);
        if (target && target.moderationStatus !== "removed") {
          await store.update("recordings", target.id, { moderationStatus: "under_review" });
        }
      }
      await store.insert("dmcaTakedowns", takedown);
      req.log?.("audit", {
        eventType: "dmca_takedown_received",
        severity: "WARN",
        outcome: "success",
        actor: { userId: null, userEmailHash: hashIdentifier(takedown.claimantEmail), authenticated: false },
        what: { takedownId: takedown.id, targetType: takedown.targetType, targetId: takedown.targetId }
      });
      return res.status(201).json({
        takedown: { id: takedown.id, status: takedown.status },
        message: "DMCA notice received. Targeted content is under review pending our designated agent's decision."
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/legal/terms", (_req, res) => {
    res.json({
      updatedAt: "2026-07-01",
      terms:
        "By using MixForge you agree to upload or import only audio you own or are licensed to use. " +
        "You are solely responsible for the rights to content you record, upload, or import by link.",
      acceptableUse: [
        "Do not upload or import content you do not have the rights to.",
        "Do not use MixForge to infringe copyright or distribute unlicensed material.",
        "Imported links are fetched by our stem provider on your behalf and are your responsibility."
      ],
      reportContact: "Report content via POST /api/reports or email abuse@mixforge.live."
    });
  });

  app.get("/api/legal/dmca", (_req, res) => {
    res.json({
      policy:
        "MixForge complies with the DMCA. Rights holders may submit a takedown notice; targeted content is placed " +
        "under review and removed if the notice is valid. Repeat infringers are terminated.",
      designatedAgentEmail: cfg.dmcaAgentEmail,
      submit: "POST /api/dmca with claimantName, claimantEmail, targetType, targetId, workDescription, goodFaith:true, signature."
    });
  });

  app.get("/api/moderation/reports", requireAdmin, async (_req, res, next) => {
    try {
      res.json({ reports: await store.list("reports") });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/moderation/dmca", requireAdmin, async (_req, res, next) => {
    try {
      res.json({ takedowns: await store.list("dmcaTakedowns") });
    } catch (error) {
      next(error);
    }
  });

  const MODERATION_STATES = new Set(["active", "flagged", "under_review", "removed"]);

  app.post("/api/moderation/recordings/:id/status", requireAdmin, async (req, res, next) => {
    try {
      const status = String(req.body.status || "").trim();
      if (!MODERATION_STATES.has(status)) {
        return res.status(400).json({ error: `status must be one of: ${[...MODERATION_STATES].join(", ")}` });
      }
      const recording = await store.findById("recordings", req.params.id);
      if (!recording) {
        return res.status(404).json({ error: "Recording not found." });
      }
      const updated = await store.update("recordings", recording.id, { moderationStatus: status });
      req.log?.("audit", {
        eventType: "recording_moderation_status_changed",
        severity: status === "removed" ? "WARN" : "INFO",
        outcome: "success",
        what: { recordingId: recording.id, from: recording.moderationStatus, to: status }
      });
      return res.json({ recording: publicRecording(updated) });
    } catch (error) {
      return next(error);
    }
  });

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      req.log?.("access_authorization", {
        eventType: "api_route_not_found",
        severity: "WARN",
        outcome: "failure",
        what: { path: req.path }
      });
      return res.status(404).json({ error: "API route not found." });
    }
    return res.sendFile(path.join(cfg.publicDir, "index.html"));
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      _req.log?.("security_threat", {
        eventType: "upload_validation_failed",
        severity: "WARN",
        outcome: "failure",
        what: { code: error.code },
        error
      });
      return res.status(400).json({ error: error.message });
    }

    // Boundary parse/size failures from express.json (malformed body, oversized
    // payload) carry a 4xx status. Surface them as client errors instead of
    // masking them behind a generic 500.
    const boundaryStatus = Number(error.status || error.statusCode);
    if (Number.isInteger(boundaryStatus) && boundaryStatus >= 400 && boundaryStatus < 500) {
      _req.log?.("security_threat", {
        eventType: "request_body_validation_failed",
        severity: "WARN",
        outcome: "failure",
        what: { status: boundaryStatus, type: error.type || null },
        error
      });
      return res.status(boundaryStatus).json({ error: error.message || "Invalid request." });
    }

    _req.log?.("error", {
      eventType: "unhandled_backend_error",
      severity: "ERROR",
      outcome: "failure",
      error
    });
    console.error(error);
    return res.status(500).json({ error: "Unexpected MixForge backend error." });
  });

  return app;
}

export { PLAN_CATALOG };
