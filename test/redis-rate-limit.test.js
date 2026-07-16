// Verifies the rate limiter is backed by REAL Redis when REDIS_URL is set:
// the limit is enforced, and the count is visible in Redis under the mixforge
// namespace (proving it would hold across instances). Skips if no Redis.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Redis from "ioredis";
import { createApp } from "../src/app.js";
import { createRateLimitBackend } from "../src/rate-limit.js";

const REDIS_URL = process.env.MIXFORGE_TEST_REDIS_URL || "redis://127.0.0.1:56379";

let reachable = false;
let probe;
try {
  probe = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  await probe.connect();
  await probe.ping();
  reachable = true;
} catch {
  reachable = false;
}
if (probe) {
  probe.disconnect();
}

describe("Redis-backed rate limiter (real Redis)", { skip: reachable ? false : "no test Redis reachable" }, () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-redis-"));
  let backend;
  let app;
  let server;
  let baseUrl;
  let redis;

  before(async () => {
    redis = new Redis(REDIS_URL);
    // Clean any prior counters so the test is deterministic.
    const keys = await redis.keys("mixforge:rl:*");
    if (keys.length) {
      await redis.del(...keys);
    }
    backend = createRateLimitBackend({ redisUrl: REDIS_URL });
    app = createApp({
      dataFile: path.join(tmpRoot, "db.json"),
      uploadRoot: path.join(tmpRoot, "uploads"),
      logRoot: path.join(tmpRoot, "logs"),
      publicDir: path.join(process.cwd(), "public"),
      jwtSecret: "redis-rl-test-secret",
      rateLimitBackend: backend
    });
    await app.locals.storeReady;
    await new Promise((r) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        r();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((r) => server.close(r));
    }
    await backend?.close?.();
    const keys = await redis.keys("mixforge:rl:*");
    if (keys.length) {
      await redis.del(...keys);
    }
    redis.disconnect();
    await app?.locals.logStore.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("selects the Redis backend when REDIS_URL is set", () => {
    assert.equal(backend.kind, "redis");
  });

  it("enforces the auth limit (40/window) and tracks the count in Redis", async () => {
    // Fire 45 login attempts (limit is 40) from one client; some must be 429.
    const codes = [];
    for (let i = 0; i < 45; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com", password: "whatever" })
      });
      codes.push(res.status);
    }
    const limited = codes.filter((c) => c === 429).length;
    assert.ok(limited >= 1, `expected some 429s past the limit, got codes: ${codes.join(",")}`);

    // The counter must live in Redis under the mixforge namespace.
    const keys = await redis.keys("mixforge:rl:auth:*");
    assert.ok(keys.length >= 1, "auth rate-limit counter must be stored in Redis");
  });
});
