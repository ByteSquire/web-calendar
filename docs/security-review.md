# web-calendar — security review guide

How to audit this application, and what earlier reviews taught. Instructions and lessons only:
findings, statuses and open items live in the dated review reports and in design §12.
Requirements: NFR-2, NFR-7. Design: §6, §7, §8.

## 1. How to audit

- **When:** before the first release and before each phase ships; whenever a route, an outbound
  connection, a secret or a stored credential is added; on every Nuxt, Nitro, Kanidm or Radicale
  upgrade (`npm audit --omit=dev`, headers re-checked on the production build).
- **How:** read the code **and** attack the production build (`.output`) with the test stack
  (Kanidm, Radicale, users alice and bob). The dev server is a different code path (its own `Host`
  allow-list, dev error pages, extra inline scripts): never conclude from it alone. Review a
  fixed commit, not a tree under edit. Use probe data with a recognisable name and remove it. Do
  not run lockout tests against a gateway others are using.
- **Both directions.** Check every control twice. _Inward:_ what can an outsider, a signed-in
  user or another user do to us through it? _Outward:_ what can a signed-in user, or a script
  injected into the page, make **us** do or send through it? A channel that carries data to a host
  chosen by anyone but the administrator is an exfiltration channel, whatever else it is for. A
  Content-Security-Policy only helps while no such channel exists on the allowed origins.
- **Report:** one dated review per audit: a status table; findings with severity, evidence (live or
  code), file, scenario and fix; and what was **not** checked and why. A control with no test gets
  a test added or a finding raised.

## 2. Lessons learned

- **Look outward.** The iCal proxy was tested for reaching private addresses (55 address forms,
  rebinding, redirects) but not for sending data to a public host. With no CSP the question had no
  effect; once the CSP limited the page to its own origin, the proxy was the one remaining channel
  to a host the attacker names. When a control is added, re-ask the earlier answers.
- **Library defaults are outbound connections.** Nuxt Icon sent every browser to
  `api.iconify.design` for `ssr: false`. Check each module's network behaviour; keep a browser test
  asserting that no request leaves the app's origin.
- **Throttles behind a reverse proxy.** Every client shares the proxy's address, so an
  address-wide block lets a stranger lock out every client. Verify the credential first, count
  only failures, make the address limit a rate limit, and document
  `NUXT_GATEWAY_TRUST_FORWARDED_FOR`.
- **Claims in the docs are not controls.** NFR-2 promised a strict CSP that did not exist. Measure
  headers on the production build; inline scripts differ between dev and prod (per-response
  hashes, no `unsafe-inline` for scripts).
- **A cached copy of authorization is a trap.** A stored `is_admin` is one `if` away from becoming
  authorization. Decide admin rights per request from fresh userinfo and fail closed without a
  `groups` claim.
- **Fail at start, not at the first request.** Lazily parsed config gave `500` on every
  authenticated request while the health check stayed green. Validate every security setting at
  startup, and let the health check exercise the verifier.
- **Dangerous test switches need a second lock.** `allowPrivate` turns the SSRF guard off; it must
  be refused in production without a separately named acknowledgement.
- **A catch-all that serves the SPA hides mistakes.** `/api/**` fell through to the shell and
  answered `200` to mutations. Always JSON `404`/`405`.
