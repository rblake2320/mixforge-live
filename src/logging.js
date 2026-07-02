import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const LOG_TYPES = {
  audit: {
    tier: "must",
    file: "audit.jsonl",
    description: "State mutations, access changes, sensitive reads, imports, exports, and configuration changes."
  },
  error: {
    tier: "must",
    file: "error.jsonl",
    description: "Runtime exceptions, provider failures, connectivity failures, and user-impacting faults."
  },
  security_threat: {
    tier: "must",
    file: "security-threat.jsonl",
    description: "Attack-pattern signals, validation failures, suspicious payloads, and webhook signature failures."
  },
  access_authorization: {
    tier: "must",
    file: "access-authorization.jsonl",
    description: "401/403/429 outcomes, token validation results, and access denials."
  },
  trace_span: {
    tier: "must",
    file: "trace-span.jsonl",
    description: "Root request spans and child spans for provider calls and multi-step workflows."
  },
  authentication: {
    tier: "must",
    file: "authentication.jsonl",
    description: "Raw signup, login, logout, session, MFA, and token events."
  },
  system_infrastructure: {
    tier: "must",
    file: "system-infrastructure.jsonl",
    description: "Startup, shutdown, process, storage, disk, and infrastructure events."
  },
  performance_availability: {
    tier: "should",
    file: "performance-availability.jsonl",
    description: "Latency, timeout, resource exhaustion, restart, and degradation events."
  },
  transaction_business: {
    tier: "should",
    file: "transaction-business.jsonl",
    description: "Business workflow transitions such as recording, project, checkout, and stem job state changes."
  },
  change_deployment: {
    tier: "should",
    file: "change-deployment.jsonl",
    description: "Deployments, release metadata, config changes, feature flags, and infra mutations."
  },
  dependency_external: {
    tier: "should",
    file: "dependency-external.jsonl",
    description: "Outbound provider calls, webhook events, API latency, status, and errors."
  },
  rate_limiting_throttle: {
    tier: "should",
    file: "rate-limiting-throttle.jsonl",
    description: "Rate limiting and throttling outcomes."
  },
  api_gateway: {
    tier: "should",
    file: "api-gateway.jsonl",
    description: "Ingress and egress request boundary records."
  },
  session: {
    tier: "should",
    file: "session.jsonl",
    description: "Session creation, validation, expiration, invalidation, and anomalous JWT events."
  },
  data_access_query: {
    tier: "nice",
    file: "data-access-query.jsonl",
    description: "Sensitive data reads, query latency, and slow query records."
  },
  feature_flag_config: {
    tier: "nice",
    file: "feature-flag-config.jsonl",
    description: "Feature flag and runtime config toggles that can alter behavior."
  },
  user_behavior_analytics: {
    tier: "nice",
    file: "user-behavior-analytics.jsonl",
    description: "Product analytics and funnel behavior events."
  },
  health_check_heartbeat: {
    tier: "nice",
    file: "health-check-heartbeat.jsonl",
    description: "Liveness/readiness probe outcomes."
  },
  agent_decision_reasoning: {
    tier: "should",
    file: "agent-decision-reasoning.jsonl",
    description: "Agent prompts, outputs, selected action, rationale metadata, and handoff events."
  },
  tool_call: {
    tier: "should",
    file: "tool-call.jsonl",
    description: "Agent/tool invocation name, arguments, latency, permission, and outcome."
  },
  token_cost: {
    tier: "nice",
    file: "token-cost.jsonl",
    description: "Model, token, cost, retry, and budget threshold events."
  },
  quality_evaluation: {
    tier: "nice",
    file: "quality-evaluation.jsonl",
    description: "Schema validation, judge scores, safety checks, and prompt-version quality records."
  },
  debug_developer: {
    tier: "nice",
    file: "debug-developer.jsonl",
    description: "Developer-only diagnostic records. Keep disabled in production unless investigating an incident."
  }
};

const LOG_TYPE_NAMES = Object.keys(LOG_TYPES);
const LOG_LEVELS = new Set(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"]);

export function hashIdentifier(value) {
  if (!value) {
    return null;
  }
  return crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

export function redact(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (typeof value !== "object") {
    return value;
  }

  const redacted = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/password|secret|token|authorization|signature|api[_-]?key|webhook/i.test(key)) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = redact(nested);
    }
  }
  return redacted;
}

function safeJsonLine(record) {
  return `${JSON.stringify(record)}\n`;
}

