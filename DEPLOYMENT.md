# MixForge Production Deployment

## Recommended: Hostinger KVM 2 + Cloudflare

Hostinger KVM 2 (2.25.184.107) runs the Node.js process and owns the `/data` disk.
Cloudflare sits in front as DNS proxy, providing free SSL and DDoS protection.

```
User → Cloudflare (DNS + SSL + CDN) → Hostinger KVM 2 → nginx → Node :4173 → /data
```

### One-time VPS setup

```bash
ssh root@2.25.184.107
bash <(curl -fsSL https://raw.githubusercontent.com/rblake2320/mixforge-live/main/deploy/vps-setup.sh) YOUR_DOMAIN
```

Or clone the repo first and run locally:

```bash
bash deploy/vps-setup.sh YOUR_DOMAIN
```

The script installs Node 22, PM2, nginx, clones the repo to `/opt/mixforge`, and creates `/data`.

### After setup

1. Edit `/opt/mixforge/.env` — fill in all secrets (see Required Environment Variables below)
2. `pm2 restart mixforge`
3. In Cloudflare dashboard: add **A record** `YOUR_DOMAIN → 2.25.184.107`, **Proxied (orange cloud)**
4. Set Cloudflare **SSL/TLS → Full** (not Flexible)
5. Confirm: `curl https://YOUR_DOMAIN/api/health`

### Ongoing deploys

```bash
ssh root@2.25.184.107
cd /opt/mixforge && git pull && npm ci --omit=dev && pm2 restart mixforge
```

### nginx config

`deploy/nginx.conf` — already includes Cloudflare IP ranges for real-IP passthrough and sets `client_max_body_size 110m` to accommodate the 100MB recording upload limit. Replace `YOUR_DOMAIN_HERE` if editing manually.

### PM2 config

`ecosystem.config.cjs` at the repo root. Runs one instance on `127.0.0.1:4173`, restarts on crash, caps memory at 512MB.

---

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
MIXFORGE_LOG_ROOT=/data/logs
MIXFORGE_LOG_RETENTION_DAYS=90
MIXFORGE_SLOW_REQUEST_MS=1000
```

Do not use local file storage for real production uploads unless your host provides a persistent disk/volume. Move recordings to object storage before real users.

## Railway Persistent Volume

For the quick launch path, use a Railway Volume mounted at:

```text
/data
```

The app now defaults to `/data/mixforge-db.json`, `/data/uploads`, and `/data/logs` when `NODE_ENV=production`, so a Railway Volume mounted at `/data` makes the JSON database, uploaded audio, and append-only JSONL log databases survive restarts and redeploys.

If you mount somewhere else, set:

```text
MIXFORGE_DATA_ROOT=/your/mount/path
```

or set the file paths explicitly:

```text
MIXFORGE_DATA_FILE=/your/mount/path/mixforge-db.json
MIXFORGE_UPLOAD_ROOT=/your/mount/path/uploads
MIXFORGE_LOG_ROOT=/your/mount/path/logs
```

After deployment, confirm `/api/health` returns the expected `dataRoot` and `logRoot`.

## Hardening Built In

- Production refuses to start with the development JWT secret.
- `/api/readiness` returns `503` until demo mode is off and JWT, HTTPS base URL, writable storage, Stripe, and StemSplit are configured.
- `/api/diagnostics` reports whether checkout/stem separation are real, demo, or unavailable without exposing secrets.
- `/api/logs/taxonomy` exposes the supported log taxonomy. Raw log records stay on disk under `MIXFORGE_LOG_ROOT`.
- Structured JSONL log databases cover audit, error, security/threat, access/authorization, trace/span, authentication, infrastructure, performance, transaction, change/deployment, dependency, rate limit, gateway, session, data access/query, health, agent decision, tool call, token/cost, quality, and debug/developer categories.
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
5. Add a Railway Volume or switch `MIXFORGE_DATA_FILE`/`MIXFORGE_UPLOAD_ROOT`/`MIXFORGE_LOG_ROOT` to cloud storage-backed paths before real users.
6. Confirm `/api/health` is green before testing checkout or recording.
7. Confirm `/api/diagnostics` reports `logging.ok: true`.

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
