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
- **Read the person's own claim before asking for a service account.** The group sync needed a
  Kanidm account in `idm_group_admins` and one with `idm_people_pii_read`, and a token to rotate and
  alarm on. Groups from the person's own sign-in need no credential at the provider. The price is
  staleness and trust in the provider's claim (§7.2); decide that trade knowingly.
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
| Token hash key, seal key                     | environment                                                 | be logged, returned, or shared between purposes                           |
| Passwords of external CalDAV accounts (FR-8) | typed once, then only as a sealed credential in the browser | be stored on the server, logged, or sent to any origin but the account's  |
| User profile, admin flag                     | SQLite, the provider's userinfo                             | be used for authorization from a stored copy                              |
| Group memberships (imported groups)          | SQLite (`group_members`), the group file                    | come from anything but a person's own verified claim                      |
| Backups of all of the above                  | operator                                                    | be restorable into a state that grants more access                        |

## 4. Inbound surfaces

For each: authentication, what an unauthenticated caller sees, isolation between users, input
limits, output encoding and headers, rate limits, logging.

| Surface                                                                         | Auth                                               | Audit                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` and all pages (SPA shell)                                                   | none                                               | CSP and the other headers on the production build; no secret in the shell; `Cache-Control`                                                                                                      |
| `/api/config`                                                                   | none                                               | only non-secret settings (issuer, client id, scope, demo flag, organization zone, sign-in window days)                                                                                          |
| `/api/me`, `/api/me/time-zone`                                                  | bearer                                             | token verification, userinfo amplification, input validation, the groups import (claim parsing)                                                                                                 |
| `/api/app-tokens`                                                               | bearer                                             | shown once, hashed, expiry, 10 per user, revoke all, last use                                                                                                                                   |
| `/api/calendar-links`, `[id]`, `[id]/reveal`                                    | bearer                                             | owner scoping (another person's link is 404), the level checked as the maker, sealed address and password, reveal audited, 50 per user                                                          |
| `/api/admin/access/calendars/:id/links`, `/api/admin/access/links/:id[/reveal]` | admin group, checked fresh per request             | reads as the calendar's owner, only links with a calendar of the access page, reveal and removal audited (`byAdmin`)                                                                            |
| `/api/link/:slug/session`, `/api/link/:slug/events`                             | the link's password, then an 8-hour session header | `no-store`, `noindex`, wrong passwords counted before the scrypt check, one 404 for unknown and removed links, the session bound to its link, "Busy times only" never queries events, read caps |
| `/api/views`, `filters`, `categories`, `calendar-prefs`                         | bearer                                             | per-user scoping in every query, id grammar, body cap, unknown fields ignored, caps per user                                                                                                    |
| `/api/ical-subscriptions` and `[id]/data`                                       | bearer                                             | **also outbound (§5)**; the data endpoint's content type, `nosniff`, owner scoping                                                                                                              |
| `/api/external-accounts`, `/api/external/<id>/…`                                | bearer                                             | **also outbound (§5)**; sealed credentials; path and method allow-lists; user isolation                                                                                                         |
| `/caldav/**`, `/.well-known/caldav`                                             | bearer or Basic with an app token                  | header, method and path allow-lists; identity header; body limits; smuggling shapes; 401 and 429 behind a proxy                                                                                 |
| `/auth/callback`, `/auth/signed-out`                                            | none (browser side)                                | no token or code left in the URL or history; state and PKCE checked                                                                                                                             |
| Unknown `/api/**`                                                               | none                                               | JSON 404/405, never the SPA shell                                                                                                                                                               |
| Phase 3: admin routes, sharing writer, group file                               | admin group, checked fresh per request             | the controls of §7 exist first; audit log written                                                                                                                                               |
| Planned: public view (FR-26/27)                                                 | none by design                                     | property allow-list, non-enumerable addresses, rate limit, short cache                                                                                                                          |

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

| Connection                              | Destination chosen by                  | Data sent                                                         | Guards to audit                                                                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Radicale (CalDAV gateway, `/caldav/**`) | administrator (`NUXT_RADICALE_URL`)    | the user's CalDAV request, `X-Remote-User`                        | header allow-list, identity header set only by the gateway, `redirect: 'manual'`, Radicale unreachable from anywhere else                                                                                                                                        |
| Discovery document and key set          | administrator (issuer setting)         | nothing                                                           | issuer equal to the setting, `jwks_uri` on the issuer's host (or `NUXT_OIDC_JWKS_HOSTS`), 64 KiB, 5 s, `redirect: 'error'`, refresh after `keyMaxAgeSec`, backoff, a failed refresh keeps the cached keys                                                        |
| Userinfo                                | administrator (the discovery document) | the user's bearer token                                           | per-user cache and single flight, 3 s timeout, `redirect: 'error'`, https for an https issuer, fail closed for admin. Also called in the background for a CalDAV bearer request (§7.2): once per person per 5 minutes, 4 at a time, with that person's own token |
| iCal subscriptions (`fetchIcal`)        | **the user**                           | a GET to the user's URL                                           | SSRF guard at socket connect, redirects re-checked, size and time caps, per-user concurrency, the host list. **An exfiltration channel whenever the host list is empty.**                                                                                        |
| External CalDAV proxy (FR-8)            | **the user**, fixed per stored account | the user's CalDAV request and, for a login, the opened credential | origin from the stored account only, sealed credential bound to user, account and origin, same-origin redirects only, read-only methods, header allow-lists both ways, the host list                                                                             |
| Container health check                  | image                                  | GET to `127.0.0.1`                                                | exercises the verifier path; no external destination                                                                                                                                                                                                             |
| Phase 3: sharing writer                 | fixed internal address                 | `X-Remote-User` as the owner                                      | a separate internal client, reconcile-and-remove, closed permission table                                                                                                                                                                                        |

The group sync's calls to Kanidm's API with a service token (a row here until 2026-11-05) are gone: the
app holds no credential at the identity provider, and the group file is a local write.

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

**Bearer tokens.** Only asymmetric algorithms (`none` and `HS*` refused), and each key verifies only
what its own type allows, so an RSA key never checks an `ES*` token; `kid` required; keys imported
only as public signing keys of an accepted type and size (`docs/oidc-providers.md`); the allowed
client is chosen from the unverified `iss`, which must equal an allowed issuer exactly, then the
signature, `iss`, `exp`/`nbf` (60 s tolerance) and `sub` are verified; header `typ` absent, `at+jwt`
or `jwt`, payload `typ` absent or `Bearer`, `token_use` absent or `access` (an ID token fails); the
token names an allowed client in `client_id`, `azp`, `cid` or `appid`, or has an `aud` with the client
id or an `NUXT_OIDC_AUDIENCE` value; the whole-word required scope (`caldav`) is in `scope` or `scp`;
the discovery document's `issuer` equals the setting; an unknown `kid` refetches at a bounded rate;
a cold cache with the provider down gives `503`, not `401`; rotated-out keys disappear within
`keyMaxAgeSec`. Probe: an ID token, `alg: none`, HS256 signed with the public key, a swapped `sub`
and an unknown `kid` all give `401`.

**App tokens and Basic login.** `wcal_` plus 32 random bytes, only an HMAC stored, key rotation by
key id, expiry one year, 10 per user, revocation immediate, secret shown once, lookup by token
hash and user name; a token is refused when its owner's last sign-in is older than the sign-in
window (`NUXT_SIGNIN_WINDOW_DAYS`), and using the token does not renew the window (§7.2). The throttle verifies first, counts failures only, groups IPv6 by /64, and
behaves behind a reverse proxy. `/api/**` accepts bearer only. The subject is validated before it
becomes a path component or a header (`isValidSubject`), and the app's own principals
(`_resources`, `_group-*`, the shared owners) are refused as a person.

**Authorization.** Every query is scoped to the user and "not yours" equals "not found"; ids by
grammar; unknown body fields (`isAdmin`, `ownerId`, `userId`, `__proto__`) ignored; per-user caps.
Admin rights per request from the provider, failing closed: fresh userinfo, or the verified token's
own groups claim only where userinfo has no endpoint, answers `200` without the claim, or refuses the
token from an endpoint on another origin than the issuer (§7.2). The CalDAV backend enforces access
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
every admin mutation, the sharing writer and the groups import, never containing tokens; the gateway
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
- Principals are the identity provider's **`sub` ids** (users, any id `isValidSubject` accepts, case
  kept) and **group short names**; never a free-text name. _Built in the access administration:_ a
  person must pass `isValidSubject` and exist in `users.oidc_sub`, a group must match the group-name
  check and exist in the `groups` table (any source; checked for principals new to the calendar, with
  the message "is not a known group; an administrator can import it on the Groups page"); no lookup
  at the provider is made, so none can be down; `public` and `admin` rules are refused. A group
  removed between the check and the write is accepted (TOCTOU).
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
  `precheck.ts` reads group membership for a group rule from the htgroup file (a missing file grants
  nothing); a rule of type `authenticated` and the free/busy availability share are granted to any
  caller who got past authentication, without reading the file, names
  `shared-<calendarId>` in a member's home are what it looks up (so members cannot own a calendar
  with such a name), COPY/MOVE destinations are checked too; the job first runs 2 minutes after
  start. Audit actions (actor `system:sharing-writer`): `sharing.removed_unknown`,
  `sharing.replaced`, `sharing.mismatch`, `sharing.failing`, `sharing.recovered`,
  `sharing.audit_mismatch`. The reconcile also removes any `token` share. Residual: API shapes S5
  did not show are assumed (see `docs/design.md` §12); each owner costs one list request per run.
- Tests: fixture ACLs → expected shares; an invented share is removed; an invalid `sub` (`a/b`, a
  space) is refused; `/caldav/.sharing/**` stays `404`; end to end, bob gains `r` on alice's calendar and
  `PUT` gets `403`, then deleting the row empties his listing within one reconcile.
  _Tests:_ `tests/server/sharing-reconcile.test.ts` (fixtures, invented share removed,
  replaced permission, deleted rule, unreachable, refused creates alarm once, invalid principal,
  response cap, backoff), `sharing-gateway-precheck.test.ts` (owner, grantee, stranger, methods,
  destination, `.sharing` `404`), `sharing-audit-job.test.ts`, `sharing-block-store.test.ts`,
  `tests/server/admin-access.test.ts`, `tests/validate-config.test.ts` (sharing settings). The
  end-to-end bob and alice case against a real Radicale is **not covered**.

### 7.2 Groups from the sign-in claim, the sign-in window, and the group file

Replaced on 2026-11-05: the pull-based sync with its Kanidm service account (`idm_group_admins`,
`idm_people_pii_read`, a token to rotate) is gone. The app reads the groups claim of each person's own
sign-in and writes Radicale's group file from its own database. It holds no credential at the identity
provider. The price is a different trust: the app believes the provider's claim, and what it believes
is as old as the person's last sign-in. Design §6 and §8 describe the mechanism; this section is what
to check and what is accepted.

**Where a claim may come from.**

- The claim (`NUXT_OIDC_GROUPS_CLAIM`, default `groups`) is read from the userinfo answer for the
  verified token's own `sub` (the endpoint is the one in the discovery document, https for an https
  issuer, no redirects, 3 s, 64 KiB, `sub` must match), and only then from the **signature-verified
  access token**, in three cases: the provider publishes no userinfo endpoint; userinfo answers `200`
  without the claim; or the endpoint is on **another origin than the issuer** and refuses the token
  with `401` or `403` (Entra's userinfo is Microsoft Graph). A `401` from the issuer's own origin never
  falls back: a revoked Kanidm token still verifies locally and only userinfo notices. A network
  error, a timeout, `5xx` or a bad body leaves the groups unknown: stored memberships stay and the
  person is not an admin. A claim from the token is as old as the token (its lifetime).
- Nothing else is a source: not the ID token, not a header, not a body field, not the person's
  profile. `users.is_admin` is still only a note.

**What a claim can do.**

- **Candidates grant nothing.** Every group in a claim that is not on the ignore list
  (`NUXT_OIDC_GROUPS_IGNORE`, default `idm_*,system_*,domain_*`) is remembered as a candidate (key,
  safe name, last seen; removed after 90 days unseen unless imported). Members are stored only for a
  group an **admin imported**. A group someone creates at the provider changes nothing here until an
  admin picks it. The admin list does not offer a name on the ignore list, the admin group's name or
  `web_calendar_users`.
- **Names and sizes.** The claim is data from outside: entries over 255 characters are skipped, at
  most 200 groups are kept, every name is cut to the group-file shape (letters, digits, `_`, `.`, `-`,
  64 characters, starting with a letter or digit). The group file is rendered from validated names and
  ids only and checked again before every write, so nothing from a claim reaches the file, a path or
  an SQL statement unchecked (prepared statements, `CHECK`s in migration 009).
- **Name clashes.** Two keys that give one safe name are both flagged `conflict` and neither can be
  imported until the provider renames one. An app group wins a name: the import of a candidate whose
  name is taken is refused (`409`), and a rename at the provider onto a taken or reserved name is
  not applied (the group keeps its name, one warning).
- **Membership is replaced.** At each import the person's membership of the imported groups is made
  equal to the claim, including an empty list (no groups). An absent claim, an Entra overage (a
  `_claim_names` pointer for more than 200 groups) and unknown groups touch nothing. The stored rows
  of other people, of app groups and of the group of everyone are never changed by an import.
- **Roles.** The admin check matches `NUXT_OIDC_ADMIN_GROUP` against the raw entry, the part before
  `@`, a Keycloak path joined with dots, or the entry cleaned to the group-file shape (case counts,
  no trimming). This is wider than equality: `calendar_admins@elsewhere`, `/calendar_admins` and
  `calendar admins` all name the group `calendar_admins`. Whoever can create a group at the provider
  whose name reduces to the admin group's name is an admin, so the operator must know who that is; on
  Kanidm the SPN's domain is the instance's. The admin group is no group of the app: it is not in
  `groups`, not in the file, and no rule can name it.

**Staleness, accepted.**

- Memberships change at the person's next sign-in or CalDAV bearer refresh (at most every five
  minutes, 10 000 people tracked, 4 refreshes at once, in the background, never delaying or failing
  the request; the person's token is used for that call only and never logged or stored; not in demo
  mode). A person removed from a provider group keeps the membership until then. A calendar app
  that signs in without the `groups` scope sends no claim, so nothing changes for it; a person who
  uses only an app token (Thunderbird) is refreshed only when they sign in to the web app.
- A person who left the provider keeps their rows (also in the group file) but cannot
  authenticate: bearer tokens expire, app tokens stop at the window. Their stale membership grants
  nothing because they cannot call.
- The group file is a copy: authorization reads the database. A stale file gives Radicale stale
  shares and the gateway pre-check stale group rules until the next write; it is written at start, 2
  s after a change (a join or leave, an import, a stop, an app-group edit, a person new to the file),
  and hourly, so people age out of the group of everyone.

**The sign-in window** (`NUXT_SIGNIN_WINDOW_DAYS`, 1 to 365, default 30; an invalid value stops the
server at start; it cannot be turned off) replaces the old "revoke the tokens of whoever left
`web_calendar_users`" (finding 2 of the 2026-11-01 review).

- `verifyAppToken` refuses a token whose owner's `last_seen_at` is null or older than now minus the
  window (exactly at the edge still counts). The token is **refused, not deleted**: it works again
  after the owner signs in.
- `last_seen_at` is renewed by a bearer call to `/api/**` (the web app) and by a valid OIDC bearer
  call to `/caldav/` (the sighting). It is **never** renewed by using an app token, so a token cannot
  keep its owner active.
- The window bounds app tokens and the group of everyone, **nothing else**: not imported or app
  groups, not bearer access, which the provider ends. A leaver's app token therefore works for up to
  the window after their last sign-in. With the sync it was cut within about a minute, without
  `NUXT_GROUP_SYNC_TOKEN` never. No admin control revokes another person's tokens; only the owner's
  "Revoke all" is shorter. An operator who wants it tighter lowers the window.

**Name-keyed groups.** Where the claim has no id the key is the name, SPN or path: Keycloak (paths),
Authentik, Authelia, Okta, Cognito, Auth0, Zitadel, and Kanidm with `groups_name` or `groups_spn`.
A group renamed at the provider is a new candidate and the imported one loses its members as people
sign in; a group deleted there and created again under the same name lands in the old app group and
**inherits its calendars and rules**. Kanidm `groups` (UUID) and Entra (object id) key by id and
are not exposed to this: a rename follows, with the rules that name the group. Who may create and
rename groups at the provider is part of the trust, and the doc says so per provider
(`docs/oidc-providers.md`).

**Known limits:**

- A person in more than 200 groups that are not ignored: the claim is cut at 200 (the parser's test
  covers the cut). The import then only adds: it takes the person out of no group, because the
  groups past the cut are unknown (`truncated`; tested in `groups-import.test.ts`). The price is that
  such a person is never removed from an imported group; that provider needs a smaller claim (a
  mapper filter, `NUXT_OIDC_GROUPS_IGNORE`).
- An entry over 255 characters cannot be imported.
- Entra: over 200 groups the claim is replaced by a pointer, so memberships stay as they were and the
  person is not an admin through the token; candidates are GUIDs, so `NUXT_OIDC_ADMIN_GROUP` must be a
  GUID there.

**Audit.** `groups.import` (actor `system:group-import`; group names and counts of one person's
change, never a member list), `group.oidc_imported` and `group.oidc_import_stopped` (admin), the
existing `group.*` actions for app groups. A write of the group file is not audited (it follows the
database); a failure to write is logged once per distinct message.

**Group file.** Written from the database only, atomically (temp file, `fsync`, `rename`, the old file
kept as `htgroup.prev`), validated first, and only when the content differs. A member that is not a
valid user id is left out and counted in a warning, so one bad row cannot stop the whole file; an
invalid group name fails the write and the old file stays. Retries back off from 5 s. The file holds
every app and imported group with its stored members, and `web_calendar_users`: every person whose last
sign-in is inside the window. Rules that name `web_calendar_users` resolve through the file; a rule
of type `authenticated` and the free/busy availability share are granted by the gateway to any
authenticated caller without reading the file, but Radicale shows the `:web_calendar_users` share
only once the file lists the person (a new person: within the debounce).

- Tests (file names; not run or re-read for this document): `tests/server/groups-claim.test.ts`,
  `groups-import.test.ts`, `groups-source.test.ts`, `groups-sighting.test.ts`,
  `groups-sighting-service.test.ts`, `groups-file-service.test.ts`, `groups-htgroup-file.test.ts`,
  `groups-schema.test.ts`, `groups-routes.test.ts`, `auth-window.test.ts`, `app-tokens.test.ts`,
  `sharing-gateway-precheck.test.ts`. According to the build notes, the window comparison, the touch gating and the
  userinfo origin rule were broken once to see these tests fail; that is not part of the suite.
- Proven live (2026-11-05, live suite 45 of 45): sign-in with the real Kanidm, a group of Kanidm
  (`idp_team`) offered as a candidate, imported by an admin, its member in the group file and the
  group gone from the file after Stop importing; the built-in `idm_*` groups, the admin group and the
  group of everyone are not offered. Not proven: the import from a real Keycloak claim, a member of
  an imported group reading a shared calendar on the real Radicale, and every provider except
  Kanidm and Keycloak (from documentation).

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
`X-Forwarded-Host` or `-Proto` for anything security-relevant. Worked examples (nginx and Caddy):
`deploy/reverse-proxy/README.md`.

### 7.9 Backups

Back up SQLite with `VACUUM INTO` or `.backup` (never a file copy of a WAL database) and
`radicale-data` including `sharing.csv`, which is authorization state. Encrypt at rest, restrict
access, keep the hash key apart, and test a restore that re-runs the sharing reconcile.

### 7.10 Design stances

- Radicale as the only enforcement point is acceptable with the gateway pre-check and the nightly
  consistency audit.
- The app holds no credential at the identity provider (2026-11-05). The earlier stance, that
  `idm_group_admins` was not acceptable and an LDAP read-only bind the target, no longer applies: the
  group sync that needed either is gone. Groups are what the person's own sign-in says (§7.2).
- Bearer revocation latency (up to 15 minutes) is acceptable because app tokens revoke at once (and
  stop at the sign-in window) and admin actions re-check userinfo; consider a deny-list of `jti` when userinfo says `401` for a token
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
- Admin flag is not authorization: a stale `is_admin`, an unreachable userinfo and a `groups` claim
  missing from both userinfo and the verified token all give `403`.
- Sign-in window: a token of an owner last seen after the cutoff is accepted, before it refused, the
  edge pinned; using the token does not renew the window; a sign-in does. Run it against real SQLite
  and break the comparison to see it fail.
- Groups: a claim cannot join a group nobody imported; an absent claim changes no membership and an
  empty one removes all; the group file equals the database, an invalid name or id never reaches it,
  and a failed write leaves the old file.
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
