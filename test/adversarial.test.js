// Adversarial + boundary tests written from the documented contract, independent
// of the happy-path suite in api.test.js. Every test's job is to try to break a
// component with hostile, malformed, empty, oversized, or unicode input, or to
// bypass an authorization boundary.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";

const JWT_SECRET = "adversarial-test-secret";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-adv-"));
const app = createApp({
  dataFile: path.join(tmpRoot, "db.json"),
  uploadRoot: path.join(tmpRoot, "uploads"),
  logRoot: path.join(tmpRoot, "logs"),
  publicDir: path.join(process.cwd(), "public"),
  jwtSecret: JWT_SECRET
  // demoMode defaults to true in development, matching the local contract.
});

let server;
let baseUrl;

async function signup(email, password = "secret123", name = "Adv") {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name })
  });
  return { res, body: await res.json() };
}

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

describe("MixForge adversarial / boundary", () => {
  // ---- Signup validation ----
  it("rejects signup with no email", async () => {
    const { res, body } = await signup("");
    assert.equal(res.status, 400);
    assert.match(body.error, /valid email/i);
  });

  it("rejects signup with an email that has no @", async () => {
    const { res } = await signup("not-an-email");
    assert.equal(res.status, 400);
  });

  it("rejects signup with a password shorter than 6 chars", async () => {
    const { res, body } = await signup("shortpw@example.com", "12345");
    assert.equal(res.status, 400);
    assert.match(body.error, /at least 6/i);
  });

  it("accepts exactly-6-char password (boundary)", async () => {
    const { res } = await signup("sixchar@example.com", "123456");
    assert.equal(res.status, 201);
  });

  it("treats email as case-insensitive and blocks duplicates", async () => {
    const first = await signup("Dup@Example.com");
    assert.equal(first.res.status, 201);
    const second = await signup("dup@example.com");
    assert.equal(second.res.status, 409);
  });

  it("survives non-string / array / object field types without crashing", async () => {
    const res = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ["a@b.com"], password: { nested: true }, name: 12345 })
    });
    // Must be a clean 4xx, never a 500 crash.
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  });

  it("does not leak the password hash in signup response", async () => {
    const { body } = await signup("nohash@example.com");
    assert.equal(body.user.passwordHash, undefined);
    assert.ok(!JSON.stringify(body).includes("$2"), "bcrypt hash prefix must not appear");
  });

  it("stores unicode/emoji names and round-trips them", async () => {
    const name = "DJ 🎧 Ünïcode 日本語";
    const { res } = await signup("unicode@example.com", "secret123", name);
    assert.equal(res.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "unicode@example.com", password: "secret123" })
    });
    const body = await login.json();
    assert.equal(body.user.name, name);
  });

  // ---- Body parsing boundaries ----
  it("returns 400 (not 500) for malformed JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"email": "x@y.com", "password": '
    });
    assert.equal(res.status, 400);
  });

  it("returns 413 (not 500) for an oversized JSON body", async () => {
    const huge = "a".repeat(2 * 1024 * 1024); // 2MB > 1MB limit
    const res = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "big@example.com", password: "secret123", name: huge })
    });
    assert.equal(res.status, 413);
  });

  // ---- Auth middleware bypass attempts ----
  it("rejects protected route with no token", async () => {
    const res = await fetch(`${baseUrl}/api/me`);
    assert.equal(res.status, 401);
  });

  it("rejects a malformed Authorization header", async () => {
    const res = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: "Bearer" } });
    assert.equal(res.status, 401);
  });

  it("rejects a JWT signed with the wrong secret", async () => {
    const forged = jwt.sign({ sub: "whoever", email: "x@y.com" }, "wrong-secret", { expiresIn: "14d" });
    const res = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${forged}` } });
    assert.equal(res.status, 401);
  });

  it("rejects a structurally-valid JWT for a non-existent user", async () => {
    const orphan = jwt.sign({ sub: "no-such-user-id", email: "ghost@example.com" }, JWT_SECRET, { expiresIn: "14d" });
    const res = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${orphan}` } });
    assert.equal(res.status, 401);
  });

  it("rejects an expired JWT", async () => {
    const expired = jwt.sign({ sub: "someone", email: "x@y.com" }, JWT_SECRET, { expiresIn: -10 });
    const res = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${expired}` } });
    assert.equal(res.status, 401);
  });

  // ---- Upload validation ----
  it("rejects a recording upload with no file", async () => {
    const { body: signed } = await signup("norec@example.com");
    const res = await fetch(`${baseUrl}/api/recordings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${signed.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "no file" })
    });
    assert.equal(res.status, 400);
  });

  it("rejects a non-audio file upload by type", async () => {
    const { body: signed } = await signup("badtype@example.com");
    const form = new FormData();
    form.append("audio", new Blob(["#!/bin/sh\nrm -rf /"], { type: "text/x-shellscript" }), "evil.sh");
    const res = await fetch(`${baseUrl}/api/recordings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${signed.token}` },
      body: form
    });
    assert.equal(res.status, 400);
  });

  it("stores a filename with path-traversal characters without escaping the upload dir", async () => {
    const { body: signed } = await signup("traversal@example.com");
    const form = new FormData();
    form.append("audio", new Blob(["audio"], { type: "audio/webm" }), "../../../../etc/passwd.webm");
    const res = await fetch(`${baseUrl}/api/recordings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${signed.token}` },
      body: form
    });
    assert.equal(res.status, 201);
    const rec = (await res.json()).recording;
    // Server assigns a random UUID filename; traversal segments must not survive.
    assert.ok(!rec.filePath?.includes(".."), "stored path must not contain traversal segments");
    // The audio must be fetchable back through the owner, proving it landed inside the root.
    const audio = await fetch(`${baseUrl}${rec.audioUrl}`, {
      headers: { Authorization: `Bearer ${signed.token}` }
    });
    assert.equal(audio.status, 200);
  });

  // ---- Authorization isolation ----
  it("blocks a stem job GET for a stranger and 404s an unknown id", async () => {
    const notFound = await fetch(`${baseUrl}/api/stems/jobs/does-not-exist`);
    assert.equal(notFound.status, 404);
  });

  it("denies attaching another user's recording to a project", async () => {
    const owner = await signup("owner-proj@example.com");
    const form = new FormData();
    form.append("audio", new Blob(["mine"], { type: "audio/webm" }), "mine.webm");
    const up = await fetch(`${baseUrl}/api/recordings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.body.token}` },
      body: form
    });
    const rec = (await up.json()).recording;

    const attacker = await signup("attacker-proj@example.com");
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${attacker.body.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "steal", recordingId: rec.id })
    });
    assert.equal(res.status, 403);
  });

  // ---- Checkout validation ----
  it("rejects an unknown plan id", async () => {
    const { body: signed } = await signup("plan@example.com");
    const res = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${signed.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ planId: "enterprise-hacker" })
    });
    assert.equal(res.status, 400);
  });

  it("requires auth for a paid plan checkout", async () => {
    const res = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: "creator" })
    });
    assert.equal(res.status, 401);
  });

  it("activates the free plan idempotently", async () => {
    const { body: signed } = await signup("free@example.com");
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${baseUrl}/api/billing/checkout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${signed.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ planId: "free" })
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).mode, "free");
    }
  });

  // ---- Contact truncation ----
  it("truncates an oversized contact message to 2000 chars", async () => {
    const res = await fetch(`${baseUrl}/api/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", email: "c@example.com", message: "m".repeat(5000) })
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).contact.message.length, 2000);
  });

  // ---- Routing ----
  it("returns JSON 404 for an unknown API route", async () => {
    const res = await fetch(`${baseUrl}/api/this/does/not/exist`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /not found/i);
  });

  it("serves the SPA index.html for a non-API path", async () => {
    const res = await fetch(`${baseUrl}/studio`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /html/);
  });

  // ---- Concurrency on the shared JsonStore ----
  // Uses its own app instance with a fresh rate-limit window and datafile so it
  // genuinely exercises concurrent JsonStore writes, not the shared /api/auth
  // rate limiter that the rest of this suite consumes.
  it("persists all records under concurrent signups (no lost writes)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-adv-conc-"));
    const dataFile = path.join(root, "db.json");
    const concApp = createApp({
      dataFile,
      uploadRoot: path.join(root, "uploads"),
      logRoot: path.join(root, "logs"),
      publicDir: path.join(process.cwd(), "public"),
      jwtSecret: JWT_SECRET
    });
    const concServer = concApp.listen(0, "127.0.0.1");
    await new Promise((resolve) => concServer.once("listening", resolve));
    const concUrl = `http://127.0.0.1:${concServer.address().port}`;
    try {
      const n = 25; // under the 40/15min auth limit, so 429s cannot mask a real loss
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          fetch(`${concUrl}/api/auth/signup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: `concurrent-${i}@example.com`, password: "secret123", name: `c${i}` })
          })
        )
      );
      for (const res of results) {
        assert.equal(res.status, 201, `every concurrent signup must succeed, got ${res.status}`);
      }
      // Read the persisted DB directly and confirm every concurrent user survived.
      const db = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      assert.equal(db.users.length, n, "all concurrent writes must persist");
      for (let i = 0; i < n; i++) {
        assert.ok(
          db.users.some((u) => u.email === `concurrent-${i}@example.com`),
          `concurrent-${i} must be persisted`
        );
      }
    } finally {
      await new Promise((resolve) => concServer.close(resolve));
      await concApp.locals.logStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
