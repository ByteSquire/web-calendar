# Group sync (Phase 3)

## Built

`server/utils/group-sync/`: `types.ts` (Result, failure kinds), `ports.ts`, `config.ts` (interval clamp
1..300, default 60; file path), `kanidm.ts` (fetch client: bearer token, 10 s timeout, 1 MiB cap,
`redirect: 'error'`, token scrubbed from every message), `members.ts` (SPN to UUID), `format.ts`
(htgroup text and its validation), `file.ts` (temp file, fsync, rename, `.prev`), `service.ts` (one run,
failure streaks, alarms), `scheduler.ts` (no overlap, debounce), `active.ts` (process handle,
`requestGroupSyncRun()`, `noteUserGroups()`). Plugin: `server/plugins/group-sync.ts`.
`resolveMe` calls `noteUserGroups` (option `groupsSeen` overrides it in tests).
Config: `groupSync.file` (NUXT_GROUP_SYNC_FILE). `validate-config.mjs` rejects an interval over 300 and an empty file value.

## Decisions

- **SPN to UUID (important).** `GET /v1/group/<name>` lists members as SPNs only. In the test stack the
  sync token cannot read persons (`/v1/person/<spn>` and `/v1/raw/search` return `null`/empty), `/scim/v1/*`
  and `/v1/internal/uuid/*` answer 404. So the UUID comes from the app's `users` table
  (`preferred_username` = SPN, `oidc_sub` = UUID). Not cached across runs (an SPN can be reused).
  A member who never signed in makes the run fail (warning names up to 5 SPNs). Retried every interval,
  so it resolves within one interval after their first sign-in. Nested group members are unresolvable too.
- Alarm: 401/403 logs at error level on every run; one `group_sync.unauthorized` audit event per streak.
  Escalation: at every 5th consecutive failure, error log plus `group_sync.failing`. Recovery after
  an alarm or escalation: `group_sync.recovered`. A changed file: `group_sync.updated`
  (details: group names, member count; no SPNs).
- The first look at a user's groups is not a change; only a differing later claim triggers a run
  (debounce 2 s, and a request during a run schedules one follow-up run).
- Startup run waits (up to 30 s) for the db plugin to open the database.
- `USERS_GROUP = 'web_calendar_users'` is a constant, not config.

## Ports for integration

```ts
// in server/utils/group-sync/ports.ts: createDefaultPorts() is used in server/plugins/group-sync.ts
ports: { listExtraGroups: () => listReferencedGroupNames(getDb()), audit: (e) => writeAudit(getDb(), { actor: null, ...e }) }
```

Replace `createDefaultPorts()` in `server/plugins/group-sync.ts` (it is the only call). `listExtraGroups`
must return group short names (not SPNs); invalid names fail the run. `audit` is called with
actions `group_sync.updated|unauthorized|failing|recovered`; it must not throw (a throw is swallowed).

## Doc changes needed (not made)

- design.md §8/§12 S9: members are mapped through the `users` table because the API token cannot
  read persons; a never-signed-in member blocks a run. LDAP (`entryuuid`) removes that limit.
- security-review.md §7.2: add the audit actions above; note the "stale file keeps removed members"
  risk during failures and that the escalation threshold is 5 runs.

## Tests (written, NOT run)

`tests/server/group-sync-file.test.ts`, `-kanidm.test.ts`, `-service.test.ts` (exact file, null/error
leaves file, atomic rename and `.prev`, removed member, token never in logs, interval clamp, no
overlap, 401/403 alarm, trigger, users-table resolver); `tests/validate-config.test.ts` (interval, file).

## Risks

- Fail-closed on unresolved members can leave the file stale (removals not applied) while someone in a
  group has never signed in. Mitigation to decide: LDAP bind, or a Kanidm grant to read persons.
- If the app's `preferred_username` is not the SPN (short names), nothing resolves.
- The Radicale volume dir must be writable by the app user (`/groups` is chowned to node in the Dockerfile).
- The Dockerfile CMD still creates an empty file first; that stays valid.
