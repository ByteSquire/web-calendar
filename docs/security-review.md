# web-calendar — application security review

Date: 2026-10-30. Scope: the current working tree of `/var/home/felix/Documents/web-calendar` (committed `207fc00` plus uncommitted changes) and the local test stack (gateway `nuxt dev` on `127.0.0.1:3300` inside `intelligent_mayer`, Kanidm 1.11.2 and Radicale 3.9.0 from `dev/spike-s1`). Read-only review: nothing in the repository was changed; probe data (one app token, two views, two subscriptions, three calendar objects, all named `sec-review-probe*`) was created through the API and removed again (verified empty afterwards); probe scripts lived in `/tmp` inside the container and were deleted.

## Status after the fixes (2026-10-30, later the same day)

| id                                                              | status | how                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 throttle behind a proxy                                      | fixed  | every Basic login is verified first; only failures count; the address limit is a token bucket; two `WWW-Authenticate` lines; a warning when all requests come from a proxy-looking address                                                                                                                                                                                       |
| M2 security headers and CSP                                     | fixed  | `server/utils/security`, a Nitro plugin: strict `script-src` with per-response hashes of the inline scripts, `frame-ancestors 'none'`, `connect-src` limited to the app and the identity provider, `nosniff`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, `no-store` on pages, a sandbox policy on everything else; browser tests `e2e/security-headers.spec.ts` |
| (found while fixing M2) icons fetched from `api.iconify.design` | fixed  | Nuxt Icon's default for `ssr: false` sent every browser to that public API; now `provider: 'server'`, `fallbackToApi: false`, the runtime-chosen icons named in the client bundle; a test asserts that no request leaves the app's origin                                                                                                                                        |
| L1 `is_admin`                                                   | fixed  | `requireAdmin` asks userinfo, needs the `groups` claim, fails closed; handlers no longer receive `isAdmin`                                                                                                                                                                                                                                                                       |
| L2 lazy config                                                  | fixed  | a startup plugin builds verifier, gateway and proxy config and exits on error; `validate-config.mjs`, `.env.example`, compose and the health check cover every security setting                                                                                                                                                                                                  |
| L3 `allowPrivate`                                               | fixed  | refused in production without a second, explicitly named variable                                                                                                                                                                                                                                                                                                                |
| L4 `/api` falls through to the SPA                              | fixed  | always JSON 404                                                                                                                                                                                                                                                                                                                                                                  |
| L5 userinfo per request                                         | fixed  | 60 s cache per user, shared in-flight calls, never past the token's expiry                                                                                                                                                                                                                                                                                                       |
| L6 logout                                                       | fixed  | the token is revoked at Kanidm's revocation endpoint (capped at 3 s, fail soft)                                                                                                                                                                                                                                                                                                  |
| L7 key id on app-token hashes                                   | open   | backlog                                                                                                                                                                                                                                                                                                                                                                          |
| L8 storage quota                                                | partly | Radicale `max_content_length`; no quota yet                                                                                                                                                                                                                                                                                                                                      |
| L9 `.dockerignore`                                              | fixed  |                                                                                                                                                                                                                                                                                                                                                                                  |
| I1 dependency audit                                             | open   | re-check on each Nuxt release                                                                                                                                                                                                                                                                                                                                                    |

**Moving targets.** While this review ran, other agents changed `server/utils/auth/{authenticate,errors,jwt,nitro}.ts`, added `server/utils/auth/{throttle,client-address}.ts`, changed `server/utils/gateway/{gateway,nitro}.ts`, `nuxt.config.ts` (`oidc.keyMaxAgeSec`, `gateway.trustForwardedFor`, `demo`, `icalProxy.*`) and added `app/utils/live/**`, `app/utils/writes/**`, `app/components/settings/**`, `app/pages/settings.vue`, `app/composables/useCalDav.ts`, `useLiveCalendar.ts`, `app/plugins/caldav.client.ts`. For a few minutes the dev gateway answered `500` to every `/caldav/**` and `/api/**` request because the running process had the new `server/utils/auth/nitro.ts` (requires `oidc.keyMaxAgeSec`) but not yet the new `nuxt.config.ts` default. Findings below refer to the files as they were at the time of reading (between 06:10 and 07:20 local time); line numbers for the files above may have shifted.

---

## 1. Summary

**Verdict: good foundations, no Critical or High finding. The gateway, the token verifier, the app-token store, the SSRF guard and the per-user API isolation hold up against everything that was tried, in code and against the live stack. Two Medium findings must be fixed before Phase 2 ships to real users: the new Basic-login throttle locks out every third-party client behind the documented reverse-proxy deployment, and the "strict CSP" promised by NFR-2 does not exist (no security headers at all on the SPA). Phase 3 (sharing writer, group sync, admin routes, public view) multiplies the trust the design places in Radicale's `X-Remote-User` and in a stale group file; §5 lists the controls that must exist before each of those features ships, in build order.**

| id  | severity | status                                          | title                                                                                                                                                                                                                     | file                                                                                                                                                    |
| --- | -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Medium   | CONFIRMED (code; per-user path reproduced live) | Basic-login throttle: address-wide block makes every CalDAV client lockable by an unauthenticated attacker behind the documented reverse proxy                                                                            | `server/utils/auth/throttle.ts:9,192-211`, `server/utils/auth/authenticate.ts:100-110`, `server/utils/gateway/nitro.ts:44-50`, `nuxt.config.ts:71`      |
| M2  | Medium   | CONFIRMED (live)                                | No security headers on the SPA or the API: no CSP, no `frame-ancestors`/`X-Frame-Options`, no `Referrer-Policy`, no `nosniff`; NFR-2 and design §6 claim a strict CSP                                                     | `nuxt.config.ts` (no `routeRules`/headers), observed on `GET /`, `/api/config`, `/api/ical-subscriptions/:id/data`                                      |
| L1  | Low      | CONFIRMED                                       | `users.is_admin` is persisted from userinfo and kept when the `groups` claim is missing; a stale flag sits one `if` away from becoming authorization in Phase 3                                                           | `server/utils/api/me.ts:47-52,78`, `server/db/users.ts:61`, `server/db/types.ts:108`                                                                    |
| L2  | Low      | CONFIRMED (live)                                | Security-relevant config is parsed lazily on the first request and fails there (500), not at start; `validate-config.mjs`, `.env.example` and compose do not know the new variables                                       | `server/validate-config.mjs:35-99`, `server/utils/auth/nitro.ts:15-34`, `server/utils/gateway/nitro.ts:13-35`, `server/utils/ical-proxy/nitro.ts:12-22` |
| L3  | Low      | HYGIENE                                         | `NUXT_ICAL_PROXY_ALLOW_PRIVATE=true` switches the whole SSRF guard off at runtime with only a log line; nothing stops it in production                                                                                    | `server/utils/ical-proxy/nitro.ts:14-18`, `server/utils/ical-proxy/ssrf.ts:133-142`                                                                     |
| L4  | Low      | CONFIRMED (live)                                | `/api/<route>/` with a trailing slash or an unmatched method falls through to the SPA: `200 text/html`, also without any credential                                                                                       | `server/api/[...path].ts:3-5`, observed `PUT`/`DELETE /api/views/` → 200                                                                                |
| L5  | Low      | CONFIRMED (code)                                | Every `GET /api/me` makes one uncached userinfo call to Kanidm with the caller's token (3 s timeout, no per-user limit): cheap amplification against the identity provider                                                | `server/api/me.get.ts:6-19`, `server/utils/api/userinfo.ts:64-139`                                                                                      |
| L6  | Low      | HYGIENE                                         | Logout does not revoke the refresh token at the provider; only local state is dropped                                                                                                                                     | `app/utils/auth/client.ts:183-204`                                                                                                                      |
| L7  | Low      | HYGIENE                                         | App-token hashes carry no key id: `NUXT_TOKEN_HASH_KEY` cannot be rotated without invalidating every token                                                                                                                | `server/db/app-tokens.ts:44-47`, `server/db/migrations/001_init.sql:20-29`                                                                              |
| L8  | Low      | HYGIENE                                         | No per-user storage quota: an authenticated user may `MKCALENDAR`/`PUT` without bound (10 MB per request) into the `radicale-data` volume                                                                                 | `deploy/radicale/config`, `nuxt.config.ts` (`gateway.maxBodyBytes`)                                                                                     |
| L9  | Low      | HYGIENE                                         | `.dockerignore` lets the dev-container dotfiles (`.claude/`, `.mcp.json`, `.gitconfig`, shell rc files, `.idea`, `.vscode`) into the build context and build-stage layers                                                 | `Dockerfile:13`, `.dockerignore`                                                                                                                        |
| I1  | Info     | CONFIRMED                                       | `npm audit --omit=dev`: 1 high (`node-forge` ≤1.4.0 via nitropack/listhen), 8 low (nuxt/nitro/esbuild/deepmerge); none reachable from `.output/server/index.mjs` as far as the dependency graph shows                     | `package-lock.json`                                                                                                                                     |
| I2  | Info     | CONFIRMED (live)                                | `X-Powered-By: Nuxt` on the shell; dev error pages carry stack traces and absolute paths (production handler hides them, verified in `nitropack/dist/runtime/internal/error/prod.mjs`)                                    | observed on `GET /`, `/api/nope`                                                                                                                        |
| I3  | Info     | CONFIRMED (live)                                | Test-stack hygiene: the hash key is on the `nuxt dev` command line (visible in `ps` to every process in the dev container); Radicale is published on `127.0.0.1:5232`; the Kanidm client has `enable-localhost-redirects` | `dev/spike-s1/compose.yml`, `dev/spike-s1/spike.sh:171-173`                                                                                             |

