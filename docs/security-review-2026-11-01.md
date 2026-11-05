# Security review — 2026-11-01

Before the first release (guide §1). Reviewed commit `cfe9498`. Method: read the code against
`docs/security-review.md` §1–§8, split into three areas, plus a live attack of the production
build (`.output`) with the test stack (`dev/spike-s1`, users alice and bob, real Kanidm tokens).

The fixes in §2 were made after the review, on top of `cfe9498`, each in its own commit (see
`git log cfe9498..`). Release gate, run in the Dev Container on the tree at `b431ddb` (the last of those commits),
all passing:

| Step                        | Result                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| `npm run check`             | exit 0 (format, lint, typecheck, e2e typecheck)                                 |
| `npm test`                  | 5553 passed, 63 skipped (164 files)                                             |
| `npm run test:e2e`          | 880 passed, 562 skipped by design (project-specific), exit 0                    |
| `npm run audit:prod`        | exit 0: only the three known advisories (glob, minimatch, deepmerge)            |
| `npm run test:gateway:prod` | 30 passed                                                                       |
| `npm run test:e2e:live`     | 20 passed, against the real Kanidm and Radicale                                 |
| `reuse lint`                | compliant: 665 of 665 files have a licence and a copyright (`fsfe/reuse` image) |

## 1. Status, by guide §6 bullet

The three reviewers (identity and gateway; outbound connections and rendering; organization data,
bookings and deployment) each went through the guide's bullets for their area and judged all but
the ones below OK, naming the code and the test for each. **Their per-bullet tables were not saved
into the repo**, so this report lists the findings and the gaps only, and an OK here is the
reviewer's reading, not something re-checked by a second person. Three bullets had no clean OK:

- **App tokens: "revoke all"** — missing, although FR-31 asks for it (Finding 3).
- **Secrets: one purpose per key** — not enforced (Finding 5).
- **7.8 Reverse proxy and TLS reference configuration** — not shipped (Finding 4).

## 2. Findings

Confidence is how sure the finding is real, not its severity.

1. **Medium, confidence 85 (live-confirmed). Any public host is an iCal destination by default.**
   `server/utils/ical-proxy/nitro.ts:41-47`, `server/validate-config.mjs:271`.
   `NUXT_OUTBOUND_ALLOWED_HOSTS` defaults to empty, which means **every** public host, not none.
   Confirmed against the production build: `POST /api/ical-subscriptions` with
   `https://example.com/anything.ics` was accepted, and `GET …/data` made the server actually
   fetch it (log: `sub 1 host=example.com: http-404`). A script injected into the page, or a
   malicious user, can make the server contact a host the attacker names, carrying up to 2000
   characters of URL or query — the guide calls this an exfiltration channel outright. The SSRF
   guard (private addresses, rebinding) is not in question; the open allow-list is.
   **Fixed** (you chose this): in production the server and `validate-config.mjs` refuse to start
   with an empty list unless `NUXT_OUTBOUND_ALLOW_ANY_HOST=true` (a warning then). It is ignored
   when a list is set, and does not apply outside production. Config: `nuxt.config.ts`,
   `.env.example`, `docker-compose.yml`, README. `scripts/test-gateway-prod.mjs` now gives its
   server a host list. Tests: `tests/validate-config.test.ts`, `tests/server/api-startup-glue.test.ts`.
   Proven on the production build (`.output`) started by hand: with no list and no switch it
   exits at the first request with the message; with the switch it runs and warns; with a list it
   runs. The Playwright configs set the switch (the build runs in production), so the browser
   tests still mean what they meant. **Not run:** the Docker image itself, and `npm run preview`,
   which is also production and now needs a list or the switch.

