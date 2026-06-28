# MixForge Agent Instructions

These instructions apply to this repository: `mixforge-live`.

## Startup Context

Before substantive work, query MemoryWeb for relevant project context:

```powershell
$env:PYTHONIOENCODING='utf-8'
python D:\memory-web\mw_query.py "MixForge live app <describe the task>"
```

Use the result as context, but treat the current repository files as the source of truth.

## Project Shape

- Express app entrypoint: `src/server.js`
- App/API implementation: `src/app.js`
- Runtime config: `src/config.js`
- Structured logging: `src/logging.js`
- Readiness/diagnostics: `src/readiness.js`
- Static frontend: `public/index.html` and `public/mixforge-backend.js`
- Tests: `test/api.test.js`
- Deployment docs: `DEPLOYMENT.md`

## Core Rule: Real vs Demo

Do not add silent mocks or fake success paths.

Allowed demo behavior must be explicit and labeled:

- Demo mode is controlled by `MIXFORGE_DEMO_MODE`.
- Production should use `MIXFORGE_DEMO_MODE=false`.
- Demo checkout must not activate paid plans.
- Demo stem jobs must return `provider: "demo"` and diagnostics explaining that real StemSplit is not configured.
- If demo mode is off and Stripe or StemSplit is missing, fail loudly with a clear configuration error.

Use `/api/readiness` and `/api/diagnostics` to expose what is real, demo, unavailable, or misconfigured.

## Logging Contract

Do not remove or bypass structured logging.

- All log records are JSONL under `MIXFORGE_LOG_ROOT` and are also mirrored into `all.jsonl`.
- `src/logging.js` defines the authoritative log taxonomy.
- Every state mutation must emit an `audit` and/or `transaction_business` event.
- Authentication success/failure must emit `authentication` and `session` events.
- Authorization failures must emit `access_authorization`; suspicious validation failures must emit `security_threat`.
- Runtime exceptions and provider failures must emit `error`.
- Provider calls must emit `dependency_external` and trace-span records.
- Sensitive reads must emit `audit` and `data_access_query`.
- Request correlation IDs must be preserved through `x-correlation-id`.
- Do not log passwords, tokens, secrets, webhook signatures, or full Authorization headers.

## Secrets And Data

Never commit secrets or runtime data.

Ignored/local-only:

- `.env`
- `data/`
- local JSONL logs under `data/logs/`
- `node_modules/`
- `server.*.log`

Real provider values belong in the deployment host dashboard, not in source:

- `JWT_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- Stripe price IDs
- `STEMSPLIT_API_KEY`
- `STEMSPLIT_WEBHOOK_SECRET`

## Validation

Run the relevant checks before committing code changes:

```powershell
npm test
npm audit --audit-level=moderate
npm run doctor
```

`npm run doctor` is expected to exit non-zero for local/demo setups until real production env vars are configured and demo mode is disabled. Do not hide that failure.

For live deploy validation:

```powershell
$env:MIXFORGE_LIVE_URL="https://your-live-url"
npm run smoke:live
Remove-Item Env:\MIXFORGE_LIVE_URL
```

For real StemSplit validation:

```powershell
$env:STEMSPLIT_API_KEY="..."
npm run smoke:stemsplit
Remove-Item Env:\STEMSPLIT_API_KEY
```

## Deployment

The GitHub repo is intended to be the deployment source for Railway, Render, Fly.io, or equivalent Node hosting.

Required production basics:

- HTTPS public URL
- Persistent `/data` volume or replacement managed storage
- `MIXFORGE_DEMO_MODE=false`
- Real Stripe configuration
- Real StemSplit configuration

Do not claim production readiness until `/api/readiness` returns `ready: true` on the deployed URL.
