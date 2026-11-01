# Security review — 2026-11-01

Before the first release (guide §1). Reviewed commit `cfe9498`. Method: read the code against
`docs/security-review.md` §1–§8, split into three areas, plus a live attack of the production
build (`.output`) with the test stack (`dev/spike-s1`, users alice and bob, real Kanidm tokens).

The fixes in §2 were made after the review, on top of `cfe9498`, each in its own commit (see
`git log cfe9498..`). Release gate, run in the Dev Container on the tree those commits add up to,
all passing:

| Step                        | Result                                                               |
| --------------------------- | -------------------------------------------------------------------- |
| `npm run check`             | exit 0 (format, lint, typecheck, e2e typecheck)                      |
| `npm test`                  | 5518 passed, 63 skipped (163 files)                                  |
| `npm run test:e2e`          | 860 passed, 526 skipped by design (project-specific), exit 0         |
| `npm run audit:prod`        | exit 0: only the three known advisories (glob, minimatch, deepmerge) |
| `npm run test:gateway:prod` | 30 passed                                                            |
| `npm run test:e2e:live`     | 20 passed, against the real Kanidm and Radicale                      |

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
   `verifyAppToken` afterwards), `tests/server/group-sync-service.test.ts`. **Not run: a live
   removal in Kanidm** — the stack's sync token was not used.

3. **Low, confidence 90. No "revoke all" for app tokens.** Guide §4 and §7.7 ask for it; only
   per-token delete exists (`server/api/app-tokens/[id].delete.ts`, max 10 tokens). FR-31 says "individually and
   all at once". **Fixed**: `DELETE /api/app-tokens` (revokes all of the caller's tokens, answers
   `{ revoked: n }`) and a "Revoke all" button with a confirmation next to the list in Settings →
   App tokens. Tests: `tests/server/api-app-tokens.test.ts`, `tests/server/api-routes.test.ts`,
   `tests/settings-tokens-section.test.ts`. The new button has no browser (Playwright) test.

4. **Low, confidence 85. No reverse-proxy reference configuration shipped.** Guide §7.8 asks for
   one (TLS, HSTS, appended `X-Forwarded-For`, body size, buffering off for `/caldav/`); `deploy/`
   has only Radicale's files, and `design.md` leaves it to prose. **Fixed**: added
   `deploy/reverse-proxy/README.md` with an nginx and a Caddy example, linked from the guide §7.8
   and the README. **The two examples were written to the guide's list and have not been run
   against nginx or Caddy.**

5. **Low, confidence 70. The three secret keys are not required to differ.**
   `NUXT_TOKEN_HASH_KEY`/`NUXT_TOKEN_HASH_KEYS`, `NUXT_EXTERNAL_SEAL_KEY` and
   `NUXT_GROUP_SYNC_TOKEN` can be set to the same value; the guide says one purpose per key.
   **Fixed**: `server/validate-config.mjs` now fails startup if two of the three purposes share a
   value (several token hash key versions may share one). Tests: `tests/validate-config.test.ts`.

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
   writer. **The `docker run …` command in the README was not run**; Radicale's volume
   (with `sharing.csv`) is still backed up by the operator.

8. **Low, confidence 50. Radicale's isolation rests on the default Compose network.**
   `docker-compose.yml` has no explicit `networks:`, so another container the operator later joins
   to the same Compose project could set `X-Remote-User` to anyone. **Fixed**: an explicit `radicale` network with `internal: true`,
   shared only by `web-calendar` and `radicale`; Radicale is no longer on `default`. Checked with
   `docker compose config` only. **The stack was not brought up with it**, so that the app still
   reaches Radicale over the new network is unverified.

9. **Low, confidence 50. The gateway has no per-user rate limit, concurrency cap or upstream
   timeout**, so a valid user can run unbounded heavy `REPORT`/`PROPFIND` requests, and `client_id`
   is optional in bearer verification (`server/utils/auth/jwt.ts:284`). **Fixed the
   small part**: the gateway now gives up after 30 s (`upstreamTimeoutMs`) when Radicale has not
   started to answer, with `504`. Only the wait for the headers is timed, so a long streamed answer
   is not cut off. Tests: `tests/server/gateway-proxy.test.ts`. **Not fixed**: a per-user token
   bucket and a required `client_id`; larger changes, see §5.

10. **Low, confidence 50. Admin mutation and its audit-log row are not one transaction**
    (for example `server/api/admin/views/[id].put.ts`), unlike the booking routes. A failed audit
    insert leaves a change with no audit row. **Fixed**: `defineAdminHandler` gives every admin
    route `atomic()`, which runs the change and its `audit()` in one database transaction; the
    seven mutating admin routes use it, and the reconcile request of the access route runs after
    the commit. Tests: `tests/server/admin-views.test.ts` and `tests/server/admin-access.test.ts`
    break the audit insert with a trigger and check that the change is not stored.

11. **Low, confidence 40. Base images pinned by tag, not digest**
    (`node:24.15-bookworm-slim`, `radicale:3.9.0` in `dev/spike-s1`). Left open, see §5.

## 3. Not checked

The reviewers named what they did not read. In short: `sharing/reconcile.ts`, `sharing/plugins/sharing.ts`, the group-sync internals beyond the
plugin, migrations 001–004 and 008, most `.vue` files beyond a grep for `v-html`/`innerHTML`/
`href`, `oidc-client-ts` and `tsdav`'s own source, and the test _bodies_ (only titles were matched
by grep almost throughout — nobody in this review ran the suites file-by-file to confirm a title's
test does what it says beyond the full-suite pass already recorded above).

## 4. Controls with no test (candidates for a test)

- The `.ics` data endpoint (`server/api/ical-subscriptions/[id]/data.get.ts`) has no route-level
  test for `nosniff` or content-type coercion.
- Compose hardening (`read_only`, `cap_drop`, `no-new-privileges`, the `internal: true` network)
  and the content of the Radicale rights file.
- A live Kanidm user removal against the gateway (this review read the code path; it did not
  remove a live user).
- The "Revoke all" button in a real browser.

## 5. Open

Not done, larger or touching many files:

- Finding 9: a per-user rate limit or concurrency cap on the gateway, and a required `client_id`.
- Finding 11: base images by digest.
- Finding 2 has no live proof against Kanidm (see its entry).
