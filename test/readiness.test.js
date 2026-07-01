// Guards on the production readiness gate. The JWT-secret check must fail the
// gate for the code default, the .env.example placeholder, and any secret under
// 32 chars — booting production with a publicly-known signing key lets anyone
// forge sessions.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertMinimumProductionConfig, evaluateReadiness } from "../src/readiness.js";

const base = {
  jwtSecret: "a-genuinely-random-secret-value-over-32-chars",
  defaultJwtSecret: "mixforge-dev-secret-change-me",
  publicBaseUrl: "https://mixforge.example.com",
  dataRoot: "/data",
  uploadRoot: "/data/uploads",
  logRoot: "/data/logs",
  demoMode: false,
  isProduction: true,
  stripeSecretKey: "sk_live_x",
  stripeWebhookSecret: "whsec_x",
  stripePrices: { creator: "price_c", dj_pro: "price_d", label: "price_l" },
  stemsplitApiKey: "ss_key",
  stemsplitWebhookSecret: "ss_whsec"
};

function jwtCheck(cfg) {
  return evaluateReadiness(cfg).checks.find((c) => c.id === "jwt_secret");
}

describe("readiness JWT-secret guard", () => {
  it("rejects the code default secret", () => {
    assert.equal(jwtCheck({ ...base, jwtSecret: base.defaultJwtSecret }).ok, false);
  });

  it("rejects the .env.example placeholder secret", () => {
    assert.equal(jwtCheck({ ...base, jwtSecret: "replace-this-with-a-long-random-secret" }).ok, false);
  });

  it("rejects a too-short secret", () => {
    assert.equal(jwtCheck({ ...base, jwtSecret: "short" }).ok, false);
  });

  it("rejects an empty secret", () => {
    assert.equal(jwtCheck({ ...base, jwtSecret: "" }).ok, false);
  });

  it("accepts a unique random 32+ char secret", () => {
    assert.equal(jwtCheck(base).ok, true);
  });

  it("assertMinimumProductionConfig throws on the placeholder in production", () => {
    assert.throws(
      () => assertMinimumProductionConfig({ ...base, jwtSecret: "replace-this-with-a-long-random-secret" }),
      /JWT_SECRET/
    );
  });

  it("assertMinimumProductionConfig is a no-op in development", () => {
    assert.doesNotThrow(() =>
      assertMinimumProductionConfig({ ...base, isProduction: false, jwtSecret: base.defaultJwtSecret })
    );
  });

  it("a fully-configured production config is ready", () => {
    assert.equal(evaluateReadiness(base).ready, true);
  });
});
