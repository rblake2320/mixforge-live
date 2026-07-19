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

- `GET /api/health` — liveness (public)
- `GET /api/readiness` — launch checklist, 503 until production-ready (public)
- `GET /api/diagnostics` — readiness + logging detail (public in dev, `x-admin-token` in production)
- `GET /api/logs/taxonomy`
- `POST /api/auth/signup` / `POST /api/auth/login` — passwords must be 8+ chars
- `POST /api/auth/verify-email` / `POST /api/auth/forgot-password` / `POST /api/auth/reset-password` — reset revokes all sessions issued before it
- `GET /api/me`
- `GET /api/beats` / `GET /api/community` / `GET /api/plans`
- `POST /api/recordings` / `GET /api/recordings` / `GET /api/recordings/:id/audio` — anonymous callers only ever see ownerless rows
- `POST /api/projects` / `GET /api/projects`
- `POST /api/stems/jobs` / `GET /api/stems/jobs/:id` / `POST /api/stems/webhook`
- `POST /api/billing/checkout` / `POST /api/billing/webhook`
- `POST /api/contact` (rate-limited like all write endpoints)
- `POST /api/reports` / `POST /api/dmca` — trust & safety intake
- `GET /api/legal/terms` / `GET /api/legal/dmca`
- `GET /api/moderation/reports` / `GET /api/moderation/dmca` / `POST /api/moderation/recordings/:id/status` — require `x-admin-token`

## Self-hosted stem engine (built, opt-in via env)

Run real stem separation on your own GPU instead of the hosted StemSplit
provider — no per-job cost, audio never leaves your infrastructure:

```bash
pip install -r stem-engine/requirements.txt
cd stem-engine && python -m uvicorn engine:app --host 127.0.0.1 --port 9077
# then in .env:  STEM_ENGINE_URL=http://127.0.0.1:9077
```

Jobs run Demucs (`STEM_ENGINE_MODEL=htdemucs` default, `htdemucs_ft` for higher
quality) and include BPM/key analysis. Verified on an RTX 5090: a 12 s track
separates into 4 stems in ~3 s end-to-end. YouTube/SoundCloud link import
still requires the hosted provider; the engine handles uploads and direct
audio URLs.

## Scaling switches (built, opt-in via env)

- **Postgres persistence**: set `DATABASE_URL` (flat-file JSON store is the zero-config default).
- **S3/R2 upload storage**: set `S3_BUCKET` (+ credentials). Uploads are persisted to the bucket and served via pre-signed URLs; stem jobs from stored recordings hand StemSplit a signed URL.
- **Redis-backed rate limits**: set `REDIS_URL` so limits hold across instances and restarts.
- **Moderation/admin**: set `MIXFORGE_ADMIN_TOKEN`.

## Still manual before public launch

- Forward JSONL logs from `MIXFORGE_LOG_ROOT` into a SIEM/log platform and retain audit/security logs for the required compliance window.
- Configure StemSplit (`STEMSPLIT_API_KEY`, `STEMSPLIT_WEBHOOK_SECRET`) for real stem separation.
- Configure live Stripe products, price IDs, webhook signing, and customer portal.
- Email delivery for verification/reset tokens (demo mode returns tokens in the API response instead).

## One-day launch checklist

1. Set `JWT_SECRET`, `PUBLIC_BASE_URL`, and `MIXFORGE_DEMO_MODE=false` in `.env`.
2. Create Stripe products/prices for Creator, DJ Pro, and Label, then paste the price IDs into `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_DJ_PRO`, and `STRIPE_PRICE_LABEL`.
3. Put the production domain in Stripe Checkout success/cancel URLs through `PUBLIC_BASE_URL`.
4. Set `STEMSPLIT_API_KEY` and `STEMSPLIT_WEBHOOK_SECRET`, then run `npm run smoke:stemsplit`.
5. Move `MIXFORGE_UPLOAD_ROOT` to private object storage before real user uploads.
6. Run `npm test`, then smoke-test signup, recording, checkout, and contact on the production URL.
