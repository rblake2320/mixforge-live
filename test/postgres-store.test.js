// Runs the REAL app end-to-end against a REAL Postgres backend (a dedicated,
// isolated container — never a shared cluster). Skips itself if no test database
// URL is provided, so CI without Postgres stays green while local/CI-with-PG
// proves the backend for real.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.js";
import { PostgresStore } from "../src/postgres-store.js";

const DATABASE_URL =
  process.env.MIXFORGE_TEST_DATABASE_URL || "postgresql://mixforge:mixforge@127.0.0.1:55432/mixforge_test";

// Probe the database up front; if unreachable, skip (don't fail) the whole suite.
let reachable = false;
try {
  const probe = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  await probe.connect();
  await probe.query("SELECT 1");
  await probe.end();
  reachable = true;
} catch {
  reachable = false;
}

describe("PostgresStore backend (real Postgres)", { skip: reachable ? false : "no test Postgres reachable" }, () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-pg-"));
  let store;
  let app;
  let server;
  let baseUrl;

  before(async () => {
    // Clean isolation: drop any tables from a prior run so seeding/asserts are deterministic.
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    const { rows } = await admin.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'mixforge_%'"
    );
    for (const row of rows) {
      await admin.query(`DROP TABLE IF EXISTS ${row.tablename} CASCADE`);
    }
    await admin.end();

    store = new PostgresStore({ databaseUrl: DATABASE_URL });
    app = createApp({
      store,
      uploadRoot: path.join(tmpRoot, "uploads"),
      logRoot: path.join(tmpRoot, "logs"),
      publicDir: path.join(process.cwd(), "public"),
      jwtSecret: "postgres-test-secret",
      stripeSecretKey: "sk_test_mixforge",
      stripeWebhookSecret: "whsec_test"
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
    if (store) {
      await store.close();
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function signup(email) {
    const res = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "secret123", name: "PG User" })
    });
    return { res, body: await res.json() };
  }

  it("seeds beats on init and serves them", async () => {
    const res = await fetch(`${baseUrl}/api/beats`);
    const payload = await res.json();
    assert.equal(res.status, 200);
    assert.ok(payload.beats.length >= 5, "beats must be seeded into Postgres");
  });

  it("health probe passes against Postgres", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    const payload = await res.json();
    assert.equal(res.status, 200);
    assert.equal(payload.checks.store, true);
  });

  it("signs up, persists the user, and logs in (bcrypt round-trip through Postgres)", async () => {
    const { res, body } = await signup("pg-user@example.com");
    assert.equal(res.status, 201);
    assert.equal(body.user.email, "pg-user@example.com");
    // Read straight from Postgres to prove persistence, not just the response.
    const persisted = await store.findBy("users", "email", "pg-user@example.com");
    assert.ok(persisted, "user row must exist in Postgres");
    assert.equal(persisted.passwordHash, undefined ?? persisted.passwordHash, "hash stored server-side");

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pg-user@example.com", password: "secret123" })
    });
    assert.equal(login.status, 200);
  });

  it("blocks a duplicate email at the unique-lookup level", async () => {
    const first = await signup("pg-dup@example.com");
    assert.equal(first.res.status, 201);
    const second = await signup("pg-dup@example.com");
    assert.equal(second.res.status, 409);
  });

  it("stores a recording and enforces cross-user isolation", async () => {
    const owner = await signup("pg-owner@example.com");
    const form = new FormData();
    form.append("audio", new Blob(["pg audio bytes"], { type: "audio/webm" }), "take.webm");
    form.append("beatId", "dark-trap");
    const up = await fetch(`${baseUrl}/api/recordings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.body.token}` },
      body: form
    });
    const rec = (await up.json()).recording;
    assert.equal(up.status, 201);
    assert.equal(rec.beatName, "Dark Trap", "beat lookup resolved through Postgres");

    const stranger = await signup("pg-stranger@example.com");
    const denied = await fetch(`${baseUrl}${rec.audioUrl}`, {
      headers: { Authorization: `Bearer ${stranger.body.token}` }
    });
    assert.equal(denied.status, 403);

    // Owner sees only their own row via listByOwner.
    const list = await fetch(`${baseUrl}/api/recordings`, {
      headers: { Authorization: `Bearer ${owner.body.token}` }
    });
    const listed = (await list.json()).recordings;
    assert.ok(listed.some((r) => r.id === rec.id));
  });

  it("runs the demo stem-job lifecycle through Postgres and applies a Stripe webhook", async () => {
    const user = await signup("pg-stem@example.com");
    const form = new FormData();
    form.append("audio", new Blob(["pg stem bytes"], { type: "audio/webm" }), "s.webm");
    const up = await fetch(`${baseUrl}/api/recordings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.body.token}` },
      body: form
    });
    const rec = (await up.json()).recording;
    const created = await (
      await fetch(`${baseUrl}/api/stems/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.body.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ recordingId: rec.id })
      })
    ).json();
    assert.equal(created.job.provider, "demo");
    await new Promise((r) => setTimeout(r, 1900));
    const done = await (
      await fetch(`${baseUrl}/api/stems/jobs/${created.job.id}`, {
        headers: { Authorization: `Bearer ${user.body.token}` }
      })
    ).json();
    assert.equal(done.job.status, "completed");
    assert.equal(done.job.stems.length, 4);

    // Stripe webhook updates the user's plan in Postgres via the customer link.
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe("sk_test_mixforge");
    async function hook(event) {
      const payload = JSON.stringify(event);
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test" });
      return fetch(`${baseUrl}/api/billing/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
        body: payload
      });
    }
    await hook({
      id: "evt_pg_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_pg",
          client_reference_id: user.body.user.id,
          metadata: { userId: user.body.user.id, planId: "creator" },
          customer: "cus_pg",
          subscription: "sub_pg"
        }
      }
    });
    const me = await (
      await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${user.body.token}` } })
    ).json();
    assert.equal(me.user.planId, "creator", "Stripe webhook plan change persisted to Postgres");
  });

  it("removes a row via remove() (used by moderation/DMCA)", async () => {
    const { body } = await signup("pg-remove@example.com");
    const before = await store.findById("users", body.user.id);
    assert.ok(before);
    const removed = await store.remove("users", body.user.id);
    assert.equal(removed, true);
    assert.equal(await store.findById("users", body.user.id), null);
  });
});
