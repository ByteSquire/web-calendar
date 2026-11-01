# Resources, part 1: entities, bookings, availability blocks (server side)

## Built

- `server/utils/resources/`: `block.ts` (`AVAILABILITY_COLLECTION`, `blockPath`, `buildAvailabilityBlock`,
  `BlockStore` port, `createLoggingBlockStore`), `store.ts` (`setBlockStore`/`getBlockStore`),
  `service.ts` (`requestBooking`, `acceptBooking`, `declineBooking`, `cancelBooking`, `syncBlock`,
  `repairBlocks`, `listResourcesFor`, `getResourceFor`, `listBookingsFor`), `input.ts` (validators),
  `caller.ts` (`actorOf`: groups from userinfo, short names), `dto.ts`, `http.ts` (error mapping, booking
  rate limit 10 burst + 1 per 2 s per user).
- Routes: `GET /api/resources`, `GET /api/resources/:id`, `GET|POST /api/resources/:id/bookings`,
  `POST /api/resources/:id/bookings/:bookingId/{accept,decline,cancel}`; admin (`defineAdminHandler`):
  `GET|POST /api/admin/resources`, `PUT /api/admin/resources/:id`, `POST .../:id/deactivate`,
  `GET|PUT .../:id/acl` (replace; only read/book/manage for user/group/authenticated).
- Event properties: `app/utils/ical/x-properties.ts` (names, `parseBookingMarks`, `ReadEvent`),
  `booking-marks.ts` (`setBookingMarks(ics, marks|null)` for part 2), reader option
  `trustBookingProperties` -> `ReadEvent.bookingMarks`, importer strips event-level X- properties
  (`IMPORT_ALLOWED_X_PROPERTIES`, empty), a "this and following" split drops the booking marks from the new series.

## Decisions

- No migration: a block needs no stored state; the desired block follows from the booking status, so
  `syncBlock` is idempotent and `repairBlocks` (bookings ending within the last 24 h or later) retries.
  A store failure keeps the booking, is logged (error type only) and audited (`resource_booking.block_failed`;
  repair runs do not audit again).
- Block: DTSTAMP = booking `updated_at` (deterministic). Pending = `STATUS:TENTATIVE`, approved has no STATUS
  (VEVENT cannot carry BUSY-TENTATIVE; free-busy derives it). Back-reference `X-WEB-CALENDAR-BLOCK:<block_ref>`;
  UID `<block_ref>@resources.web-calendar.invalid`. `buildAvailabilityBlock` returns null for declined/cancelled.
- Rights: no right -> 404; read only -> 403 on booking; non-requester non-manager -> 404 on a booking; decline/accept
  need manage; cancel = requester or manager. The event calendar of a booking must be owned by the booker.
- Pending/approved state changes, audit entries and the rights check are one transaction; the store call comes after.
- Audit actions: `resource_booking.created|approved|declined|cancelled|block_failed`, `resource.created|updated|
deactivated|acl_replaced`; ids only. Auto-declines are audited as `declined` with `automatic: true`.
- `CalendarEvent` (shared/types) is not mine: the marks are on `ReadEvent = CalendarEvent & { bookingMarks? }`.
- Import strips ALL event-level X- properties (design: unless allow-listed); `tests/ical-split.test.ts` follows.

## Needs integration

- Wire the real store: `setBlockStore(store)` (server/utils/resources/store.ts) in a Nitro plugin at start-up;
  the store implements `{ put(path, ics), delete(path) }` and tolerates deleting a missing block.
  Call `repairBlocks({ db, store })` at start-up and on a timer (e.g. every few minutes).
- `app/utils/live/events.ts` (not mine): pass `trustBookingProperties: true` in the CalDAV branch only;
  the subscription branch must not (default false).
- Create the `_resources` collection and its shares (read audience of each resource) in the sharing task.
- design.md §5/§8 and security-review 7.4: block carries `STATUS:TENTATIVE` for pending, back-reference property
  `X-WEB-CALENDAR-BLOCK`; routes and audit actions above; import strips all event X- properties.

## Tests (written, NOT run)

`tests/server/resources-service.test.ts`, `resources-input.test.ts`, `resources-routes.test.ts`,
`tests/ical-x-properties.test.ts`; `tests/ical-split.test.ts` edited (X-CUSTOM now removed).

## Risks

- Unrun tests (mock of userinfo by fetch copied from admin-guard test). Nested immediate transactions rely on
  better-sqlite3 savepoints.
- Booking rate limit and user group lookup are per process / 60 s userinfo cache: a removed group right lingers up to a minute.
- Managers of a deactivated resource cannot list its bookings (`getResourceFor` hides inactive); they can still act by id.
- Resource ids are per resource_acl; a read-only audience for `_resources` shares is for the sharing task.
