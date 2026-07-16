// Trust & Safety: content reports, DMCA takedown intake with auto-flagging,
// admin moderation (removal blocks audio access), and public legal endpoints.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";

const ADMIN_TOKEN = "test-admin-token-32-characters-long!";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-mod-"));
const app = createApp({
  dataFile: path.join(tmpRoot, "db.json"),
  uploadRoot: path.join(tmpRoot, "uploads"),
  logRoot: path.join(tmpRoot, "logs"),
  publicDir: path.join(process.cwd(), "public"),
  jwtSecret: "moderation-test-secret",
  adminToken: ADMIN_TOKEN
});

let server;
let baseUrl;

async function signup(email) {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", name: "Mod" })
  });
  return res.json();
}

async function uploadRecording(token) {
  const form = new FormData();
  form.append("audio", new Blob(["mod audio"], { type: "audio/webm" }), "take.webm");
  const res = await fetch(`${baseUrl}/api/recordings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  return (await res.json()).recording;
}

before(async () => {
  await new Promise((r) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await app.locals.logStore.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("content reporting", () => {
  it("accepts a valid report", async () => {
    const res = await fetch(`${baseUrl}/api/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetType: "recording", targetId: "abc", reason: "copyright" })
    });
    assert.equal(res.status, 201);
    assert.ok((await res.json()).report.id);
  });

  it("rejects a report with an invalid target type", async () => {
    const res = await fetch(`${baseUrl}/api/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetType: "spaceship", targetId: "x", reason: "y" })
    });
    assert.equal(res.status, 400);
  });
});

describe("DMCA takedown", () => {
  it("requires the good-faith statement and signature", async () => {
    const res = await fetch(`${baseUrl}/api/dmca`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        claimantName: "Rights Holder",
        claimantEmail: "rights@example.com",
        targetType: "recording",
        targetId: "abc",
        workDescription: "My song"
        // missing goodFaith + signature
      })
    });
    assert.equal(res.status, 400);
  });

  it("accepts a complete notice and auto-flags the targeted recording for review", async () => {
    const owner = await signup("dmca-owner@example.com");
    const rec = await uploadRecording(owner.token);
    assert.equal(rec.moderationStatus, "active");

    const res = await fetch(`${baseUrl}/api/dmca`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        claimantName: "Rights Holder",
        claimantEmail: "rights@example.com",
        targetType: "recording",
        targetId: rec.id,
        workDescription: "My copyrighted song",
        goodFaith: true,
        signature: "Rights Holder"
      })
    });
    assert.equal(res.status, 201);

    // Admin sees the recording is now under review.
    const list = await fetch(`${baseUrl}/api/moderation/dmca`, { headers: { "x-admin-token": ADMIN_TOKEN } });
    const { takedowns } = await list.json();
    assert.ok(takedowns.some((t) => t.targetId === rec.id));
  });
});

describe("admin moderation", () => {
  it("blocks moderation endpoints without the admin token", async () => {
    const res = await fetch(`${baseUrl}/api/moderation/reports`);
    assert.equal(res.status, 401);
  });

  it("removing a recording makes its audio return 410 even to the owner", async () => {
    const owner = await signup("mod-owner@example.com");
    const rec = await uploadRecording(owner.token);

    // Owner can fetch audio while active.
    const before = await fetch(`${baseUrl}${rec.audioUrl}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.equal(before.status, 200);

    // Admin removes it.
    const mod = await fetch(`${baseUrl}/api/moderation/recordings/${rec.id}/status`, {
      method: "POST",
      headers: { "x-admin-token": ADMIN_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "removed" })
    });
    assert.equal(mod.status, 200);

    // Now even the owner gets 410 Gone.
    const after = await fetch(`${baseUrl}${rec.audioUrl}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.equal(after.status, 410);
  });

  it("rejects an invalid moderation status", async () => {
    const owner = await signup("mod-bad@example.com");
    const rec = await uploadRecording(owner.token);
    const res = await fetch(`${baseUrl}/api/moderation/recordings/${rec.id}/status`, {
      method: "POST",
      headers: { "x-admin-token": ADMIN_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "banned-forever" })
    });
    assert.equal(res.status, 400);
  });
});

describe("diagnostics gating", () => {
  it("is open in development", async () => {
    const res = await fetch(`${baseUrl}/api/diagnostics`);
    assert.equal(res.status, 200);
  });

  it("requires the admin token in production", async () => {
    const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-mod-prod-"));
    const prodApp = createApp({
      isProduction: true,
      dataFile: path.join(prodRoot, "db.json"),
      uploadRoot: path.join(prodRoot, "uploads"),
      logRoot: path.join(prodRoot, "logs"),
      dataRoot: prodRoot,
      publicDir: path.join(process.cwd(), "public"),
      jwtSecret: "moderation-prod-secret-32-chars-long!",
      adminToken: ADMIN_TOKEN,
      demoMode: false
    });
    const prodServer = prodApp.listen(0, "127.0.0.1");
    await new Promise((r) => prodServer.once("listening", r));
    const prodUrl = `http://127.0.0.1:${prodServer.address().port}`;
    try {
      const anonymous = await fetch(`${prodUrl}/api/diagnostics`);
      assert.equal(anonymous.status, 401, "production diagnostics must reject anonymous callers");
      const admin = await fetch(`${prodUrl}/api/diagnostics`, { headers: { "x-admin-token": ADMIN_TOKEN } });
      assert.equal(admin.status, 200, "production diagnostics must allow the admin");
      const health = await fetch(`${prodUrl}/api/health`);
      assert.equal(health.status, 200, "health stays public for platform probes");
    } finally {
      await new Promise((r) => prodServer.close(r));
      await prodApp.locals.logStore.close();
      fs.rmSync(prodRoot, { recursive: true, force: true });
    }
  });
});

describe("legal endpoints", () => {
  it("serves terms and DMCA policy publicly", async () => {
    const terms = await fetch(`${baseUrl}/api/legal/terms`);
    assert.equal(terms.status, 200);
    assert.ok((await terms.json()).acceptableUse.length >= 1);

    const dmca = await fetch(`${baseUrl}/api/legal/dmca`);
    assert.equal(dmca.status, 200);
    assert.ok((await dmca.json()).designatedAgentEmail.includes("@"));
  });
});
