# Changelog

All notable changes to MixForge Live are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer once tagged.

## [Unreleased] - 2026-07-16

Production-readiness pass (branch `improve/production-ready-20260716`).

### Security
- Anonymous `GET /api/recordings` and `GET /api/projects` no longer list every
  user's rows; callers without a session only see ownerless (anonymous) rows.
- Password resets now revoke every JWT issued before the reset
  (`passwordChangedAt` vs token `iat`).
- Minimum password length raised from 6 to 8 characters (NIST SP 800-63B-4).
- `POST /api/contact` is now covered by the 30/min write rate limiter (was the
  only unauthenticated write route without one).
- `GET /api/diagnostics` requires `x-admin-token` in production (still open in
  development). `/api/health` and `/api/readiness` remain public for probes.

### Fixed
- **S3/R2 storage mode actually works now**: `storage.persist()` was never
  called, so uploads stayed on local disk while playback redirected to
  pre-signed URLs for objects that were never uploaded. Recordings and stem
  sources now flow through the storage backend, and stem jobs created from a
  persisted recording hand StemSplit a time-limited signed URL instead of a
  dead local path.
- `/api/health` reports the real store (`json`/`postgres`) and upload backend
  (`local`/`s3`) plus the configured service version, instead of hardcoded
  `"local-json"` / `"0.1.0"`. Readiness capabilities are derived from config
  the same way.
- Test teardowns no longer race the buffered log flush (`JsonlLogStore.close()`
  drains deterministically), eliminating the ENOENT noise on every run.

### Changed
- One shared Stripe client per app with a 30 s network timeout and 2 retries
  (was: a new client per request with the SDK-default 80 s timeout).
- Admin-guard error message generalized (it now guards diagnostics too).

### Dependencies
- stripe 17.7.0 → 22.3.2 (five majors; code already handled item-level
  `current_period_end`).
- bcryptjs 2.4.3 → 3.0.3 (maintained line, identical API).
- helmet 8.2 → 8.3, AWS SDK minors. `npm audit`: 0 vulnerabilities.

### Fixed after adversarial review (33-agent workflow over the branch diff)
- Stem uploads are persisted **before** the job row and provider call exist, so
  a storage failure can no longer orphan a live StemSplit job (previously the
  persist sat between the provider accepting the job and `providerJobId` being
  recorded, making the remote job unpollable and unmatchable by webhook).
- Session revocation now compares a `passwordVersion` (`pwv`) claim instead of
  JWT `iat` vs reset time — `iat`'s one-second resolution let a token minted in
  the same second as the reset survive.
- Login form no longer applies `minlength="8"` (signup only); legacy accounts
  with 6–7-char passwords could authenticate via the API but were locked out
  of the UI by browser constraint validation.
- Readiness `capabilities` now mirror the exact factory selection precedence
  (`MIXFORGE_STORE`/`MIXFORGE_STORAGE` override wins over credential presence)
  instead of contradicting the running backend.
- `scripts/live-smoke.js` sends `x-admin-token` when `MIXFORGE_ADMIN_TOKEN` is
  set and treats a gated 401/503 as expected; DEPLOYMENT.md documents the gate.

### Fixed from the 2026-07-17 pre-launch test report
- **Mobile navigation restored**: the hamburger was 0–16 px visible at
  320–390 px (header CTA/status pill crowded it off-screen) and the page
  overflowed horizontally at 320 px. Verified 0 px overflow and a fully
  visible 44×44 hamburger at 320/375/390/414/768.
- **Every footer link has a real destination**: Privacy, Terms,
  Rights & Licensing, and Cookies are real pages under `/legal`; API Docs is a
  real endpoint reference at `/docs.html`; Blog/Discord/About/Careers/Press
  removed until they exist.
- **Accessibility**: record control is a real keyboard-operable button with an
  accessible name; all sliders/selects/file/url inputs and icon-only buttons
  labeled; `<main>` landmark; heading order fixed; modal `aria-labelledby`;
  44 px touch targets on phone widths; Enter submits the link-import field.
- **Launch metadata**: meta description, canonical, Open Graph/Twitter cards,
  SVG favicon, web manifest, theme-color.
- **Permissions-Policy header**: microphone self-only, camera/geolocation/
  payment/usb denied.
- **Honest copy**: "Join thousands", "500+ beats", and "real tracks from real
  creators" replaced with verifiable claims and sample-content labeling.

### Added 2026-07-19 — self-hosted stem engine (`stem-engine/`)
- New local GPU stem-separation service (FastAPI + Demucs) speaking the same
  job vocabulary as the hosted provider, plus BPM/key analysis (librosa).
  `STEM_ENGINE_URL` selects it through the existing `stemsplitClient()` seam:
  provider `local-engine`, mode `real`, readiness satisfied without StemSplit
  keys. YouTube/SoundCloud imports remain hosted-only and fail loudly.
- Live-verified on the RTX 5090: 12 s track → 4 stems in 3.0 s end-to-end
  through MixForge (7.6 s including cold model load); BPM/key detected;
  stems fetched over HTTP. 4 new integration tests against a real wire-format
  engine double (113 total).

### Deferred (needs human decision)
- Express 4 → 5 migration (one major, touches middleware semantics).
- Native bcrypt/argon2 (bcryptjs is pure JS and blocks the event loop ~100 ms
  per hash at cost 12; acceptable behind the 40/15 min auth limiter).
