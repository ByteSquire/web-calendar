# Schema rework (Phase 3): access rules, resources, bookings

## Built

- `server/db/migrations/006_access_and_resources.sql`: recreates `calendar_acl` (principals are
  Kanidm ids, `applied_at`) and `resources` (no `calendar_id`, plus `description`, `active`); adds
  `resource_acl` and `calendar_bookings` with triggers. A TEMP guard table aborts the migration
  with a named CHECK message if the old `calendar_acl` or `resources` hold rows (names are not
  `sub`s, resource calendars are not resources, so they cannot be converted). Nothing references
  either old table. `calendars.kind` is unchanged.
- DB modules: `calendar-acl.ts`, `resources.ts`, `resource-acl.ts`, `bookings.ts`; types in `types.ts`.
- `docs/requirements.md` FR-16, FR-18, Q12 match the 2026-10-31 model.

## API for other tasks

- calendar-acl: `listCalendarAcl`, `listAllCalendarAcl`, `listUnappliedCalendarAcl`,
  `replaceCalendarAcl` (keeps `applied_at` of unchanged rules; changed permission or new rule is
  unapplied), `addCalendarAcl` (upsert), `removeCalendarAcl`, `markCalendarAclApplied(db, ids, at?)`.
  Invalid principal or duplicate rule throws `AclError` (`code`). Remove/replace delete rows at once;
  the reconcile removes the share from desired state, so no tombstones.
- resources: `createResource` (also inserts the default `authenticated -> book` row),
  `getResource`, `listResources({includeInactive})`, `updateResource`, `deactivateResource`.
- resource-acl: `listResourceAcl`, `replaceResourceAcl`, `addResourceAcl`, `removeResourceAcl`,
  `effectiveResourceRight(db, id, {sub, groups})` (manage > book > read, max over matching rules).
  Column `"right"` is a SQL keyword; quote it in raw SQL.
- bookings: `createBooking` (result type `{ok:true,booking}|{ok:false,code}`; checks slot, resource
  active, not in past, duration, look-ahead, per-requester-per-UTC-day count, approved overlap; limits
  via `options.limits`, clock via `options.now`), `getBooking`, `listBookingsByResource`,
  `listBookingsByRequester`, `listBookingsInRange`, `approveBooking` (returns `declinedIds`),
  `transitionBooking(db, id, 'declined'|'cancelled', actorId)`, `markBookingOrphaned`,
  `clearBookingOrphaned`, `setBookingEvent`, `newBlockRef`.

## Decisions

- Default booking right is data (a `resource_acl` row), so managers can narrow it. `public` is not
  allowed in `resource_acl`.
- "Orphaned" is not a status: `orphaned_at` + `reconcile_attempts`; the booking keeps its status
  and slot during retries. Status moves: pending -> approved|declined|cancelled, approved ->
  cancelled; declined/cancelled are final (also a DB trigger). Approval only via `approveBooking`.
- Overlap guard: triggers on insert and on update of status/start/end/resource; half-open slots.
- Deletes: resource -> bookings RESTRICT (deactivate instead); requester RESTRICT (like calendar
  owners); approver SET NULL; booking calendar SET NULL (reconcile marks orphaned).
- Principal case is not normalised; UUIDs should be stored lower-case by the caller.
- Default limits (24 h, 10 per day, 365 days ahead) are placeholders; the design gives none.

## Doc changes needed

- design.md §5: replace the `calendars ||--o| resources` ER line and the `resources` bullet (no
  `calendar_id`; add `description`, `active`); `calendar_acl.principal` is a `sub`/group id plus
  `applied_at`; add `resource_acl` and `calendar_bookings` bullets; "Built" paragraph: migration 006.
- security-review §7.1: `applied_at` exists. §7.4: the unique slot is the approved-overlap trigger.

## Tests (written, NOT run)

`tests/server/access-schema.test.ts` (new), `tests/server/db.test.ts` (table list needs migration
005's `audit_log`; old resources/acl assertions rewritten).

## Risks

- Unrun SQL/tests: possible slip in trigger or GLOB syntax. The guard's error text depends on
  SQLite reporting a named CHECK constraint by name.
- A deployment with rows in the old tables fails to start until they are removed.
