# MixForge Production Deployment

The simplest launch path is a single Node web service because Express already serves both the API and the static frontend.

## Required Environment Variables

Set these in the host dashboard, not in git:

```text
NODE_ENV=production
JWT_SECRET=<long random secret>
PUBLIC_BASE_URL=https://your-production-domain.example
ALLOWED_ORIGINS=https://your-production-domain.example
MIXFORGE_DEMO_MODE=false
STRIPE_SECRET_KEY=<Stripe secret key>
STRIPE_WEBHOOK_SECRET=<Stripe webhook signing secret>
STRIPE_PRICE_CREATOR=<Stripe price id>
STRIPE_PRICE_DJ_PRO=<Stripe price id>
STRIPE_PRICE_LABEL=<Stripe price id>
STEMSPLIT_API_KEY=<StemSplit API key>
STEMSPLIT_WEBHOOK_SECRET=<StemSplit webhook signing secret>
```

Optional while still using local file storage:

```text
MIXFORGE_DATA_ROOT=/data
MIXFORGE_DATA_FILE=/data/mixforge-db.json
MIXFORGE_UPLOAD_ROOT=/data/uploads
```

Do not use local file storage for real production uploads unless your host provides a persistent disk/volume. Move recordings to object storage before real users.

## Railway Persistent Volume

For the quick launch path, use a Railway Volume mounted at:

```text
/data
```

The app now defaults to `/data/mixforge-db.json` and `/data/uploads` when `NODE_ENV=production`, so a Railway Volume mounted at `/data` makes the JSON database and uploaded audio survive restarts and redeploys.

If you mount somewhere else, set:

```text
MIXFORGE_DATA_ROOT=/your/mount/path
```

or set the file paths explicitly:

```text
MIXFORGE_DATA_FILE=/your/mount/path/mixforge-db.json
MIXFORGE_UPLOAD_ROOT=/your/mount/path/uploads
```

After deployment, confirm `/api/health` returns the expected `dataRoot`.

## Hardening Built In

- Production refuses to start with the development JWT secret.
- `/api/readiness` returns `503` until demo mode is off and JWT, HTTPS base URL, writable storage, Stripe, and StemSplit are configured.
- `/api/diagnostics` reports whether checkout/stem separation are real, demo, or unavailable without exposing secrets.
- API write/auth endpoints are rate limited.
- User-owned recordings and stem jobs are private to the owner.
- Paid checkout cannot silently upgrade users without Stripe. In demo mode it returns a labeled no-payment response and leaves the user on their current plan.
- Stem jobs cannot silently pretend to be AI separation. In demo mode the API returns `provider: "demo"` and labels the outputs as demo previews.
- CORS is restricted in production to `PUBLIC_BASE_URL` plus `ALLOWED_ORIGINS`.

## Render

1. Push this folder to GitHub.
2. In Render, create a Blueprint from the repo or create a Web Service manually.
3. Use `npm ci` as the build command and `npm start` as the start command.
4. Set healthcheck path to `/api/health`.
5. Set all required environment variables.
6. After deploy, set `PUBLIC_BASE_URL` to the Render/custom-domain URL and redeploy.

## Railway

1. Push this folder to GitHub.
2. Create a Railway service from the repo.
3. Railway will read `railway.json`; confirm start command is `npm start`.
4. Set all required environment variables.
5. Add a Railway Volume or switch `MIXFORGE_DATA_FILE`/`MIXFORGE_UPLOAD_ROOT` to cloud storage-backed paths before real users.
6. Confirm `/api/health` is green before testing checkout or recording.

## Stripe

Create three recurring Stripe Prices and set them in the host environment:

```text
STRIPE_PRICE_CREATOR=price_...
STRIPE_PRICE_DJ_PRO=price_...
STRIPE_PRICE_LABEL=price_...
```

Create a Stripe webhook endpoint pointing to:

```text
https://your-production-domain.example/api/billing/webhook
```

Subscribe it to:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

Copy the webhook signing secret into:

```text
STRIPE_WEBHOOK_SECRET=whsec_...
```

Checkout sessions include MixForge `userId` and `planId` metadata. The webhook updates each user's `planId`, `stripeCustomerId`, `stripeSubscriptionId`, `stripeSubscriptionStatus`, and `currentPeriodEnd`.

## Fly.io

1. Install and log in to `flyctl`.
2. Run:

```powershell
fly launch --no-deploy
```

3. Use the generated `fly.toml`, or copy settings from `fly.toml.example`.
4. Set secrets:

```powershell
fly secrets set JWT_SECRET="..." PUBLIC_BASE_URL="https://your-app.fly.dev"
fly secrets set STRIPE_SECRET_KEY="..." STRIPE_WEBHOOK_SECRET="..."
fly secrets set STRIPE_PRICE_CREATOR="..." STRIPE_PRICE_DJ_PRO="..." STRIPE_PRICE_LABEL="..."
fly secrets set STEMSPLIT_API_KEY="..." STEMSPLIT_WEBHOOK_SECRET="..."
```

5. Deploy:

```powershell
fly deploy
```

## Post-Deploy Smoke Test

```powershell
npm test
Invoke-RestMethod https://your-production-domain.example/api/health
$env:MIXFORGE_LIVE_URL="https://your-production-domain.example"
npm run smoke:live
Remove-Item Env:\MIXFORGE_LIVE_URL
```

Then manually verify:

- Signup/login modal creates a user.
- Nav links scroll to the right sections.
- Mic recording requests permission, records, uploads, and unlocks playback/save/export.
- Free plan activates.
- Paid plan opens Stripe Checkout when Stripe env vars are set.
- Contact form stores a request.
- Preview Mashup creates a StemSplit-backed stem job when `STEMSPLIT_API_KEY` is set. If `MIXFORGE_DEMO_MODE=true` and StemSplit is missing, it returns a labeled demo preview. If demo mode is false and StemSplit is missing, it fails with a configuration error.

For a sales demo URL, you may intentionally set `MIXFORGE_DEMO_MODE=true`; keep `/api/readiness` visible during internal QA so nobody mistakes that for full production readiness.

## StemSplit Smoke Test

After setting a real key locally or in a secure shell, run:

```powershell
$env:STEMSPLIT_API_KEY="sk_..."
npm run smoke:stemsplit
Remove-Item Env:\STEMSPLIT_API_KEY
```

Expected result with a valid account/key is a JSON response where `provider` is `stemsplit` and `providerJobId` is present. If the key is invalid or credits are missing, the script exits non-zero and prints the provider error returned by the backend.
