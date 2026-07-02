// Upload-storage abstraction. The local backend is the tested default and is
// exercised through the real audio-serve path. The S3 backend is verified only
// for selection/guard behavior here — a live S3 round-trip needs credentials
// and is called out in the report's "not tested" section.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { LocalFileStorage, S3FileStorage, createStorage } from "../src/storage.js";

describe("createStorage selection", () => {
  it("defaults to local when no S3 bucket is configured", () => {
    const s = createStorage({ uploadRoot: "/tmp/x" });
    assert.equal(s.kind, "local");
    assert.ok(s instanceof LocalFileStorage);
  });

  it("selects S3 when a bucket is set", () => {
    const s = createStorage({ s3Bucket: "mixforge-media", uploadRoot: "/tmp/x" });
    assert.equal(s.kind, "s3");
    assert.ok(s instanceof S3FileStorage);
  });

  it("selecting s3 without a bucket throws (no silent fallback)", () => {
    assert.throws(() => createStorage({ storageBackend: "s3", uploadRoot: "/tmp/x" }), /S3_BUCKET/);
  });

  it("the S3 backend's SDK dependencies resolve (config-ready, not vaporware)", async () => {
    const s = new S3FileStorage({ s3Bucket: "mixforge-media", s3Region: "us-east-1", uploadRoot: "/tmp/x" });
    // _load() imports @aws-sdk/client-s3 + presigner and builds the client with
    // no network call. Proves the S3 path is real code that will run once creds
    // and a bucket are provided.
    await s._load();
    assert.ok(s._client, "S3 client constructed");
    assert.equal(typeof s._sdk.getSignedUrl, "function");
    assert.equal(s.key("a/b.webm"), "uploads/a/b.webm");
  });
});

describe("LocalFileStorage", () => {
  let root;
  let storage;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-store-"));
    storage = new LocalFileStorage(root);
    fs.writeFileSync(path.join(root, "song.webm"), "audio");
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reports existence and treats a traversal path as not-found (safe)", async () => {
    assert.equal(await storage.exists("song.webm"), true);
    assert.equal(await storage.exists("missing.webm"), false);
    // A traversal attempt must never resolve to a real file outside the root.
    assert.equal(await storage.exists("../../etc/passwd"), false);
    // ensureInside itself rejects the unsafe path outright.
    assert.throws(() => storage.ensureInside("../../etc/passwd"), /Unsafe file path/);
  });

  it("removes a file", async () => {
    fs.writeFileSync(path.join(root, "temp.webm"), "x");
    await storage.remove("temp.webm");
    assert.equal(fs.existsSync(path.join(root, "temp.webm")), false);
  });
});

describe("audio serves through the storage abstraction end-to-end", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-store-e2e-"));
  const app = createApp({
    dataFile: path.join(tmpRoot, "db.json"),
    uploadRoot: path.join(tmpRoot, "uploads"),
    logRoot: path.join(tmpRoot, "logs"),
    publicDir: path.join(process.cwd(), "public"),
    jwtSecret: "storage-e2e-secret"
  });
  let server;
  let baseUrl;

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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("uses the local storage backend and serves uploaded audio bytes", async () => {
    assert.equal(app.locals.storage.kind, "local");
    const signup = await (
      await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "store@example.com", password: "secret123" })
      })
    ).json();
    const form = new FormData();
    form.append("audio", new Blob(["real audio payload"], { type: "audio/webm" }), "take.webm");
    const rec = (
      await (
        await fetch(`${baseUrl}/api/recordings`, {
          method: "POST",
          headers: { Authorization: `Bearer ${signup.token}` },
          body: form
        })
      ).json()
    ).recording;
    const audio = await fetch(`${baseUrl}${rec.audioUrl}`, { headers: { Authorization: `Bearer ${signup.token}` } });
    assert.equal(audio.status, 200);
    assert.equal((await audio.text()).length, "real audio payload".length);
  });
});
