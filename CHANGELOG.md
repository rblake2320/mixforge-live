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

### Deferred (needs human decision)
- Express 4 → 5 migration (one major, touches middleware semantics).
- Native bcrypt/argon2 (bcryptjs is pure JS and blocks the event loop ~100 ms
  per hash at cost 12; acceptable behind the 40/15 min auth limiter).