2. **Medium, confidence 75. An app token outlives the account it was issued to.**
   `server/db/app-tokens.ts:159-205`, `server/utils/auth/nitro.ts:72`,
   `server/utils/sharing/precheck.ts:60-68`. `verifyAppToken` checks only SQLite (hash, username,
   expiry); it never asks Kanidm. Confirmed by reading the precheck: a request to the caller's own
   home (`collection === undefined`) returns `true` unconditionally, without checking group
   membership at all — group membership is only consulted for _shared_ calendars. A disabled,
   deleted or removed user keeps full CalDAV read/write on their own calendar for up to a token's
   year-long life; a bearer token dies within minutes because `/api/me` re-asks userinfo, but the
   gateway's Basic path has nothing equivalent. **Fixed** (you chose this): after a group sync run that
   read every group and wrote the file, the app tokens of every user outside `web_calendar_users`
   are deleted (`revokeTokensOfNonMembers` in `server/utils/group-sync/app-ports.ts`; one
   `group_sync.tokens_revoked` audit event per user). Limits, by design: it needs the group sync
   (`NUXT_GROUP_SYNC_TOKEN`), so with no token nothing removes them; tokens made after the run
   began are kept (a user added meanwhile); an empty users group removes nobody; a failed run
   removes nobody. Tests: `tests/server/group-sync-app-ports.test.ts` (real SQLite and a real
   `verifyAppToken` afterwards), `tests/server/group-sync-service.test.ts`. **Proven live** against
   the test Kanidm: after bob was removed from `web_calendar_users`, his app token was refused
   (401) within about 9 s with the sync interval at 5 s, the audit row `group_sync.tokens_revoked`
   (`{"reason":"no longer in the users group","revoked":1}`) was written, and alice's token kept
   working; bob was then added back. That run also found a defect in the sync itself, now fixed:
   with Kanidm's documented `prefer-short-username` the stored name is `alice` but the group
   member is `alice@idm.localhost`, so no member matched and the sync never ran. The users
   lookup then also matched the short name in the issuer's domain; since 2026-11-02 the names are
   not looked up locally at all (§5), which removes this class of mismatch. Tests:
   `tests/server/group-sync-service.test.ts` (also checked by breaking the code).

   _Superseded 2026-11-05 by the sign-in window._ The group sync, `revokeTokensOfNonMembers` and the
   `group_sync.tokens_revoked` audit event no longer exist, and neither does the proof above (it
   ran against that code). `verifyAppToken` now refuses a token whose owner has not signed in to the
   web app, or with an OIDC bearer token at `/caldav/`, within `NUXT_SIGNIN_WINDOW_DAYS` (default 30,
   1 to 365); using the token does not renew the window. The finding's scenario therefore ends at the
   window, not within one sync interval, and it needs no group sync or token. The worst case is now
   weaker in time (up to the window after the owner's last sign-in, where the sync deleted the tokens
   within about a minute) and stronger in coverage (it also holds with no Kanidm credential at all);
   no admin control cuts a token off sooner except the owner's own "Revoke all". Design §6 and
   `docs/security-review.md` §7.2 describe the new control. The text above is kept as the record of
   the 2026-11-01 review.

3. **Low, confidence 90. No "revoke all" for app tokens.** Guide §4 and §7.7 ask for it; only
   per-token delete exists (`server/api/app-tokens/[id].delete.ts`, max 10 tokens). FR-31 says "individually and
   all at once". **Fixed**: `DELETE /api/app-tokens` (revokes all of the caller's tokens, answers
   `{ revoked: n }`) and a "Revoke all" button with a confirmation next to the list in Settings →
   App tokens. Tests: `tests/server/api-app-tokens.test.ts`, `tests/server/api-routes.test.ts`,
   `tests/settings-tokens-section.test.ts`. Browser tests (`e2e/settings.spec.ts`): confirm, cancel, a failing server and no tokens.

