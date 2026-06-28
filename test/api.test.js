import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Stripe from "stripe";
import { createApp } from "../src/app.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-test-"));
const app = createApp({
  dataFile: path.join(tmpRoot, "db.json"),
  uploadRoot: path.join(tmpRoot, "uploads"),
  publicDir: path.join(process.cwd(), "public"),
  jwtSecret: "test-secret",
  stripeSecretKey: "sk_test_mixforge",
  stripeWebhookSecret: "whsec_test"
});

async function withTempApp(overrides, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-test-app-"));
  const isolatedApp = createApp({
    dataFile: path.join(root, "db.json"),
    uploadRoot: path.join(root, "uploads"),
    publicDir: path.join(process.cwd(), "public"),
    jwtSecret: "isolated-test-secret",
    ...overrides
  });
  let isolatedServer;
  let isolatedBaseUrl;
  try {
    await new Promise((resolve) => {
      isolatedServer = isolatedApp.listen(0, "127.0.0.1", () => {
        const address = isolatedServer.address();
        isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    return await fn(isolatedBaseUrl);
  } finally {
    if (isolatedServer) {
      await new Promise((resolve) => isolatedServer.close(resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

let server;
let baseUrl;
let token;
let recordingId;
let userId;
let secondToken;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("MixForge API", () => {
  it("reports health", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
  });

  it("creates a user session", async () => {
    const response = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "artist@example.com", password: "secret123", name: "Artist" })
    });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.user.email, "artist@example.com");
    assert.ok(payload.token);
    token = payload.token;
    userId = payload.user.id;
  });

  it("lists seeded beats", async () => {
    const response = await fetch(`${baseUrl}/api/beats`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.ok(payload.beats.length >= 5);
  });

  it("stores an uploaded recording", async () => {
    const form = new FormData();
    form.append("audio", new Blob(["test audio bytes"], { type: "audio/webm" }), "take.webm");
    form.append("beatId", "dark-trap");
    form.append("preset", "Natural");
    form.append("durationSeconds", "3");

    const response = await fetch(`${baseUrl}/api/recordings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.recording.beatName, "Dark Trap");
    assert.ok(payload.recording.audioUrl);
    recordingId = payload.recording.id;
  });

  it("blocks another user from private recording audio", async () => {
    const signup = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "other@example.com", password: "secret123", name: "Other" })
    });
    const other = await signup.json();
    secondToken = other.token;

    const response = await fetch(`${baseUrl}/api/recordings/${recordingId}/audio`, {
      headers: { Authorization: `Bearer ${secondToken}` }
    });
    assert.equal(response.status, 403);
  });

  it("creates a project from a recording", async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ title: "First Take", recordingId, mode: "vocal" })
    });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.project.title, "First Take");
    assert.equal(payload.project.recordingId, recordingId);
  });

  it("runs the explicit demo stem-job lifecycle", async () => {
    const createResponse = await fetch(`${baseUrl}/api/stems/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ recordingId, sourceName: "Test Stem Job" })
    });
    const created = await createResponse.json();
    assert.equal(createResponse.status, 202);
    assert.equal(created.mode, "demo");
    assert.equal(created.job.provider, "demo");
    assert.equal(created.job.status, "queued");
    assert.match(created.job.diagnostic, /Demo stem preview/);

    await new Promise((resolve) => setTimeout(resolve, 1900));
    const completeResponse = await fetch(`${baseUrl}/api/stems/jobs/${created.job.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const completed = await completeResponse.json();
    assert.equal(completeResponse.status, 200);
    assert.equal(completed.job.status, "completed");
    assert.equal(completed.job.provider, "demo");
    assert.equal(completed.job.stems.length, 4);
    assert.match(completed.job.stems[0].note, /not AI-separated audio/);
  });

  it("blocks another user from private stem jobs", async () => {
    const createResponse = await fetch(`${baseUrl}/api/stems/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ recordingId, sourceName: "Private Stem Job" })
    });
    const created = await createResponse.json();
    assert.equal(createResponse.status, 202);

    const response = await fetch(`${baseUrl}/api/stems/jobs/${created.job.id}`, {
      headers: { Authorization: `Bearer ${secondToken}` }
    });
    assert.equal(response.status, 403);
  });

  it("returns explicit demo checkout without activating a paid plan", async () => {
    const response = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ planId: "creator" })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.mode, "demo");
    assert.equal(payload.plan.id, "creator");
    assert.match(payload.diagnostic, /Configure STRIPE_SECRET_KEY/);

    const meResponse = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const me = await meResponse.json();
    assert.equal(me.user.planId, "free");
  });

  it("fails paid checkout loudly when Stripe and demo mode are both unavailable", async () => {
    await withTempApp({ demoMode: false }, async (isolatedBaseUrl) => {
      const signup = await fetch(`${isolatedBaseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "stripe-required@example.com", password: "secret123", name: "Stripe Required" })
      });
      const signedUp = await signup.json();

      const response = await fetch(`${isolatedBaseUrl}/api/billing/checkout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signedUp.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ planId: "creator" })
      });
      const payload = await response.json();
      assert.equal(response.status, 503);
      assert.equal(payload.error, "Stripe checkout is not configured.");
    });
  });

  it("fails stem jobs loudly when StemSplit and demo mode are both unavailable", async () => {
    await withTempApp({ demoMode: false }, async (isolatedBaseUrl) => {
      const signup = await fetch(`${isolatedBaseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "stem-required@example.com", password: "secret123", name: "Stem Required" })
      });
      const signedUp = await signup.json();

      const form = new FormData();
      form.append("audio", new Blob(["real test upload bytes"], { type: "audio/webm" }), "take.webm");
      const upload = await fetch(`${isolatedBaseUrl}/api/recordings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${signedUp.token}` },
        body: form
      });
      const uploaded = await upload.json();

      const response = await fetch(`${isolatedBaseUrl}/api/stems/jobs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signedUp.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ recordingId: uploaded.recording.id, sourceName: "Stem Required" })
      });
      const payload = await response.json();
      assert.equal(response.status, 503);
      assert.equal(payload.error, "StemSplit is not configured.");
    });
  });

  it("applies signed Stripe checkout webhooks to user plans", async () => {
    const stripe = new Stripe("sk_test_mixforge");
    const event = {
      id: "evt_checkout_completed_test",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_mixforge",
          object: "checkout.session",
          client_reference_id: userId,
          metadata: { userId, planId: "creator" },
          customer: "cus_mixforge_test",
          subscription: "sub_mixforge_test"
        }
      }
    };
    const payload = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_test"
    });

    const response = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signature
      },
      body: payload
    });
    const webhookPayload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(webhookPayload.updatedUserId, userId);

    const meResponse = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const me = await meResponse.json();
    assert.equal(me.user.planId, "creator");
    assert.equal(me.user.stripeCustomerId, "cus_mixforge_test");
    assert.equal(me.user.stripeSubscriptionId, "sub_mixforge_test");
  });

  it("stores contact messages", async () => {
    const response = await fetch(`${baseUrl}/api/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Label Buyer",
        email: "buyer@example.com",
        message: "Interested in Label / Agency."
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.contact.email, "buyer@example.com");
    assert.equal(payload.contact.message, "Interested in Label / Agency.");
  });

  it("reports readiness status", async () => {
    const response = await fetch(`${baseUrl}/api/readiness`);
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.ready, false);
    assert.equal(payload.demoMode, true);
    assert.ok(payload.checks.some((check) => check.id === "demo_mode"));
    assert.ok(payload.checks.some((check) => check.id === "stripe"));
    assert.ok(payload.checks.some((check) => check.id === "stemsplit"));
  });
});
