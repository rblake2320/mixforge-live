# CLAUDE.md — MixForge Live

## What this is
Music creation SaaS — Express API + single-page frontend (no framework). Three user tiers: Everyday (free), Creator ($12/mo), DJ Pro ($29/mo), Label/Agency ($79/mo).

## Layout
```
src/
  server.js        entrypoint — loads config, starts listener
  app.js           Express factory — all routes and business logic
  config.js        all env vars with dev defaults
  db.js            JsonStore — flat JSON file, atomic writes via tmp→rename
  auth.js          JWT middleware (attachUser) + bcrypt helpers
  readiness.js     /api/readiness checklist enforced at boot in production
public/
  index.html       marketing site + studio UI (~1,700 lines, no build step)
  mixforge-backend.js  IIFE that wires every UI element to real API calls
test/
  api.test.js      Node built-in test runner, full lifecycle coverage
scripts/
  doctor.js        environment sanity check
  live-smoke.js    smoke test against a live URL
  stemsplit-smoke.js  confirms StemSplit key works end-to-end
```

## Commands
```bash
npm start          # production server
npm run dev        # node --watch (restarts on file change)
npm test           # Node built-in test runner
npm run doctor     # check environment
npm run smoke:live # smoke test a live URL (needs MIXFORGE_LIVE_URL set)
npm run smoke:stemsplit  # test real StemSplit key (needs STEMSPLIT_API_KEY set)
```

## Key invariants
- `src/app.js` exports `createApp(overrides)` — pass config overrides for testing; never mutate global state.
- `JsonStore` writes atomically (tmp file → rename). Never write to `this.data` directly; always go through `insert`, `update`, or `transaction`.
- Demo mode is auto-on in development. Stripe checkout and StemSplit stem jobs both have explicit labeled demo paths — they never silently succeed without real credentials.
- Production refuses to start with the default JWT secret (`assertMinimumProductionConfig`).
- `/api/readiness` returns 503 until JWT, HTTPS base URL, writable storage, Stripe, StemSplit, and demo-mode-off all pass.
- Detectors/step common_mistakes are matched globally — the coach never changes.

## Adding routes
All routes live in `createApp()` in `src/app.js`. The middleware stack order matters:
1. Stripe + StemSplit webhooks (raw body) — must come before `express.json()`
2. `express.json()` + rate limiters
3. `express.static(cfg.publicDir)`
4. Feature routes
5. 404 catch-all → serve `index.html` for non-API paths
6. Error handler

## Storage collections
`users`, `beats`, `recordings`, `projects`, `stemJobs`, `payments`, `community`, `contacts`. `beats` and `community` are always re-seeded from defaults if empty. Never add a collection without updating `defaultData()` in `db.js`.

## Environment variables
See `.env.example` for the full list. In production, set via host dashboard — never commit secrets.

Required for real launch:
```
NODE_ENV=production
JWT_SECRET               # 32+ random chars
PUBLIC_BASE_URL          # https://your-domain
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_CREATOR
STRIPE_PRICE_DJ_PRO
STRIPE_PRICE_LABEL
STEMSPLIT_API_KEY
STEMSPLIT_WEBHOOK_SECRET
```

## Deployment
- **Recommended**: Hostinger KVM 2 (2.25.184.107) + Cloudflare proxy. See `DEPLOYMENT.md` and `deploy/`.
  - `deploy/vps-setup.sh` — one-time VPS bootstrap (Node 22, PM2, nginx, `/data`)
  - `deploy/nginx.conf` — reverse proxy with Cloudflare IP passthrough and 110MB body limit
  - `ecosystem.config.cjs` — PM2 config (port 4173, NODE_ENV=production)
- **Railway**: `railway.json` present. Mount a Volume at `/data`.
- **Render**: `render.yaml` present.
- **Docker**: `Dockerfile` — node:24-alpine, port 4173.
- After deploy: verify `/api/health` → `ok: true`, then `/api/readiness` → `ready: true`.

## Stripe webhook events to subscribe
`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` — all pointing to `/api/billing/webhook`.

## What is and isn't built
**Built**: auth, beat catalog (metadata), vocal recording upload, projects, demo+real stem separation, demo+real Stripe checkout, Stripe/StemSplit webhook handlers, contact form, rate limiting, CORS, CSP headers.

**Not built**: real audio playback/mixing engine (DJ decks are visual only), beat audio files, object storage for uploads, social/community features (seed data only), email, admin dashboard.
