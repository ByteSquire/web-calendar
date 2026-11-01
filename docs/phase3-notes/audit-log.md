# Audit log and admin guard

## Built

- `server/db/migrations/005_audit_log.sql`: `audit_log` (id, at, actor_sub, action, target, details JSON with `json_valid` CHECK, request_id), indexes on `at` and `actor_sub`, trigger `audit_log_no_update` (BEFORE UPDATE aborts). DELETE stays allowed for a later retention job. `actor_sub` is text, no FK, so entries outlive users.
- `server/db/audit-log.ts`: `AuditEntry`, `AuditLogRow`, `recordAudit`, `listAuditEntries(db, {limit?, beforeId?})` (newest first, default 50, max 500), `serializeAuditDetails`.
  Redaction: keys matching the requested regex -> `[redacted]`, recursively; Bearer/JWT patterns inside any string are replaced; cycles/depth > 8 -> `[omitted]`; over 8192 bytes -> `{"truncated":true,"originalBytes":n,"preview":"..."}`.
- `server/utils/api/admin-limit.ts`: token bucket per sub (burst 20, 1/s = 60/min), bounded map (10 000).
- `server/utils/api/admin-handler.ts`: `defineAdminHandler(handler, {limiter?})` is `defineApiHandler` + limiter + `requireAdmin`; context `{ db, user, identity, audit(action, target?, details?) }`. Request id: `X-Request-Id` if `[A-Za-z0-9._:-]{1,64}`, else a UUID.

## Contract

Admin routes use only `defineAdminHandler`. Limit is checked BEFORE the userinfo call (protects the IdP), after authentication; 429 + `Retry-After`. `handler.ts`/`errors.ts` untouched (429 is raised with h3 `createError`; `ApiErrorStatus` has no 429).

## Doc changes needed

- design.md §8 / security-review.md §7.3: audit log exists (table, append-only trigger, redaction, 8 KB cap), admin routes rate limited at ~60/min per sub; retention job may DELETE.
- Schema agent: add `audit_log` to the expected table list in tests/server/db.test.ts and a row type if wanted.

## Tests written, NOT run

tests/server/audit-log.test.ts, tests/server/admin-guard.test.ts.

## Risks

- Per-process limiter (looser on restart/multi-instance).
- Redaction is pattern-based; callers should still not pass secrets. A key like `sealed` or `tokens_used` is redacted too (intended: broad).
- requireAdmin re-verifies the token (second `requireUser`); cheap but double.
