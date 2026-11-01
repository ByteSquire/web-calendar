# Sharing writer (Phase 3): calendar_acl to Radicale map shares

## Built

`server/utils/sharing/`: `radicale-client.ts` (separate internal client; acts as a validated principal
or `_resources`; 10 s timeout, 4 MiB cap, `redirect: 'manual'`), `desired.ts` (pure ACL to shares),
`reconcile.ts` (diff, apply, re-read, compare, mark, alarm), `calendars.ts` (discovery into
`calendars`), `audit-job.ts` (nightly), `block-store.ts`, `precheck.ts` + `membership.ts` (gateway
pre-check), `names.ts`, `loop.ts` (no overlap, debounce, backoff), `config.ts`, `index.ts`
(`requestSharingReconcile()`, `getSharingState()`), plugin `server/plugins/sharing.ts` (off in demo
mode and without `radicale.url`). Gateway: optional `precheck` option, wired in `nitro.ts`.

## Contract for other tasks

- `requestSharingReconcile(): void` from `server/utils/sharing` (debounced 2 s; no-op when not running).
- `createResourceBlockStore(): { put(path, ics), delete(path) }` from `server/utils/sharing/block-store`;
  acts as `_resources`; path must match `/_resources/availability/<[A-Za-z0-9_-]+>.ics`; creates the
  collection on first use; throws on any failure (the booking marks itself orphaned). The reconcile
  keeps the collection shared with `f` to `web_calendar_users`; members see it as
  `/<sub>/resource-availability/`.
- Audit actor `system:sharing-writer`; actions `sharing.removed_unknown`, `sharing.replaced`,
  `sharing.mismatch` (once per distinct difference set), `sharing.failing` (5 failed runs),
  `sharing.recovered`, `sharing.audit_mismatch`.
- `calendars` is filled by discovery (personal for users' homes, shared for `sharing.sharedOwners`,
  e.g. `_team`). Rows are never deleted. `_resources` is not mirrored.

## Decisions

- Names in a member's home: user share `/<sub>/shared-<calendarId>/`, group share
  `/{user}/shared-<calendarId>-<group>/`, availability `/{user}/resource-availability/`. The id in the
  name is what the gateway pre-check looks up, so **no extra table or migration** was needed.
  Consequence: members cannot own a calendar named `shared-<digits>[-x]` (the pre-check treats it as a
  share). Documented in the README.
- Share identity = (owner, PathMapped, User). A differing PathOrToken or permission is deleted and
  recreated. Several rules for the same recipient (e.g. `authenticated` plus group
  `web_calendar_users`) merge to the highest permission.
- User shares are accepted (enable + unhide as the member) when created, when the list shows them
  disabled/hidden, and while any rule behind them is unapplied (self-heals a crash between create and
  accept). Group lists get `epu` appended by Radicale; the comparison ignores those letters.
- Token shares: the reconcile also lists `token` shares per owner and removes any (we never create
  one). If that API does not answer, it is ignored.
- `applied_at`: set in one synchronous block after the verified re-read, only for rules unchanged
  since the run started. `admin`/`public` rules (nothing for Radicale) are marked once their calendar's
  owner verified clean. Rules of calendars missing in Radicale, or invalid principals, stay unapplied.
- Unreachable: the run fails, nothing is marked, the loop retries after 5 s, 10 s, 20 s ... up to the
  interval. `getSharingState()` exposes `consecutiveFailures`, `lastFailure`, `lastSummary`.
  ACL writers can return 503 when it is `> 0` if they want.
- Pre-check group membership: the htgroup file the group sync writes (`groupSync.file`), the same
  file Radicale reads, re-read when mtime/size change. A missing file means no groups (fail closed:
  `authenticated` and group rules grant nothing, with one warning). Rules: root allowed; own home
  allowed, but `shared-<id>*` names need a rule granting the caller (write methods need `write`);
  `resource-availability` needs `web_calendar_users` and is read-only; another principal's home itself
  is 403, and its calendars need a rule (looked up by `collection_path`). `admin` and `public` rules
  grant nothing. COPY/MOVE destinations are checked too.
- Audit job: uses the same desired-share computation and the htgroup file; a confirmed rule whose share
  is not listed, or a share listed without a rule, is a difference. First run 2 min after start.

## Config

`sharing.reconcileIntervalSec` (NUXT_SHARING_RECONCILE_INTERVAL_SEC, default 300, max 900),
`sharing.auditIntervalHours` (default 24, 1..168), `sharing.sharedOwners` (comma list of `_name`).
`validate-config.mjs` rejects out-of-range values and bad owners.

## Doc changes needed

- design.md §8: the share naming above; pre-check source of group membership; audit actions; `epu`
  suffix in group lists; token shares are removed.
- security-review §7.1: `applied_at` and the audit actions exist; tests list below; §7.10 unchanged.

## Tests (run at integration, pass)

`tests/server/sharing-reconcile.test.ts` (fixture ACLs to shares, invented share removed, replaced
permission, deleted rule, unreachable, refused creates alarm once, invalid principal refused, response
cap, backoff), `sharing-gateway-precheck.test.ts` (owner/grantee/stranger, methods, destination,
`.sharing` 404), `sharing-audit-job.test.ts`, `sharing-block-store.test.ts`, helper
`sharing-fake-radicale.ts` (not a test file), `tests/validate-config.test.ts` (sharing settings).
Not covered: end to end bob/alice against a real Radicale.

## Risks

- The API shapes not seen in S5: group share `User` as `:group` in list output, the `{user}`
  placeholder echoed back, `token/list` and `token/delete`. If the list differs, the reconcile
  churns (delete and create each run) and alarms; check on the first live run.
- Group share to a member who also has a user share of the same calendar may get a 409 (one share per
  source and user); it shows as a difference.
- A calendar renamed or removed in Radicale: renames are mirrored; removed ones keep their row.
- The pre-check reads the group file per request (one `stat`); a stale file means stale grants, as
  for Radicale.
- Each owner costs one list request (plus one for tokens) every run.
