# Resources part 2, client (FR-16..FR-19)

## Built
- Loader (`app/utils/live/loader.ts`): lists `/api/resources` with the sources; each resource becomes a `type: 'resource'`
  calendar `res:<id>` (hidden by default, read-only) plus a `CalendarResource`. For visible resource calendars it asks
  `/api/resources/availability` (pieces of <= 62 days) and adds entries to `events`: approved+blocked = hatched "Busy",
  pending+blocked = tentative "Busy (pending)", others "Booked by <name>" or the title of an event the browser has (by uid).
  Errors under `source:resources` / `source:availability`.
- `app/utils/resources/*`: types, availability mapping, slot, booking-flow (orchestration with fakes), errors, updates (toast text, localStorage
  key `web-calendar:resource-updates-seen:<sub>`), rows, format.
- Composables: `useResourceRights` (rights from the list; demo = manage), `useResourceBooking`, `useResourceBookings` (page data; demo = local state),
  `useResourceUpdates` (one toast on sign-in, wired in `useLiveCalendar`).
- UI: `ResourceBookingFields`, `BookRightAwayCheckbox` in QuickAddModal, EventEditModal (+ EventWriteDialogs books after the edit);
  page `/resources/requests`; sidebar link; overflow entry "Resource bookings" for managers only (live).
- Page: pending requests (accept/decline, overlap hint, orphaned note), "My bookings" (cancel). Redirects home when nothing to manage or show.

## Decisions
- Recurring events: new repeating events and edits with scope other than "this" are saved WITHOUT booking, with a message (marks cover a
  series). An occurrence ("This event") can get a booking; marks are not written for it.
- Booking sends `eventCalendarId: null` (the browser knows calendars by ref, not by DB id). Several resources: only the first booked one is marked.
- Refused booking: event stays saved; quick add shows the reasons and switches to a Close button (saving again would duplicate the event).
- Own bookings are collected from `GET /api/resources/:id/bookings` for resources with book/manage right (N requests); a managed list is filtered to own requester id.

## Needs integration
- A route listing all own bookings in one call would replace the N requests; and `eventCalendarId` could be resolved if `/api/calendar-prefs`/calendars exposed DB ids.
- design.md §5/§9: describe the page, availability display and the series rule. README: add `/resources/requests`.

## Tests (written, NOT run)
`tests/resources-ui-availability.test.ts`, `resources-ui-updates.test.ts`, `resources-ui-flow.test.ts`, `e2e/resources-requests.spec.ts`.
Existing specs/tests not edited; demo overflow menu and live menu unchanged for non-managers.

## Risks
- No component test of the forms; the marks edit after create races nothing but needs a real CalDAV check. Sidebar "Resource bookings" link is shown in demo and live.
- Pending-hatch: no tentative+hatched variant, so pending blocked is plain tentative.