---

## 2. Findings

### M1 — Basic-login throttle: address-wide block behind the documented reverse proxy

**Where.** `server/utils/auth/throttle.ts:8-9` (`DEFAULT_MAX_USER_FAILURES = 5`, `DEFAULT_MAX_ADDRESS_FAILURES = 30`, window 600 s), `throttle.ts:192-199` (`retryAfter` refuses when _either_ counter is at its limit), `throttle.ts:201-211` and the doc comment at `:50` ("The address counter does not [reset on success]"), `server/utils/auth/authenticate.ts:100-102` (the block is applied _before_ the credentials are checked), `server/utils/gateway/nitro.ts:44-50` (`clientAddress()` = `getRequestIP(event)` unless `trustForwardedFor`), `nuxt.config.ts:71` (`trustForwardedFor: 'false'`), `docker-compose.yml:23-25` ("Bind to loopback only: expect a reverse proxy (TLS) in front").

**Scenario.** In the documented deployment every request reaches Node from the reverse proxy, so `getRequestIP` is the proxy's address for _all_ clients. An unauthenticated attacker who can reach the app sends 30 Basic requests with any user names and wrong tokens (`Authorization: Basic …`, one second of work). From then on `addresses.unblockedAt(proxyAddress)` is non-null for 600 s and `retryAfter` returns a wait for _every_ Basic login, correct tokens included: Thunderbird, DAVx5 and iOS Calendar of every user get `429` for ten minutes, and the attacker repeats this indefinitely. The per-user counter has the same shape: five wrong attempts for `alice` from anywhere lock _her_ clients for ten minutes, because all addresses are the proxy's. The code comment at `nuxt.config.ts:66-70` knows ("Off, every client behind a proxy shares the proxy's address") but the default plus the documented deployment make the weak configuration the normal one; `trustForwardedFor` is also absent from `.env.example` and compose.

**Verified.** Live, from the container's loopback: six wrong attempts for user `sec-review-nobody` → `401 ×5`, then `429` with `Retry-After: 600`; a correct token for another user name from the same address still worked (the address counter was far from 30). The 30-failure address lockout was _not_ exercised against the shared dev gateway on purpose (it would have blocked other agents' Basic logins for ten minutes); the behaviour is unambiguous in `throttle.ts:195-198` and covered by the unit test "blocks every user name of an address after 30 failures" (`tests/server/auth-throttle.test.ts:90`).

**Fix (S/M).**

1. Reorder in `authenticateRequest`: look the token up first (one HMAC and one indexed `SELECT`, microseconds), then apply the throttle only to _failures_. A correct credential is never refused; a blocked key still gets `429` without the verdict and without a log line. This removes the lockout vector entirely while keeping what the throttle was written for (bounded work and log noise).
2. Keep the per-`(address, username)` counter as is; turn the per-address counter into a _rate_ limit (token bucket, e.g. 10 attempts/s burst 30 → `429` with `Retry-After: 1`) instead of a ten-minute block.
3. In `server/utils/gateway/nitro.ts`, when `trustForwardedFor` is false and the socket peer is loopback or private, log once at startup: "all clients share the proxy's address for the login throttle; set `NUXT_GATEWAY_TRUST_FORWARDED_FOR=true` behind a trusted proxy". Add the variable to `.env.example` and compose with that comment.
4. Tests to add: "a correct Basic login succeeds while the address is blocked"; "behind a proxy (all requests from 127.0.0.1) an attacker cannot stop alice's client".

### M2 — No security headers / CSP on the SPA and the API

**Where.** `nuxt.config.ts` has no `routeRules` or header configuration; observed live: `GET /` → `content-type`, `x-powered-by: Nuxt`, nothing else; `GET /api/config` → no headers; `GET /api/ical-subscriptions/:id/data` → `cache-control: no-store`, `content-type: text/calendar`, no `x-content-type-options`. Only Nitro's _error_ pages carry `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` and a CSP. `docs/requirements.md` NFR-2 ("under a strict content-security policy") and `docs/design.md:322` ("strict CSP and no third-party scripts") describe a control that is not implemented.

**Scenario.** The tokens live in memory, which is exactly why a CSP matters: any script injection (a future dependency bug, a FullCalendar content hook someone switches to `html`, a Nuxt UI slot) gives the attacker the user's bearer token and, through it, every calendar the user may read or write, plus the ability to mint app tokens (`POST /api/app-tokens`) that outlive the session for a year. Today no injection sink exists (§3), so the CSP is defence in depth, not a fix for a live bug. Clickjacking of a signed-in instance is currently prevented only by Kanidm: its UI answers with `frame-ancestors 'none'` (checked on `https://kanidm:8443/ui/login` in the test stack), so a framed app instance cannot complete the silent login. That is the identity provider's header protecting the app; the app should not depend on it. Without a `Referrer-Policy`, pages reached after `/auth/callback?code=…&state=…` could leak that URL to any cross-origin resource that is ever added.

**Fix (S for headers, M for a CSP that passes the Playwright suite).** In `nuxt.config.ts`:

```ts
routeRules: {
  '/**': { headers: {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:", "font-src 'self'", "connect-src 'self' https://idm.example.org",
      "frame-ancestors 'none'", "form-action 'self' https://idm.example.org",
      "base-uri 'none'", "object-src 'none'",
    ].join('; '),
  } },
  '/api/**': { headers: { 'Cache-Control': 'no-store' } },
}
```

`connect-src`/`form-action` must be built from `runtimeConfig.oidc.issuer` (a Nitro plugin that sets the header is simpler than static `routeRules`). Measure against the _production_ build: the dev shell has three inline `<script>` elements (Vite client), the production shell has Nuxt's own; use hashes or move to `nuxt-security`. FullCalendar and Nuxt UI set inline `style` attributes, hence `style-src 'unsafe-inline'`; keep `script-src` strict. Add `nosniff` to the `.ics` proxy response in `server/api/ical-subscriptions/[id]/data.get.ts` even if the global header lands. HSTS belongs to the reverse proxy (document it). Remove `X-Powered-By` (`nitro: { routeRules }` cannot; set `app.head` → no; it is set by the Nuxt renderer: strip it at the proxy or with a Nitro `beforeResponse` hook).

### L1 — `users.is_admin` is a persisted copy of a Kanidm group, kept when the claim is missing

**Where.** `server/utils/api/me.ts:78` (`isAdmin: profile.groups ? isAdminByGroups(...) : undefined`), `me.ts:47-52` ("A missing `groups` claim keeps the stored admin flag"), `server/db/users.ts:61` (`is_admin = COALESCE(@isAdmin, is_admin)`), `server/db/types.ts:108` (`User.isAdmin` is in the `User` object every API handler receives through `ApiContext`).

