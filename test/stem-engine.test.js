// Local stem engine integration: MixForge must treat a configured engine as a
// real provider — real mode, provider "local-engine", jobs created by upload
// against the engine's REST API, and status/outputs mapped on refresh. The
// engine here is a REAL http server speaking the engine's wire format (not a
// mocked client), so the StemEngineClient's fetch paths are exercised.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { StemEngineClient } from "../src/stem-engine-client.js";
import { evaluateReadiness } from "../src/readiness.js";
import { config as baseConfig } from "../src/config.js";

const engineState = {
  creates: [],
  job: null
};

// Minimal engine double implementing the real wire format.
const fakeEngine = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, model: "htdemucs", cudaAvailable: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/jobs") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      engineState.creates.push({
        contentType: req.headers["content-type"] || "",
        bytes: Buffer.concat(chunks).length
      });
      engineState.job = {
        id: "engine-job-1",
        status: "PENDING",
        progress: 0,
        outputs: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
        errorMessage: null
      };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(engineState.job));
    });
    return;
  }
  if (req.method === "GET" && req.url === "/v1/jobs/engine-job-1") {
    // Second look at the job: separation finished.
    engineState.job = {
      ...engineState.job,
      status: "COMPLETED",
      progress: 100,
      completedAt: new Date().toISOString(),
      outputs: {
        vocals: { url: "http://engine.local/v1/outputs/engine-job-1/vocals.wav", expiresAt: null },
        drums: { url: "http://engine.local/v1/outputs/engine-job-1/drums.wav", expiresAt: null },
        bass: { url: "http://engine.local/v1/outputs/engine-job-1/bass.wav", expiresAt: null },
        other: { url: "http://engine.local/v1/outputs/engine-job-1/other.wav", expiresAt: null }
      }
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(engineState.job));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ detail: "not found" }));
});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-engine-"));
let engineUrl;
let app;
let server;
let baseUrl;
let token;

before(async () => {
  await new Promise((r) => {
    fakeEngine.listen(0, "127.0.0.1", () => {
      engineUrl = `http://127.0.0.1:${fakeEngine.address().port}`;
      r();
    });
  });
  app = createApp({
    dataFile: path.join(tmpRoot, "db.json"),
    uploadRoot: path.join(tmpRoot, "uploads"),
    logRoot: path.join(tmpRoot, "logs"),
    publicDir: path.join(process.cwd(), "public"),
    jwtSecret: "stem-engine-test-secret",
    demoMode: false,
    stemEngineUrl: engineUrl
  });
  await new Promise((r) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
  const signup = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "engine@example.com", password: "secret123" })
  });
  token = (await signup.json()).token;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fakeEngine.close(r));
  await app.locals.logStore.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("local stem engine provider", () => {
  it("satisfies the stem-separation readiness check", () => {
    const readiness = evaluateReadiness({ ...baseConfig, stemEngineUrl: "http://127.0.0.1:9077" });
    const check = readiness.checks.find((c) => c.id === "stemsplit");
    assert.equal(check.ok, true, "engine URL must satisfy the stem readiness check");
    assert.equal(readiness.capabilities.stemSeparation, "local-engine");
  });

  it("readiness live-probes the engine: reachable passes, dead tunnel fails", async () => {
    const live = await (await fetch(`${baseUrl}/api/readiness`)).json();
    const liveCheck = live.checks.find((c) => c.id === "stem_engine_reachable");
    assert.ok(liveCheck, "readiness must include the live engine probe when configured");
    assert.equal(liveCheck.ok, true);
    assert.match(liveCheck.detail, /htdemucs/);

    // Same app pointed at a closed port: the probe must fail loudly.
    const deadTmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-engine-dead-"));
    const deadApp = createApp({
      dataFile: path.join(deadTmp, "db.json"),
      uploadRoot: path.join(deadTmp, "uploads"),
      logRoot: path.join(deadTmp, "logs"),
      publicDir: path.join(process.cwd(), "public"),
      jwtSecret: "stem-engine-dead-secret",
      demoMode: false,
      stemEngineUrl: "http://127.0.0.1:9"
    });
    const deadServer = deadApp.listen(0, "127.0.0.1");
    await new Promise((r) => deadServer.once("listening", r));
    try {
      const dead = await (
        await fetch(`http://127.0.0.1:${deadServer.address().port}/api/readiness`)
      ).json();
      const deadCheck = dead.checks.find((c) => c.id === "stem_engine_reachable");
      assert.equal(deadCheck.ok, false, "an unreachable engine must fail the probe");
      assert.match(deadCheck.detail, /unreachable|responded/i);
    } finally {
      await new Promise((r) => deadServer.close(r));
      await deadApp.locals.logStore.close();
      fs.rmSync(deadTmp, { recursive: true, force: true });
    }
  });

  it("runs a real-mode stem job through the engine's REST API", async () => {
    const form = new FormData();
    form.append("audio", new Blob(["engine test audio"], { type: "audio/wav" }), "song.wav");
    const upload = await fetch(`${baseUrl}/api/recordings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    const recording = (await upload.json()).recording;

    const create = await fetch(`${baseUrl}/api/stems/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId: recording.id, sourceName: "Engine Test" })
    });
    const created = await create.json();
    assert.equal(create.status, 202, JSON.stringify(created));
    assert.equal(created.job.provider, "local-engine");
    assert.equal(created.job.mode, "real");
    assert.equal(created.job.providerJobId, "engine-job-1");
    assert.equal(engineState.creates.length, 1, "the engine must receive exactly one create call");
    assert.match(engineState.creates[0].contentType, /multipart\/form-data/);
    assert.ok(engineState.creates[0].bytes > 0, "the audio bytes must actually be uploaded");

    const poll = await fetch(`${baseUrl}/api/stems/jobs/${created.job.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const polled = await poll.json();
    assert.equal(polled.job.status, "completed");
    assert.equal(polled.job.stems.length, 4);
    assert.ok(polled.job.stems.every((stem) => stem.url.includes("/v1/outputs/engine-job-1/")));
  });

  it("fails YouTube link imports loudly instead of pretending", async () => {
    const create = await fetch(`${baseUrl}/api/stems/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://www.youtube.com/watch?v=abc123" })
    });
    const payload = await create.json();
    assert.equal(create.status, 502);
    assert.match(payload.detail, /not supported by the local stem engine/i);
    assert.equal(payload.job.status, "failed");
  });

  it("client rejects streaming imports without any network call", async () => {
    const client = new StemEngineClient({ baseUrl: "http://127.0.0.1:1" });
    await assert.rejects(() => client.youtubeJobs.create("https://youtu.be/x"), /not supported/i);
    await assert.rejects(() => client.soundcloudJobs.create("https://soundcloud.com/x"), /not supported/i);
  });
});
