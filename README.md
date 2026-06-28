# MixForge Live Backend

This turns the static `mixforge.html` prototype into a runnable local full-stack app.

## What works now

- Static MixForge landing/studio UI served from Express.
- Email/password auth with JWT sessions.
- Beat catalog API seeded from local data.
- Real browser microphone recording through `MediaRecorder`.
- Audio upload and persisted recording metadata.
- Playback, export, and save-to-project actions wired to the backend.
- Project creation/listing API.
- Stem job API with explicit demo previews in development and real StemSplit support when `STEMSPLIT_API_KEY` is set.
- Stripe-ready checkout endpoint. Paid checkout uses Stripe when configured; otherwise demo mode returns a labeled no-payment result and does not activate paid plans.
- Structured JSONL log databases under `data/logs` for audit, security, access, trace, auth, error, performance, business, provider, session, health, and AI-agent observability events.

## Run

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Open `http://127.0.0.1:4173`.

For production hosting steps, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Verify

```powershell
npm test
npm audit --audit-level=moderate
npm run doctor
```

`npm run doctor` exits non-zero until demo mode is off and real production secrets are configured. That is expected for local/demo setups.

## API

- `GET /api/health`
- `GET /api/readiness`
- `GET /api/diagnostics`
- `GET /api/logs/taxonomy`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/beats`
- `GET /api/community`
- `POST /api/recordings`
- `GET /api/recordings`
- `GET /api/recordings/:id/audio`
- `POST /api/projects`
- `GET /api/projects`
- `POST /api/stems/jobs`
- `GET /api/stems/jobs/:id`
- `POST /api/stems/webhook`
- `GET /api/plans`
- `POST /api/billing/checkout`

## Production switches still needed

- Replace local JSON persistence with Supabase/Postgres or managed Postgres.
- Replace local upload storage with Supabase Storage, S3, R2, or equivalent private object storage.
- Forward JSONL logs from `MIXFORGE_LOG_ROOT` into a SIEM/log platform and retain audit/security logs for the required compliance window.
- Configure StemSplit for real stem separation.
- Configure live Stripe products, price IDs, webhook signing, and customer portal.
- Add moderation, licensing checks, rate limits, and abuse monitoring before public launch.

## One-day launch checklist

1. Set `JWT_SECRET`, `PUBLIC_BASE_URL`, and `MIXFORGE_DEMO_MODE=false` in `.env`.
2. Create Stripe products/prices for Creator, DJ Pro, and Label, then paste the price IDs into `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_DJ_PRO`, and `STRIPE_PRICE_LABEL`.
3. Put the production domain in Stripe Checkout success/cancel URLs through `PUBLIC_BASE_URL`.
4. Set `STEMSPLIT_API_KEY` and `STEMSPLIT_WEBHOOK_SECRET`, then run `npm run smoke:stemsplit`.
5. Move `MIXFORGE_UPLOAD_ROOT` to private object storage before real user uploads.
6. Run `npm test`, then smoke-test signup, recording, checkout, and contact on the production URL.
