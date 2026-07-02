// Unit tests for the JsonlLogStore durability mechanics: buffered async writes,
// flush/flushSync draining, size-based rotation, and retention pruning of
// rotated segments. These exist because retentionDays used to be declared but
// never enforced, and every log call used to block the event loop.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { JsonlLogStore, LOG_TYPES } from "../src/logging.js";

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-log-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function readLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  return raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
}

describe("JsonlLogStore durability", () => {
  it("buffers writes and lands them after flush()", async () => {
    const store = new JsonlLogStore({ rootDir: root });
    store.log("audit", { eventType: "buffered_event", outcome: "success" });
    await store.flush();
    const audit = readLines(path.join(root, LOG_TYPES.audit.file));
    assert.ok(audit.some((entry) => entry.eventType === "buffered_event"));
    const all = readLines(path.join(root, "all.jsonl"));
    assert.ok(all.some((entry) => entry.eventType === "buffered_event"));
  });

  it("drains buffered lines synchronously via flushSync() (crash path)", () => {
    const store = new JsonlLogStore({ rootDir: root });
    store.log("error", { eventType: "crash_event", severity: "CRITICAL", outcome: "failure" });
    store.flushSync();
    const errors = readLines(path.join(root, LOG_TYPES.error.file));
    assert.ok(errors.some((entry) => entry.eventType === "crash_event"));
  });

  it("preserves write order across many buffered events", async () => {
    const store = new JsonlLogStore({ rootDir: root });
    for (let i = 0; i < 50; i++) {
      store.log("audit", { eventType: `ordered_${i}`, outcome: "success" });
    }
    await store.flush();
    const audit = readLines(path.join(root, LOG_TYPES.audit.file)).filter((entry) =>
      entry.eventType.startsWith("ordered_")
    );
    assert.equal(audit.length, 50);
    for (let i = 0; i < 50; i++) {
      assert.equal(audit[i].eventType, `ordered_${i}`, "lines must land in log() order");
    }
  });

  it("rotates a live file when it exceeds maxFileBytes", async () => {
    const store = new JsonlLogStore({ rootDir: root, maxFileBytes: 512 });
    for (let i = 0; i < 10; i++) {
      store.log("audit", { eventType: `fill_${i}`, outcome: "success" });
      await store.flush();
    }
    const rotated = fs.readdirSync(root).filter((name) => name.startsWith("audit.") && name.endsWith(".rotated.jsonl"));
    assert.ok(rotated.length >= 1, "audit log must rotate once past the size cap");
    // The live file must still be valid JSONL and under-ish the cap.
    const live = readLines(path.join(root, LOG_TYPES.audit.file));
    for (const entry of live) {
      assert.ok(entry.eventType);
    }
  });

  it("prunes rotated segments older than retentionDays and keeps fresh ones", () => {
    const store = new JsonlLogStore({ rootDir: root, retentionDays: 30 });
    const oldFile = path.join(root, "audit.2020-01-01T00-00-00Z.rotated.jsonl");
    const freshFile = path.join(root, "audit.2099-01-01T00-00-00Z.rotated.jsonl");
    fs.writeFileSync(oldFile, '{"old":true}\n');
    fs.writeFileSync(freshFile, '{"fresh":true}\n');
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, past, past);

    const removed = store.pruneExpired();
    assert.ok(removed >= 1, "expired rotated segment must be deleted");
    assert.equal(fs.existsSync(oldFile), false, "90-day-old segment must be gone");
    assert.equal(fs.existsSync(freshFile), true, "fresh segment must survive");
    // Live files are never pruned.
    assert.equal(fs.existsSync(path.join(root, LOG_TYPES.audit.file)), true);
  });

  it("never prunes live log files regardless of age", () => {
    const store = new JsonlLogStore({ rootDir: root, retentionDays: 1 });
    const liveFile = path.join(root, LOG_TYPES.audit.file);
    const past = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    fs.utimesSync(liveFile, past, past);
    store.pruneExpired();
    assert.equal(fs.existsSync(liveFile), true, "live audit.jsonl must never be deleted");
  });
});
