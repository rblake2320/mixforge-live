// Integration tests for two fixes:
// 1. /api/health is a real liveness probe — it must degrade to 503 when log
//    storage breaks instead of always reporting ok.
// 2. Stripe subscription renewal dates must survive API versions that report
//    current_period_end on the subscription ITEM instead of the subscription.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Stripe from "stripe";
import { createApp } from "../src/app.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-hs-"));
const logRoot = path.join(tmpRoot, "logs");
const app = createApp({
  dataFile: path.join(tmpRoot, "db.json"),
  uploadRoot: path.join(tmpRoot, "uploads"),
  logRoot,
  publicDir: path.join(process.cwd(), "public"),
  jwtSecret: "health-stripe-test-secret",
  stripeSecretKey: "sk_test_mixforge",
  stripeWebhookSecret: "whsec_test"
});

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await app.locals.logStore.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function signedWebhook(event) {
  const stripe = new Stripe("sk_test_mixforge");
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test" });
  return fetch(`${baseUrl}/api/billing/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: payload
  });
}

describe("Stripe item-level current_period_end", () => {
  it("captures the renewal date when Stripe reports it on the subscription item", async () => {
    const signup = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "period@example.com", password: "secret123", name: "Period" })
    });
    const signed = await signup.json();
    const userId = signed.user.id;

    // checkout.session.completed links the Stripe customer to the user.
    const checkout = await signedWebhook({
      id: "evt_checkout_period_test",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_period_test",
          object: "checkout.session",
          client_reference_id: userId,
          metadata: { userId, planId: "creator" },
          customer: "cus_period_test",
          subscription: "sub_period_test"
        }
      }
    });
    assert.equal(checkout.status, 200);

    // 2025+ API shape: current_period_end lives on the ITEM, not the subscription.
    const periodEndSeconds = 1893456000; // 2030-01-01T00:00:00Z
    const updated = await signedWebhook({
      id: "evt_sub_updated_period_test",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_period_test",
          object: "subscription",
          status: "active",
          customer: "cus_period_test",
          metadata: { planId: "creator" },
          items: { data: [{ id: "si_test", current_period_end: periodEndSeconds }] }
        }
      }
    });
    assert.equal(updated.status, 200);

    const me = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${signed.token}` }
    });
    const payload = await me.json();
    assert.equal(payload.user.planId, "creator");
    assert.equal(
      payload.user.currentPeriodEnd,
      new Date(periodEndSeconds * 1000).toISOString(),
      "item-level current_period_end must not be lost"
    );
  });
});

describe("/api/health as a real liveness probe", () => {
  it("reports 200 with per-check detail while healthy", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.checks, { store: true, logging: true });
    assert.equal(payload.store, "json", "health must report the active store backend");
    assert.equal(payload.uploads, "local", "health must report the active upload storage");
    assert.equal(payload.version, app.locals.config.serviceVersion);
  });

  it("degrades to 503 when log storage becomes unwritable", async () => {
    // Break log storage for real: replace the log directory with a plain file
    // so every mkdir/write inside it fails.
    await app.locals.logStore.flush();
    fs.rmSync(logRoot, { recursive: true, force: true });
    fs.writeFileSync(logRoot, "not a directory");
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const payload = await response.json();
      assert.equal(response.status, 503);
      assert.equal(payload.ok, false);
      assert.equal(payload.checks.logging, false);
      assert.equal(payload.checks.store, true, "store is still fine; only logging broke");
    } finally {
      // Restore so the shared after() teardown and later suites are unaffected.
      fs.rmSync(logRoot, { force: true });
      fs.mkdirSync(logRoot, { recursive: true });
    }
  });
});
