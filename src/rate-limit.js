import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import Redis from "ioredis";

// Builds the shared rate-limit backing store. With REDIS_URL set, limits are
// tracked in Redis so they hold ACROSS instances and survive restarts (the
// in-memory default resets per process and is per-instance). Keys are namespaced
// under `mixforge:rl:` so MixForge never collides with anything else on the
// Redis server.
export function createRateLimitBackend(cfg) {
  if (!cfg.redisUrl) {
    return { kind: "memory", client: null, async close() {} };
  }
  const client = new Redis(cfg.redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true
  });
  // Never let a Redis blip crash the process; express-rate-limit surfaces store
  // errors per-request and we log them at the app layer.
  client.on("error", () => {});
  return {
    kind: "redis",
    client,
    async close() {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
  };
}

export function buildLimiter({ windowMs, limit, prefix, backend, handler }) {
  const options = { windowMs, limit, standardHeaders: true, legacyHeaders: false, handler };
  if (backend?.kind === "redis" && backend.client) {
    options.store = new RedisStore({
      sendCommand: (...args) => backend.client.call(...args),
      prefix: `mixforge:rl:${prefix}:`
    });
  }
  return rateLimit(options);
}