- **Calls to the identity provider amplify.** Cache userinfo per user (at most 60 s, never past
  the token's expiry) with one call in flight.
- **Sign-out must revoke where the provider allows.** Kanidm has a revocation endpoint and no
  end-session endpoint.
- **Keys need ids from day one.** Without a key id on app-token hashes, rotating the key
  invalidates every token.
- **Build context leaks.** `.dockerignore` must exclude dev-container dotfiles (`.claude`,
  `.mcp.json`, `.gitconfig`, shell rc files, `.idea`, `.vscode`).

## 3. Assets

| Asset                                        | Where it lives                                              | Must never                                                                |
| -------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Calendar data (events, descriptions)         | Radicale volume                                             | reach another user, be served stale, be cached beyond 30 s in the browser |
| Access rules and shares                      | SQLite (`calendar_acl`), Radicale `sharing.csv`             | drift apart (Phase 3)                                                     |
| Access and refresh tokens of the user        | browser memory only                                         | reach storage, logs, URLs or a third party                                |
| App tokens (third-party clients)             | SQLite, hashed with the token hash key                      | be stored or logged in the clear                                          |
| Token hash key, seal key, group-sync token   | environment                                                 | be logged, returned, or shared between purposes                           |
| Passwords of external CalDAV accounts (FR-8) | typed once, then only as a sealed credential in the browser | be stored on the server, logged, or sent to any origin but the account's  |
| User profile, admin flag                     | SQLite, Kanidm userinfo                                     | be used for authorization from a stored copy                              |
| Backups of all of the above                  | operator                                                    | be restorable into a state that grants more access                        |

## 4. Inbound surfaces

For each: authentication, what an unauthenticated caller sees, isolation between users, input
limits, output encoding and headers, rate limits, logging.

| Surface                                                 | Auth                                   | Audit                                                                                                           |
| ------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/` and all pages (SPA shell)                           | none                                   | CSP and the other headers on the production build; no secret in the shell; `Cache-Control`                      |
| `/api/config`                                           | none                                   | only non-secret settings (issuer, client id, scope, demo flag, organization zone)                               |
| `/api/me`, `/api/me/time-zone`                          | bearer                                 | token verification, userinfo amplification, input validation                                                    |
| `/api/app-tokens`                                       | bearer                                 | shown once, hashed, expiry, 10 per user, revoke all, last use                                                   |
| `/api/views`, `filters`, `categories`, `calendar-prefs` | bearer                                 | per-user scoping in every query, id grammar, body cap, unknown fields ignored, caps per user                    |
| `/api/ical-subscriptions` and `[id]/data`               | bearer                                 | **also outbound (§5)**; the data endpoint's content type, `nosniff`, owner scoping                              |
| `/api/external-accounts`, `/api/external/<id>/…`        | bearer                                 | **also outbound (§5)**; sealed credentials; path and method allow-lists; user isolation                         |
| `/caldav/**`, `/.well-known/caldav`                     | bearer or Basic with an app token      | header, method and path allow-lists; identity header; body limits; smuggling shapes; 401 and 429 behind a proxy |
| `/auth/callback`, `/auth/signed-out`                    | none (browser side)                    | no token or code left in the URL or history; state and PKCE checked                                             |
| Unknown `/api/**`                                       | none                                   | JSON 404/405, never the SPA shell                                                                               |
| Phase 3: admin routes, sharing writer, group sync       | admin group, checked fresh per request | the controls of §7 exist first; audit log written                                                               |
| Planned: public view (FR-26/27)                         | none by design                         | property allow-list, non-enumerable addresses, rate limit, short cache                                          |

## 5. Outbound connections

Everything the application connects to, from the server **and** from the browser. A new row is a
reason to audit again. For each connection answer, and record the answers:

1. **Who chooses the destination?** The administrator (config), the signed-in user, or data (a
   calendar entry, a redirect, a DNS answer)? Anything but the administrator needs a guard.
2. **What can the chooser put into the request?** Path, query, headers, body. A path or query is
   enough to carry a stolen token to a host the attacker controls.
3. **Which credentials are attached, and to which destinations only?** Is that enforced on the
   server, per hop, including redirects?
4. **Can the destination be an internal address?** Loopback, private ranges, link-local and the
   cloud metadata address, IPv4-mapped IPv6, DNS that answers differently at check and at connect
   (rebinding), redirects to internal hosts.
5. **Is it an exfiltration channel?** Could an injected script, or one user against another, send
   data out to a host the attacker picks? Is there an administrator host list
   (`NUXT_OUTBOUND_ALLOWED_HOSTS`), and is it enforced at connect time as well as when an address
   is saved?
6. **What comes back to the browser, and with which headers?** Content type, `nosniff`,
   `Set-Cookie`, `WWW-Authenticate` (a Basic challenge makes a browser prompt), `Location`.
7. **Limits:** response size, time, redirects, concurrency and rate per user, bounded tables.
8. **What is logged?** Destination host and status at most; no path, query, header or body.
9. **Failure:** fail closed, never serve stale data, never block the other calendars.

### 5.1 From the server

| Connection                                 | Destination chosen by                  | Data sent                                                         | Guards to audit                                                                                                                                                                      |
| ------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Radicale (CalDAV gateway, `/caldav/**`)    | administrator (`NUXT_RADICALE_URL`)    | the user's CalDAV request, `X-Remote-User`                        | header allow-list, identity header set only by the gateway, `redirect: 'manual'`, Radicale unreachable from anywhere else                                                            |
| Kanidm key set (`<issuer>/public_key.jwk`) | administrator (client allow-list)      | nothing                                                           | refresh after `keyMaxAgeSec`, backoff, timeout, a failed refresh keeps the cached keys                                                                                               |
| Kanidm userinfo                            | administrator                          | the user's bearer token                                           | per-user cache and single flight, 3 s timeout, `redirect: 'error'`, fail closed for admin                                                                                            |
| iCal subscriptions (`fetchIcal`)           | **the user**                           | a GET to the user's URL                                           | SSRF guard at socket connect, redirects re-checked, size and time caps, per-user concurrency, the host list. **An exfiltration channel whenever the host list is empty.**            |
| External CalDAV proxy (FR-8)               | **the user**, fixed per stored account | the user's CalDAV request and, for a login, the opened credential | origin from the stored account only, sealed credential bound to user, account and origin, same-origin redirects only, read-only methods, header allow-lists both ways, the host list |
| Container health check                     | image                                  | GET to `127.0.0.1`                                                | exercises the verifier path; no external destination                                                                                                                                 |
| Phase 3: group sync                        | administrator                          | a read-only Kanidm token                                          | least privilege (LDAP bind preferred), atomic file write, token never logged                                                                                                         |
| Phase 3: sharing writer                    | fixed internal address                 | `X-Remote-User` as the owner                                      | a separate internal client, reconcile-and-remove, closed permission table                                                                                                            |

The server must make **no other** connection: no telemetry, update check, public icon or font
service, or webhook. Verify by running the production image with all egress blocked except the
destinations above and exercising every screen.

### 5.2 From the browser

| Connection                                            | Allowed by                                                       | Audit                                                                                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The app's own origin (`/api`, `/caldav`, the proxies) | `connect-src 'self'`                                             | every route that forwards to another host is in §5.1                                                                                                                            |
| Kanidm (authorize, token, revocation, userinfo, keys) | `connect-src` + navigation to the issuer origin                  | tokens in memory only, `state`, PKCE, single-flight renewal, revocation capped at 3 s                                                                                           |
| Images, fonts, styles, scripts                        | `img-src 'self' data:`, `font-src 'self'`, hashed inline scripts | none from a CDN or public API                                                                                                                                                   |
| Links, images and URLs from calendar data             | the page itself                                                  | event URL, description, location, attendee and conference links are text or safe links (`rel="noopener noreferrer"`, scheme allow-list), never HTML, never loaded automatically |
| Navigation                                            | **not restricted by CSP**                                        | a script can still leave the page with data in the URL; `script-src` is the barrier, so keep it strict                                                                          |

### 5.3 Build and supply chain

Build time reaches the npm registry, the container registry and Playwright's browsers. Audit: lock
file committed, `npm audit --omit=dev` allowing only the known advisory, no install scripts from
unreviewed packages, AGPLv3 compatibility of each new dependency (design §12), base image pinned
and updated, runtime image as a non-root user with no capabilities and a read-only root.

## 6. What to check, by area

Cite the file and the test that proves each.

**Bearer tokens.** Algorithm pinned to ES256 before any key is used; `typ` is `at+jwt` (an ID
token fails); `kid` required; the client is chosen from the unverified `iss`, then `iss`, `aud`,
`exp`/`nbf` (60 s tolerance), `sub`, `client_id` and the whole-word scope `caldav` are verified;
only EC P-256 public keys are imported; an unknown `kid` refetches at a bounded rate; a cold
cache with the provider down gives `503`, not `401`; rotated-out keys disappear within
`keyMaxAgeSec`. Probe: an ID token, `alg: none`, HS256 with the real signature, a swapped `sub` and an
unknown `kid` all give `401`.

**App tokens and Basic login.** `wcal_` plus 32 random bytes, only an HMAC stored, key rotation by
key id, expiry one year, 10 per user, revocation immediate, secret shown once, lookup by token
hash and user name. The throttle verifies first, counts failures only, groups IPv6 by /64, and
behaves behind a reverse proxy. `/api/**` accepts bearer only. The subject is validated before it
becomes a path component or a header.

**Authorization.** Every query is scoped to the user and "not yours" equals "not found"; ids by
grammar; unknown body fields (`isAdmin`, `ownerId`, `userId`, `__proto__`) ignored; per-user caps.
Admin rights per request from fresh userinfo, failing closed. The CalDAV backend enforces access
for every client. Phase 3: reconcile-and-remove, a closed permission table, `audit_log` for every
admin and writer action.

**Gateway.** Request headers by allow-list (never `X-Remote-User`, `X-Forwarded-*`, `Cookie`,
`Authorization`, method-override); spoofed identity headers change nothing; cross-user access is
`403` for every method; paths decoded once, re-encoded canonically, traversal, backslashes,
control characters and dot-names refused; `Destination` host ignored and its path checked; body
limits (`Content-Length` grammar, `413` before reading, chunked buffered and bounded); smuggling
shapes refused; response hop-by-hop headers, `Set-Cookie`, `WWW-Authenticate` and CORS headers
dropped, `nosniff` added; a Radicale `401` becomes `502`; CORS off by default with exact origins.

**Outbound guards (iCal, FR-8).** Scheme allow-list; no credentials in the URL; the WHATWG parser
canonicalises numeric hosts; IPv4 blocks every non-public range; IPv6 allows only `2000::/3`
minus documentation, 6to4 and protocol ranges; `localhost` blocked without DNS; names resolved
inside the socket's `lookup` (rebinding) and refused if any record is blocked; every redirect hop
rechecked; no pooled sockets; size cap while streaming; one deadline; bounded cache and
per-user concurrency; no stale copy after an error; logs host only. Probe at least:
`127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`, `[::ffff:169.254.169.254]`,
`[64:ff9b::7f00:1]`, `[2002:7f00:1::1]`, `[fe80::1]`, `[fc00::1]`, `LOCALHOST.`,
`foo.localhost`, `127.0.0.1.nip.io`, `file:`, `javascript:`, userinfo URLs and
`example.com#@127.0.0.1`.

**Browser login.** Code and PKCE; tokens in memory; login state per tab; `returnTo` validated when
stored and when read; one renewal in flight (Kanidm rotates refresh tokens); the bearer attached
only to requests to the app's own origin; one renew-and-retry on `401`; provider error text shown
as text; no token in any log line or URL.

**CalDAV client and iCalendar.** Every href from a server answer must be http(s) on the server's
origin before it is requested; client-written XML and iCalendar text escaped, control characters
stripped, lines folded; ETags validated; parsers bounded (nesting, size, entity expansion,
recurrence expansion, events per file); unreadable components salvaged one by one; file import
limited in size and count.

**Rendering.** No `v-html`, `innerHTML`, `document.write` or dynamic `href` on calendar,
subscription or imported data; colours normalised to `#rrggbb` before they reach `style`; non-HTML
answers carry `nosniff` and a sandbox policy; `Cache-Control: no-store` on every API answer.

**Browser hardening.** CSP measured on the production build: hashed inline scripts, no
`unsafe-inline` or `unsafe-eval` for scripts, `connect-src` limited, `frame-ancestors 'none'`,
`object-src 'none'`, `base-uri 'none'`, `form-action`; `Referrer-Policy`, `Permissions-Policy`,
`X-Frame-Options`, `nosniff`; `X-Powered-By` removed; storage use and what happens when storage
throws; no service worker. Do not rely on the identity provider's `frame-ancestors`.

**Secrets and cryptography.** One purpose per key. Sealed credentials: AEAD, random nonce, bound
data, uniform errors, key rotation voids them knowingly. Nothing secret in logs, errors,
`/api/config`, the bundle or the image. Startup refuses a missing or malformed security setting,
and `allowPrivate` in production without its acknowledgement.

**iCal parsing and round-trip.** The reader/writer must reject malformed input without throwing
across the whole collection; unknown components and X- properties are handled per the fidelity
policy (preserve X- properties on app-created/edited events, strip them on import unless
allow-listed); size caps on input and output; control characters rejected; no entity expansion or
billion-laughs; round-trip tests cover folding, escaping and time zones. Resource booking
properties (`X-WEB-CALENDAR-RESOURCE`, `X-WEB-CALENDAR-BOOKING`,
`X-WEB-CALENDAR-BOOKING-STATUS`) are app metadata, never trusted as authorization.

**Data stores.** Prepared statements only; numbered migrations; backups with `VACUUM INTO`.
Radicale: `max_content_length`, per-home growth, `sharing.csv` backed up with the collections.

**Deployment.** Containers read-only, `cap_drop: ALL`, `no-new-privileges`; app bound to
loopback; Radicale with no published port and read-only config; runtime image copies only
`.output`; install with `--ignore-scripts`; `.env` ignored by git and Docker; the issuer must be
https; test credentials ignored by git and read without logging.

**Availability.** Limits on every costly route, bounded caches and tables, timeouts, concurrency
caps, no unbounded fan-out from one view change.

**Logging and audit.** Never tokens, keys, passwords, paths or queries of outbound requests;
control characters in user names and URLs cannot inject log lines; `audit_log` holds actor, time,
target and details for administrative actions.

**Privacy.** What each outbound request reveals about the user to its destination; what is stored
about external accounts (name, address, user name; never the password).

## 7. Controls before the remaining features

Each must exist **before** the feature ships, with the tests listed.

**Phase 3 prerequisites.** `requireAdmin` as the only admin check, failing closed; an
`audit_log` table (`at`, `actor_sub`, `action`, `target`, `details` JSON, `request_id`) written by
every admin mutation, the sharing writer and the group sync, never containing tokens; the gateway
path pre-check below.

_Status (2026-11-01):_ all of these are **built; unit and e2e tests pass**, and migrations 005, 006
and 008 ran on a copy of the dev database (which held no rows). The built app also ran against the
test stack's Kanidm and Radicale (the live e2e passes; a booking, the reconcile and a share revoke
were driven with real tokens, design §11). Not yet run: production, or a database with data. `requireAdmin` is reached only through
`defineAdminHandler` (`server/utils/api/admin-handler.ts`), which adds a per-`sub` rate limit of
about 60 a minute before the userinfo call and an `audit()` helper. `audit_log` (migration 005) is
append-only (a trigger aborts `UPDATE`; `DELETE` stays for a retention job), redacts keys that look
like secrets and Bearer/JWT patterns, omits depth above 8 and caps `details` at 8 KB. The limiter
is per process, so it is looser after a restart or with several instances. Redaction is pattern
based; callers still must not pass secrets. Tests: `tests/server/audit-log.test.ts`,
`tests/server/admin-guard.test.ts`.

### 7.1 Sharing writer (`calendar_acl` → Radicale map shares)

It is the one component that must send an identity it did not verify, and a drift between SQLite
and Radicale's CSV is a silent authorization error in either direction.

- A **separate internal client**, on a path the gateway cannot reach; never expose `.sharing`
  through `/caldav/`.
- Principals are **Kanidm `sub` UUIDs** (users) and group UUIDs or SPNs, validated against Kanidm
  at write time and against `isValidSubject`; never a free-text name. _Built in the access
  administration:_ a person must be a lower-case UUID that exists in `users.oidc_sub`, a group must
  match the group-name check and exist in Kanidm (checked with the sync token for principals new to
  the calendar; Kanidm down means `409` and nothing is stored); `public` and `admin` rules are
  refused. A group removed between the check and the write is accepted (TOCTOU).
- **Reconcile, do not patch:** desired shares from `calendar_acl`, Radicale's actual list, apply
  the diff, re-read, compare, alarm on any difference; on every ACL change and every 5 minutes. A
  share SQLite does not know is **removed** and the removal audited.
- Closed permission table: `read → r`, `write → rw`, `free_busy → f` (confirmed for map shares of
  a calendar in S5: free/busy only, `GET`/`calendar-query`/writes 403; Radicale also accepts `''` and
  free-form strings, so the writer sends only these three values), `admin` never reaches Radicale.
- Radicale unreachable: retry with backoff, `503` for ACL writes, `calendar_acl.applied_at` set only
  after Radicale confirmed. _Built:_ `applied_at` exists (migration 006) and is set after the
  verified re-read, only for rules unchanged since the run began; the loop retries after 5 s, 10 s,
  20 s up to the interval. The ACL routes do **not** answer `503` yet (`getSharingState()` exposes the
  failure count for that); the rules stay saved and show as not applied.
- **Second opinion for Radicale:** the gateway pre-checks from SQLite that the collection's owner
  is the caller or `calendar_acl` grants the caller something on that path (`403` otherwise), and a
  nightly job lists each home as each user and compares with `calendar_acl`. _Built:_
  `precheck.ts` takes group membership from the htgroup file (a missing file grants nothing), names
  `shared-<calendarId>` in a member's home are what it looks up (so members cannot own a calendar
  with such a name), COPY/MOVE destinations are checked too; the job first runs 2 minutes after
  start. Audit actions (actor `system:sharing-writer`): `sharing.removed_unknown`,
  `sharing.replaced`, `sharing.mismatch`, `sharing.failing`, `sharing.recovered`,
  `sharing.audit_mismatch`. The reconcile also removes any `token` share. Residual: API shapes S5
  did not show are assumed (see `docs/design.md` §12); each owner costs one list request per run.
- Tests: fixture ACLs → expected shares; an invented share is removed; a non-UUID `sub` is
  refused; `/caldav/.sharing/**` stays `404`; end to end, bob gains `r` on alice's calendar and
  `PUT` gets `403`, then deleting the row empties his listing within one reconcile.
  _Tests:_ `tests/server/sharing-reconcile.test.ts` (fixtures, invented share removed,
  replaced permission, deleted rule, unreachable, refused creates alarm once, invalid principal,
  response cap, backoff), `sharing-gateway-precheck.test.ts` (owner, grantee, stranger, methods,
  destination, `.sharing` `404`), `sharing-audit-job.test.ts`, `sharing-block-store.test.ts`,
  `tests/server/admin-access.test.ts`, `tests/validate-config.test.ts` (sharing settings). The
  end-to-end bob and alice case against a real Radicale is **not covered**.

### 7.2 Group sync (Kanidm → `htgroup`)

The sync credential is the most powerful secret the app holds; staleness is an authorization
error.

- Least privilege first: the LDAP bind (read-only by construction) before the `idm_group_admins`
  API token; if the token stays, document the residual risk in `kanidm-setup.md`, expire it within
  90 days, write a rotation runbook, and audit-alarm any `401`/`403` from the sync.
- Read only the groups `calendar_acl` references plus `calendar_admins` and `web_calendar_users`.
- Atomic write: temp file in the same directory, `fsync`, `rename`; validate the content first;
  keep `htgroup.prev`. Members are `sub` UUIDs.
- An error leaves the file untouched and warns; escalate after repeated failures; never write an
  empty file because Kanidm answered `null`.
- The interval is a security setting: default 60 s, hard ceiling 300 s; a group change seen in
  `/api/me` triggers a run.
- _Built:_ the token is read-only and never logged (scrubbed from every message; 10 s timeout, 1
  MiB cap, no redirects); groups are those named by `calendar_acl` and `resource_acl` plus the
  two fixed ones; the interval is clamped to 1..300 and `validate-config.mjs` rejects a larger
  value. Members are mapped from SPN to `sub` through the `users` table, so a member who never
  signed in fails the run (fail closed; the file stays as it was). **Stale-file risk:** while
  runs fail, removed members keep access (removals are not applied) until the cause is fixed.
  Alarms: `401`/`403` logs at error level each run and audits `group_sync.unauthorized` once per
  streak; the fifth consecutive failure and every fifth after it log at error level and audit
  `group_sync.failing`; `group_sync.recovered` follows; a changed file audits `group_sync.updated`
  (names and count, no SPNs). Actor `system:group-sync`. Not yet done: the token's 90-day rotation
  runbook beyond `kanidm-setup.md`, and the LDAP bind.
- Tests: fixture answers → exact file; an error or `null` leaves the file unchanged; the rename is
  atomic; a removed member is gone after one run; the token never appears in logs. _Tests:_
  `tests/server/group-sync-file.test.ts`, `-kanidm.test.ts`, `-service.test.ts` and
  `tests/validate-config.test.ts`.

### 7.3 Admin routes and shared views

`requireAdmin` on every admin handler; mutations audited with the actor's `sub`; rate-limited per
actor; the SPA hides but never relies on hiding. Admin views are `is_admin = 1`, `owner_id = NULL`,
validated like user views, and **may not contain `ext:` refs**; inaccessible calendars are omitted
because Radicale answers `403`, not because the app guesses. Preference refs are opaque keys, never
turned into a URL or path without `resolveRequestUrl` or the gateway. Tests: a forged `isAdmin` in
the body → `403`; an admin who lost the group → `403`; an audit row per mutation.

_Built (unit tests pass):_ the routes `POST /api/admin/views`, `PUT`/`DELETE
/api/admin/views/:id` and the access administration routes are all `defineAdminHandler`, so the
server enforces the admin check and hiding the controls is cosmetic. Admin view statements are
restricted to `is_admin = 1`, `ext:` refs are refused per field, and refs are shape-checked only,
so refs to calendars the viewer cannot read just show nothing. Audit actions: `admin_view.created`,
`admin_view.updated`, `admin_view.deleted` (target the view id, details the name) and
`acl.replaced` (target `calendar:<id>`, details only counts and principal types, no principals,
no tokens; an unchanged `PUT` writes nothing). Resource administration is audited as in §7.4. Tests:
`tests/server/admin-views.test.ts`, `tests/admin-views.test.ts`, `e2e/admin-views.spec.ts`,
`tests/server/admin-access.test.ts`, `tests/admin-access-utils.test.ts`,
`tests/admin-access-visibility.test.ts`, `tests/admin-access-page.test.ts`,
`tests/admin-access-menu.test.ts`, `e2e/admin-access.spec.ts`. Residual: the browser flag costs
an extra `/api/me` call; the rate limit is per process.

### 7.4 Resources and booking (FR-16 to FR-19)

A booking writes into two calendars, and the resource calendar is widely shared as free/busy, so
any leak from the block defeats FR-18.

- The **server** writes the block (internal client, service principal `_resources`); users need no
  write permission on resource calendars. A `calendar_bookings` table with a unique slot (or a
  conflict check in one transaction) prevents double booking. _Built:_ the unique slot is the
  approved-overlap trigger on `calendar_bookings` (migration 006); the block is written by
  `createResourceBlockStore()` as `_resources`, only to
  `/_resources/availability/<id>.ics`, and `server/plugins/resources.ts` repairs failed writes
  every 10 minutes.
- The block holds only `DTSTART`, `DTEND`, `UID`, `SUMMARY:Reserved`, `TRANSP:OPAQUE`,
  `CLASS:CONFIDENTIAL` and an opaque back-reference id, never the booking calendar's path or UID.
  Details come from an API that checks the caller's access to the booking calendar first. _Built:_
  the block also carries `X-WEB-CALENDAR-BLOCK:<block_ref>` and `STATUS:TENTATIVE` while pending
  (the block reference is random and unique, not the booking id); the detail API is
  `GET /api/resources/availability` (built, tests pass): a caller who cannot read the event's calendar
  gets exactly `bookingId, start, end, status, blocked, mine`, and an event without a calendar is
  blocked. Residual: the check also takes `free_busy` grants and is imprecise for mixed grants.
- Users get `f` (or `r`) on resource calendars; the API refuses `write` ACLs on resources.
- Accept/decline is app-side state with an audit trail (CalDAV scheduling would admit arbitrary
  iTIP input). Limit bookings per user per day, duration and look-ahead. _Built:_ 24 h, 10 per
  requester and UTC day and 365 days ahead are placeholders (the design gave no values), plus a
  booking rate limit of 10 burst and one per 2 s per user (per process); the resource ACL routes
  accept only `read`, `book`, `manage` for user, group, authenticated, never `public`. Event-level
  `X-` properties are stripped on import and booking marks are trusted only from the built-in
  service. Audit actions: `resource_booking.created|approved|declined|cancelled|orphaned|block_failed`,
  `resource.created|updated|deactivated|acl_replaced`, ids only; an automatic decline carries
  `automatic: true` and `reason: 'overlap'`. Residual: a removed group right lingers up to the 60 s userinfo cache.
- The reconcile of moved or deleted events runs as the booker through the internal client, with the
  same principal and path guards as the sharing client. It never cancels because an event changed,
  lost its marks or could not be read: those go to the manager queue. Only an event that is
  definitively gone cancels, after 3 looks, audited as `system:resources` with
  `reason: 'event_removed'`. A manager cancels the booking of someone else only while
  `NUXT_RESOURCES_MANAGER_CANCEL` is not `false` (on by default); the requester always may. The
  booking names its event calendar by path; the server accepts only a path in the booker's own home
  that the booker can read (their own calendar, or a share with a `read` or `write` grant) and
  otherwise answers 400 or 403, so a booking cannot point into a stranger's calendar. The reconcile
  reads that path as the booker, so it cannot be used to read anything the booker cannot.
- Tests: the block contains nothing else; a user with `f` cannot `GET` it; two concurrent bookings
  → one wins; a booker cannot delete another's block; a non-reader gets "blocked". _Tests:_
  `tests/server/access-schema.test.ts`, `tests/server/resources-service.test.ts`,
  `resources-input.test.ts`, `resources-routes.test.ts`, `resources-availability.test.ts`,
  `resources-availability-routes.test.ts`, `resources-reconcile.test.ts`,
  `resources-reconcile-reader.test.ts`, `tests/resources-ui-*.test.ts`,
  `e2e/resources-requests.spec.ts`, `tests/ical-x-properties.test.ts`,
  `tests/ical-split.test.ts` (changed). Not covered yet: the "contains nothing else" and "user with
  `f` cannot `GET`" checks against a real Radicale, and the detail API against one.

### 7.5 Public view (FR-26/27)

The first unauthenticated read path; the risks are over-sharing, the credential it uses, and
expensive unauthenticated reads.

- A dedicated endpoint (never `/caldav/`) mapping a random slug to a published calendar, reading as
  a `_public` principal that has map shares for exactly the published set, never a rights-file rule.
- Strip server-side to an allow-list (`SUMMARY`, `DTSTART`, `DTEND`, `RRULE`, `LOCATION` if
  configured, `UID`, `DTSTAMP`); never `DESCRIPTION`, `ATTENDEE`, `ORGANIZER`, `X-*`, `ATTACH`, `URL`.
- Publishing is admin-only and audited; resource and personal calendars are refused; unpublishing
  removes the share in the same reconcile and rotates the slug.
- Short cache (60 s, the one documented exception to "no stale data"), per-IP rate limit, a separate
  CSP, no cookies.
- Tests: the property allow-list; an unpublished slug → `404`; a resource cannot be published; the
  rate limit; `_public` cannot read an unpublished calendar directly.

### 7.6 External CalDAV accounts (FR-8)

The attacker-controlled component is the remote server and the page; the serious risk is
credential misdirection and the proxy as an exfiltration channel.

- The proxy takes an account id; the **target origin comes only from the stored account**, never
  from the request. Path normalised and checked; read-only methods; header allow-lists in both
  directions (no app `Authorization`, cookies or `X-Forwarded-*` upstream; no `Set-Cookie` or
  `WWW-Authenticate` back); same-origin redirects only, each rechecked; upstream `401` becomes
  `502` so a `401` always means the app token is bad.
- The password is **sealed**: AEAD bound to user, account and origin, so a script cannot read it or
  replay it to another origin; the server stores nothing. Changing the origin, user name or auth
  mode requires the password again. Https is required for any account with a login.
- The optional host list also gates iCal subscriptions, at save time and at every connect; listed
  names may be private, but loopback, link-local and Radicale's own host are always refused.
- Per-user concurrency and rate limits; response and time caps; `ext:` refs refused in admin
  views; one failing account never disables the built-in service.
- Tests: no header or credential leaks either way (assert what a fake upstream received); the
  origin cannot be changed by a request; credentials are never sent on a cross-origin redirect;
  seals fail for another user, account, origin or version.

### 7.7 Third-party clients over Basic

Send the two `WWW-Authenticate` challenges as two header lines, or `Basic` first without
`charset`; document that the user name is the Kanidm short name and the password an app token;
show last use and offer "revoke all"; note that unauthenticated `OPTIONS` on `/caldav/` is `401`,
which some discovery code dislikes.

### 7.8 Reverse proxy and TLS

Reference configuration: TLS 1.2+, HSTS, `X-Forwarded-For` appended **and**
`NUXT_GATEWAY_TRUST_FORWARDED_FOR=true`, `client_max_body_size` at least the gateway limit,
request buffering off for `/caldav/`, the app's port on loopback only. The app never trusts
`X-Forwarded-Host` or `-Proto` for anything security-relevant.

### 7.9 Backups

Back up SQLite with `VACUUM INTO` or `.backup` (never a file copy of a WAL database) and
`radicale-data` including `sharing.csv`, which is authorization state. Encrypt at rest, restrict
access, keep the hash key apart, and test a restore that re-runs the sharing reconcile.

### 7.10 Design stances

- Radicale as the only enforcement point is acceptable with the gateway pre-check and the nightly
  consistency audit.
- `idm_group_admins` is not an acceptable final state; the LDAP read-only bind is the target.
- Bearer revocation latency (up to 15 minutes) is acceptable because app tokens revoke at once and
  admin actions re-check userinfo; consider a deny-list of `jti` when userinfo says `401` for a token
  that still verifies.
- The gateway, the sharing writer and the public endpoint are the only components that set
  `X-Remote-User`; each is its own module with its own header allow-list and tests, and Radicale is
  reachable from nothing else.
- Keep the Radicale rights file static; use shares and the group file only. SQLite is the source of
  truth for ACLs only through reconcile-and-remove.

## 8. Tests every audit expects to find

- Throttle behind a proxy: a correct Basic login succeeds while the shared address is blocked; 30
  failures from the proxy address do not block alice's client.
- Security headers on every surface (`/`, `/api/config`, an API route, the `.ics` data endpoint,
  `/caldav/` 401), and a Playwright run of every view with the production CSP and no violations.
- A browser test that no request leaves the app's origin.
- Every `/api/**` URL answers JSON, never the shell, for every method and trailing slash.
- The gateway integration suite against the production build with a fake Radicale, the Kanidm key
  fixture and raw-socket cases (absolute-form target, `//caldav/`, `Transfer-Encoding` with
  `Content-Length`).
- Cross-user access through every method: `PROPFIND`, `GET`, `PUT`, `DELETE`, `REPORT`,
  `PROPPATCH`, `MKCOL`/`MKCALENDAR`, and `MOVE`/`COPY` with a `Destination` in another home, also
  over Basic.
- Admin flag is not authorization: a stale `is_admin`, an unreachable userinfo and a missing
  `groups` claim all give `403`.
- Config fail-fast for every security variable; `allowPrivate` refused in production.
- Logout calls the revocation endpoint; Back after sign-out does not land in a signed-in app.
- DoS regression guards: well-formedness check on adversarial XML within a time budget, recurrence
  fixtures that hit each limit and warn, a large `.ics` within a time budget.
- Proxy response hygiene: `nosniff` and `no-store` on the data endpoint; a feed served as
  `text/html` comes back as `text/calendar`.
- N concurrent `/api/me` calls for one user make one upstream call.
- A live key rotation in Kanidm: the old token is rejected after the refresh, the new one accepted.
- For every outbound connection: what the destination received (no leaked header or credential),
  and that the request cannot change the destination.
