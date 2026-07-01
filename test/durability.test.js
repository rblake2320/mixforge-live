// Durability / failure-injection tests for JsonStore, which is the only stateful
// persistence layer. Verifies atomic writes, restart/resume, recovery from a
// leftover temp file after a crash mid-write, and that an empty file is treated
// as an empty DB rather than corrupting state.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { JsonStore } from "../src/db.js";

let root;
let dataFile;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-dur-"));
  dataFile = path.join(root, "db.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("JsonStore durability", () => {
  it("seeds a valid DB on first load and writes it atomically", () => {
    const store = new JsonStore(dataFile);
    assert.ok(fs.existsSync(dataFile));
    // The seed must be complete and parseable.
    const onDisk = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    assert.equal(onDisk.beats.length, store.list("beats").length);
    assert.ok(onDisk.beats.length >= 5);
    // No temp file should linger after a successful save.
    assert.equal(fs.existsSync(`${dataFile}.tmp`), false);
  });

  it("persists inserts across a simulated process restart (new store, same file)", () => {
    const store = new JsonStore(dataFile);
    store.insert("users", { id: "u1", email: "restart@example.com" });
    store.insert("projects", { id: "p1", title: "Survivor" });

    // Simulate a fresh process: brand-new store object reading the same file.
    const reopened = new JsonStore(dataFile);
    assert.ok(reopened.find("users", (u) => u.id === "u1"));
    assert.equal(reopened.find("projects", (p) => p.id === "p1").title, "Survivor");
  });

  it("never leaves a half-written main file (only whole-object rename)", () => {
    const store = new JsonStore(dataFile);
    for (let i = 0; i < 50; i++) {
      store.insert("users", { id: `u${i}`, email: `u${i}@example.com` });
      // After every save the main file must always parse as complete JSON.
      const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      assert.equal(parsed.users.length, i + 1);
    }
  });

  it("recovers from a leftover .tmp file after a crash mid-write", () => {
    const store = new JsonStore(dataFile);
    store.insert("users", { id: "u1", email: "before-crash@example.com" });

    // Simulate a crash that left a partial temp file behind (never renamed).
    fs.writeFileSync(`${dataFile}.tmp`, '{"partial": true, "corrupt');

    // A fresh store must load the committed main file and ignore the stray tmp.
    const reopened = new JsonStore(dataFile);
    assert.ok(reopened.find("users", (u) => u.id === "u1"));
    // And it must be able to keep writing (which overwrites the stray tmp).
    reopened.insert("users", { id: "u2", email: "after-crash@example.com" });
    assert.equal(reopened.list("users").length, 2);
  });

  it("treats a zero-byte main file as an empty DB, not a crash", () => {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, "");
    const store = new JsonStore(dataFile);
    // Empty file → default shape re-seeded, still usable.
    assert.ok(store.list("beats").length >= 5);
    assert.equal(store.list("users").length, 0);
  });

  it("re-seeds beats/community if they are emptied but preserves user data", () => {
    const store = new JsonStore(dataFile);
    store.insert("users", { id: "u1", email: "keep@example.com" });
    // Corrupt the collections that are supposed to self-heal.
    store.transaction((data) => {
      data.beats = [];
      data.community = [];
    });
    const reopened = new JsonStore(dataFile);
    assert.ok(reopened.list("beats").length >= 5, "beats must re-seed");
    assert.ok(reopened.list("community").length >= 1, "community must re-seed");
    assert.ok(reopened.find("users", (u) => u.id === "u1"), "user data must survive");
  });

  it("throws on an unknown collection instead of silently creating one", () => {
    const store = new JsonStore(dataFile);
    assert.throws(() => store.insert("not_a_collection", { id: "x" }), /Unknown collection/);
  });

  it("update on a missing id returns null without mutating other records", () => {
    const store = new JsonStore(dataFile);
    store.insert("users", { id: "u1", email: "a@example.com" });
    const result = store.update("users", "does-not-exist", { email: "hacked@example.com" });
    assert.equal(result, null);
    assert.equal(store.find("users", (u) => u.id === "u1").email, "a@example.com");
  });
});
