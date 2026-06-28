import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import Stripe from "stripe";
import { StemSplit, webhooks as stemsplitWebhooks } from "@stemsplit/sdk";
import { attachUser, signToken, toPublicUser } from "./auth.js";
import { config as defaultConfig } from "./config.js";
import { JsonStore, now } from "./db.js";
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

function applyStripeCheckoutSession(store, session) {
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

function applyStripeSubscription(store, cfg, subscription) {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (!customerId) {
    return null;
  }

  const user = store.find("users", (candidate) => candidate.stripeCustomerId === customerId);
  if (!user) {
    return null;
  }

  return store.update("users", user.id, {
    planId: subscriptionIsActive(subscription) ? subscriptionPlanId(cfg, subscription) : "free",
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id || user.stripeSubscriptionId || null,
    stripeSubscriptionStatus: subscription.status || null,
    currentPeriodEnd: unixToIso(subscription.current_period_end)
  });
}

function applyStripeEvent(store, cfg, event) {
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

function audioFileFilter(_req, file, cb) {
  const allowedMime = file.mimetype?.startsWith("audio/") || file.mimetype === "video/webm";
  const allowedExt = [".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm"].includes(
    path.extname(file.originalname || "").toLowerCase()
  );
  if (allowedMime || allowedExt) {
    cb(null, true);
    return;
  }
  cb(new Error("Only audio uploads are supported."));
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
  if (!cfg.stemsplitApiKey) {
    return null;
  }
  return new StemSplit({ apiKey: cfg.stemsplitApiKey });
}

function refreshDemoStemJob(store, job) {
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
  if (!outputs) {
    return [];
  }
  return Object.entries(outputs).map(([type, output]) => ({
    type,
    status: "ready",
    url: output?.url || null,
    expiresAt: output?.expiresAt || null
  }));
}

async function refreshStemSplitJob(store, cfg, job) {
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

  const remote = await client.jobs.get(job.providerJobId);
  const status = mapStemSplitStatus(remote.status);
  return store.update("stemJobs", job.id, {
    status,
    progress: remote.raw?.progress ?? (status === "completed" ? 100 : job.progress),
    completedAt: status === "completed" ? remote.raw?.completedAt || now() : job.completedAt || null,
    errorMessage: remote.errorMessage || null,
    stems: status === "completed" ? publicStemOutputs(remote.outputs) : job.stems
  });
}

export function createApp(overrides = {}) {
  const cfg = { ...defaultConfig, ...overrides };
  fs.mkdirSync(cfg.uploadRoot, { recursive: true });
  const recordingUploadDir = path.join(cfg.uploadRoot, "recordings");
  const stemUploadDir = path.join(cfg.uploadRoot, "stems");
  fs.mkdirSync(recordingUploadDir, { recursive: true });
  fs.mkdirSync(stemUploadDir, { recursive: true });

  const store = overrides.store || new JsonStore(cfg.dataFile);
  const app = express();
  app.locals.store = store;
  app.locals.config = cfg;
  app.set("trust proxy", cfg.isProduction ? 1 : false);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false
    })
  );
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
    (req, res) => {
      if (!cfg.stripeSecretKey || !cfg.stripeWebhookSecret) {
        return res.status(501).json({ error: "Stripe webhook is not configured." });
      }

      const stripe = new Stripe(cfg.stripeSecretKey);
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature"), cfg.stripeWebhookSecret);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      store.insert("payments", {
        id: crypto.randomUUID(),
        provider: "stripe",
        eventType: event.type,
        payloadId: event.id,
        objectId: event.data?.object?.id || null,
        createdAt: now()
      });
      const updatedUser = applyStripeEvent(store, cfg, event);
      return res.json({ received: true, updatedUserId: updatedUser?.id || null });
    }
  );

  app.post(
    "/api/stems/webhook",
    express.raw({ type: "*/*" }),
    (req, res) => {
      if (!cfg.stemsplitWebhookSecret) {
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
          return res.json({ received: true, ignored: true });
        }

        const localJob = store.find("stemJobs", (candidate) => candidate.providerJobId === providerJobId);
        if (!localJob) {
          return res.json({ received: true, matched: false });
        }

        const eventName = event.event || "";
        if (eventName === "job.completed") {
          store.update("stemJobs", localJob.id, {
            status: "completed",
            progress: 100,
            completedAt: now(),
            stems: publicStemOutputs(event.data?.outputs)
          });
        } else if (eventName === "job.failed" || eventName === "job.expired") {
          store.update("stemJobs", localJob.id, {
            status: "failed",
            errorMessage: event.data?.errorMessage || eventName
          });
        }

        return res.json({ received: true, matched: true });
      } catch {
        return res.status(401).json({ error: "Invalid StemSplit webhook signature." });
      }
    }
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    "/api/auth",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 40,
      standardHeaders: true,
      legacyHeaders: false
    })
  );
  app.use(
    ["/api/recordings", "/api/stems/jobs", "/api/billing/checkout"],
    rateLimit({
      windowMs: 60 * 1000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false
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

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "mixforge-backend",
      version: "0.1.0",
      storage: "local-json",
      dataRoot: cfg.dataRoot,
      timestamp: now()
    });
  });

  app.get("/api/readiness", (_req, res) => {
    const readiness = evaluateReadiness(cfg);
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });

  app.get("/api/diagnostics", (_req, res) => {
    res.json(evaluateReadiness(cfg));
  });

  app.post("/api/auth/signup", async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || "");
      const name = String(req.body.name || email.split("@")[0] || "Creator").trim();

      if (!email.includes("@")) {
        return res.status(400).json({ error: "A valid email is required." });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters." });
      }
      if (store.find("users", (user) => user.email === email)) {
        return res.status(409).json({ error: "That email already has a MixForge account." });
      }

      const user = {
        id: crypto.randomUUID(),
        email,
        name,
        passwordHash: await bcrypt.hash(password, 12),
        planId: "free",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionStatus: null,
        currentPeriodEnd: null,
        createdAt: now(),
        updatedAt: now()
      };

      store.insert("users", user);
      return res.status(201).json({
        user: toPublicUser(user),
        token: signToken(user, cfg.jwtSecret)
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || "");
      const user = store.find("users", (candidate) => candidate.email === email);

      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        return res.status(401).json({ error: "Incorrect email or password." });
      }

      return res.json({
        user: toPublicUser(user),
        token: signToken(user, cfg.jwtSecret)
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/me", requiredUser, (req, res) => {
    res.json({ user: toPublicUser(req.user) });
  });

  app.get("/api/beats", (_req, res) => {
    res.json({ beats: store.list("beats") });
  });

  app.get("/api/community", (_req, res) => {
    res.json({ tracks: store.list("community") });
  });

  app.post("/api/recordings", optionalUser, recordingUpload.single("audio"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Upload an audio file in the 'audio' form field." });
    }

    const activeBeat = store.find("beats", (beat) => beat.id === req.body.beatId);
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
      filePath: path.relative(cfg.uploadRoot, req.file.path).replaceAll("\\", "/"),
      createdAt: now(),
      updatedAt: now()
    };

    store.insert("recordings", recording);
    return res.status(201).json({ recording: publicRecording(recording) });
  });

  app.get("/api/recordings", optionalUser, (req, res) => {
    const recordings = store
      .list("recordings")
      .filter((recording) => !req.user || recording.userId === req.user.id || recording.userId === null)
      .map(publicRecording);
    res.json({ recordings });
  });

  app.get("/api/recordings/:id/audio", optionalUser, (req, res, next) => {
    try {
      const recording = store.find("recordings", (candidate) => candidate.id === req.params.id);
      if (!recording) {
        return res.status(404).json({ error: "Recording not found." });
      }
      if (!canAccessOwnedRecord(recording, req.user)) {
        return res.status(403).json({ error: "Recording access denied." });
      }
      const fullPath = ensureInside(cfg.uploadRoot, recording.filePath);
      res.type(recording.mimeType);
      return res.sendFile(fullPath);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/projects", optionalUser, (req, res) => {
    const recording = req.body.recordingId
      ? store.find("recordings", (candidate) => candidate.id === req.body.recordingId)
      : null;
    if (recording && !canAccessOwnedRecord(recording, req.user)) {
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

    store.insert("projects", project);
    return res.status(201).json({ project });
  });

  app.get("/api/projects", optionalUser, (req, res) => {
    const projects = store
      .list("projects")
      .filter((project) => !req.user || project.userId === req.user.id || project.userId === null);
    res.json({ projects });
  });

  app.post("/api/stems/jobs", optionalUser, stemUpload.single("track"), (req, res) => {
    const recording = req.body.recordingId
      ? store.find("recordings", (candidate) => candidate.id === req.body.recordingId)
      : null;

    const sourcePath = req.file
      ? req.file.path
      : recording?.filePath
        ? ensureInside(cfg.uploadRoot, recording.filePath)
        : null;
    if (recording && !canAccessOwnedRecord(recording, req.user)) {
      return res.status(403).json({ error: "Recording access denied." });
    }
    if (!sourcePath) {
      return res.status(400).json({ error: "Upload audio or select a recording before creating a stem job." });
    }
    if (!cfg.stemsplitApiKey && !cfg.demoMode) {
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
      sourceName: String(req.body.sourceName || req.file?.originalname || recording?.title || "Mashup Source").slice(0, 160),
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

    store.insert("stemJobs", job);

    if (job.provider === "demo") {
      return res.status(202).json({ mode: "demo", job: publicStemJob(job) });
    }

    const client = stemsplitClient(cfg);
    return client.jobs
      .create({
        audio: sourcePath,
        outputType: "FOUR_STEMS",
        quality: "BALANCED",
        outputFormat: "MP3",
        metadata: {
          mixforgeJobId: job.id,
          userId: job.userId,
          sourceName: job.sourceName
        }
      })
      .then((remote) => {
        const updated = store.update("stemJobs", job.id, {
          providerJobId: remote.id,
          status: mapStemSplitStatus(remote.status),
          progress: remote.raw?.progress ?? 10,
          stems: publicStemOutputs(remote.outputs),
          externalCreatedAt: remote.raw?.createdAt || null
        });
        return res.status(202).json({ job: publicStemJob(updated) });
      })
      .catch((error) => {
        const failed = store.update("stemJobs", job.id, {
          status: "failed",
          errorMessage: error.message
        });
        return res.status(502).json({
          error: "StemSplit job creation failed.",
          detail: error.message,
          job: publicStemJob(failed)
        });
      });
  });

  app.get("/api/stems/jobs/:id", optionalUser, async (req, res, next) => {
    const job = store.find("stemJobs", (candidate) => candidate.id === req.params.id);
    if (!job) {
      return res.status(404).json({ error: "Stem job not found." });
    }
    if (job.userId && job.userId !== req.user?.id) {
      return res.status(403).json({ error: "Stem job access denied." });
    }
    try {
      const refreshed =
        job.provider === "stemsplit"
          ? await refreshStemSplitJob(store, cfg, job)
          : job.provider === "demo"
            ? refreshDemoStemJob(store, job)
          : store.update("stemJobs", job.id, {
              status: "failed",
              errorMessage: `Unsupported stem provider: ${job.provider || "unknown"}`
            });
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
        return res.status(400).json({ error: "Unknown plan." });
      }

      if (plan.id === "free") {
        if (req.user) {
          store.update("users", req.user.id, { planId: "free" });
        }
        return res.json({ mode: "free", plan, message: "Free plan is active." });
      }

      const priceId = cfg.stripePrices[plan.id];
      if (plan.id !== "free" && !req.user) {
        return res.status(401).json({ error: "Authentication is required for paid checkout." });
      }
      if (!cfg.stripeSecretKey || !priceId) {
        if (!cfg.demoMode) {
          return res.status(503).json({ error: "Stripe checkout is not configured." });
        }
        return res.json({
          mode: "demo",
          plan,
          checkoutUrl: null,
          message: "Demo checkout only. Stripe is not configured, so no paid plan was activated.",
          diagnostic:
            "Configure STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and the Stripe price IDs to open real Checkout."
        });
      }
      if (cfg.stripeSecretKey && priceId) {
        const stripe = new Stripe(cfg.stripeSecretKey);
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

        const session = await stripe.checkout.sessions.create(checkoutSession);

        store.insert("payments", {
          id: crypto.randomUUID(),
          userId: req.user ? req.user.id : null,
          provider: "stripe",
          planId: plan.id,
          checkoutSessionId: session.id,
          status: "created",
          createdAt: now()
        });

        return res.json({ mode: "stripe", plan, checkoutUrl: session.url });
      }
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/contact", (req, res) => {
    const contact = {
      id: crypto.randomUUID(),
      name: String(req.body.name || "").slice(0, 120),
      email: normalizeEmail(req.body.email),
      message: String(req.body.message || "").slice(0, 2000),
      createdAt: now()
    };
    store.insert("contacts", contact);
    res.status(201).json({ contact });
  });

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "API route not found." });
    }
    return res.sendFile(path.join(cfg.publicDir, "index.html"));
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: "Unexpected MixForge backend error." });
  });

  return app;
}

export { PLAN_CATALOG };
