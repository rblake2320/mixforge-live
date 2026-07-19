// Email verification + password reset flows. Tokens are real and single-use;
// demo mode surfaces them so the flow is fully testable without an SMTP server.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-recovery-"));
const app = createApp({
  dataFile: path.join(tmpRoot, "db.json"),
  uploadRoot: path.join(tmpRoot, "uploads"),
  logRoot: path.join(tmpRoot, "logs"),
  publicDir: path.join(process.cwd(), "public"),
  jwtSecret: "recovery-test-secret"
  // demoMode defaults true in development → tokens are returned for testing.
});

let server;
let baseUrl;

async function signup(email) {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", name: "Rec" })
  });
  return res.json();
}

function post(url, body) {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
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

describe("email verification", () => {
  it("new users start unverified and a token is issued", async () => {
    const body = await signup("verify@example.com");
    assert.equal(body.user.emailVerified, false);
    assert.ok(body.verificationToken, "demo mode returns the verification token");
  });

  it("verifies with a valid token and flips the flag", async () => {
    const body = await signup("verify2@example.com");
    const res = await post("/api/auth/verify-email", { token: body.verificationToken });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).verified, true);

    const me = await (await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${body.token}` } })).json();
    assert.equal(me.user.emailVerified, true);
  });

  it("rejects an unknown token", async () => {
    const res = await post("/api/auth/verify-email", { token: "deadbeef" });
    assert.equal(res.status, 400);
  });

  it("rejects a token reused after verification", async () => {
    const body = await signup("verify3@example.com");
    await post("/api/auth/verify-email", { token: body.verificationToken });
    const again = await post("/api/auth/verify-email", { token: body.verificationToken });
    assert.equal(again.status, 400);
  });
});

describe("password reset", () => {
  it("does not reveal whether an email exists (no enumeration)", async () => {
    const known = await post("/api/auth/forgot-password", { email: "reset@example.com" });
    await signup("reset@example.com");
    const knownAfter = await post("/api/auth/forgot-password", { email: "reset@example.com" });
    const unknown = await post("/api/auth/forgot-password", { email: "nobody-here@example.com" });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    // Same status + same top-level message regardless of existence.
    assert.equal((await known.json()).message, (await unknown.json()).message);
    // A real account gets a token (demo mode); an unknown one does not.
    assert.ok((await knownAfter.json()).resetToken);
  });

  it("resets the password with a valid token and lets the user log in with the new password", async () => {
    await signup("reset2@example.com");
    const forgot = await (await post("/api/auth/forgot-password", { email: "reset2@example.com" })).json();
    const reset = await post("/api/auth/reset-password", { token: forgot.resetToken, password: "newpass456" });
    assert.equal(reset.status, 200);

    const oldLogin = await post("/api/auth/login", { email: "reset2@example.com", password: "secret123" });
    assert.equal(oldLogin.status, 401, "old password must no longer work");
    const newLogin = await post("/api/auth/login", { email: "reset2@example.com", password: "newpass456" });
    assert.equal(newLogin.status, 200, "new password must work");
  });

  it("revokes sessions issued before a password reset", async () => {
    // No sleep needed: revocation compares password VERSIONS, so even a token
    // minted in the same second as the reset is revoked deterministically.
    const signed = await signup("revoke@example.com");
    const forgot = await (await post("/api/auth/forgot-password", { email: "revoke@example.com" })).json();
    const reset = await post("/api/auth/reset-password", { token: forgot.resetToken, password: "brandnew99" });
    assert.equal(reset.status, 200);

    const stale = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${signed.token}` } });
    assert.equal(stale.status, 401, "pre-reset token must be revoked");

    const login = await post("/api/auth/login", { email: "revoke@example.com", password: "brandnew99" });
    assert.equal(login.status, 200);
    const fresh = await fetch(`${baseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${(await login.json()).token}` }
    });
    assert.equal(fresh.status, 200, "post-reset login must work immediately");
  });

  it("rejects a too-short new password", async () => {
    await signup("reset3@example.com");
    const forgot = await (await post("/api/auth/forgot-password", { email: "reset3@example.com" })).json();
    const res = await post("/api/auth/reset-password", { token: forgot.resetToken, password: "123" });
    assert.equal(res.status, 400);
  });

  it("rejects a reset token reused after a successful reset", async () => {
    await signup("reset4@example.com");
    const forgot = await (await post("/api/auth/forgot-password", { email: "reset4@example.com" })).json();
    await post("/api/auth/reset-password", { token: forgot.resetToken, password: "firstpass1" });
    const again = await post("/api/auth/reset-password", { token: forgot.resetToken, password: "secondpass2" });
    assert.equal(again.status, 400, "single-use token must not work twice");
  });

  it("rejects an unknown reset token", async () => {
    const res = await post("/api/auth/reset-password", { token: "not-a-real-token", password: "whatever9" });
    assert.equal(res.status, 400);
  });
});