**Scenario.** Today the flag only reaches the SPA (`/api/me`). Phase 3 plans admin routes "authorised by a userinfo group check" (design §6) — correct — but every handler already holds `context.user.isAdmin`, and the first person who writes `if (user.isAdmin)` has turned a cached, possibly stale value into authorization: a user removed from `calendar_admins` keeps `is_admin = 1` until their next `/api/me` with a token that carries `groups`; a token without the `groups_name` scope (another allowed client, a future scope change) never demotes anyone. Low today, Medium the day admin routes exist.

**Fix (S).** Rename the column to `last_seen_admin` (or drop it from `User` and expose it only from `resolveMe`), and put the rule in `server/utils/api/handler.ts`: `requireAdmin(event)` calls userinfo with the caller's token, requires the `groups` claim to be present (absence = not admin, fail closed), and is the only admin check. Test: "a stale `is_admin = 1` row does not pass `requireAdmin` when userinfo has no `calendar_admins`"; "`requireAdmin` fails closed when userinfo is unreachable or has no `groups`".

### L2 — Lazy, per-request config parsing; validation and examples lag the code

**Where.** `server/utils/auth/nitro.ts:15-34` (verifier built on first request; throws for a bad `keyMaxAgeSec`), `server/utils/gateway/nitro.ts:13-35`, `server/utils/ical-proxy/nitro.ts:12-22`; `server/validate-config.mjs:35-99` checks only `NUXT_OIDC_ISSUER`, `NUXT_TOKEN_HASH_KEY`, `NUXT_RADICALE_URL`, `TZ`, warns on `NUXT_GROUP_SYNC_TOKEN`. `.env.example` and `docker-compose.yml` list none of `NUXT_OIDC_KEY_MAX_AGE_SEC`, `NUXT_GATEWAY_TRUST_FORWARDED_FOR`, `NUXT_ICAL_PROXY_*`, `NUXT_DEMO`.

**Scenario.** Observed live: with the new `auth/nitro.ts` and an old config, `/caldav/` and `/api/me` answered `500` with `NUXT_OIDC_KEY_MAX_AGE_SEC must be a positive integer, got "undefined"` on every request. The failure is closed (no request reaches Radicale), which is right, but the container passes its health check (`GET /` is the SPA) and reports healthy while every authenticated request fails. The same shape applies to a typo in any of the lazily parsed variables.

**Fix (S).** A Nitro plugin that eagerly calls `getVerifier()`, `getGateway()` and `getIcalProxy()` at startup and exits the process on error (same pattern as `server/plugins/db.ts`); mirror every security knob in `validate-config.mjs` (type, range, and "`true` only" for the two booleans), in `.env.example` and in compose; make the health check hit `/api/config` _and_ a cheap authenticated-path self-test (e.g. `GET /caldav/` expecting `401`, which exercises the verifier wiring).

### L3 — `allowPrivate` disables the SSRF guard with a log line

**Where.** `server/utils/ical-proxy/nitro.ts:14-18`, `ssrf.ts:139-140` (both `isBlockedAddress` and `isBlockedHostname` become `() => false`).

**Scenario.** The test stack runs with it on (seen in the `nuxt dev` command line). An operator who copies the dev environment, or a compromised env file, gets a proxy that fetches `http://radicale:5232/…`, `http://kanidm:8443/v1/…`, `169.254.169.254` on behalf of any user. Confirmed live: a subscription to `http://127.0.0.1:3300/api/config` was accepted and fetched in the dev stack (then removed). Radicale answers such requests with `403` (no `X-Remote-User`), Kanidm's API needs a bearer; the realistic damage is reconnaissance and reaching other internal HTTP services.

**Fix (S).** Refuse to start when `allowPrivate` is true and `NODE_ENV=production` unless a second, explicitly named variable (`NUXT_ICAL_PROXY_ALLOW_PRIVATE_I_UNDERSTAND_THE_RISK=true`) is set; have `validate-config.mjs` print an error for it; never list it in `.env.example`.

### L4 — `/api/**` falls through to the SPA for unmatched methods and trailing slashes

**Where.** `server/api/[...path].ts` only catches paths with at least one extra segment; observed live: `PUT /api/views/`, `DELETE /api/views/`, `PUT /api/ical-subscriptions/`, `DELETE /api/app-tokens/` → `200 text/html` (the SPA shell), with or without an `Authorization` header.

**Scenario.** No action is performed, so this is not a bypass. It is a correctness trap: a client (or a test) that treats `200` as success for a mutation is misled — exactly what happened to this review's first probe run — and an unauthenticated request to an `/api/` URL gets a `200`.

**Fix (S).** Extend `server/middleware/api-guards.ts`: for `event.path.startsWith('/api/')` and a method the matched route does not implement, or a trailing slash, throw `404` (or `405` with `Allow`) JSON. Test: "every `/api/**` URL answers JSON, never the shell, for every method".

### L5 — `GET /api/me` is an uncached call to Kanidm per request

**Where.** `server/api/me.get.ts:6-19`, `server/utils/api/userinfo.ts:64-139`.

**Scenario.** An authenticated user running `GET /api/me` in a loop makes the app open one outbound TLS request to Kanidm per call (3 s timeout, `redirect: 'error'`); `MAX_FETCHES_PER_USER`-style limits exist for the iCal proxy but not here. With 50 users this is noise; it becomes relevant when admin routes (Phase 3) also call userinfo per request.

**Fix (S).** Cache the userinfo result per `(sub, token jti)` for the token's remaining lifetime (≤ 15 min), or per `sub` for 60 s; one in-flight call per user (the `KeyedLimiter` in `ical-proxy/cache.ts` fits).

### L6 — Logout keeps the refresh token alive at the provider

**Where.** `app/utils/auth/client.ts:183-204`: when discovery has no `end_session_endpoint` (Kanidm), `removeUser()` and a navigation to `/auth/signed-out`.

**Scenario.** On a shared machine "sign out" drops the in-memory tokens, but the refresh token chain stays valid at Kanidm until its session expires, and Kanidm's own session remains (documented on the signed-out page). Kanidm implements RFC 7009 token revocation: the test stack's discovery document advertises `revocation_endpoint: https://idm.localhost:8443/oauth2/token/revoke` (verified; `end_session_endpoint` is indeed absent).

**Fix (S).** Before `removeUser()`, if `metadataService` lists a `revocation_endpoint`, `POST` the refresh token to it (`token_type_hint=refresh_token`, `client_id`); oidc-client-ts has `UserManager.revokeTokens()` for this. Fail soft (still sign out locally).

### L7 — No key id on app-token hashes

**Where.** `server/db/app-tokens.ts:44-47` (`createHmac('sha256', hashKey)`), `001_init.sql:20-29` (no `key_id` column).

**Fix (S/M).** Store `key_version` per row; accept a list `NUXT_TOKEN_HASH_KEYS=v2:…,v1:…`, hash new tokens with the first, verify with the one the row names. Lets an operator rotate after a leak without logging every phone out.

### L8 — No storage quota per user

**Where.** Radicale has no quota mechanism; `deploy/radicale/config` sets none of `[server] max_content_length` (Radicale default 100 MB, the gateway caps requests at 10 MB, `nuxt.config.ts` `gateway.maxBodyBytes`), and nothing limits the number of collections or objects.

**Fix (M).** Monitor the `radicale-data` volume; set `max_content_length = 10485760` in Radicale too (defence in depth); consider a per-home size check in the gateway for `PUT`/`MKCALENDAR` (a `du` per home is cheap at this scale) or a periodic report. Low priority for 30–50 trusted users.

### L9 — `.dockerignore` gaps

**Where.** `Dockerfile:13` (`COPY . .`); `.dockerignore` excludes `.env*`, `.git`, `node_modules`, docs, dev, e2e, `.npmrc` but not `.claude/`, `.mcp.json`, `.gitconfig`, `.bashrc`/`.zshrc`/`.profile`, `.idea`, `.vscode`. Those exist in the dev-container workspace (they are in `git status`), so a build run from there copies them into the build-stage layer (not the runtime image, which copies only `.output`).

**Fix (S).** Add `.claude`, `.mcp.json`, `.gitconfig`, `.*rc`, `.*profile`, `.idea`, `.vscode`, `tests`, `playwright*.ts`, `vitest.config.ts`, `eslint.config.mjs` to `.dockerignore`.

