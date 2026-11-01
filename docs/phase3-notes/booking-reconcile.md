# Resources, part 3: reconcile bookings whose event moved or was deleted

## Built

- `server/utils/resources/reconcile.ts` (`createBookingReconciler({ db, reader, store, now?, log?, maxAttempts? }).run()`),
  `reconcile-reader.ts` (`BookingEventReader` port + HTTP implementation: PROPFIND ctag/sync-token, REPORT by UID,
  home listing; acts as the booker; same principal/path guards as the sharing client), `reconcile-config.ts`.
- Migration `008_booking_sync.sql` (`booking_sync(calendar_id, stamp, checked_at)`, cascades with the calendar) and
  `server/db/booking-sync.ts`.
- `server/plugins/resources.ts`: reconcile loop (`createJobLoop`, first run after 90 s, no overlap, errors turn into
  backoff). Off in demo mode and without Radicale (as before).

## Behaviour

- Active = pending/approved, not ended, `event_calendar_id` set and the calendar owned by the requester. Bookings
  without a calendar are skipped (not saved yet, or the calendar was deleted: not decidable).
- Gate: per calendar the stamp (`ctag|sync-token`) is compared with `booking_sync`; unchanged = no event read.
  A calendar with a booking in retry (orphaned, attempts < limit) is read anyway. The stamp is stored only when every
  booking of the calendar is resolved. A server with neither ctag nor token is never gated.
- Outcomes: unchanged (UID found, same slot, marks `res:<resource>` and booking id match) clears orphaned.
  Not readable (error/timeout/non-207) = `markBookingOrphaned`, up to 3 attempts, never a cancel. Gone (calendar 404,
  or the UID absent in the calendar and in every other calendar of the booker's home; a shared mount appears there)
  = mark; at the 3rd sighting the booking is cancelled, block removed (`syncBlock`), audited
  `resource_booking.cancelled` `{reason:'event_removed'}` (actor `system:resources`). Found in another calendar of the
  booker with the same slot and marks: `setBookingEvent`. Slot or resource changed, marks stripped, or moved to
  a calendar the app has no row for: `event_moved`: attempts jump to the limit (manager queue), audit
  `resource_booking.orphaned {reason:'event_moved'}` once; never cancelled. Orphaned audits also carry
  `event_unreadable` / `event_missing` (first marking only).
- A booking younger than 10 min with missing marks is left alone (part 2 writes them after the booking).
- The cancel is a direct `transitionBooking` + audit in one transaction (the service's `cancelBooking` needs an actor
  with rights and cannot carry a reason or system actor), then `syncBlock` from the service.

## Config (README rows to add)

- `NUXT_RESOURCES_RECONCILE_INTERVAL_SEC` (`resources.reconcileIntervalSec`, default 300, 1..900).
- `NUXT_RESOURCES_MANAGER_CANCEL` (`resources.managerCancel`, `true`/`false`, default `false`).

## Needs integration

- DONE at integration (default on, as design §5 says): `managerCancel` is read by `depsOf` through `apiConfig()` and checked in `move` in service.ts. Original note: the service (`service.ts` `move`) already lets a manager cancel any booking, unconditionally. I
  could not gate it there (frozen). Decision for integration: in `server/api/resources/[id]/bookings/[bookingId]/cancel.post.ts`
  (or `move`), refuse (403) a cancel by a non-requester manager unless `useRuntimeConfig().resources.managerCancel === 'true'`.
  Note this changes today's behaviour with the default off; if that is unwanted, flip the default.
- The manager queue API lists orphaned bookings; it cannot tell moved from missing/unreadable except by audit.
- docs/design.md §5 "Reconcile on move/delete": describe the above (outcomes, limit of 3, `booking_sync`, the grace).
- docs/security-review.md 7.4: reconcile runs as the booker through the internal client, never auto-cancels on a
  changed/stripped/unreadable event; audit actions `resource_booking.orphaned`, `resource_booking.cancelled` (reason).

## Tests (written, NOT run)

`tests/server/resources-reconcile.test.ts` (unchanged clears, grace, deleted cancels only after retries + block + audit,
calendar gone, follows a moved event, unreadable never cancels, moved flagged, stripped marks, ctag gate, settled
bookings, no overlap), `resources-reconcile-reader.test.ts` (XML parsing, 404 vs error, guards),
`tests/validate-config.test.ts` (new settings). The reconcile tests use an in-memory fake of the reader port, not the
HTTP fake (it has no REPORT/ctag); the real HTTP reader is only covered by the small reader test.

## Risks

- Radicale's REPORT/PROPFIND shapes (getctag/sync-token, `calendar-data` quoting) are unverified live.
- Mixed counting: attempts from unreadable looks and "gone" looks share one counter, so unreadable x3 then one
  "gone" cancels. A moved-flagged booking whose event is later deleted is cancelled on the first "gone" look.
- Events in a shared calendar the booker does not own cannot be followed (skipped); an event moved there is flagged.
- Booker's home with more than 20 calendars: the search is treated as unreadable (never cancels).