function normalizeSeverity(severity) {
  const normalized = String(severity || "INFO").toUpperCase();
  return LOG_LEVELS.has(normalized) ? normalized : "INFO";
}

function normalizeOutcome(outcome) {
  return String(outcome || "unknown").toLowerCase();
}

export class JsonlLogStore {
  constructor({
    rootDir,
    serviceName = "mixforge-backend",
    serviceVersion = "0.1.0",
    retentionDays = 90,
    maxFileBytes = 25 * 1024 * 1024
  }) {
    this.rootDir = rootDir;
    this.serviceName = serviceName;
    this.serviceVersion = serviceVersion;
    this.retentionDays = retentionDays;
    this.maxFileBytes = maxFileBytes;
    // Buffered writes: log() appends to an in-memory queue per file and the
    // queue drains asynchronously, so request handlers never block on disk.
    this.pending = new Map();
    this.flushScheduled = false;
    this.writeChain = Promise.resolve();
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.writeManifest();
    for (const type of LOG_TYPE_NAMES) {
      this.touch(this.fileFor(type));
    }
    this.touch(path.join(this.rootDir, "all.jsonl"));
    this.pruneExpired();
  }

  fileFor(type) {
    const metadata = LOG_TYPES[type];
    if (!metadata) {
      throw new Error(`Unknown log type: ${type}`);
    }
    return path.join(this.rootDir, metadata.file);
  }