### I1 — Dependency audit

`npm audit --omit=dev` in the container: `node-forge` high (RSA PKCS#1 v1.5 verification, reached through `listhen` → `nitropack`), `esbuild` low (dev server on Windows), `deepmerge` low (prototype poisoning, build time), `nuxt`/`@nuxt/*` low. The runtime entry `.output/server/index.mjs` does not load `listhen` or `esbuild`; `jose`, `better-sqlite3`, `oidc-client-ts`, `tsdav`/`xml-js`, `ical.js` have no advisories. Do not run `npm audit fix` (design §12). Re-check on each Nuxt release; a lockfile-based check in CI (`npm audit --omit=dev --audit-level=high` allowed to fail on the known `node-forge` id) would make drift visible.

### I2 / I3 — Information disclosure and test-stack hygiene

Dev-only: error JSON with stack traces and `/workspaces/...` paths (`nitropack/.../error/dev.mjs`); production uses `prod.mjs`, which returns `url`, `statusCode`, `statusMessage`, `message` ("Server Error" for unhandled/fatal) and no stack. `X-Powered-By: Nuxt` is sent in both. In the test stack the hash key and `NUXT_ICAL_PROXY_ALLOW_PRIVATE` are inline environment assignments on the `nuxt dev` command line (`ps` shows them), Radicale is published on `127.0.0.1:5232`, and the Kanidm client allows localhost redirects — all documented as development-only, none applies to the compose deployment.

---

## 3. Checked and fine

Everything here was read in full and, where marked _(live)_, exercised against the dev stack.

**Token verification (`server/utils/auth/jwt.ts`).** `alg` pinned to ES256 before any key is used; `typ` must normalise to `at+jwt` (an ID token has none); `kid` required; the client is picked from the unverified `iss` _then_ `jwtVerify` re-checks `iss`, `aud` (required; array accepted), `exp`/`nbf` with 60 s tolerance, `requiredClaims: ['exp','sub']`; `client_id` must match when present; `scope` must contain `caldav` as a whole word; keys imported only if `kty: EC`, `crv: P-256`, no `d`, `use` absent or `sig`, `alg` absent or ES256; key refetch for an unknown `kid` is rate-limited (30 s, 5 s after a failure); a fetch that yields no usable key is rejected rather than adopted; a cold cache with Kanidm down gives `503 Retry-After` (not `401`); the new `keyMaxAgeSec` refresh drops removed keys within an hour. _(live)_: ID token, `alg: none`, HS256 header with the real signature, swapped `sub`, unknown `kid` → all `401 … error="invalid_token"`. The JWKS URL is built from config only (`redirect: 'error'`, 5 s timeout).

**Gateway (`server/utils/gateway/**`).** Request headers go through an _allow-list_ (`FORWARDED_REQUEST_HEADERS`); `X-Remote-User`, `X-Script-Name`, `X-Forwarded-*`, `X-Remote-Addr`, `Forwarded`, `Cookie`, `Authorization`, method-override headers never reach Radicale. _(live)_: alice's token plus spoofed `X-Remote-User: <bob>`, `X-Script-Name`, `X-Forwarded-User`, `Remote-User`, `X-Remote-Addr`, `Forwarded`, two `X-Remote-User` lines, `Connection: X-Remote-User` → principal is still alice; bob's home/calendar/objects → `403` for `PROPFIND`, `GET`, `PUT`, `MKCOL`, `REPORT`, `MOVE`, `COPY`; `PROPFIND /caldav/ Depth: 1` lists only alice's own home (Radicale filters the root listing by rights); `Depth: infinity` is bounded by Radicale (2.3 KB). Methods: `POST`, `POST + X-HTTP-Method-Override`, `PATCH`, `LOCK`, `TRACE`, `ACL` → `405` _(live)_. Paths: every segment is decoded exactly once, re-encoded canonically, `.`/`..`, `/`, `\`, control characters, bad percent-encoding, unencoded non-ASCII and empty segments are refused (`400`), a leading dot-name is `404` (Radicale's `.sharing`/`.web` namespace), the query string is dropped (`tests/server/gateway-paths.test.ts` has 80+ cases). _(live, raw socket)_: `/caldav/<a>/../<b>/`, `/caldav/<a>/%2e%2e/<b>/`, `\`, `%00`, `%0d%0a`, raw space → `400`; `..;` → `404`; absolute-form target and `//caldav/` are not routed to the gateway at all (SPA shell). `Destination`: scheme must be http(s), authority may not hold `@`, `\` or whitespace, the host is _ignored_ and the path normalised like a request path; outside `/caldav/` → `403`, traversal → `400`, reserved → `403`; _(live)_ MOVE to bob's calendar → `403` (Radicale), to a foreign host but own path → `201` (host ignored, moved within the own store, then deleted). Bodies: `Content-Length` must be 1–15 digits (`-1` → `400`), over the limit → `413` before reading, chunked bodies are buffered up to the limit and forwarded with a length (Radicale ignores chunked), a body longer than declared is cut and the client gets `413`, `GET`/`HEAD` bodies are discarded; _(live)_ `Expect: 100-continue` with an 11 MB declaration → `100` then `413`; a 300 KB event round-trips. Smuggling shapes _(live)_: `Transfer-Encoding: chunked` + `Content-Length`, `Transfer-Encoding: xchunked`, duplicate `Content-Length` → `400` from Node's parser; a 20 KB `Authorization` → `431`; 9 KB → `401` (`MAX_HEADER_LENGTH` 8192). Responses: hop-by-hop headers, `Connection`-named headers, `Set-Cookie`, `Server`, `X-Powered-By`, `WWW-Authenticate` and `Access-Control-*` from Radicale are dropped, `nosniff` added, `Content-Encoding`/`Content-Length` dropped when fetch decoded the body; _(live)_ no `Server:` on a Radicale `404`. A `401` from Radicale becomes `502` (gateway fault, never a challenge to the client). `redirect: 'manual'` upstream. CORS: off by default, no reflection of `Origin` _(live)_, exact-origin allow-list only, no credentials, preflight answered without auth only for an allowed origin.

