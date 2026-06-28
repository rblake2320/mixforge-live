const baseUrl = (process.env.MIXFORGE_LIVE_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

if (!baseUrl) {
  console.error("Set MIXFORGE_LIVE_URL or PUBLIC_BASE_URL before running live smoke.");
  process.exit(2);
}

async function readJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  return { response, body };
}

function assertOk(name, response, body) {
  if (!response.ok) {
    throw new Error(`${name} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
}

const stamp = Date.now();
const email = `live-smoke-${stamp}@mixforge.local`;
const password = `mixforge-${stamp}`;

const results = [];

const health = await readJson("/api/health");
assertOk("health", health.response, health.body);
results.push({ check: "health", ok: true, dataRoot: health.body.dataRoot });

const home = await fetch(`${baseUrl}/`);
if (!home.ok) {
  throw new Error(`home failed with ${home.status}`);
}
results.push({ check: "home", ok: true });

const beats = await readJson("/api/beats");
assertOk("beats", beats.response, beats.body);
if (!Array.isArray(beats.body.beats) || beats.body.beats.length === 0) {
  throw new Error("beats returned no catalog data");
}
results.push({ check: "beats", ok: true, count: beats.body.beats.length });

const signup = await readJson("/api/auth/signup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name: "Live Smoke" })
});
assertOk("signup", signup.response, signup.body);
const token = signup.body.token;
results.push({ check: "signup", ok: true });

const me = await readJson("/api/me", {
  headers: { Authorization: `Bearer ${token}` }
});
assertOk("me", me.response, me.body);
results.push({ check: "me", ok: true, planId: me.body.user.planId });

const free = await readJson("/api/billing/checkout", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ planId: "free" })
});
assertOk("free checkout", free.response, free.body);
results.push({ check: "free_checkout", ok: true });

const contact = await readJson("/api/contact", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Live Smoke",
    email,
    message: "Automated production smoke test contact."
  })
});
assertOk("contact", contact.response, contact.body);
results.push({ check: "contact", ok: true });

const readiness = await readJson("/api/readiness");
results.push({
  check: "readiness",
  ok: readiness.response.ok,
  ready: readiness.body.ready,
  status: readiness.response.status,
  demoMode: readiness.body.demoMode,
  capabilities: readiness.body.capabilities
});

const diagnostics = await readJson("/api/diagnostics");
results.push({
  check: "diagnostics",
  ok: diagnostics.response.ok,
  loggingOk: diagnostics.body.logging?.ok,
  logTypes: diagnostics.body.logging?.logTypes
});

const taxonomy = await readJson("/api/logs/taxonomy");
assertOk("log taxonomy", taxonomy.response, taxonomy.body);
results.push({
  check: "log_taxonomy",
  ok: true,
  count: Object.keys(taxonomy.body.logTypes || {}).length
});

console.log(JSON.stringify({ baseUrl, results }, null, 2));

if (!readiness.response.ok) {
  process.exitCode = 1;
}
