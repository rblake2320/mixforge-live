import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isProduction = process.env.NODE_ENV === "production";
const host = process.env.HOST || (isProduction ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.PORT || 4173);
const defaultDataRoot = isProduction ? "/data" : path.join(rootDir, "data");
const defaultJwtSecret = "mixforge-dev-secret-change-me";
const demoModeRaw = (process.env.MIXFORGE_DEMO_MODE ?? "").trim().toLowerCase();
const demoMode = demoModeRaw === "" ? !isProduction : ["1", "true", "yes", "on"].includes(demoModeRaw);

export const config = {
  rootDir,
  serviceName: "mixforge-backend",
  serviceVersion: "0.1.0",
  isProduction,
  publicDir: path.join(rootDir, "public"),
  host,
  port,
  demoMode,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
  dataRoot: process.env.MIXFORGE_DATA_ROOT || defaultDataRoot,
  dataFile: process.env.MIXFORGE_DATA_FILE || path.join(process.env.MIXFORGE_DATA_ROOT || defaultDataRoot, "mixforge-db.json"),
  uploadRoot: process.env.MIXFORGE_UPLOAD_ROOT || path.join(process.env.MIXFORGE_DATA_ROOT || defaultDataRoot, "uploads"),
  logRoot: process.env.MIXFORGE_LOG_ROOT || path.join(process.env.MIXFORGE_DATA_ROOT || defaultDataRoot, "logs"),
  logRetentionDays: Number(process.env.MIXFORGE_LOG_RETENTION_DAYS || 90),
  slowRequestMs: Number(process.env.MIXFORGE_SLOW_REQUEST_MS || 1000),
  jwtSecret: process.env.JWT_SECRET || defaultJwtSecret,
  defaultJwtSecret,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripePrices: {
    creator: process.env.STRIPE_PRICE_CREATOR || "",
    dj_pro: process.env.STRIPE_PRICE_DJ_PRO || "",
    label: process.env.STRIPE_PRICE_LABEL || ""
  },
  stemsplitApiKey: process.env.STEMSPLIT_API_KEY || "",
  stemsplitWebhookSecret: process.env.STEMSPLIT_WEBHOOK_SECRET || "",
  // Self-hosted stem engine (stem-engine/engine.py). When set, stem jobs run
  // on local GPU hardware instead of the hosted StemSplit provider.
  stemEngineUrl: process.env.STEM_ENGINE_URL || "",
  stemEngineApiKey: process.env.STEM_ENGINE_API_KEY || "",
  databaseUrl: process.env.DATABASE_URL || "",
  storeBackend: process.env.MIXFORGE_STORE || "",
  redisUrl: process.env.REDIS_URL || "",
  adminToken: process.env.MIXFORGE_ADMIN_TOKEN || "",
  dmcaAgentEmail: process.env.MIXFORGE_DMCA_AGENT_EMAIL || "dmca@mixforge.live",
  storageBackend: process.env.MIXFORGE_STORAGE || "",
  s3Bucket: process.env.S3_BUCKET || "",
  s3Prefix: process.env.S3_PREFIX || "uploads",
  s3Region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
  s3Endpoint: process.env.S3_ENDPOINT || "",
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || "",
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ""
};
