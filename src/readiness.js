import fs from "node:fs";
import path from "node:path";

function isHttpsOrLocal(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function checkStorageWritable(cfg) {
  const result = {
    ok: false,
    detail: cfg.dataRoot
  };

  try {
    fs.mkdirSync(cfg.dataRoot, { recursive: true });
    fs.mkdirSync(cfg.uploadRoot, { recursive: true });
    const probe = path.join(cfg.dataRoot, `.mixforge-write-test-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    result.ok = true;
  } catch (error) {
    result.detail = error.message;
  }

  return result;
}

function checkLogStorageWritable(cfg) {
  const result = {
    ok: false,
    detail: cfg.logRoot
  };

  try {
    fs.mkdirSync(cfg.logRoot, { recursive: true });
    const probe = path.join(cfg.logRoot, `.mixforge-log-write-test-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    result.ok = true;
  } catch (error) {
    result.detail = error.message;
  }

  return result;
}

function allStripeValuesConfigured(cfg) {
  return Boolean(
    cfg.stripeSecretKey &&
      cfg.stripeWebhookSecret &&
      cfg.stripePrices.creator &&
      cfg.stripePrices.dj_pro &&
      cfg.stripePrices.label
  );
}

function allStemSplitValuesConfigured(cfg) {
  return Boolean(cfg.stemsplitApiKey && cfg.stemsplitWebhookSecret);
}

export function evaluateReadiness(cfg) {
  const stripeConfigured = allStripeValuesConfigured(cfg);
  const stemsplitConfigured = allStemSplitValuesConfigured(cfg);
  const checks = [
    {
      id: "jwt_secret",
      label: "JWT secret is configured",
      required: true,
      ok: Boolean(cfg.jwtSecret && cfg.jwtSecret !== cfg.defaultJwtSecret && cfg.jwtSecret.length >= 32),
      detail: cfg.jwtSecret === cfg.defaultJwtSecret ? "Using development default JWT secret." : "Configured"
    },
    {
      id: "public_base_url",
      label: "Public base URL is HTTPS or local",
      required: true,
      ok: isHttpsOrLocal(cfg.publicBaseUrl),
      detail: cfg.publicBaseUrl
    },
    {
      id: "storage_writable",
      label: "Data and upload storage are writable",
      required: true,
      ...checkStorageWritable(cfg)
    },
    {
      id: "log_storage_writable",
      label: "Structured log storage is writable",
      required: true,
      ...checkLogStorageWritable(cfg)
    },
    {
      id: "demo_mode",
      label: "Demo mode is disabled for real launch readiness",
      required: true,
      ok: !cfg.demoMode,
      detail: cfg.demoMode
        ? "MIXFORGE_DEMO_MODE is enabled; demo flows are allowed but this is not real launch-ready."
        : "Disabled"
    },
    {
      id: "production_storage_path",
      label: "Production storage is mounted at /data",
      required: Boolean(cfg.isProduction),
      ok: !cfg.isProduction || path.resolve(cfg.dataRoot) === path.resolve("/data"),
      detail: cfg.dataRoot
    },
    {
      id: "stripe",
      label: "Stripe checkout and webhook are configured",
      required: true,
      ok: stripeConfigured,
      detail: stripeConfigured
        ? "Configured"
        : "Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_CREATOR, STRIPE_PRICE_DJ_PRO, STRIPE_PRICE_LABEL"
    },
    {
      id: "stemsplit",
      label: "StemSplit API and webhook are configured",
      required: true,
      ok: stemsplitConfigured,
      detail: stemsplitConfigured ? "Configured" : "Set STEMSPLIT_API_KEY and STEMSPLIT_WEBHOOK_SECRET"
    }
  ];

  const ready = checks.filter((check) => check.required).every((check) => check.ok);
  return {
    ready,
    mode: cfg.isProduction ? "production" : "development",
    demoMode: cfg.demoMode,
    publicBaseUrl: cfg.publicBaseUrl,
    dataRoot: cfg.dataRoot,
    logRoot: cfg.logRoot,
    capabilities: {
      auth: "real",
      recording: "real",
      fileStorage: "local-json-and-files",
      checkout: stripeConfigured ? "stripe" : cfg.demoMode ? "demo-disabled-payment" : "unavailable",
      stemSeparation: stemsplitConfigured ? "stemsplit" : cfg.demoMode ? "demo-preview" : "unavailable"
    },
    checks
  };
}

export function assertMinimumProductionConfig(cfg) {
  if (!cfg.isProduction) {
    return;
  }
  const readiness = evaluateReadiness(cfg);
  const jwtCheck = readiness.checks.find((check) => check.id === "jwt_secret");
  if (!jwtCheck?.ok) {
    throw new Error("Refusing to start production with the development JWT secret. Set JWT_SECRET.");
  }
}