4. **Low, confidence 85. No reverse-proxy reference configuration shipped.** Guide §7.8 asks for
   one (TLS, HSTS, appended `X-Forwarded-For`, body size, buffering off for `/caldav/`); `deploy/`
   has only Radicale's files, and `design.md` leaves it to prose. **Fixed**: added
   `deploy/reverse-proxy/README.md` with an nginx and a Caddy example, linked from the guide §7.8
   and the README. Run on 2026-11-02 against nginx 1.31.8 and Caddy 2.11.7 (results in that
   file's "Tested"); fixed then: Caddy's `header_up X-Forwarded-For` line sent `,<address>` and is
   gone, and nginx's `/caldav/` sets `proxy_http_version 1.1` so older nginx streams chunked bodies.

5. **Low, confidence 70. The three secret keys are not required to differ.**
   `NUXT_TOKEN_HASH_KEY`/`NUXT_TOKEN_HASH_KEYS`, `NUXT_EXTERNAL_SEAL_KEY` and
   `NUXT_GROUP_SYNC_TOKEN` can be set to the same value; the guide says one purpose per key.
   **Fixed**: `server/validate-config.mjs` now fails startup if two of the three purposes share a
   value (several token hash key versions may share one). Tests: `tests/validate-config.test.ts`.
   _Note 2026-11-05:_ `NUXT_GROUP_SYNC_TOKEN` no longer exists (the group sync was removed), so the
   purposes that must differ are the token hash key and the seal key.

6. **Low, confidence 60. No overall cap on a user's live resource bookings.**
   `server/db/bookings.ts:92-98` caps 10 pending/approved bookings **per start day**, uncapped
   overall; cancelling and recreating costs only the 0.5/s rate limit, and each cycle writes and
   deletes a block in Radicale's shared calendar. **Fixed**: a cap of 50 pending + approved
   bookings per user on any day (`maxLivePerRequester`, answer 409 `live_limit`), alongside the
   per-day cap. Test: `tests/server/access-schema.test.ts`. The 50 is my choice; say if you want
   another number.

7. **Low, confidence 70. No backup tooling.** Guide §3 and §7.9 ask for a restorable backup; only
   prose (`VACUUM INTO`) existed. **Fixed**: `scripts/backup-db.mjs` (`npm run backup -- <db> <dir>`):
   `VACUUM INTO` from a read-only connection (it picked up a row that was only in the `-wal`
   file), a `0600` timestamped copy that is never written over an existing one, and a
   `PRAGMA integrity_check` on the copy. It uses `node:sqlite` (Node 24), so no new dependency.
   README "Production" has the throwaway-container command and the restore steps. Tests:
   `tests/scripts/backup-db.test.ts`, plus one run through `npm run backup` against a live
   writer. The README's `docker run …` command was run on 2026-11-02 against a live Compose stack's
   volume, and the copy restored by the README's steps into a new volume: `PRAGMA integrity_check`
   is `ok` and the image starts on it. Radicale's volume
   (with `sharing.csv`) is still backed up by the operator.

8. **Low, confidence 50. Radicale's isolation rests on the default Compose network.**
   `docker-compose.yml` has no explicit `networks:`, so another container the operator later joins
   to the same Compose project could set `X-Remote-User` to anyone. **Fixed**: an explicit `radicale` network with `internal: true`,
   shared only by `web-calendar` and `radicale`; Radicale is no longer on `default`. Checked with
   `docker compose config`, then brought up on 2026-11-02: the app reaches `radicale:5232`,
   Radicale has no published port, no default route and no DNS outside, and both containers run
   with a read-only root, no capabilities (`CapEff` 0) and `NoNewPrivs` 1.

9. **Low, confidence 50. The gateway has no per-user rate limit, concurrency cap or upstream
   timeout**, so a valid user can run unbounded heavy `REPORT`/`PROPFIND` requests, and `client_id`
   is optional in bearer verification (`server/utils/auth/jwt.ts`). **Fixed**, in three parts:
   - The gateway gives up after 30 s (`upstreamTimeoutMs`) when Radicale has not started to
     answer, with `504`. Only the wait for the headers is timed, so a long streamed answer is not
     cut off. Tests: `tests/server/gateway-proxy.test.ts`.
   - A cap of 8 requests in flight per user (`server/utils/gateway/concurrency.ts`, setting
     `NUXT_GATEWAY_MAX_CONCURRENT_PER_USER`, checked at startup); a ninth answers `429` with
     `Retry-After`. The slot is held until the answer has been read to its end and is given back
     when Radicale fails, times out or the path is refused. Tests:
     `tests/server/gateway-concurrency.test.ts`, `tests/server/gateway-proxy.test.ts`,
     `tests/server/api-startup-glue.test.ts`, `tests/validate-config.test.ts`.
   - `client_id` is required: a bearer token without one is refused. Test:
     `tests/server/auth-jwt.test.ts`.

   The guide asks for a rate limit _or_ a concurrency cap; I chose the cap. A per-user request
   rate (token bucket) was not added. The value 8 is the user's choice.

10. **Low, confidence 50. Admin mutation and its audit-log row are not one transaction**
    (for example `server/api/admin/views/[id].put.ts`), unlike the booking routes. A failed audit
    insert leaves a change with no audit row. **Fixed**: `defineAdminHandler` gives every admin
    route `atomic()`, which runs the change and its `audit()` in one database transaction; the
    seven mutating admin routes use it, and the reconcile request of the access route runs after
    the commit. Tests: `tests/server/admin-views.test.ts` and `tests/server/admin-access.test.ts`
    break the audit insert with a trigger and check that the change is not stored.

11. **Low, confidence 40. Base images pinned by tag, not digest**
    (`node:24.15-bookworm-slim`, `radicale:3.9.0` in `dev/spike-s1`). **Decided: stay on tags**
    (your choice), so the images are not byte-for-byte reproducible and a re-tagged image would be
    picked up on the next pull. Nothing changed.

## 3. Not checked

The reviewers named what they did not read. In short: `sharing/reconcile.ts`, `sharing/plugins/sharing.ts`, the group-sync internals beyond the
plugin, migrations 001–004 and 008, most `.vue` files beyond a grep for `v-html`/`innerHTML`/
`href`, `oidc-client-ts` and `tsdav`'s own source, and the test _bodies_ (only titles were matched
by grep almost throughout — nobody in this review ran the suites file-by-file to confirm a title's
test does what it says beyond the full-suite pass already recorded above).