**Authentication plumbing (`authenticate.ts`).** `Authorization` parsed with a linear regex, scheme case-insensitive; Basic must be valid base64 and UTF-8 with a non-empty name and token; `/api/**` accepts bearer only (Basic → `401`, _(live)_); the subject is checked against `isValidSubject` (printable ASCII, no `/` or `\`) on both paths before it becomes a path component and a header. Failure reasons are logged, never sent.

**App tokens (`server/db/app-tokens.ts`).** `wcal_` + 32 random bytes (base64url), HMAC-SHA256 with the server key, only the hash stored (unique index), one year expiry, 10 unexpired per user, label 1–100 chars, revocation deletes the row and takes effect immediately _(live)_, lookup by `(token_hash, username)` with Kanidm's case-insensitive name _(live: `ALICE` works, the `sub` as user name does not, bob's name with alice's token does not)_, `last_used_at` written at most once a minute, the secret appears in the create response only _(live: list has no secret and no hash field)_, another user's `DELETE` → `404` _(live)_. The HMAC key makes offline guessing of a leaked `token_hash` column infeasible without the key.

**App API isolation.** Every `SELECT/UPDATE/DELETE` in `server/db/*.ts` is a prepared statement scoped by `owner_id`/`user_id`; "not yours" and "not found" are the same `404`; ids must match `^[1-9][0-9]{0,14}$` (`0`, `-1`, `1e3`, `3%20` → `404` _(live)_); bodies are read field by field and unknown fields (`isAdmin`, `ownerId`, `is_admin`, `userId`, `__proto__`) are ignored _(live: the created view has `isAdmin:false`, `ownerId:<own id>`)_; admin views and shared categories/subscriptions are read-only for everyone (`is_admin = 0`/`owner_id = ?` in the `UPDATE`); per-user caps (views 100, filters 100, categories 200, prefs 500, subscriptions 50, tokens 10); JSON bodies ≤ 256 KB (`413` _(live)_), chunked → `411` _(live)_; `readBody` uses `destr` (no prototype pollution); view `definition` JSON is re-parsed defensively on read; the `ref` grammar rejects control characters. `cache-control: no-store` on every API answer.

**Users.** Created from the verified `sub` only; profile fields from userinfo are taken only when userinfo's `sub` equals the token's `sub`; a username that moves to another `sub` is cleared from the stale row (no username squatting across renames); userinfo is called with `redirect: 'error'`, a hard 3 s race timeout and a 64 KB cap.

**iCal proxy and SSRF guard (`server/utils/ical-proxy/**`).** Scheme allow-list (`http`, `https`, `webcal`→`https`), credentials in the URL refused, hostname ≤ 253, URL ≤ 2000, fragment dropped; the WHATWG parser canonicalises decimal/octal/hex IPv4 and bracketed IPv6; IPv4 block list is complete (0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4); IPv6 allows only `2000::/3` minus 2001::/23, 2001:db8::/32, 2002::/16, 3fff::/20 (so `::1`, `::`, mapped, compatible, NAT64 `64:ff9b::`, link-local, ULA, multicast are all blocked); `localhost` and `*.localhost` (with trailing dot) blocked without DNS; names are resolved _inside_ the socket's `lookup` so DNS rebinding between check and connect is moot, and a name with one private record is refused; each redirect hop (≤ 3) is re-checked; `agent: false` (no pooled socket), identity encoding only, 5 MB cap while streaming, one deadline for all hops, `node:http(s)` does not honour `HTTP_PROXY`; cache bounded (200 entries, 64 MB), 4 concurrent fetches per user, in-flight sharing per URL, never serves stale on error, logs host only. _(unit-level, via `vite-node`, production policy)_: 55 URL forms were tried; every one that denotes a local or private address was rejected or blocked (`127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`, `017700000001`, `0`, `0.0.0.0`, `[::ffff:169.254.169.254]`, `[::ffff:a9fe:a9fe]`, `[::ffff:7f00:0001]`, `[64:ff9b::7f00:1]`, `[2002:7f00:1::1]`, `[2001::1]`, `[fe80::1]`, `[fc00::1]`, `172.31.255.255`, `100.64.0.1`, `198.18.0.1`, `224.0.0.1`, `255.255.255.255`, `LOCALHOST.`, `foo.localhost`, `127.0.0.1.nip.io`), `file:`, `gopher:`, `ftp:`, `javascript:` and any URL with userinfo were rejected, and the confusion forms `example.com#@127.0.0.1` and `example.com\@127.0.0.1` parse to the public host `example.com` (WHATWG semantics), so they fetch `example.com`, not the loopback; `radicale`, `kanidm`, `idm.localhost`, `127.0.0.1.nip.io` blocked at resolution; `fetchIcal` to `radicale:5232`, `127.0.0.1:3300`, `[::1]:3300` → `blocked` without a connection. _(live, API)_: `file://`, `javascript:`, userinfo URLs → `400`. The data endpoint answers `text/calendar`, `no-store`, and only to the owner or for shared rows _(live: bob → 404)_.

**Browser login (`app/utils/auth/**`).** Authorization code + PKCE through oidc-client-ts; access/refresh/ID tokens in `InMemoryWebStorage` (gone on reload), login state (`state`, verifier, `returnTo`) in `sessionStorage` (per tab); `returnTo` is validated when stored _and_ when read (`safeReturnTo`: one leading slash, no `//`, no control characters or backslashes, re-parsed against a dummy origin, `/.//evil` caught, `/auth/*` refused); one renewal in flight (Kanidm refresh-token rotation); the bearer token is attached only to requests whose resolved origin is the app's own, and a 401 triggers exactly one renew-and-retry; provider error text is interpolated as text on the callback page; no token appears in any log line (checked every `console.*` call) or URL.

**CalDAV client (`app/utils/caldav/**`).** Every href from a server answer is resolved and must be http(s) on the _server's_ origin without credentials before it is requested (`resolveRequestUrl`), otherwise the entry is dropped; `hrefForCaller` keeps `javascript:` recognisable and never dereferences it; XML written by the client escapes text; ETags are validated for control characters before going into `If-Match`; the multistatus well-formedness check (`xml.ts`) is linear — _(measured)_ 300k-character adversarial inputs (unterminated tags, quote floods, `<` floods) in ≤ 2.6 ms, 100k-deep nesting 19 ms, 5 MB text 2.4 ms; tsdav's `xml-js`/sax parser does not expand DTD entities.

**iCal parsing and writing (`app/utils/ical/**`).** Recurrence expansion is bounded (`DEFAULT_MAX_OCCURRENCES` 2000, `MAX_SKIPPED_OCCURRENCES` 50 000, iterator work limits 100 000/2 000 000 steps, `MAX_SLOTS` 60 000, VTIMEZONE onsets 2000, zone cache 64); unreadable components are salvaged one by one instead of failing or hanging; every regex has an anchored, bounded shape; user text going into a resource passes `stripControl` + `escapeText` (no line injection) and lines are folded at 75 octets; parameters are quoted per RFC 6868.

**Rendering.** No `v-html`, `innerHTML`, `document.write` or dynamic `href` anywhere in `app/`; FullCalendar `eventContent` slots render `{{ event.title }}` as text; colours bound into `style` are normalised to `#rrggbb` (`normalizeColor`, `readColor`) before use; descriptions render with `whitespace-pre-line` as text.

**Deployment.** Both containers `read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs for `/tmp`; app bound to `127.0.0.1:3000`; Radicale has no published port and its rights/config are bind-mounted read-only; the Dockerfile runs as `node`, installs with `--ignore-scripts`, copies only `.output` into the runtime stage; `.env` is in `.dockerignore` and `.gitignore`; `validate-config.mjs` refuses a non-https issuer, an issuer whose last segment is not the client id, a short hash key; Radicale's rights file is owner-only (`{user}` is `re.escape`d by Radicale) and _(live, direct to Radicale)_ an unauthenticated request → `403`, a spoofed `X-Remote-User` → full access (confirming why the gateway is the whole defence). Test credentials live in `dev/spike-s1/.local/secrets.env` (git-ignored, mode 600) and are read by `e2e/live/credentials.ts` without logging.

---

## 4. Test gaps

What exists is good (`tests/server/auth-jwt.test.ts`, `gateway-*.test.ts`, `auth-throttle.test.ts`, `ical-ssrf.test.ts`, `ical-fetcher.test.ts`, `api-routes.test.ts`, the opt-in `tests/integration/gateway.integration.test.ts`). Missing, in priority order:

1. **Throttle behind a proxy.** "A correct Basic login succeeds while the shared address is blocked" and "30 failures from the proxy address do not block alice's client" — both fail today (M1) and should be written first as the specification of the fix.
2. **Security headers.** One test per surface (`/`, `/api/config`, `/api/views`, `/api/ical-subscriptions/:id/data`, `/caldav/` 401) asserting `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`; a Playwright run of every view with the production CSP (console must show no CSP violation).
3. **`/api/**` never serves the shell.** For every route file: trailing slash and each unsupported method → JSON `404`/`405`, with and without a token (L4).
4. **Gateway against the production build.** The integration test is skipped without `GATEWAY_IT=1` and real tokens, and the dev server in front of it is not what ships: the dev proxy enforces a `Host` allow-list (`Host: evil.example` → `403` before the gateway) and rewrites nothing, but it is still a different code path. Run the integration suite in CI against `.output/server/index.mjs` with a fake Radicale (the `gateway-http.test.ts` server) plus the captured Kanidm JWKS fixture; add raw-socket cases (absolute-form target, `//caldav/`, TE+CL) so the Node-level behaviour is pinned.
5. **Cross-user through every method.** The integration test covers `PROPFIND`/`GET`/`PUT`; add `MOVE`/`COPY` with a `Destination` in bob's home, `MKCOL`/`MKCALENDAR` under bob, `PROPPATCH` on bob's calendar, `REPORT` on bob's calendar, `DELETE` of bob's object, and the same set over Basic.
6. **Admin flag is not authorization.** Once `requireAdmin` exists: stale `is_admin = 1` + userinfo without the group → `403`; userinfo unreachable → `403`; userinfo without a `groups` claim → `403` (L1).
7. **Config fail-fast.** `validate-config.test.ts` cases for every new variable; a startup test that a bad `NUXT_OIDC_KEY_MAX_AGE_SEC`/`NUXT_GATEWAY_MAX_BODY_BYTES` exits the process instead of producing 500s (L2); `allowPrivate` refused in production (L3).
8. **Logout.** Unit: revocation endpoint called when advertised; e2e (live suite): after sign-out, Back does not land in a signed-in app.
9. **Regression guards for DoS limits.** A timing assertion for `isWellFormedXml` on the adversarial inputs used here (≤ 50 ms for 300k chars); recurrence fixtures that hit each `MAX_*` limit and assert the warning rather than a hang; a 5 MB `.ics` through `readEvents` within a time budget.
10. **Proxy response hygiene.** `nosniff`/`no-store` on the `.ics` data endpoint; a feed whose body starts with `BEGIN:VCALENDAR` but is served as `text/html` by the source comes back as `text/calendar` only (it does _(live)_; pin it).
11. **Userinfo amplification.** Once cached (L5): N concurrent `/api/me` for one user make one upstream call.
12. **Key rotation, live.** A real rotation in the test Kanidm (`kanidm system oauth2 … rotate`) with the `keyMaxAgeSec` path: old token rejected after the refresh, new one accepted; currently unit-tested only (design §12 S6 "not verified").

---

## 5. Plan ahead: security design for the remaining phases

Order of work (each item lists what must exist _before_ the feature ships and the first tests to write):

**0. Prerequisites for all of Phase 3 (do first).** (a) `requireAdmin` (L1) as the only admin check, fail closed. (b) An **audit log** table (`audit_log`: `at`, `actor_sub`, `action`, `target`, `details` JSON, `request_id`) written by every admin mutation and by the sharing writer and group sync; never contains tokens. (c) Security headers/CSP (M2) — the admin UI is the highest-value XSS target. (d) Fix M1. (e) A `server/plugins/startup.ts` that fails fast (L2).

### 5.1 Sharing writer (`calendar_acl` → Radicale map shares)

_Threat model._ The writer acts as the calendar owner (`X-Remote-User`) against `/.sharing/v1/map/*` — it is the one component that **must** send an identity it did not verify. Bugs here hand calendars to the wrong principal (a typo in a `sub`, a name instead of a `sub`, a group name that is also a user name), and a drift between SQLite and Radicale's CSV is a silent authorization error in either direction. An admin who may edit `calendar_acl` can grant themselves anything (acceptable if audited). Radicale's sharing database is a CSV file with no transactions.

_Controls before shipping._

- The writer talks to Radicale through a **separate internal client** (not the public gateway), on a path the gateway cannot reach from outside (it already refuses dot-names). Never expose `.sharing` through `/caldav/`.
- Principals are stored as **Kanidm `sub` UUIDs** for users and **group UUIDs** (or SPNs) for groups, validated against Kanidm at write time (`GET /v1/person/<name>` / `/v1/group/<name>` with the sync token) and against `isValidSubject`. Never pass a free-text name to Radicale.
- **Reconcile, do not patch:** compute the desired share set from `calendar_acl`, read Radicale's actual share list, apply the diff, then re-read and compare; log and alarm on any residual difference. Run on every ACL change and on a timer (5 min). A share Radicale has that SQLite does not know is **removed** (fail closed), and the removal is audited.
- `permission` mapping is a closed table: `read → r`, `write → rw`, `free_busy → f` (confirm `f` works for map shares — S5 open item — before offering it; until then `free_busy` is refused by the API), `admin` → app-level only, never a Radicale permission.
- Radicale is unreachable → the writer retries with backoff and the API returns `503` for ACL writes; it never records an ACL row as applied until Radicale confirmed it (`calendar_acl.applied_at`).
- Radicale's shares CSV is on the `radicale-data` volume: back it up with the collections; a restore of one without the other re-grants or revokes access.

_First tests._ Fixture ACL sets → expected share lists; a share Radicale invented is removed; a `sub` that is not a UUID is refused; the gateway still answers `404` for `/caldav/.sharing/**` after the writer exists; end to end: bob gains `r` on alice's calendar and `PROPFIND` of his home lists it, `PUT` gets `403`; the ACL row is deleted and the listing is empty within one reconcile.

_Challenge: Radicale as the only enforcement point._ It is a reasonable choice (the gateway cannot filter inside a `calendar-query` response), but it means a Radicale rights/sharing bug is a full breach and the app has no second opinion. Two cheap mitigations: (1) the gateway enforces a **path-level pre-check** from SQLite for the subset it can express — the collection owner is the caller, or `calendar_acl` grants the caller something on that collection path; anything else is `403` before Radicale is asked. This is defence in depth, not a replacement, and it also closes the enumeration of foreign homes. (2) A nightly **consistency audit** that lists every home's visible collections as each user (through the internal client) and compares with `calendar_acl`.

### 5.2 Group sync (Kanidm → `htgroup`)

_Threat model._ The sync credential is the most powerful secret the app holds. Design §12 S9 puts the service account in `idm_group_admins` with a read-only token as the only barrier: whoever can generate a read-write token for that account (an `idm_admin`) or whoever finds a Kanidm bug in token scoping gets group-admin power over the whole directory, and a leaked read-only token exposes all memberships. Staleness is an authorization error: a removed member keeps access up to the interval plus Radicale's reaction; a failed sync that empties the file revokes everyone's shared access (availability) or, worse, a partially written file is read by Radicale mid-write.

_Controls before shipping._

- **Least privilege first:** try Kanidm's LDAP interface with a service-account bind (read-only by construction) before accepting `idm_group_admins`; if the API route stays, document the residual risk in `kanidm-setup.md`, set a token expiry ≤ 90 days and a rotation runbook, and alarm (`audit_log`) on any `403`/`401` from the sync (a revoked token must be noticed within one interval).
- Only the groups referenced by `calendar_acl` (plus `calendar_admins`, `web_calendar_users`) are read — never "all groups".
- **Atomic file write:** write `htgroup.tmp` in the same directory, `fsync`, `rename`. Validate the content (one `name: member member` line per group, members are valid subjects) before the rename. Keep the previous file as `htgroup.prev`.
- **Fail-closed on error, fail-open on outage, explicitly:** a sync that returns an error leaves the file untouched and raises a warning; after N consecutive failures (e.g. 10 min) escalate to an error and show it on the admin page; never write an empty file because Kanidm answered `null`.
- Staleness budget is a config value with a documented default (60 s) and a **hard ceiling** (`NUXT_GROUP_SYNC_INTERVAL_SEC ≤ 300`).
- Complement the poll with **event-driven refresh**: when a user's `/api/me` userinfo shows a group change, trigger a sync run.
- Members are written as `sub` UUIDs (what `X-Remote-User` carries), resolved from the SPNs Kanidm returns.

_First tests._ Fixture Kanidm answers → exact file content; an API error leaves the file unchanged; a `null` answer never empties the file; the rename is atomic (no partial file observable); a member removed in the fixture is gone from the file after one run; the token never appears in logs.

### 5.3 Admin routes

_Controls._ `requireAdmin` (L1) on every admin handler, userinfo per request (or L5's cache ≤ 60 s), `groups` claim required; admin mutations audited with actor `sub`; the admin group name is config with a non-empty default; the SPA hides but never relies on hiding. Rate-limit admin mutations per actor (e.g. 60/min). Admin views: `is_admin = 1`, `owner_id = NULL`, validated like user views; "calendars the viewer cannot access are omitted" is done by Radicale returning `403`, not by the app guessing.

_First tests._ Non-admin with a forged `isAdmin` in the body → `403`; admin whose userinfo lost the group → `403`; audit row per mutation.

### 5.4 Resources and booking (FR-16–19)

_Threat model._ A booking writes into **two** calendars (the booker's and the resource's); the resource calendar is shared broadly as free/busy, so any leakage of the opaque block's content (title, description, attendee names, the back-reference) defeats FR-18. Bookers need `rw` on the resource calendar, so a booker can delete or alter _other people's_ blocks (Radicale has per-collection, not per-item, rights). Double booking is a race.

_Controls before shipping._

- The block is written by the **server** (internal client, acting as the resource's service principal `_resources`), not by the browser with the user's token: users then need **no** write permission on resource calendars, which removes the "booker deletes another booker's block" problem and lets the server enforce "one booking per slot" with a `calendar_bookings` table (`resource_id`, `start`, `end`, `owner_sub`, `booking_uid`, unique on `(resource_id, start, end)` or a conflict check in one transaction).
- The block carries only `DTSTART`/`DTEND`, `UID`, `SUMMARY:Reserved`, `TRANSP:OPAQUE`, `CLASS:CONFIDENTIAL`, and the back-reference as an opaque id (`X-WEBCAL-BOOKING:<calendar_bookings.id>`), never the booking calendar's path or event UID. The SPA resolves details through an API that checks the caller's access to the booking calendar (via Radicale: a `PROPFIND` of that calendar as the caller) before returning anything.
- Users get `f` (or `r` if `f` is impossible as a map share) on resource calendars; the API refuses `write` ACLs on `kind = resource`.
- Accept/decline (FR-19) is app-side state in `calendar_bookings` with an audit trail; CalDAV scheduling (RFC 6638) would reintroduce arbitrary iTIP input and should not be the first implementation.
- Limits: bookings per user per day, maximum duration, no bookings further than N years out.

_First tests._ Block text contains nothing but the allowed properties; a user with `f` cannot `GET` the block; two concurrent bookings of the same slot → one succeeds; a booker cannot delete another's block; a non-reader of the booking calendar gets "blocked" from the detail API.

### 5.5 Public view and publishing (FR-14, FR-26, FR-27)

_Threat model._ The first **unauthenticated** read path. Everything it serves is public; the risk is over-sharing (a wrong `published_calendars` row, a resource calendar, a personal calendar), the credential it uses (a service principal with read on published calendars — if it is a Radicale identity with broad rights, the public endpoint becomes an oracle), and DoS (unauthenticated `REPORT`s are expensive).

_Controls before shipping._

- Public reads go through a **dedicated server endpoint** (`/public/<slug>.ics` and `/public/<slug>/events?from&to`), never through `/caldav/`; the endpoint maps `slug → calendar` from `published_calendars`, fetches as a `_public` Radicale principal that has **only** map shares for exactly the published calendars (`r`), never a rights-file rule, and **strips** properties server-side to an allow-list (`SUMMARY`, `DTSTART`, `DTEND`, `RRULE`, `LOCATION` if configured, `UID`, `DTSTAMP`; never `DESCRIPTION`, `ATTENDEE`, `ORGANIZER`, `X-*`, `ATTACH`, `URL`).
- Publishing is admin-only and audited; the API refuses `kind = resource` and personal calendars unless the owner is the publisher; unpublishing removes the map share in the same reconcile.
- Caching with a short TTL (60 s) and a **stale-while-revalidate** allowance _for the public view only_ (NFR-4's "no stale data" is about signed-in users; document the exception), rate limiting per IP (e.g. 60/min), `Cache-Control: public, max-age=60`, a separate CSP for the public page, no cookies.
- Slugs are random (not the calendar id) so publishing is not enumerable; revoking a publication rotates the slug.

_First tests._ Allow-list of properties; an unpublished calendar's slug → `404`; a resource calendar cannot be published; rate limit; the `_public` principal cannot read an unpublished calendar directly.

### 5.6 External CalDAV accounts in the browser (FR-8)

_Threat model._ Credentials for _other_ servers live in the browser. The attacker-controlled component is now the **remote CalDAV server**: hostile XML, hostile hrefs, enormous responses, CORS-dependent behaviour, and — the serious one — credential misdirection: anything that makes the browser send account A's credentials to host B. Stored `ext:` refs in views and prefs (`readCalendarRef` accepts any string ≤ 500 chars) are a second-order input: an admin-shared view could carry `ext:<account>:<url>`.

_Controls before shipping._

- Credentials are **bound to an origin**, not to a ref: an account record is `{ id, origin, authMode, …}`; the account's fetch wrapper refuses any request whose resolved origin ≠ the account's origin (the same rule `createAuthFetch` applies to the app's token). `resolveRequestUrl` already enforces the server's origin for hrefs — keep it and add the credential check at the fetch layer.
- Storage: OIDC tokens for external accounts in memory only (re-login per tab, same as the app); Basic passwords **not stored at all** by default (prompt per session), with an explicit opt-in "remember on this device" that stores in IndexedDB encrypted with a key held in… nothing better than the same origin — so say plainly in the UI that XSS = password theft, and keep M2's CSP as the control. Never put them in `localStorage` under a guessable key; never include them in error reports.
- `ext:` refs in _admin_ views are refused (admins must not steer users' external credentials); in user views they must name one of the user's own account ids.
- All the existing XML/href hardening applies; add response size caps (5 MB) and a per-account concurrency limit; a `bad-response` from an external account must not disable the built-in service (NFR-4).
- Presets shipped by the operator (design §5) are origin + auth mode only, never credentials.

_First tests._ A multistatus whose hrefs point to another host → entries dropped, nothing requested; account A's credential is never attached to account B's origin (unit test on the fetch wrapper with a hostile redirect); an admin view with an `ext:` ref → `400`.

### 5.7 Admin-shared views and per-user preferences

Views: already read-only for non-owners; admin views need `requireAdmin` on write and the `ext:` refusal above. Preferences: `calendar_ref` is free text ≤ 500 — fine as an opaque key, but never turn it into a URL or path without going through `resolveRequestUrl`/the gateway. `users.time_zone` (FR-32): validate with `Intl.DateTimeFormat` as `validate-config.mjs` does.

### 5.8 S7 third-party clients over Basic

Before telling users to configure Thunderbird/DAVx5/iOS: fix M1; give the two `WWW-Authenticate` challenges as **two header lines** or `Basic` first without the `charset` parameter (Node joins repeated headers with `, `, and some clients mis-parse `Basic realm="…", charset="UTF-8", Bearer realm="…"`); document that the user name is the Kanidm short name and the password an app token; make `/.well-known/caldav` and `/caldav/` answer unauthenticated `OPTIONS` with `DAV:` headers if a client needs it (currently `401`, which is acceptable per RFC but trips some discovery code); consider `last_used_at` plus client `User-Agent` in the token list so users can spot an unknown device; expose "revoke all" in the UI.

### 5.9 Reverse proxy, TLS, `X-Forwarded-*`

Document a reference configuration: TLS 1.2+, HSTS (`max-age=31536000; includeSubDomains`), `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` **and** `NUXT_GATEWAY_TRUST_FORWARDED_FOR=true`, `client_max_body_size` ≥ the gateway limit (so the gateway's `413` is the one the client sees), `proxy_request_buffering off` for `/caldav/` (streamed `PUT`s), no path normalisation surprises (`merge_slashes` is fine: the gateway refuses `//` anyway), the app's port bound to loopback only, and that nothing but the proxy may reach `:3000`. The app itself must not trust `X-Forwarded-Host`/`-Proto` for anything security-relevant (it does not today; Nitro's error handler only uses them to echo the URL).

### 5.10 Backups

Back up the SQLite file (with `VACUUM INTO` or `sqlite3 .backup`, not a file copy of a WAL database), `radicale-data` (collections **and** `sharing.csv` — the share list is authorization state), and the group file is regenerable. Backups contain app-token hashes (useless without the key) and, from Phase 3, ACLs: encrypt at rest, restrict access, and test a restore that re-runs the sharing reconcile (so SQLite and Radicale agree after restore). Record the hash key separately from the DB backup.

### 5.11 Design challenges, summarised

- **Radicale as the only enforcement point** — acceptable, with the gateway pre-check and nightly consistency audit of 5.1 as second opinion.
- **`idm_group_admins` service account** — not acceptable as the final state; LDAP read-only bind or a future Kanidm read-only role, with expiry/rotation/alarm meanwhile.
- **Revocation latency ≤ 15 min** — acceptable for bearer tokens _given_ that app tokens are instant and that admin actions re-check userinfo; add a `/api/me`-triggered "kill switch": if userinfo returns `401` for a token that still verifies, treat it as revoked for the rest of its lifetime (an in-memory deny-list of `jti`).
- **Group-sync staleness** — bound it (≤ 300 s), make it observable, and let `/api/me` trigger a sync.
- **Public client with tokens in the browser** — the right model for an SPA; the CSP (M2), in-memory storage and same-origin token attachment are the controls; keep the refresh token in memory only.
- **`X-Remote-User` trust** — the gateway is the sole writer today; the sharing writer and the public endpoint add two more. Each must be a separate module with its own allow-listed header set and its own tests, and Radicale must stay unreachable from anything else (compose network, no port).
- **A writer that rewrites rights files** — do not; keep the rights file static (as designed) and use shares + the group file only.
- **SQLite as the source of truth for ACLs** — fine, as long as "truth" is enforced by reconcile-and-remove, not by append-only writes.
- **Public publishing credentials** — a dedicated principal with shares for exactly the published set and a property allow-list at the endpoint; never a rights-file wildcard.

---

## 6. Hardening backlog (ordered)

| #   | item                                                                                                                                                         | effort |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | M1: verify-then-throttle ordering, address counter as rate limit, startup warning and documented `NUXT_GATEWAY_TRUST_FORWARDED_FOR`                          | S/M    |
| 2   | M2: security headers on every response, CSP measured against the production build, `nosniff` on the `.ics` proxy answer, strip `X-Powered-By`                | S + M  |
| 3   | L2: eager startup wiring (`startup.ts`), every security variable in `validate-config.mjs`, `.env.example`, compose; health check exercises the verifier path | S      |
| 4   | L1: `requireAdmin` fail-closed; rename/isolate `is_admin`                                                                                                    | S      |
| 5   | L4: `/api/**` always JSON (`404`/`405`), never the shell                                                                                                     | S      |
| 6   | L3: production guard for `allowPrivate`                                                                                                                      | S      |
| 7   | L5: userinfo cache per sub/jti with in-flight sharing                                                                                                        | S      |
| 8   | L6: RFC 7009 revocation on logout (`UserManager.revokeTokens`)                                                                                               | S      |
| 9   | Two `WWW-Authenticate` lines / drop `charset` for client interop (5.8)                                                                                       | S      |
| 10  | L9: `.dockerignore` additions                                                                                                                                | S      |
| 11  | L7: `key_version` on app tokens, multi-key verification                                                                                                      | S/M    |
| 12  | `audit_log` table and writer (prerequisite for Phase 3)                                                                                                      | M      |
| 13  | Gateway path pre-check from SQLite (owner or ACL) as defence in depth (5.1)                                                                                  | M      |
| 14  | Radicale `max_content_length = 10485760`; volume monitoring; per-home size report (L8)                                                                       | S/M    |
| 15  | Integration suite against `.output` in CI with a fake Radicale and the JWKS fixture (test gap 4)                                                             | M      |
| 16  | `npm audit --omit=dev` in CI with the known `node-forge` id allowed                                                                                          | S      |
| 17  | Reverse-proxy reference config and HSTS in the README (5.9)                                                                                                  | S      |
| 18  | Backup runbook (`VACUUM INTO`, `sharing.csv`, key kept apart) (5.10)                                                                                         | S      |

---

## 7. Suggested changes to `docs/requirements.md` and `docs/design.md`

**requirements.md**

- NFR-2, replace "under a strict content-security policy" with concrete, testable text: "Every response of the app carries `Content-Security-Policy` with `script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`. The policy is verified by an automated browser test of every view."
- NFR-2, add: "Authentication failures are rate-limited per client and per user name; a correct credential is never refused because of someone else's failures. The limits are documented and tested behind a reverse proxy."
- NFR-2, add: "Administrative rights are decided per request from the identity provider's group membership; no stored copy of a group membership is used for authorization. Administrative actions and every change to access rules are written to an audit log with actor, time and target."
- NFR-2, add: "The CalDAV backend's identity header is set by at most three named components (the gateway, the sharing writer, the public endpoint), each with its own tests; the backend is reachable from nothing else."
- NFR-4, add a sentence that the planned public view may serve data up to 60 s old (the one exception to "no stale data").
- New NFR-7 (Operability/security): "The server refuses to start with an invalid or missing security setting; a settings error is never discovered at the first request. All security settings are listed in `.env.example` with their defaults."
- FR-31, add: "Tokens can be revoked individually and all at once; the list shows last use. The hashing key can be rotated without invalidating existing tokens."
- FR-26/27 (planned), add: "Published calendars are served through a dedicated unauthenticated endpoint with a property allow-list (never descriptions, attendees or attachments), random non-enumerable addresses, rate limiting and a short cache; publishing is an audited admin action."
- FR-8, add: "Credentials of an external account are bound to that account's origin and are never sent elsewhere; administrators cannot reference external accounts in shared views."

**design.md**

- §6 "Security": replace the sentence with what is built (PKCE, state, tokens in memory, login state per tab) and what is **not yet** built (CSP, headers), with a pointer to the header plan; record that Kanidm's `frame-ancestors 'none'` is the only clickjacking control today.
- §6: add the Basic-login throttle (limits, window, `trustForwardedFor`, the verify-then-throttle order once fixed) and `keyMaxAgeSec`.
- §6 "Groups and admin": state explicitly that `users.is_admin` is informational and that `requireAdmin` calls userinfo and fails closed without a `groups` claim.
- §7 gateway: list `NUXT_GATEWAY_TRUST_FORWARDED_FOR` and what it does to the throttle; note the dev server's `Host` allow-list and that gateway tests must run against the production build.
- §8: add the writer's reconcile-and-remove rule, principal format (`sub` UUIDs), `applied_at`, the internal client, and the gateway pre-check; add the resource-booking rule "blocks are written by the server as `_resources`; users never have write on resource calendars".
- §8 "Groups": atomic write, fail-closed/fail-open rules, hard ceiling on the interval, event-driven refresh from `/api/me`; record the `idm_group_admins` residual risk and the LDAP alternative as the target.
- §10: add the reverse-proxy reference (HSTS, forwarded headers, body size, request buffering), the full `NUXT_*` list with the security-relevant ones marked, the health check that exercises the verifier, and the backup procedure (`VACUUM INTO`, `sharing.csv`).
- §12 risks: add "throttle behind a proxy", "CSP compatibility with FullCalendar/Nuxt UI (inline styles)", "userinfo amplification", "token key rotation".

---

## 8. What was not checked and why

- **The production build (`.output`)**: not built (would share `.nuxt`/`node_modules` with working agents). Header behaviour, inline scripts for the CSP, and the error handler were read from Nitro's `prod.mjs`, not observed.
- **A real reverse proxy** in front of the app (TLS, `X-Forwarded-For` chains, path normalisation): reasoned from code and the proxy's documented defaults.
- **The 30-failure address lockout, live**: deliberately not run against the shared dev gateway; the per-user path was reproduced and the code is unambiguous.
- **Kanidm's `/ui/oauth2` authorise page in an iframe**: `frame-ancestors 'none'` was observed on `/ui/login` only; the conclusion that a framed silent login is blocked assumes the same CSP on the authorise route.
- **A live key rotation** in Kanidm and the `keyMaxAgeSec` refresh path: unit-tested only (the agent working on it was mid-change).
- **Raw-gateway path behaviour in dev**: requests with a foreign `Host` are refused (`403`) by the dev server before the gateway, and absolute-form/`//` targets are routed to the SPA; the gateway's own handling of those shapes is covered by unit tests (`gateway-paths.test.ts`), not by this live run.
- **Radicale internals**: `max_content_length`, behaviour of `f` as a map-share permission, sharing-CSV behaviour under concurrent writes, and `Depth: infinity` limits were taken from the design's spike notes and one live probe, not from Radicale's source.
- **`tsdav`/`xml-js` entity handling** (billion laughs): reasoned from the parser family (sax-based, no DTD processing), not fuzzed.
- **Deep read of `app/utils/ical/write.ts`, `recurrence-edit.ts`, `app/utils/writes/**` and the new live loader**: skimmed for input handling, limits and sinks (found `escapeText`/`stripControl`, bounded iterators, no sinks), not line-by-line.
- **FullCalendar's own rendering of `title`** when `eventContent` is not used (the app always provides the slot) and Nuxt UI internals: trusted upstream.
- **Transitive runtime reachability of the `node-forge` advisory**: inferred from the dependency graph (`listhen` is the dev listener), not proven by tracing `.output`.
- **Performance DoS** (many concurrent `REPORT`s, 10 MB `PUT`s in a loop, 50 subscriptions to slow hosts): reasoned from the limits in code; no load was generated.
