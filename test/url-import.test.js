// Tests for link/URL import into stem jobs. Two layers:
// 1. Demo mode (what runs locally) — pasting a link creates a labeled demo job.
// 2. Real mode — routing to the correct StemSplit resource is verified with an
//    INJECTED FAKE StemSplit client, declared in the final report. The real
//    StemSplit API cannot be reached without a key, so this double records
//    which resource/method each source kind hits and returns realistic shapes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";

// ---- Fake StemSplit client (test double for the unreachable external API) ----
function makeFakeStemSplit(calls) {
  const detail = (id) => ({
    id,
    status: "COMPLETED",
    progress: 100,
    completedAt: "2026-07-02T00:00:00.000Z",
    outputs: { vocals: { url: "https://cdn.test/v.mp3", expiresAt: null }, instrumental: { url: "https://cdn.test/i.mp3", expiresAt: null } }
  });
  return {
    jobs: {
      create(options) {
        calls.push({ resource: "jobs", method: "create", options });
        return Promise.resolve({ id: "job_url_1", status: "PENDING", raw: { progress: 5 }, outputs: null });
      },
      get(id) {
        calls.push({ resource: "jobs", method: "get", id });
        return Promise.resolve(detail(id));
      }
    },
    youtubeJobs: {
      create(url) {
        calls.push({ resource: "youtubeJobs", method: "create", url });
        return Promise.resolve({ id: "job_yt_1", status: "PENDING", progress: 5, outputs: ["vocals", "instrumental"] });
      },
      get(id) {
        calls.push({ resource: "youtubeJobs", method: "get", id });
        return Promise.resolve(detail(id));
      }
    },
    soundcloudJobs: {
      create(url) {
        calls.push({ resource: "soundcloudJobs", method: "create", url });
        return Promise.resolve({ id: "job_sc_1", status: "PENDING", progress: 5, outputs: null });
      },
      get(id) {
        calls.push({ resource: "soundcloudJobs", method: "get", id });
        return Promise.resolve(detail(id));
      }
    }
  };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-url-"));
const calls = [];
const app = createApp({
  dataFile: path.join(tmpRoot, "db.json"),
  uploadRoot: path.join(tmpRoot, "uploads"),
  logRoot: path.join(tmpRoot, "logs"),
  publicDir: path.join(process.cwd(), "public"),
  jwtSecret: "url-import-test-secret",
  // Force real (non-demo) mode with a fake client so routing is exercised.
  demoMode: false,
  stemsplitApiKey: "fake-key",
  stemsplitClientFactory: () => makeFakeStemSplit(calls)
});

// A separate demo-mode app (no key, demo on) for the labeled-demo path.
const demoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-url-demo-"));
const demoApp = createApp({
  dataFile: path.join(demoRoot, "db.json"),
  uploadRoot: path.join(demoRoot, "uploads"),
  logRoot: path.join(demoRoot, "logs"),
  publicDir: path.join(process.cwd(), "public"),
  jwtSecret: "url-import-demo-secret",
  demoMode: true
});

let server;
let baseUrl;
let demoServer;
let demoBaseUrl;
let token;
let demoToken;

async function signup(base, email) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", name: "URL" })
  });
  return (await res.json()).token;
}

before(async () => {
  await new Promise((r) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
  await new Promise((r) => {
    demoServer = demoApp.listen(0, "127.0.0.1", () => {
      demoBaseUrl = `http://127.0.0.1:${demoServer.address().port}`;
      r();
    });
  });
  token = await signup(baseUrl, "real@example.com");
  demoToken = await signup(demoBaseUrl, "demo@example.com");
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => demoServer.close(r));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(demoRoot, { recursive: true, force: true });
});

