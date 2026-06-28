import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createApp } from "../src/app.js";

if (!process.env.STEMSPLIT_API_KEY) {
  console.error("Set STEMSPLIT_API_KEY before running this smoke test.");
  process.exit(2);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mixforge-stemsplit-"));
const app = createApp({
  dataFile: path.join(tmpRoot, "db.json"),
  uploadRoot: path.join(tmpRoot, "uploads"),
  publicDir: path.join(process.cwd(), "public"),
  jwtSecret: "stemsplit-smoke-secret",
  stemsplitApiKey: process.env.STEMSPLIT_API_KEY,
  demoMode: false
});

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const signup = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `stemsplit-smoke-${Date.now()}@mixforge.local`,
      password: "secret123",
      name: "StemSplit Smoke"
    })
  });
  const signedUp = await signup.json();
  if (!signup.ok) {
    throw new Error(signedUp.error || `Signup failed: ${signup.status}`);
  }

  const form = new FormData();
  form.append("audio", new Blob([Buffer.alloc(8192)], { type: "audio/webm" }), "smoke.webm");
  form.append("durationSeconds", "1");
  form.append("beatId", "dark-trap");
  form.append("preset", "Natural");
  form.append("title", "StemSplit Smoke Take");

  const upload = await fetch(`${baseUrl}/api/recordings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signedUp.token}` },
    body: form
  });
  const uploaded = await upload.json();
  if (!upload.ok) {
    throw new Error(uploaded.error || `Recording upload failed: ${upload.status}`);
  }

  const jobResponse = await fetch(`${baseUrl}/api/stems/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${signedUp.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recordingId: uploaded.recording.id,
      sourceName: "StemSplit Smoke Job"
    })
  });
  const jobPayload = await jobResponse.json();

  console.log(
    JSON.stringify(
      {
        ok: jobResponse.ok,
        status: jobResponse.status,
        provider: jobPayload.job?.provider,
        providerJobId: jobPayload.job?.providerJobId || null,
        jobStatus: jobPayload.job?.status,
        error: jobPayload.error || null,
        detail: jobPayload.detail || null
      },
      null,
      2
    )
  );

  if (!jobResponse.ok) {
    process.exitCode = 1;
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
