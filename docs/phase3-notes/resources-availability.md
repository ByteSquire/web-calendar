# Resources part 2, server half: availability, queue, updates

## Built

- `server/utils/resources/availability.ts` (`parseAvailabilityQuery`, `listAvailability`, instant helpers),
  `requests.ts` (`listBookingRequests`), `updates.ts` (`listBookingUpdates`).
- Routes `GET /api/resources/availability|requests|updates` (`defineApiHandler`, `no-store`), shapes from
  `shared/types/resources-api.ts`. Bad input -> 400 with field errors.

## Decisions

- Detail access reuses `createPathPrecheck` (sharing) with a membership adapter built from the caller's
  userinfo groups (+ the all-users group); the path is the event calendar's `collection_path`.
- The pre-check accepts `free_busy` grants too. Narrowing in `readableCalendars`: a calendar not in the
  caller's own home needs at least one non-`free_busy` ACL row. This is imprecise for mixed grants (a
  free_busy grant for me plus a read grant for someone else would pass). Proper fix: the sharing module
  exports a permission-aware decision (needs `read`); then drop the narrowing.
- Blocked entry: exactly bookingId, start, end, status, blocked, mine. Null event calendar -> blocked.
- Updates time = `COALESCE(decided_at, updated_at)` (a booker's cancellation may have no decided_at);
  `updated_at` also moves on block/orphan changes, so an update can reappear: best effort. Capped at 200:
  the oldest 200 after `since`. Reason: latest audit row with `target = booking:<id>` and
  `details.reason` in decision|overlap|event_removed|event_moved, else `decision`.
- Queue: pending, or orphaned and pending/approved, of resources with `manage`; oldest `created_at` first.
- Inactive resources are not listed (as `listResourcesFor`).

## Needs integration

- Nothing required. The auto-decline audit in service.ts now carries `reason: 'overlap'` (added at
  integration), so the requester's update shows it.
- docs/design.md §5 / security-review 7.4: describe the three routes, the blocked-entry key set, and the
  free_busy narrowing above.

## Tests (run at integration, pass)

`tests/server/resources-availability.test.ts`, `resources-availability-routes.test.ts`.

## Risks

- Unrun tests; the route test mocks userinfo by fetch like resources-routes.test.ts.
- Groups come from userinfo (60 s cache), the pre-check normally uses the htgroup file: a short disagreement is possible.
