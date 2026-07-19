# MixForge — Launch checklist (production-ready gate)

Updated 2026-07-19. Everything code-side is done on `improve/production-ready-20260716`
(PR #1). What remains is **owner configuration + one architecture decision**.
When every box below is checked, `/api/readiness` returns 200 `ready: true` and
the pre-launch retest gate passes.

## 1. Decide the stem-separation backend (pick ONE)

| Option | How | Trade-off |
|---|---|---|
| **A. Self-hosted engine (recommended)** | Run `stem-engine/` on the RTX 5090 (or a DGX Spark), expose to the VPS via Cloudflare Tunnel with `STEM_ENGINE_API_KEY` set; VPS gets `STEM_ENGINE_URL=https://<tunnel-host>` | Zero per-job cost, audio stays on your infra (strongest privacy posture), ~3 s/track. You own uptime; YouTube/SoundCloud import unavailable |
| B. Hosted StemSplit | Set `STEMSPLIT_API_KEY` + `STEMSPLIT_WEBHOOK_SECRET` on the VPS | Per-job cost, provider dependency; link imports work |
| C. Both | Engine URL set → engine wins; remove it to fall back to StemSplit | Most flexibility |

Engine as a permanent Windows service: run `stem-engine/install-service.ps1` **as Admin**
(NSSM, same pattern as MemoryWeb-API). Verify: `curl http://127.0.0.1:9077/health`.

**Tunnel resilience (Option A):** run `cloudflared` as a service too (`cloudflared service install`)
so the tunnel restarts independently of the engine. `/api/readiness` now live-probes the
engine's health endpoint — a dead tunnel or stopped engine flips readiness to 503 in
production, so point uptime monitoring at `/api/readiness`, not just `/api/health`.

**Capacity fallback trigger:** one 5090 ≈ a 3-4 min track separated in ~40-70 s
(htdemucs, jobs serialize on the GPU). The queue is comfortable below ~50 jobs/hour
sustained. If the job queue depth regularly exceeds ~10 (users waiting >10 min),
that's the trigger to either add the second GPU box (a Spark) behind the same
tunnel or temporarily set StemSplit keys and remove `STEM_ENGINE_URL` — the code
falls back with a config change, no deploy.

## 2. Production environment (VPS dashboard / .env — owner only)
- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET` — unique, 32+ chars (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
- [ ] `PUBLIC_BASE_URL=https://<your-domain>`
- [ ] `MIXFORGE_DEMO_MODE=false`
- [ ] Stripe LIVE: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_DJ_PRO`, `STRIPE_PRICE_LABEL`; webhook endpoint `https://<domain>/api/billing/webhook` subscribed to checkout.session.completed + customer.subscription.{created,updated,deleted}
- [ ] Stem backend per §1
- [ ] `MIXFORGE_ADMIN_TOKEN` — 32+ chars (moderation + production `/api/diagnostics`)
- [ ] Storage mounted at `/data` (or `MIXFORGE_DATA_ROOT` override) — readiness enforces `/data` in production
- [ ] Recommended: `DATABASE_URL` (Postgres), `REDIS_URL` (cross-instance rate limits), `S3_BUCKET`+creds (uploads)

## 3. Deploy + verify (runbook)
1. Merge PR #1 → deploy per DEPLOYMENT.md (VPS + nginx + Cloudflare or Railway/Render)
2. `curl https://<domain>/api/health` → `ok: true`, correct `store`/`uploads`
3. `curl https://<domain>/api/readiness` → **200, `ready: true`** ← the gate
4. `MIXFORGE_LIVE_URL=https://<domain> MIXFORGE_ADMIN_TOKEN=<token> npm run smoke:live` → all checks pass
5. Real-money test: subscribe with a live card on Creator, confirm plan flips via webhook, cancel in Stripe, confirm downgrade at period end
6. Real stem test on prod URL: upload → job → stems playable
7. Password reset e2e (demo mode off = token via email — email delivery is the one feature still manual; interim: operate resets via support until an SMTP/Resend integration lands)

## 4. Owner review items (flagged, non-blocking)
- Legal pages (`/legal/*`) — generated to match actual behavior; counsel review before public marketing push. Specifically confirm: the mashup/derivative-work language in Terms §3 + Rights & Licensing, and the committed 3-business-day takedown review SLA (content is inaccessible during review, so the SLA only delays restoration, never removal)
- Marketing copy — real numbers can replace the launch-honest claims when real data exists
- Express 4→5 migration — deferred, tracked in CHANGELOG

## Context from 2026-07 market scan
- Stem separation is commoditized (LALAL.AI credit packs, Moises, Fadr $10/mo, free UVR) — differentiation is the integrated record→autotune→mashup→sell flow and the zero-marginal-cost engine, not separation quality alone
- Quality upgrade path when wanted: `STEM_ENGINE_MODEL=htdemucs_ft`, or BS-RoFormer-class weights (~12 dB SDR vs ~10) behind the same engine API
- Legal climate (Suno/Udio rulings due July 2026): our posture — users supply rights, no site-ripping, DMCA agent + under-review flow — is exactly right; keep it