Follow-up (2026-11-02): `server/utils/sharing/reconcile.ts`, `server/plugins/sharing.ts`,
`server/utils/group-sync/*`, migrations 001–004 and 008, the `.vue` files under `app/` and the
German-translation commit (411e485, `tparts`) are now read. No `v-html`, `innerHTML`,
`target="_blank"` or bound `href`/`src` exists; `tparts` returns text parts rendered with `{{ }}`,
so user text is escaped; the OIDC user store is in memory, only the login state is in
`sessionStorage`. The one finding is open in §5. `oidc-client-ts`, `tsdav` and the test bodies
outside the files below are still unread.

## 4. Controls with no test (candidates for a test)

Both now have one (2026-11-02):

- The `.ics` data endpoint: `tests/server/api-routes.test.ts` (`GET /api/ical-subscriptions/:id/data`)
  checks `nosniff` and that a body that looks like HTML is still served as `text/calendar`.
- Compose hardening (`read_only`, `cap_drop`, `no-new-privileges`, the `internal: true` network,
  no published Radicale port) and the content of the Radicale rights file:
  `tests/scripts/compose-hardening.test.ts`.

## 5. Open

No finding is open. What the gate did not prove:

- Findings 4, 7 and 8 were run on 2026-11-02 (see each); not run: an authenticated request
  through the proxies, and Let's Encrypt.
- A per-user request rate limit (Finding 9) was not added; the concurrency cap stands in for it.
- What §3 still lists as unread.
- Group membership by stale user name (Low, medium confidence), found 2026-11-02 and **fixed** the
  same day: the sync mapped a member SPN to a `sub` through `users.username` as last seen at
  sign-in, so a name renamed away and given to someone who had not signed in yet granted the old
  holder that person's groups. It now reads each member's `uuid` from Kanidm on every run
  (`createKanidmResolver` in `server/utils/group-sync/members.ts`, `readPersonUuid` in
  `kanidm.ts`); the sync account needs `idm_people_pii_read` (docs/kanidm-setup.md §3). Tests:
  `tests/server/group-sync-service.test.ts` (the reuse test fails when a cache is added),
  `tests/server/group-sync-kanidm.test.ts`. **Proven live** against the test Kanidm: with an empty
  `users` table the file got alice's and bob's UUIDs; without the grant every run failed with the
  message naming it and no file was written; a write with the token still answers 403.
  _Superseded 2026-11-05:_ the sync and its account are gone. Members of imported groups are now
  stored by the `sub` the person's own token carries, so no name is mapped to an id any more (the
  class of finding is gone, a different trust is in its place: `docs/security-review.md` §7.2). The
  `docs/kanidm-setup.md` §3 cited above no longer describes a sync account.