function createJob(base, tok, body) {
  return fetch(`${base}/api/stems/jobs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("stem job link import — validation", () => {
  it("rejects a non-http(s) URL", async () => {
    const res = await createJob(baseUrl, token, { sourceUrl: "ftp://evil.example/song.mp3" });
    assert.equal(res.status, 400);
  });

  it("rejects a javascript: URL", async () => {
    const res = await createJob(baseUrl, token, { sourceUrl: "javascript:alert(1)" });
    assert.equal(res.status, 400);
  });

  it("rejects a non-URL string", async () => {
    const res = await createJob(baseUrl, token, { sourceUrl: "just some text" });
    assert.equal(res.status, 400);
  });

  it("rejects an oversized URL", async () => {
    const huge = `https://example.com/${"a".repeat(3000)}.mp3`;
    const res = await createJob(baseUrl, token, { sourceUrl: huge });
    assert.equal(res.status, 400);
  });

  it("still 400s when no file, recording, or URL is given", async () => {
    const res = await createJob(baseUrl, token, { sourceName: "nothing" });
    assert.equal(res.status, 400);
  });
});

describe("stem job link import — real-mode routing (injected fake client)", () => {
  it("routes a YouTube link to youtubeJobs.create", async () => {
    calls.length = 0;
    const res = await createJob(baseUrl, token, { sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    const payload = await res.json();
    assert.equal(res.status, 202);
    assert.equal(payload.job.provider, "stemsplit");
    assert.equal(payload.job.sourceKind, "youtube");
    const create = calls.find((c) => c.method === "create");
    assert.equal(create.resource, "youtubeJobs");
    assert.equal(create.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("routes a youtu.be short link to youtubeJobs.create", async () => {
    calls.length = 0;
    const res = await createJob(baseUrl, token, { sourceUrl: "https://youtu.be/dQw4w9WgXcQ" });
    assert.equal(res.status, 202);
    assert.equal(calls.find((c) => c.method === "create").resource, "youtubeJobs");
  });

  it("routes a SoundCloud link to soundcloudJobs.create", async () => {
    calls.length = 0;
    const res = await createJob(baseUrl, token, { sourceUrl: "https://soundcloud.com/artist/track" });
    const payload = await res.json();
    assert.equal(res.status, 202);
    assert.equal(payload.job.sourceKind, "soundcloud");
    assert.equal(calls.find((c) => c.method === "create").resource, "soundcloudJobs");
  });

  it("routes a direct audio URL to jobs.create with sourceUrl", async () => {
    calls.length = 0;
    const res = await createJob(baseUrl, token, { sourceUrl: "https://cdn.example.com/song.mp3" });
    const payload = await res.json();
    assert.equal(res.status, 202);
    assert.equal(payload.job.sourceKind, "url");
    const create = calls.find((c) => c.method === "create");
    assert.equal(create.resource, "jobs");
    assert.equal(create.options.sourceUrl, "https://cdn.example.com/song.mp3");
    assert.equal(create.options.audio, undefined, "URL jobs must not send a local file path");
  });

  it("polls the matching resource for a youtube job and returns ready stems", async () => {
    calls.length = 0;
    const created = await (await createJob(baseUrl, token, { sourceUrl: "https://youtu.be/pollme" })).json();
    const jobId = created.job.id;
    const detail = await fetch(`${baseUrl}/api/stems/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const payload = await detail.json();
    assert.equal(detail.status, 200);
    assert.equal(payload.job.status, "completed");
    assert.ok(payload.job.stems.some((s) => s.type === "vocals" && s.url));
    assert.equal(calls.find((c) => c.method === "get").resource, "youtubeJobs", "must poll youtubeJobs, not jobs");
  });
});

describe("stem job link import — demo mode", () => {
  it("creates a labeled demo job from a YouTube link without calling any provider", async () => {
    const res = await createJob(demoBaseUrl, demoToken, {
      sourceUrl: "https://www.youtube.com/watch?v=demo123"
    });
    const payload = await res.json();
    assert.equal(res.status, 202);
    assert.equal(payload.mode, "demo");
    assert.equal(payload.job.provider, "demo");
    assert.equal(payload.job.sourceKind, "youtube");
    assert.match(payload.job.diagnostic, /Demo stem preview/);
    assert.match(payload.job.sourceName, /youtube\.com|demo123/i);
  });
});