  touch(filePath) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "");
    }
  }

  rotatedName(filePath) {
    const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
    return filePath.replace(/\.jsonl$/, `.${stamp}.rotated.jsonl`);
  }

  rotateIfNeeded(filePath) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size < this.maxFileBytes) {
        return false;
      }
      fs.renameSync(filePath, this.rotatedName(filePath));
      fs.writeFileSync(filePath, "");
      this.pruneExpired();
      return true;
    } catch {
      // Missing file or a rotation race — the append below recreates it.
      return false;
    }
  }

  pruneExpired() {
    // Retention is enforced on ROTATED segments only; the live files always
    // keep the most recent window. Anything rotated out and older than
    // retentionDays is deleted.
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    let entries;
    try {
      entries = fs.readdirSync(this.rootDir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      if (!name.endsWith(".rotated.jsonl")) {
        continue;
      }
      const full = path.join(this.rootDir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        // File vanished between readdir and stat — nothing to prune.
      }
    }
    return removed;
  }

  enqueue(filePath, line) {
    if (!this.pending.has(filePath)) {
      this.pending.set(filePath, []);
    }
    this.pending.get(filePath).push(line);
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    const timer = setTimeout(() => {
      this.flushScheduled = false;
      this.flush().catch((error) => {
        console.error("JsonlLogStore flush failed:", error);
      });
    }, 20);
    timer.unref?.();
  }

  drainPending() {
    const batches = [];
    for (const [filePath, lines] of this.pending) {
      if (lines.length > 0) {
        batches.push([filePath, lines.join("")]);
      }
    }
    this.pending.clear();
    return batches;
  }

  flush() {
    // Serialize all disk writes on one chain so lines never interleave, while
    // callers (request handlers) never wait on this unless they opt in.
    this.writeChain = this.writeChain.then(async () => {
      for (const [filePath, chunk] of this.drainPending()) {
        this.rotateIfNeeded(filePath);
        await fs.promises.appendFile(filePath, chunk);
      }
    });
    return this.writeChain;
  }

  flushSync() {
    // Crash/shutdown path: drain whatever is buffered with blocking writes so
    // the final events (uncaught exception, shutdown) reach disk.
    for (const [filePath, chunk] of this.drainPending()) {
      this.rotateIfNeeded(filePath);
      fs.appendFileSync(filePath, chunk);
    }
  }

  writeManifest() {
    const manifest = {
      service: this.serviceName,
      version: this.serviceVersion,
      retentionDays: this.retentionDays,
      format: "jsonl",
      createdAt: new Date().toISOString(),
      requiredFields: [
        "timestamp",
        "traceId",
        "service",
        "version",
        "eventType",
        "logType",
        "severity",
        "outcome",
        "actor",
        "where",
        "what"
      ],
      logTypes: LOG_TYPES
    };
    fs.writeFileSync(path.join(this.rootDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  log(logType, event = {}) {
    if (!LOG_TYPES[logType]) {
      throw new Error(`Unknown log type: ${logType}`);
    }

    const record = {
      timestamp: new Date().toISOString(),
      traceId: event.traceId || crypto.randomUUID(),
      spanId: event.spanId || crypto.randomUUID(),
      parentSpanId: event.parentSpanId || null,
      service: event.service || this.serviceName,
      version: event.version || this.serviceVersion,
      eventType: event.eventType || logType,
      logType,
      severity: normalizeSeverity(event.severity),
      outcome: normalizeOutcome(event.outcome),
      actor: event.actor || { userId: null },
      where: event.where || {},
      what: event.what || {},
      details: redact(event.details || {}),
      durationMs: event.durationMs ?? null,
      error: event.error
        ? {
            name: event.error.name,
            message: event.error.message,
            stack: event.error.stack
          }
        : null
    };

    const line = safeJsonLine(record);
    this.enqueue(this.fileFor(logType), line);
    this.enqueue(path.join(this.rootDir, "all.jsonl"), line);
    return record;
  }

  health() {
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
      const probe = path.join(this.rootDir, `.mixforge-log-write-test-${Date.now()}`);
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
      return {
        ok: true,
        rootDir: this.rootDir,
        logTypes: LOG_TYPE_NAMES.length,
        retentionDays: this.retentionDays
      };
    } catch (error) {
      return {
        ok: false,
        rootDir: this.rootDir,
        error: error.message,
        logTypes: LOG_TYPE_NAMES.length,
        retentionDays: this.retentionDays
      };
    }
  }
}

export function requestActor(req) {
  return {
    userId: req.user?.id || null,
    userEmailHash: hashIdentifier(req.user?.email),
    authenticated: Boolean(req.user)
  };
}

export function requestWhere(req) {
  return {
    ip: req.ip || req.socket?.remoteAddress || null,
    method: req.method,
    path: req.originalUrl || req.url,
    routePath: req.route?.path || null,
    userAgent: req.get("user-agent") || null,
    origin: req.get("origin") || null,
    referer: req.get("referer") || null
  };
}

export function requestLoggerMiddleware(logStore, cfg) {
  return (req, res, next) => {
    const start = performance.now();
    const traceHeader = req.get("x-correlation-id") || req.get("x-request-id") || req.get("traceparent");
    req.traceId = traceHeader ? String(traceHeader).slice(0, 128) : crypto.randomUUID();
    req.spanId = crypto.randomUUID();
    req.log = (logType, event = {}) =>
      logStore.log(logType, {
        traceId: req.traceId,
        parentSpanId: req.spanId,
        actor: event.actor || requestActor(req),
        where: event.where || requestWhere(req),
        ...event
      });
    res.setHeader("x-correlation-id", req.traceId);

    res.on("finish", () => {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      const statusCode = res.statusCode;
      const outcome = statusCode >= 500 ? "failure" : statusCode >= 400 ? "denied" : "success";
      const severity = statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARN" : "INFO";
      const common = {
        eventType: "http_request_completed",
        severity,
        outcome,
        durationMs,
        what: {
          statusCode,
          contentLength: res.getHeader("content-length") || null
        }
      };

      if ((req.originalUrl || req.url).startsWith("/api/")) {
        req.log("trace_span", common);
        req.log("api_gateway", common);
      }

      if ([401, 403, 429].includes(statusCode) || statusCode >= 500) {
        req.log("access_authorization", {
          ...common,
          eventType: "http_access_exception"
        });
      }

      if (durationMs >= cfg.slowRequestMs || statusCode >= 500) {
        req.log("performance_availability", {
          ...common,
          eventType: statusCode >= 500 ? "http_error_availability_impact" : "slow_request"
        });
      }
    });

    next();
  };
}

export function timedDependency(req, serviceName, operation, fn) {
  const startedAt = performance.now();
  return Promise.resolve()
    .then(fn)
    .then((result) => {
      req.log("dependency_external", {
        eventType: "dependency_call_completed",
        severity: "INFO",
        outcome: "success",
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        what: { serviceName, operation }
      });
      req.log("trace_span", {
        eventType: "dependency_span_completed",
        severity: "INFO",
        outcome: "success",
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        what: { serviceName, operation }
      });
      return result;
    })
    .catch((error) => {
      req.log("dependency_external", {
        eventType: "dependency_call_failed",
        severity: "ERROR",
        outcome: "failure",
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        what: { serviceName, operation },
        error
      });
      throw error;
    });
}
