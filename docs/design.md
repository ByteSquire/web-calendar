# Web Calendar — Design

> Status: **Draft v1.5** — companion to `requirements.md` (Draft v1.4).
> This document turns the requirements into a concrete technical design.
> v1.2 (2026-10-29), after spike S1: the app bundles Radicale and exposes its own authenticated
> `/caldav/` endpoint (bearer tokens verified locally, app tokens for other clients). Access rules
> are administered in the app and enforced by Radicale. External CalDAV servers are reached from the
> browser. Earlier versions are in git history (v1.2: commit `8b1da20`; v1.1: `f7bdfc8`; v1.0:
> `97a8e44` and earlier).
> v1.3 (2026-10-29), implementation started: Phase 1 steps 4–7 (sidebar, top bar, standard views,
> split view) and the Phase 2 groundwork (SQLite layer, app tokens, token verifier, CalDAV gateway)
> are built. Spikes S2 and S6 are done (§12); the deployment files follow this design (§10).
> v1.4 (2026-11-01): no CI for now; releases are gated by a manual run of the checks on the
> maintainer's machine (§12, Security backlog; README "Release checks").
> v1.5 (2026-11-01): the external-account proxy and the time-zone ranges and writes are marked as
> built, not planned (§4, §7); the `calendar-timezone` hint is still planned.

---

## 1. Overview

A **standalone, self-hosted**, web-based calendar for teams/organizations
(30–50 users) whose defining strength is **aggregating entries from multiple
calendars into a single, unified view**. It replaces GroupOffice calendar.

Key decisions (from the requirements review and the 2026-10-29 interviews):

- **License** — **AGPLv3** (frontend + backend fully AGPLv3-compliant), which lets
  us use **FullCalendar Premium** under its AGPLv3 license.
- **Stack** — **Nuxt 4** (Vue 3 frontend + Nitro backend). The logged-in app is a
  **SPA** (`ssr: false`); Nitro serves the API and the CalDAV gateway. Deployed with
  **Radicale** in one `docker-compose.yml`.
- **Authentication** — **generic OIDC** (currently **kanidm**) with the app's **own
  OAuth2 client**. The SPA runs the login in the browser and keeps its tokens there.
  The server **verifies every token locally** (signature, issuer, audience, expiry
  and scope) against an **allow-list of clients** and stores none.
- **CalDAV** — **Radicale** is the calendar store and is reachable **only** through
  the app. The app's server is the **gateway**: `/caldav/` accepts OIDC bearer
  tokens (the SPA) or Basic auth with **app tokens** (Thunderbird, phones), sets
  `X-Remote-User`, and proxies to Radicale. OpenCloud is not in the CalDAV path.
- **Access control** — administered **in the app** (users, groups, per calendar) and
  **enforced by Radicale** through shares and group files the app maintains, for every client. The app
  never filters events itself.
- **External accounts** — the user can add other CalDAV servers (basic or no auth;
  OIDC later). The server keeps the non-secret part; the password exists only as a sealed
  credential in the browser and is **never stored on the server**; each request goes
  through a stateless pass-through proxy in the app (§6, §7).
- **Database** — **SQLite** for **app-level data only**: calendars, access rules,
  views, categories, filters, subscriptions, app tokens and preferences. Events are
  **not** stored.
- **Data freshness** — events are read **live** from Radicale; the browser keeps fetched
  events in memory for 30 s. **No stale data** is ever served: an unreachable source
  shows an error.
- **UI components** — **Nuxt UI v4** (MIT; Reka UI + Tailwind CSS v4), **adopted**
  after trial S3, with the conditions in §9 and §12. Installed.
- **Events** — recurring events are common; the organization uses **one time zone**
  (`TZ`, default `Europe/Berlin`). Editing a recurring event asks what to change (§7).

---

## 2. Licensing

- The project is licensed **AGPLv3**. Both the frontend and backend are fully
  AGPLv3-compliant.
- **FullCalendar Premium** is used under its **AGPLv3 license** (FullCalendar v7),
  with the license key:
  ```js
  schedulerLicenseKey: 'AGPL-My-Frontend-And-Backend-Are-Open-Source'
  ```
- **Implication** — all dependencies must be **AGPLv3-compatible**. AGPLv3 is
  compatible with GPLv3 and permissive licenses (MIT, BSD, Apache-2.0). We must
  **audit any new dependency** for AGPLv3 compatibility before adding it (see §12).
  That includes the transitive dependencies of Nuxt UI (about 60 direct
  dependencies). Trial S3 checked them: see §12 for the result and the one open
  license gap (`vaul-vue`).
- The app is currently run **internally** by the org, so the AGPLv3 network-use
  copyleft is not yet a distribution concern — but we keep the project
  AGPLv3-compliant so the FullCalendar Premium license is valid and so we can
  distribute later if we choose.

---

## 3. Tech Stack

| Layer                   | Choice                                      | Notes                                                                                                                                                                           |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework               | **Nuxt 4** (Vue 3)                          | Nitro backend and Vue SPA in one codebase; `ssr: false` for the app, SSR only per route if the public view needs it                                                             |
| UI components           | **Nuxt UI v4** (Reka UI, Tailwind CSS v4)   | Adopted after trial S3. Slideover, dropdown menu, modal, date inputs; keyboard and screen-reader behavior for NFR-3. MIT. Skip `UDrawer` (§9)                                   |
| Calendar UI             | **FullCalendar v7** (Premium, AGPLv3)       | `@fullcalendar/vue3` plus `@fullcalendar/vue3-scheduler` for the split view and narrow day columns (both 7.1.3, subpath imports); dark mode through the palette stylesheet (§9) |
| Database                | **SQLite** via `better-sqlite3`             | App-level data only; WAL mode; migrations are numbered `.sql` files applied by a small runner at startup, with hand-written types                                               |
| Login (browser)         | An OIDC client library, code flow with PKCE | Candidate `oidc-client-ts` (unverified, licence to check). Tokens in memory or `sessionStorage`; renewal by silent redirect or refresh grant                                    |
| Token check (server)    | A JOSE library, ES256 JWTs                  | Candidate `jose` (unverified, licence to check). Verifies against each allowed client's published keys (cached); no Kanidm call per request                                     |
| CalDAV store            | **Radicale** (3.9 in the test stack)        | Bundled in compose, internal network only; `http_x_remote_user` auth; static rights file, sharing by map, `htgroup` groups                                                      |
| CalDAV gateway          | A **Nitro route** (`/caldav/**`)            | Proxies any WebDAV method with streamed bodies (h3 `proxyRequest`, untested). Header hygiene is security-critical (§7)                                                          |
| CalDAV client (browser) | `ts-caldav` or `tsdav`                      | _To be verified in a browser_ (custom auth header, XML parsing, bundle size)                                                                                                    |
| iCal parsing            | **`ical.js`**                               | `.ics` URL subscriptions (read-only), and recurrence expansion where Radicale cannot do it                                                                                      |
| Caching                 | In-process, short TTL                       | Kanidm signing keys and iCal fetches on the server; fetched events for 30 s in the SPA. No stale fallback                                                                       |
| Runtime                 | **Node.js** (LTS)                           | Nitro runtime                                                                                                                                                                   |
| Packaging               | **Docker Compose**                          | `web-calendar` and `radicale`; Kanidm is external                                                                                                                               |

---

## 4. Architecture

A single Nuxt 4 process serves the **SPA**, the **app API** and the **CalDAV
gateway**. It talks to Radicale on an internal network, to Kanidm for token checks,
to plain iCal URLs, and to a local SQLite file. Browsers and third-party CalDAV
clients only ever talk to the app.

```mermaid
graph TD
    Browser[Browser SPA] -->|HTTPS, bearer token| Nuxt
    TB[Thunderbird / phones] -->|CalDAV, app token| Nuxt
    Nuxt[Nuxt 4 app<br/>Nitro: API + CalDAV gateway]
    Browser -->|OIDC code + PKCE| Kanidm[kanidm<br/>OIDC provider]
    Nuxt -->|signing keys, userinfo| Kanidm
    Nuxt -->|SQLite| DB[(SQLite<br/>app data)]
    Nuxt -->|X-Remote-User<br/>internal network| Radicale[Radicale<br/>CalDAV store]
    Nuxt -->|share API + group file| Radicale
    Nuxt -->|GET .ics| ICS[iCal URLs]
    Nuxt -->|CalDAV, per-request credentials<br/>from the browser, not stored| Ext[External CalDAV servers]
```

**Components inside the app:**

- **SPA** — sidebar, view types, FullCalendar, split view, account settings, app
  tokens, access administration.
- **App API** (`/api/**`) — views, categories, filters, iCal subscriptions,
  resources, calendars and access rules, app tokens. Every call carries a bearer
  token that is checked as described in §6.
- **CalDAV gateway** (`/caldav/**`, `/.well-known/caldav`) — §7.
- **Sharing writer** — keeps Radicale's map shares and group file in line with the
  access rules (§8).
- **iCal proxy** — fetches `.ics` subscriptions for the browser, which cannot read
  arbitrary URLs cross-origin.
- **External-account proxy** — forwards CalDAV requests to a user-added server
  with the credentials the browser sends per request; stores and logs none (§6, §7;
  `server/api/external/[id]/`).
- **Caches** — Kanidm signing keys and iCal fetches (server); fetched events for
  30 s (SPA). Nothing is served stale.

**Why a gateway in the app** — Radicale has no OIDC of its own, and OpenCloud's
proxy accepts tokens from one Kanidm client only (spike S1). With the gateway in the
app, the one trusted party checks tokens, and the same endpoint serves the SPA and
third-party clients.

---

## 5. Data Model

SQLite (single file) holds **app-level data only**. Calendars and events live in
Radicale (or in iCal files and external servers) and are identified by the
calendar's collection path and the event's iCal `UID`; events are never copied
into SQLite.

**Why SQLite (not no-DB)** — we need to persist _and query_ calendars, access
rules, views, categories, filters, subscriptions and app tokens. SQLite (a single
file, WAL mode) does this cleanly and handles the expected concurrency (≤10)
without a separate database server.

```mermaid
erDiagram
    users ||--o{ app_tokens : creates
    users ||--o{ views : owns
    users ||--o{ ical_subscriptions : owns
    users ||--o{ calendar_prefs : sets
    users ||--o{ calendars : owns
    calendars ||--o{ calendar_acl : "governed by"
    resources ||--o{ resource_acl : "governed by"
    resources ||--o{ calendar_bookings : "booked through"
    users ||--o{ calendar_bookings : requests
```

**Tables** (key columns; all have `created_at`/`updated_at`):

- **users** — `id` (PK), `oidc_sub` (unique), `username`, `name`, `email`,
  `is_admin`, `last_seen_at`, `time_zone` (an override of the browser's zone, FR-32; NULL means
  the browser's). Created on first use. There is no roles table: admin
  comes from Kanidm group membership (§6).
- **app_tokens** — `id` (PK), `user_id` (FK), `label`, `token_hash`, `expires_at`,
  `last_used_at`. Only the hash is stored; the token is shown once (FR-31).
- **calendars** — `id` (PK), `name`, `kind` (`personal` | `shared` | `resource`),
  `owner_id` (FK, nullable: shared and resource calendars have no personal owner),
  `color`, `collection_path` (where Radicale stores it).
- **calendar_acl** — `id` (PK), `calendar_id` (FK), `principal_type` (`user` |
  `group` | `authenticated` | `public`), `principal` (a user's `sub` UUID or a group's
  short name), `permission` (`free_busy` | `read` | `write` | `admin`), `applied_at`
  (set by the sharing writer only after Radicale confirmed the share; NULL means not yet
  applied). Source of truth for the rules in §8.
- **views** — `id` (PK), `name`, `icon`, `owner_id` (FK, nullable), `is_admin`
  (bool), `definition` (JSON: ordered list of calendar refs — a `calendars.id`, an
  `ical_subscriptions.id` or an external account's calendar URL — plus colors).
  Admin views are visible to everyone; calendars the viewer cannot access are
  omitted.
- **calendar_prefs** — `user_id` (FK), `calendar_ref`, `color`, `visible`. Per-user
  sidebar toggles and color overrides.
- **categories** — `id` (PK), `name`, `color`, `owner_id` (FK, nullable). Events
  carry categories through the iCal `CATEGORIES` property.
- **filters** — `id` (PK), `owner_id` (FK), `name`, `kind` (`text` | `category` |
  `status`), `value`.
- **ical_subscriptions** — `id` (PK), `owner_id` (FK, nullable = shared), `name`,
  `url`, `color`.
- **resources** — `id` (PK), `name`, `type` (`room` | `car` | `equipment`), `location`,
  `capacity`, `description`, `active`. A resource has no calendar of its own (Q12, below).
- **resource_acl** — `id` (PK), `resource_id` (FK), `principal_type` (`user` | `group` |
  `authenticated`; `public` is not allowed), `principal`, `right` (`read` | `book` | `manage`;
  quote the column, it is an SQL keyword). The default booking right is data: creating a resource
  inserts `authenticated → book`, which managers can narrow.
- **calendar_bookings** — `id` (PK), `resource_id` (FK, RESTRICT), `requester_id` (FK, RESTRICT),
  `start_at`, `end_at` (UTC), `status` (`pending` | `approved` | `declined` | `cancelled`),
  `approver_id` and `decided_at`, `event_calendar_path` and `event_uid` (the booker's event; the
  path is the collection as the booker sees it, `/<sub>/<name>/`, a share included, with no
  foreign key, so a calendar the discovery has not seen yet or a share can be named), `block_ref` (unique; the opaque id in the availability
  block), `orphaned_at` and `reconcile_attempts`.
- **audit_log** — `id` (PK), `at`, `actor_sub` (text, no FK, so entries outlive users), `action`,
  `target`, `details` (JSON), `request_id`. Append-only (a trigger aborts every `UPDATE`;
  `DELETE` stays possible for a later retention job).
- **published_calendars** _(planned, FR-26/27)_ — `calendar_id`, `published_by`
  (FK), publish settings.
- **external_accounts** — `id` (PK), `user_id` (FK, cascade), `name`, `url`, `origin`,
  `auth_mode` (`none` | `basic`), `username`, `color`; unique on (`user_id`, `url`), at most
  10 per user (FR-8). Views and preferences refer to `ext:<account id>:<url>`, so they survive a
  change of device.

**Not stored on the server:** the passwords of external CalDAV accounts, and their sealed
credentials. The sealed credential (AES-256-GCM, bound to the user, the account and the origin) is
kept by the browser: in memory, or with "Remember on this device" also in `localStorage` under
`web-calendar:external-seal:<encodeURIComponent(sub)>:<account id>` (copies of accounts that are
gone are removed when the list is read, and another user's copies are never loaded). An admin can
ship **preset accounts** through runtime config.

Compared with v1.1, `sessions` is gone (no server-side tokens) and `calendars`,
`calendar_acl` and `app_tokens` are back or new. `shared/types/calendar.ts` and the
mock data still follow the v1.0 model (local ids, `etag`, `isBlocked`) and are
adapted in Phase 2.

**Built** (`server/db`, migrations `001_init.sql` to `006_access_and_resources.sql`, then `008_booking_sync.sql`; there is no 007): every table above except `published_calendars`. Beyond
the list: ids are `AUTOINCREMENT` (views refer to calendar ids in JSON, so ids are never reused);
`users.username` is unique case-insensitively; `updated_at` is kept by triggers; `calendar_acl` has CHECKs
tying `principal` to `principal_type`; a personal calendar needs an owner; deleting a user cascades to
their tokens, views, preferences, filters, categories and subscriptions, but is refused while they own
a calendar. App tokens (`wcal_` + 32 random bytes) are stored as HMAC-SHA256 and expire after a year;
at most 10 unexpired ones per user; revoking deletes the row. Nitro does not await plugins, so the DB
plugin exits the process when it cannot start and holds requests until the database is ready.

**Phase 3 schema** (migrations 005, 006 and 008; run on a copy of the dev database on 2026-11-01:
the integrity and foreign-key checks are clean, a second run applies nothing, and 006 refuses to
run over old rows in `calendar_acl` or `resources` and leaves 001 to 005 applied; that database held
no rows, so no data was converted).
`005_audit_log.sql` adds `audit_log`. `006_access_and_resources.sql` recreates `calendar_acl`
(principals are Kanidm ids, plus `applied_at`) and `resources` (no `calendar_id`), and adds
`resource_acl` and `calendar_bookings` with triggers. A temporary guard table aborts the
migration with a named CHECK message if the old `calendar_acl` or `resources` hold rows (names are
not `sub`s and resource calendars are not resources, so they cannot be converted); a deployment
with such rows fails to start until they are removed. `calendars.kind` is unchanged. Rules of the
model: "orphaned" is not a status but `orphaned_at` plus `reconcile_attempts`, so a booking keeps
its status and slot during retries; status moves are `pending → approved | declined | cancelled`
and `approved → cancelled`, `declined` and `cancelled` are final (also a trigger), and approval
only goes through `approveBooking`, which returns the ids it auto-declined; triggers on insert and
on update of status, slot or resource refuse an overlap of approved bookings (half-open slots), which
is the unique-slot guarantee of FR-17; deleting a resource is refused while it has bookings
(deactivate instead), a requester cannot be deleted either, an approver or a booking calendar that
goes away is set to NULL. The default limits (24 h, 10 bookings per requester and UTC day, 365 days
ahead) are placeholders. DB modules: `calendar-acl.ts`, `resources.ts`, `resource-acl.ts`,
`bookings.ts`, `audit-log.ts`. Principal case is not normalised; callers store UUIDs lower-case.

**Resource model (Q12 — revised 2026-10-31, Phase 3):**

A resource is a **first-class entity, not a calendar**. A calendar is a collection
of events owned by someone; a resource is a thing (room, car, equipment) with
metadata (name, type, location, capacity) whose availability is **derived from
bookings**, not stored as its own events. This removes the "two things pretending
to be one" problem, the CalDAV modeling leak (clients no longer see a resource as
an ordinary calendar they own), and the "bookers need write access to a collection
they don't own" problem.

- **Booking.** A booking is a row in `calendar_bookings` (resource, slot,
  requester, status, approver, …). The booker's event in their own calendar
  references the resource and the booking through custom properties:
  - `X-WEB-CALENDAR-RESOURCE: res:<id>`
  - `X-WEB-CALENDAR-BOOKING: <booking id>`
  - `X-WEB-CALENDAR-BOOKING-STATUS: pending|approved|declined|cancelled`
    The app preserves unknown X- properties on events it creates/edits (so its own
    metadata survives round-trips) but **strips all event-level X- properties on import**
    (the allow-list `IMPORT_ALLOWED_X_PROPERTIES` is empty; privacy/security). The booking
    marks are read only with the reader option `trustBookingProperties`, which the loader sets
    for the built-in CalDAV service and never for an external account or a subscription; a "this
    and following" split drops them from the new series.
- **App DB is the source of truth** for booking state; the event's properties are a
  self-describing copy for third-party clients and for recovery. A third-party edit
  that drops or alters those properties does not auto-cancel; only the app's own
  reconcile pass does.
- **Accept/decline (FR-19) is app-side state with an audit trail**, not CalDAV
  scheduling (which would admit arbitrary iTIP input). A pending booking does not
  hard-block the slot: it shows as a warning/hint in the web client, and managers
  decide which overlapping request to approve. Approving one auto-declines the
  overlapping pending ones (with a notification). Managers are per-resource
  (users and groups) with `manage` rights; booking itself is open to any
  authenticated user. Permissions live in a dedicated `resource_acl` table
  mirroring `calendar_acl` (`read`/`book`/`manage`), defaulting
  `authenticated → book`.
- **Availability for third-party clients** is a **derived artifact**: a calendar
  collection owned by the `_resources` service principal, shared to the resource's
  `read` audience (default: the `web_calendar_users` group; managers may restrict
  it). Approved blocks are written as `BUSY`; pending blocks as `BUSY-TENTATIVE`
  (a VEVENT cannot carry that value, so a pending block has `STATUS:TENTATIVE` and an
  approved one has no `STATUS`; free/busy derives the rest); declined/cancelled blocks are
  removed. Blocks stay opaque (`SUMMARY:Reserved`,
  `TRANSP:OPAQUE`, `CLASS:CONFIDENTIAL`, plus the back-reference id in the property
  `X-WEB-CALENDAR-BLOCK:<block_ref>`; UID `<block_ref>@resources.web-calendar.invalid`;
  `DTSTAMP` is the booking's `updated_at`, so the block is deterministic) — details come
  from an API that checks the caller's access to the booking calendar first
  (FR-18).
- **Reconcile on move/delete.** Detection is ctag-gated (only when a calendar's
  ctag/sync-token changed) plus a soft "orphaned" state with retry before
  cancelling, and a manager queue for anything ambiguous; auto-cancel only when
  the event is definitively gone or the slot changed and the user confirms (a
  single consolidated toast: "Your booking for <resource> moved — re-approval
  requested"). Manager-mediated cancellation (never auto-cancel) stays available
  behind a flag that can be turned off later.
- **Built (part 1, server side; unit tests pass).** No migration or stored block
  state: the desired block follows from the booking status, so `syncBlock` is idempotent and
  `repairBlocks` retries bookings ending within the last 24 h or later (at start and every
  10 minutes, `server/plugins/resources.ts`; off in demo mode and without Radicale). The block is
  written through `createResourceBlockStore()` of the sharing writer, as `_resources`, into
  `/_resources/availability/<id>.ics`; the reconcile keeps that collection shared with `f` to
  `web_calendar_users`, and members see it as `/<sub>/resource-availability/`. A store failure
  keeps the booking, is logged (error type only) and audited (`resource_booking.block_failed`).
  State change, audit entry and rights check are one transaction; the store call comes after.
  Rights: no right on the resource gives 404; `read` only gives 403 on booking; a booking is
  visible to its requester and to managers (others get 404); accept and decline need `manage`;
  cancel is for the requester, or for a manager while `NUXT_RESOURCES_MANAGER_CANCEL` is not
  `false` (on by default); the booking's event calendar must belong to the
  booker. Routes: `GET /api/resources`, `GET /api/resources/:id`,
  `GET|POST /api/resources/:id/bookings`, `POST /api/resources/:id/bookings/:bookingId/{accept,decline,cancel}`
  (booking rate limit 10 burst, one more per 2 s per user); admin (`defineAdminHandler`):
  `GET|POST /api/admin/resources`, `PUT /api/admin/resources/:id`, `POST .../:id/deactivate`,
  `GET|PUT .../:id/acl` (only `read`/`book`/`manage` for user, group, authenticated). Auto-declines
  are audited as `declined` with `automatic: true`. Known limits: a managers' group right removed in
  Kanidm lingers up to the 60 s userinfo cache; managers of a deactivated resource cannot list its
  bookings (they can act by id).
- **Built (part 2, server half; unit tests pass).** `GET /api/resources/availability`
  gives the booked slots of the resources a caller may see in a range. Details (title, requester)
  go only to a caller who can read the event's calendar, decided by the sharing module's path
  pre-check with the caller's userinfo groups; everyone else gets exactly `bookingId, start, end,
status, blocked, mine`, and an event without a calendar counts as blocked. `GET
/api/resources/requests` is the manager queue (pending, or orphaned and pending or approved, of
  resources with `manage`; oldest first). `GET /api/resources/updates` lists the caller's bookings
  changed after a given time (at most 200), each with the reason `decision`, `overlap`,
  `event_removed` or `event_moved` from the latest audit entry. All three are `no-store`; the
  shapes are in `shared/types/resources-api.ts`. Known limits: the pre-check also accepts
  `free_busy` grants, so a calendar outside the caller's own home must have one non-`free_busy`
  rule, which is imprecise for mixed grants; groups come from userinfo (60 s cache) while the
  pre-check normally reads the htgroup file, so the two can disagree briefly.
- **Built (part 2, client; unit tests pass, the e2e spec runs against mocked answers).** Each resource becomes a read-only
  calendar `res:<id>`, hidden by default. For the visible ones the loader asks the availability
  route in pieces of at most 62 days and shows approved and blocked slots as hatched "Busy",
  pending ones as tentative "Busy (pending)", the rest as "Booked by <name>" or the event's title.
  Quick add and the event edit form have the resource fields and the "book right away" checkbox;
  the booking is requested after the save, and a refusal keeps the saved event and says why.
  **Series rule:** a new repeating event, or an edit with a scope other than "This event", is
  saved without booking (the marks would cover the whole series); one occurrence can be booked.
  The page `/resources/requests` (menu entry "Resource bookings", managers only) lists pending
  requests with accept and decline, an overlap hint and an orphaned note, and "My bookings" with
  cancel. One toast on sign-in reports bookings that changed (seen-state in `localStorage`). Known
  limits: "My bookings" takes one request per resource; with several resources only the first
  booked one is marked on the event; a pending, blocked slot has no hatched tentative look.
  The booking body carries the event's calendar by its path (`eventCalendarPath`, required, only
  for the built-in service; an event on another server is not booked). The server stores the path
  as given if it is in the booker's own home (`/<sub>/...`, else 400 `invalid_event`) and the
  booker can read that calendar: their own, or a share with a `read` or `write` grant, judged by
  the same rule as the availability details (a `free_busy`-only or unknown share gives 403
  `calendar_not_readable`). A share such as `/<sub>/shared-12/` is therefore linked like any other
  calendar, and the reconcile can follow it.
- **Built (part 3, reconcile; unit tests pass, its Radicale reader checked live, §11).** `server/plugins/resources.ts` runs it
  90 s after start and then every `NUXT_RESOURCES_RECONCILE_INTERVAL_SEC` (300 s, at most 900 s;
  off in demo mode and without Radicale). It reads the event of each active booking (pending or
  approved, not ended) as the booker at the stored path, through the internal client with the
  sharing client's principal and path guards. Per path it compares `ctag|sync-token` with the
  table `booking_sync` (migration 008, keyed by `collection_path`, pruned at the end of a run) and
  reads events only when it changed or a booking is in retry. An unchanged event clears the
  orphaned state. An event that cannot be read marks the booking orphaned for up to 3 looks and
  never cancels. A collection the booker can no longer read (403, or 404 on the collection, which
  is what a revoked, disabled or deleted calendar looks like) is ambiguous: the booking goes
  straight to the manager queue (`resource_booking.orphaned`, `reason: 'calendar_unavailable'`,
  `cause: 'forbidden'` or `'missing'`), is never cancelled, and its stored stamp is cleared. Only a
  UID that is absent from a readable collection and from every other calendar of the booker's
  home (all listings ok, none forbidden) counts as gone; at the third look that cancels the booking, removes
  its block and is audited as `resource_booking.cancelled` with `reason: 'event_removed'`, actor
  `system:resources`. The same UID in another calendar of the booker with the same slot and marks
  is followed, and the new path (a share included) is stored. A changed slot or resource, or
  stripped marks, goes straight to the manager queue (`resource_booking.orphaned`, `reason:
'event_moved'`) and is never cancelled. A booking younger than 10 minutes with missing marks is
  left alone, because the client writes the marks after the booking.
- **Booking creation UX.** Booking is attempted automatically when an event with a
  resource attached is first saved, gated by a checkbox next to the save/booking
  control that is checked by default ("book right away"). Explicit add/remove of a
  resource on an existing event remains available for drafts, recurring events and
  multi-resource cases.

---

## 6. Authentication

Standard OIDC **authorization code flow with PKCE**, provider-agnostic via
**discovery**. Currently pointed at **kanidm**; switching providers is a config
change. Three kinds of callers reach the app:

**1. The SPA (own login).** It uses the app's own Kanidm client, **`web-calendar`**
(public, PKCE, consent shown once). The browser is redirected to Kanidm; with an
existing Kanidm session the redirect is silent, otherwise Kanidm shows its login.
The SPA then exchanges the code for tokens itself (Kanidm sends CORS headers on its
OAuth2 endpoints) and keeps them in memory or `sessionStorage`. It sends the access
token as `Authorization: Bearer` to same-origin `/api/**` and `/caldav/**`.

```mermaid
sequenceDiagram
    participant B as Browser (SPA)
    participant K as Kanidm
    participant A as App server
    participant R as Radicale
    B->>K: redirect: authorize (client web-calendar, PKCE)
    K-->>B: code (silent if a Kanidm session exists)
    B->>K: token request (code + verifier)
    K-->>B: access, ID and refresh tokens
    B->>A: /caldav/... with Bearer token
    A->>A: verify the JWT locally (keys cached)
    A->>R: same request + X-Remote-User
    R-->>A: response
    A-->>B: response
```

**2. Third-party CalDAV clients.** HTTP **Basic** with the username and an **app
token** the user created in the SPA (FR-31). The server hashes the presented token
and looks it up. Clients that support OIDC may use a bearer token instead. Each token row
records the version of the hash key that made it (`app_tokens.key_version`). The key is
`NUXT_TOKEN_HASH_KEY` (version 1), or a list `NUXT_TOKEN_HASH_KEYS=2:<new>,1:<old>` whose first
entry is current; a login with an older version re-hashes the token to the current one. To rotate:
generate a key (`openssl rand -base64 48`), set `NUXT_TOKEN_HASH_KEYS=2:<new key>` and keep
`NUXT_TOKEN_HASH_KEY`, restart, let tokens move as they are used, check what is left on version 1
(`SELECT key_version, COUNT(*) FROM app_tokens WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') GROUP BY key_version`), then
remove the old key. A token whose version is no longer configured is unknown. The next rotation
is `3:<newer>,2:<new>`; to go back, list the old key first again rather than deleting entries.

**3. External CalDAV accounts (generic).** Decided 2026-10-30: a **stateless
pass-through proxy** with **sealed credentials**. The account's non-secret part is stored in the
database. The password is typed once; the server seals it (`base64url(0x01 ‖ nonce12 ‖
ciphertext ‖ tag16)`, AES-256-GCM, AAD `v1|<sub>|<account id>|<origin>`, plaintext
`username:password`, key `NUXT_EXTERNAL_SEAL_KEY`) and hands the text to the browser, which
sends it with every request as `X-Upstream-Authorization: Sealed <text>` (never `Authorization`,
which carries the app's own token). The proxy opens it, compares the sealed user name with the
account's, and forwards the login to the account's origin and nowhere else. A script in the page
can neither read the password nor replay it to another origin, because the seal opens only for
that user, account and origin. Changing the origin, user name or none-to-basic needs the password
again; rotating the seal key voids every seal (users re-enter passwords through
`POST /api/external-accounts/:id/credential`). Logins are basic and https only; without the key
only accounts with no login work. Why not call the server from the browser: CORS is enforced only
by browsers, so most CalDAV servers (which only serve native clients) do not send CORS headers;
native clients reach any server. Controls (details in §7 and the security review): authenticated
users only; the target origin comes only from the stored account; the SSRF guard of the iCal
proxy plus an administrator host list, `NUXT_OUTBOUND_ALLOWED_HOSTS` (it also gates
iCal subscriptions, which closes the channel through which a script could send data to a host of
its choosing; empty means any public host, which production refuses to start with unless
`NUXT_OUTBOUND_ALLOW_ANY_HOST=true`, review 2026-11-01); method, header and size allow-lists; same-origin
redirects only; per-user rate limits; the page's `connect-src` stays `'self'`.

**Server-side token check** (SPA and bearer clients) — decided: **local JWT
verification only**, with no introspection and no per-request call to Kanidm:

- Kanidm's access tokens are ES256 JWTs (`typ: at+jwt`) signed with a key **per
  client**, published at `<issuer>/public_key.jwk`. The config holds an **allow-list**
  of clients, each with its issuer (`https://<kanidm>/oauth2/openid/<client>`); the
  initial list is `web-calendar`. The allow-list is the audience restriction: a token
  from any other client is rejected, however valid it is.
- Checks on every request: algorithm is ES256; signature against the allowed
  client's key (selected by `kid`); `iss` equals the allowed issuer; `aud`/`client_id`
  equals the allowed client; `exp` and `nbf` (with 60 s tolerance); the `caldav`
  **scope** is present. Kanidm accepts a custom scope name in a scope map and returns
  it in the token (tested).
- Keys are cached and refetched, rate-limited, when a token names an unknown `kid`
  (key rotation). Once keys are cached, a Kanidm outage does not affect bearer
  requests.
- **Revocation:** a revoked token keeps working until it expires, at most **15
  minutes**. This is the accepted trade-off for no cache and no Kanidm call per
  request. App tokens are looked up in SQLite and are revoked immediately. A user who is no longer
  in `web_calendar_users` (removed, disabled or deleted in Kanidm) loses all their app tokens at
  the next group sync run, within one interval (review 2026-11-01): the gateway never asks Kanidm
  about an app token, and a request to one's own calendar checks no group. This needs the group
  sync (`NUXT_GROUP_SYNC_TOKEN`); without it nothing removes them.
- Introspection (a confidential client sees `active: true` for tokens of any client)
  was tested in S1 and would add revocation checks; it was not chosen.
- **User mapping** — the token's `sub` is the stable key: look up or create the
  `users` row. App tokens map to their owner directly.
- **Radicale user id** — decided: the Kanidm **`sub`** goes into `X-Remote-User`. It
  survives renames; the UUID paths are only seen by the app and by clients'
  discovery.
- **Groups and admin** — Kanidm puts groups in the **ID token and the userinfo
  response**, not in the access token (tested). The scopes `groups`, `groups_name`
  and `groups_spn` add them (tested together; `groups` mixes UUIDs, SPNs and short
  names). For **admin** routes only, the server calls the client's userinfo endpoint
  (`/oauth2/openid/web-calendar/userinfo`) with the caller's bearer token, uncached,
  and checks for the Kanidm group `calendar_admins`. Radicale's group file needs the
  members of whole groups, which come from Kanidm's directory (§8).

**Token lifetime** — access tokens last 900 s. The SPA renews by a silent redirect
(loses unsaved UI state, so the app must save state first) or by the refresh grant,
which works with Kanidm. Keeping a refresh token in the browser raises the impact of
an XSS bug, so it is kept in memory only. **Kanidm rotates the refresh token on every
use**; replaying an old one fails with `invalid_grant` and also kills the newest token
(the whole chain). Two renewals at once ended the session in a test, so the SPA renews
through one shared in-flight request. Kanidm's discovery lists no `end_session_endpoint`,
so a logout clears the local state and shows a signed-out page (going straight back to the
app would sign the user in again through Kanidm's own session). Logout first revokes the
token at Kanidm's `revocation_endpoint` (RFC 7009; capped at 3 s, never blocks the sign-out,
no token is logged). Kanidm answers `200 text/plain`, which oidc-client-ts rejects unless
`revokeTokenAdditionalContentTypes` lists `text/plain`; revoking either token ends that login
session, another tab's login is unaffected, and an access token that was already copied still
passes the gateway for up to 15 minutes.

**Libraries** — the browser login uses an OIDC client library (candidate
`oidc-client-ts`, unverified, licence to check). The server verifies JWTs with a JOSE
library (candidate `jose`, unverified, licence to check).

**Security** — built: `state` and PKCE on the code flow, tokens in memory only, login
state per tab, the bearer token attached only to the app's own origin, a validated
`returnTo`; the token-hashing key and the group-sync credential come from the
environment; app tokens are long random strings, hashed, expiring and revocable; failed
Basic logins are throttled (§7). Every response carries security headers
(`server/utils/security`): a strict `Content-Security-Policy` for pages (`script-src 'self'` plus
the SHA-256 hashes of the page's three inline scripts, computed per response in the `render:html`
hook; no `unsafe-inline` or `unsafe-eval` for scripts; `connect-src` only the app and the
identity provider; `frame-ancestors 'none'`; styles keep `unsafe-inline` because FullCalendar and
Nuxt UI set style attributes), `default-src 'none'; sandbox` for everything else, `nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy`, `no-store` on pages
(keeps a signed-out page out of the back/forward cache). Off in development (Vite needs inline
scripts). HSTS belongs to the reverse proxy. Icons are served by the app itself (Nuxt Icon's
default for `ssr: false` is the public Iconify API, which is switched off). The audit scope
and the per-feature controls for Phase 3 are in `docs/security-review.md`; the open items are in
§12 and the prerequisites in §8. `users.is_admin` is informational only: admin routes call userinfo and
fail closed when the `groups` claim is missing (`requireAdmin`).

---

## 7. CalDAV gateway and access

The app is the **only** way to Radicale. It is also a **CalDAV client** (in the SPA)
and an **iCal reader**. Events are read **live** and no long-lived copy is kept.

**Gateway (`/caldav/**`, `/.well-known/caldav`)**

- Authenticates as in §6, then forwards to Radicale with `X-Remote-User` set to the
  resolved user and `X-Script-Name: /caldav`.
- **Header hygiene (security-critical):** drop any inbound `X-Remote-User`,
  `X-Script-Name` and `Authorization` before forwarding; never forward cookies;
  allow only the WebDAV/CalDAV methods (`OPTIONS`, `GET`, `HEAD`, `PUT`, `DELETE`,
  `PROPFIND`, `PROPPATCH`, `REPORT`, `MKCOL`, `MKCALENDAR`, `COPY`, `MOVE`); only the
  `/caldav/` prefix reaches Radicale; limit body sizes.
- `/.well-known/caldav` redirects to `/caldav/` so clients can discover the service
  from the host name.
- **No CORS** for the SPA (same origin). An optional allow-list of origins serves
  external browser apps. Unauthenticated `OPTIONS` preflights are answered by the
  gateway; its 401 responses carry the same CORS headers, so a browser sees the
  status instead of a network error.
- The SPA tracks token expiry itself and renews before it lapses.
- **As built (S6)** — `server/utils/gateway`, `server/utils/auth`, tested against the real Kanidm and
  Radicale. Departures from the sketch above:
  - Request headers go through an **allow-list**, not a deny-list: Radicale 3.9 switches to
    reverse-proxy mode on `X-Forwarded-For/-Host/-Proto/-Server` and also reads `X-Remote-Addr`.
  - Radicale reads a body only by `Content-Length` and treats a chunked body as empty, so the gateway
    buffers bodies of unknown length (up to `maxBodyBytes`) and sends the length. h3's `proxyRequest`
    skips bodies for `PROPFIND`/`REPORT`, so the glue calls Node's `fetch` itself (`duplex: 'half'`).
  - Radicale gets the path without `/caldav` plus `X-Script-Name: /caldav`; `Destination` of
    `COPY`/`MOVE` is rewritten to a path-only `/caldav/...` and a foreign host is ignored. The query
    string is dropped, `//` is rejected, a first path segment starting with `.` (`.sharing`, `.web`) is
    404, and a 401 from Radicale becomes 502.
  - With a cold key cache and Kanidm unreachable the answer is **503** with `Retry-After`, not 401.
    `aud` is always required; `client_id` must match when present.
  - `/caldav` and `/caldav/` need their own route file (`[...path]` does not match them).
    `requireUser(event)` for `/api/**` accepts bearer tokens only (app tokens are for CalDAV clients).
    The gateway creates no `users` row; the API layer does that.
  - Closed after the first review (2026-10-30):
    - _Key refresh:_ cached keys are also refetched in the background once older than
      `oidc.keyMaxAgeSec` (1 h), with retries at 30 s, 60 s, … if Kanidm is unreachable. A
      successful refresh replaces the set, so a removed key stops being trusted; a failed one
      keeps the cached keys, so an outage does not affect bearer requests.
    - _Failed Basic logins_ are throttled in memory, and only failures are counted: every Basic
      login is **verified first**, so a correct credential is never refused, whatever the counters
      say, and it clears its (address, user) counter. The 5th failure within 10 minutes for the
      same (client address, lower-cased user) is answered `429` with `Retry-After` (no verdict
      about the credential), and so is every failure after it. Failures of one address are also
      rate limited (token bucket, burst 30, 10 per second). Bearer requests and malformed headers
      do not count; tables are bounded. A `401` carries two `WWW-Authenticate` lines (`Basic` first,
      no `charset`, then `Bearer`). **Behind a reverse proxy set `gateway.trustForwardedFor`**
      (`NUXT_GATEWAY_TRUST_FORWARDED_FOR=true`; the proxy must overwrite `X-Forwarded-For`, the
      last hop is used); without it every client shares the proxy's address, which now only means
      that strangers' failures share one budget (the gateway logs one warning). Addresses in one
      IPv6 /64 share one counter and one bucket. `npm run test:gateway:prod` builds the app into a
      temporary directory and runs the gateway integration suites (including raw-socket cases)
      against that production server with a fake Radicale and a fake identity provider.

**SPA reads and writes**

- **Discovery** — `PROPFIND` the user's principal and `calendar-home-set` (the
  principal path is whatever Radicale returns; read it from
  `current-user-principal`). Cached for a few minutes.
- **Event reads** — a `calendar-query` `REPORT` with a `time-range` for the visible
  range, one request per visible calendar, in parallel with a concurrency limit.
  Kept in the SPA's memory for **30 s** per calendar and range (decided), cleared on
  refresh and after the user's own writes. Cost: 10–20 requests per view change.
- **Recurrence (FR-28)** — prefer Radicale's server-side `expand` if it works
  (untested, S4); otherwise expand `RRULE`, `EXDATE` and `RECURRENCE-ID` overrides
  with `ical.js`.
- **Time zones (FR-29, FR-32)** — two zones, and nothing else names one.
  - _Organization zone_: the server reads `TZ` (an IANA name, default `Europe/Berlin`; an
    invalid value stops the container at start) and serves it in `/api/config`
    (`useOrgTimeZone()`). It is the zone floating times are read in, the fallback display
    zone and the "organization time" label. Later, the default zone for new events.
  - _Display zone_: the viewer's own, the browser's `Intl` zone (`useDisplayTimeZone()`),
    falling back to the organization zone. The user's own setting comes first: the display
    zone is the user's setting, else the browser's, else the organization's, and a stored zone
    this browser does not know is skipped. `/api/me` returns `timeZone` and
    `PUT /api/me/time-zone` takes `{ timeZone: string | null }` (at most 64 characters, a
    character gate, then `Intl`; stored as sent, because V8 renames some zones). The live loader
    sets `useUserTimeZone()` from `/api/me` and reloads events in the new zone;
    `useDisplayZoneFollow()` moves demo events and the "today" anchor. In demo mode the setting
    lives in memory only.
  - _Conversion is client-side_: iCal stores UTC instants or `TZID` times and the
    gateway passes them through, so the server converts nothing. The mapper turns each
    event into wall-clock strings in the display zone (`app/utils/time-zone.ts`; an
    ambiguous or missing local time is read as RFC 5545 §3.3.5 says), so
    `CalendarEvent.start/end`, "today", FullCalendar's `timeZone` and quick-add all work in
    the display zone. **All-day events are dates and do not move.** A weekly 09:00 Berlin
    meeting follows Berlin's daylight saving, not the viewer's; for a viewer in Sydney it
    can fall on another weekday.
  - _Ranges_: the visible range is a range in the display zone; it is sent to
    Radicale as UTC instants, padded by a day (`padDays` in `app/utils/caldav/reader.ts`;
    Radicale matches floating times and all-day events as if they were UTC, see S10).
  - _Third-party clients_ show events in their device's zone; nothing server-side is
    needed. Planned: the app sets `calendar-timezone` on calendars it creates as a hint for
    floating times; Radicale stores it but does not use it (S10) and most clients ignore
    it, so floating events from such clients stay a known limitation.
  - _Writes_: new events carry `TZID` of the author's zone plus a `VTIMEZONE`,
    so a recurrence follows that zone's daylight saving; an edit keeps the event's own
    `TZID`. `ical.js` ships no time zone data, so the `VTIMEZONE` is generated from the
    runtime's own zone data (`app/utils/ical/vtimezone.ts`, Temporal over `Intl`, no added
    dependency): one observance per offset change, from the year before to 25 years after the
    event's year.
- **Writes** — `PUT`/`DELETE` with `If-Match` ETags. On `412` (changed meanwhile)
  tell the user and reload the event. **Editing a recurring event asks what to
  change** (decided): this instance, this and following, or the whole series, with
  "this instance" preselected. As built (`app/utils/ical/write*.ts`, pure functions on the raw
  resource text): the resource is **patched line by line**, not re-serialised, so everything the
  user did not change stays byte for byte (`ical.js` refolds lines, moves parameters and
  re-encodes escapes); `SEQUENCE`, `DTSTAMP` and `LAST-MODIFIED` are updated.
  - _This instance_: an override with the same `UID` and a `RECURRENCE-ID`, or an `EXDATE`
    for a delete. _This and following_: the original series gets `UNTIL` (and loses `COUNT`),
    a new series with a new `UID` starts at the chosen occurrence, later overrides and
    `EXDATE`s move to it; at the first occurrence it is the whole series. _Whole series_:
    changes the master; moving the start shifts overrides and exclusions with it (a rule
    that does not follow `DTSTART`, such as "last weekday", cannot be moved by whole days:
    the UI offers "this instance").
  - _Zones_: a new timed event gets `TZID` of the author's display zone and a `VTIMEZONE`
    generated from Intl (event year −1 to +25, explicit observances; no dependency); an
    edit keeps the event's own zone (UTC stays UTC, floating stays floating, read in the
    organization zone). The occurrence id is `CalendarEvent.recurrenceId`.
- **File import** (FR-7) — runs in the browser and keeps nothing on the server (C-6). The file
  is cut into one resource per `UID` (master and overrides together) from the original lines,
  keeping the file's `PRODID`, dropping `METHOD` and `X-WR-*`, and copying in the `VTIMEZONE`s
  the events reference; an event without `UID` gets a hash of its lines, so a re-import finds it
  again. The resource name is 128 bits of the `UID`'s SHA-256 plus `.ics` (UIDs are untrusted).
  `PUT` with `If-None-Match: *`: a `412`, or a `409` (`no-uid-conflict`), means "already there".
  A `PROPFIND` of the target comes first, because a missing collection also answers `409`.
  Concurrency 4; it stops on `401`, `403` or `404` or after 5 outage failures in a row, while
  `400` and `413` cost only that event. Skipped and counted: to-dos, journal entries, free/busy
  blocks, events without a start, damaged components and duplicates. vCalendar 1.0 is refused,
  recurrence rules are never expanded, and it needs a secure context (`crypto.subtle`).
- **iCal subscriptions** — fetched by the server (conditional `GET`, cached for a
  few minutes, read-only) because browsers cannot read arbitrary URLs. As built
  (`server/utils/ical-proxy`): http, https and webcal only; every resolved address must be
  public (IPv6 only `2000::/3`), checked again when the socket connects so DNS rebinding
  does not help; at most 3 redirects, each re-checked; size and time limits while streaming;
  no stale copy is served after an error. `NUXT_ICAL_PROXY_ALLOW_PRIVATE=true` is for tests.
  The host list (`NUXT_OUTBOUND_ALLOWED_HOSTS`: exact names and `*.suffix`) is enforced on
  create, update, every fetch and every redirect hop, for subscriptions and external accounts alike.
  An empty list is refused in production unless `NUXT_OUTBOUND_ALLOW_ANY_HOST=true` (the server
  does not start; outside production an empty list still means every public host).
  Listed hosts may be private, but loopback, link-local, unspecified, multicast and the Radicale
  host are always refused.
- **External accounts** (FR-8) — server: `GET/POST /api/external-accounts`,
  `PUT/DELETE /api/external-accounts/:id`, `POST …/:id/credential`; the proxy is
  `/api/external/<id><origin-relative path>` (`api-guards` lets these paths end in `/`). It takes
  PROPFIND, REPORT, GET, HEAD and OPTIONS only (read-only), forwards `Accept`, `Content-Type` and
  `Depth` plus a fixed `User-Agent`, returns a header allow-list (no `Set-Cookie`, no
  `WWW-Authenticate`) with `X-Upstream-Status`, follows at most 3 redirects within the origin, and
  buffers at most 10 MiB under a 20 s deadline and holds the request's slot until the answer has been sent (a 20 s write timeout), refuses a 303 for a PROPFIND or REPORT; limits are 8 requests in flight per user, 32 in
  total, and a bucket of 60 with 20 per second. An upstream `401` is answered as `502
upstream_login_failed`, so a `401` always means the app's token is bad. Own failures are
  `{ error }`: `invalid_path`, `invalid_request`, `method_not_allowed`, `host_not_allowed`,
  `account_not_found`, `length_required`, `request_too_large`, `credential_required` (428),
  `rate_limited` (429), `redirect_refused`, `bad_response`, `unreachable`, `timeout`, `too_large`.
  An update that changes nothing the seal depends on returns `sealed: null`: keep the seal.
  Browser (`app/utils/external`): one `fetch` per account rewrites only URLs on the account's
  origin to the proxy and throws for anything else; discovery tries the address as a calendar, then
  as a principal (`calendar-home-set`), then lists it, then follows `current-user-principal`; reads
  are cached 30 s, 3 at a time per account and 6 over all accounts, and the browser expands
  recurrences (servers differ in honouring `expand`). Accounts load on their own track, so a slow
  account delays nothing else, and each failure is one entry in the sidebar problems list with
  "Enter password again" where it applies. A write to the built-in service reloads without the
  accounts. Calendar refs are `ext:<id>:<collection URL>`.
- **Graceful degradation** (NFR-4) — a failing calendar shows an error with a retry
  and never blocks the others. **No stale data is served** (decided). Once the
  signing keys are cached, a Kanidm outage does not affect bearer requests, and app
  tokens never involve Kanidm.

---

## 8. Access Control

**Security prerequisites for everything below** (from the security review, in build order):
`requireAdmin` as the only admin check; an `audit_log` table written by every admin mutation, the
sharing writer and the group sync; the CSP and security headers; the throttle fix; startup
validation of all security settings. Per feature, the controls that must exist before it ships:
the **sharing writer** talks to Radicale through a separate internal client, uses `sub` UUIDs
(never free-text names), reconciles and removes unknown shares (fail closed), records
`applied_at`, and the gateway adds a path-level pre-check from SQLite as defence in depth;
**group sync** prefers a read-only LDAP bind to the `idm_group_admins` token, writes the file
atomically, never writes an empty file on error, caps the interval at 300 s and alarms on a
`401`/`403`; **resource blocks** are written by the server (users never get write on resource
calendars), carry no content, and booking conflicts are decided in one transaction; the
**public view** is a dedicated endpoint behind a `_public` principal with shares for exactly the
published calendars, a property allow-list, random slugs, rate limits and a short cache;
**external accounts** bind credentials to their origin. Details and first tests:
`docs/security-review.md` §7. Status of these controls (built; unit and e2e tests pass):
`requireAdmin` and `defineAdminHandler`, the `audit_log`, the sharing writer with its gateway
pre-check, the group sync, the access administration and the resource blocks exist; the security
headers, the throttle fix and the startup validation were built earlier; the public view and the
external-account origin binding of the list above are not part of Phase 3 yet.

**Administered in the app, enforced by Radicale.** The `calendar_acl` table is the
source of truth. The app turns it into Radicale's own mechanisms, so the web app and
third-party clients behave identically and the gateway only has to authenticate. A
transparent proxy cannot filter individual events, which is why Radicale is the
enforcement point. The mechanics below were **tested in spike S5** (Radicale 3.9.0,
2026-10-29).

| Radicale mechanism                           | Tested behavior                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rights file (`from_file`)                    | Read **once at startup**. A new rule had no effect until a restart; `SIGHUP` stops the server instead of reloading. Keep the file **static**                                                                                                                                  |
| Group file (`htgroup`)                       | Re-read on every request: adding or removing a member took effect immediately                                                                                                                                                                                                 |
| Free/busy permission `f` (rights file)       | The user gets the calendar's metadata and `free-busy-query` (a `VFREEBUSY` without titles), while `calendar-query` and `GET` return 403. This is the "blocked" view of FR-18                                                                                                  |
| Sharing by map (`/.sharing/v1/map/<action>`) | **Live**, no restart. Maps a calendar into another user's home, or into every member of a group (`User: ':group'`, `PathOrToken: '/{user}/name/'`), with per-share permissions. Writes through a `rw` share land in the owner's calendar                                      |
| Share visibility                             | A mapped share appears in `PROPFIND` of the member's home as an ordinary calendar collection, and disappears when the member leaves the group. A **user** share first needs the owner to enable it and the user to accept and unhide it; a **group** share needs none of that |

**Design**

- **Audit log and admin routes** — every admin route is a `defineAdminHandler`: authentication, a
  per-`sub` token bucket (burst 20, 1 per second, so about 60 per minute; checked before the
  userinfo call, `429` with `Retry-After`), then `requireAdmin`. The handler context offers
  `audit(action, target?, details?)`, which writes one `audit_log` row with the actor's `sub` and
  a request id (`X-Request-Id` if it matches `[A-Za-z0-9._:-]{1,64}`, else a UUID). Details are
  redacted before they are stored (keys that look like secrets become `[redacted]`, Bearer and JWT
  patterns inside strings are replaced, depth above 8 is omitted, more than 8192 bytes is truncated
  to a preview). The limiter is per process. A retention job may `DELETE` old rows; nothing can
  `UPDATE` them.
- **Static rights file** — owner-only rules, as in Phase 2 (the stack's
  `radicale/rights`). It is never edited per share.
- **Calendar access** — for each `calendar_acl` entry the app creates a **map share**
  through Radicale's sharing API, acting as the calendar's owner (`X-Remote-User`),
  with `Enabled: true` and `Hidden: false`. `read` → `r`, `write` → `rw`, `free_busy` → `f`;
  `admin` and `public` rules never reach Radicale. Built in `server/utils/sharing/` (unit
  tests pass; the Radicale API shapes were checked against Radicale 3.9.0, see §11):
  - _Reconcile._ Desired shares come from `calendar_acl` (a pure function), the actual ones from one
    `list` per owner (plus the `token` list, whose shares are all removed because the app never
    creates one); the diff is applied, re-read and compared, and any difference alarms. It runs at
    start, after every access change (`requestSharingReconcile()`, debounced 2 s, wired by
    `server/plugins/access-wiring.ts`) and every `sharing.reconcileIntervalSec` (default 300, at
    most 900). A share's identity is (owner, `PathMapped`, user); a different `PathOrToken` or
    permission is deleted and recreated; several rules for one recipient merge to the highest
    permission. User shares are accepted (`enable` and `unhide` as the member) when created, when
    the list shows them disabled or hidden, and while a rule behind them is unapplied. Group lists
    get `epu` appended by Radicale; the comparison ignores those letters. Unreachable Radicale:
    the run fails, nothing is marked, retry after 5 s, 10 s, 20 s up to the interval;
    `getSharingState()` exposes the failure count. `applied_at` is set in one synchronous block
    after the verified re-read, only for rules unchanged since the run began; `admin` and `public`
    rules are marked once their owner verified clean, rules of calendars missing in Radicale and
    invalid principals stay unapplied.
  - _Names in a member's home._ A user share is `/<sub>/shared-<calendarId>/`, a group share
    `/{user}/shared-<calendarId>-<group>/`, the availability collection
    `/{user}/resource-availability/`. The calendar id in the name is what the gateway pre-check
    looks up, so no extra table was needed; a member therefore cannot own a calendar named
    `shared-<digits>[-x]`.
  - _Calendars table._ Discovery fills `calendars` (personal for users' homes, shared for
    `sharing.sharedOwners`, for example `_team`); rows are never deleted, `_resources` is not
    mirrored.
  - _Gateway pre-check_ (defence in depth, `precheck.ts`, `membership.ts`): the root is allowed;
    one's own home is allowed, but `shared-<id>*` names need a rule that grants the caller (write
    methods need `write`); `resource-availability` needs `web_calendar_users` and is read-only;
    another principal's home itself is `403` and its calendars need a rule (found by
    `collection_path`); `COPY`/`MOVE` destinations are checked as well. Group membership comes from
    the htgroup file the group sync writes (the file Radicale reads), re-read when its mtime or size
    changes; a missing file means no groups (fail closed, one warning).
  - _Nightly audit job_ (first run 2 minutes after start, then `sharing.auditIntervalHours`,
    default 24): the same desired-share computation against each home listed as each user.
  - _Audit._ Actor `system:sharing-writer`; actions `sharing.removed_unknown`, `sharing.replaced`,
    `sharing.mismatch` (once per distinct set of differences), `sharing.failing` (five failed runs),
    `sharing.recovered`, `sharing.audit_mismatch`.
- **Groups** — the app writes Radicale's group file from Kanidm's membership: it
  reads the members of the groups used for sharing from Kanidm with a read-only
  **service account**, on a short interval, and also refreshes the caller's groups
  from userinfo (§6). A stale file means stale access, so the interval is a
  security setting. The sync (`server/utils/group-sync/`, unit tests pass) reads the
  groups that `calendar_acl` and `resource_acl` name, plus `calendar_admins` and
  `web_calendar_users`, every `NUXT_GROUP_SYNC_INTERVAL_SEC` (default 60 s, clamped to 1..300) and writes the
  file atomically (temp file, `fsync`, `rename`, `htgroup.prev`); an error or a `null` answer
  leaves the file untouched. **The members are mapped through the app's `users` table** (S9): the
  API token lists members as SPNs only and cannot read persons, so SPN (`preferred_username`) is
  mapped to `sub` from users who signed in once. A member who never signed in makes the run fail
  (the warning names up to five SPNs) and the file stays stale until the next interval after their
  first sign-in; nested groups are unresolvable the same way. `preferred_username` is the SPN, or
  the short name (the documented `prefer-short-username`) when the member's domain is the Kanidm
  domain, the host of the issuer or a parent of it (`createUsersTableResolver`); otherwise nothing
  resolves. LDAP (`entryuuid`) would remove the limit. A first look at a user's
  groups is not a change; a differing later claim triggers a run (debounce 2 s). Alarms: `401`/`403`
  logs at error level every run and records `group_sync.unauthorized` once per streak; every fifth
  consecutive failure logs at error level and records `group_sync.failing`; the first success
  afterwards records `group_sync.recovered`; a changed file records `group_sync.updated` (group
  names and member count, no SPNs). After a run that read every group and wrote the file, the
  app tokens of every user outside `web_calendar_users` are deleted (only those made before the
  run began; an empty group removes nobody; one `group_sync.tokens_revoked` event per user, with
  the count). Audit actor `system:group-sync`, wired in
  `group-sync/app-ports.ts` (an audit failure never ends a run). The service account and its read-only token are in
  [kanidm-setup.md](kanidm-setup.md) §3.
- **Team and resource calendars** — owned by a service principal that is not a
  Kanidm user (for example `_team`, `_resources`) and shared to groups. A resource
  calendar is shared so that users see "blocked" entries only (FR-18) with a map share
  with permission `f` (RUNTIME, S5 follow-up): the member gets the calendar's
  properties (`read-free-busy` privilege, only `free-busy-query` in the report set) and
  `free-busy-query` returns a `VFREEBUSY` without titles, while `GET`, `PROPFIND` Depth 1,
  `calendar-query` and every write give 403. `r` and `rw` behave as before (`r` implies
  free/busy). Limits: `PathMapped` must be a collection (a single event is refused with
  400), a share of a whole home is not usable, only one share per (calendar, user) exists
  (409), a **user** share is live only after the member itself calls `enable` and `unhide`
  (group shares need neither), and the API also stores an empty or free-form combination
  (`''`, `fr`, `rwf`), so the writer must send only the closed set.
- **Many shares (S5 follow-up).** Each share is about 100 bytes of `sharing.csv`; every create
  rewrites the whole file and every lookup scans the cache (CODE). RUNTIME with 2000 shares:
  create about 10 ms per call (2 ms at 100), one owner's list 8 ms, a full list of all
  owners 37 ms, Radicale memory 91 to 101 MiB. A member's home `PROPFIND` costs about
  0.4 ms per share (36 ms at 100, 222 ms at 500, 171 kB). Reconciling every 5 minutes is
  cheap; keep the number of shares per member low (hundreds at most). The full tables are in git
  history: `git show 352d101:docs/phase3-notes/s5-spike.md`.
- **Everyone** — a Kanidm group that contains all users (for example
  `web_calendar_users`) works as the "all users" principal.
- **Third-party clients** — they see shared calendars in their home listing like any
  other calendar. Real clients (Thunderbird, DAVx5, iOS) are untested (S7).
- **Resource rule (Q12)** — §5: opaque busy blocks, details from the booking
  calendar only for users who can read it.
- **App-level permissions** — **admin** (the Kanidm group `calendar_admins`) may
  create admin views, manage calendars and access rules, and edit resource
  metadata. Users own their personal views, filters, categories, subscriptions and
  app tokens.
- **Access administration (FR-14/15)** — the page `/admin/access` (menu entry "Calendar access" in
  live mode, admins only; the browser flag from `/api/me` only hides, the server decides).
  Routes, all `defineAdminHandler`: `GET /api/admin/access/calendars` (calendars with rules,
  `applied` taken from `applied_at`, and whether groups can be checked), `PUT
/api/admin/access/calendars/:id` (the whole rule list, one `replaceCalendarAcl` transaction),
  `GET /api/admin/access/users` (`sub`, name, username). Offered: principal types person, group,
  everyone signed in; permissions `free_busy`, `read`, `write`. `admin` and `public` are refused
  (public visibility is the public view, FR-27; `admin` never reaches Radicale). A person must be a
  lower-case UUID that exists in `users.oidc_sub`; the owner gets no rule; a group must be a valid
  group name that exists in Kanidm (`GET /v1/group/<name>` with the sync token; without the token
  every group rule is refused, with Kanidm down the answer is `409 group_check_unavailable` and
  nothing is stored). Only principals new to the calendar are checked, so an old rule never blocks
  editing another. An unchanged `PUT` writes no audit row; otherwise `acl.replaced` is recorded for
  `calendar:<id>` with counts only. After a change the route calls the `onAclChanged` port, which
  asks the sharing writer to reconcile; a throwing port is logged and the rules stay saved. A
  TOCTOU between the group check and the write is accepted. Whether the sidebar shows only
  accessible calendars was reviewed: the loader creates only calendars Radicale lists, so
  correctness rests on Radicale answering `403` (FR-15). Unit and e2e tests pass.
- **Shared views (FR-2)** — managed through `POST /api/admin/views`, `PUT` and `DELETE
/api/admin/views/:id` (`defineAdminHandler`, at most 100, audit `admin_view.created|updated|deleted`
  with the name). Only `is_admin = 1` rows are touched; user routes answer `404` for a shared view.
  `ext:` refs are refused per field, refs are shape-checked only (no lookup; what a viewer cannot read
  Radicale answers with `403`). In the sidebar admins get an "Add shared view" input and Rename /
  Update from selection / Delete actions; other users see a "Shared" badge. In demo mode the controls
  change the local list only.
- **Public view** _(planned)_ — no logged-in user, so it reads **only** the calendars
  in `published_calendars` with a service credential, read-only. Decided when the
  feature is scheduled.
- **Defense in depth** — Radicale listens only on the internal network. A bug in the
  gateway's header handling would let a caller pick their own identity, so the header
  rules in §7 are tested explicitly.
- **Limits** — shares are rows in a CSV database; behaviour with up to 2000 shares was measured
  (S5 follow-up, above). Group shares at scale and more than 2000 shares are untested.

---

## 9. Frontend / UI

Built on the **GroupOffice** baseline (FR-21…FR-25), mobile-friendly (FR-20).

- **Left sidebar** (top → bottom): **views** (icon + `⋯` menu), **calendars**
  (visibility toggle), **resources** (visibility toggle), **categories** (add
  control), **filters** (add control + chooser).
- **View-type switcher** (FR-22): **day, 5-day, week, month, year, split, list**.
- **Date navigation** (FR-23): previous / **today** / next.
- **Quick-add** (FR-24) and **overflow (`⋮`) menu** (FR-25).
- **Accounts and tokens** — Settings shows the **built-in calendar service** (preconfigured, same
  origin), **external CalDAV accounts** (URL plus OIDC, basic or no auth; their tokens stay in
  the browser), **app tokens** for Thunderbird and phones (FR-31) and, for admins, **calendars
  and access rules** (Phase 3).
- **SPA** — the logged-in app runs with `ssr: false`: no hydration mismatches, and
  no server/browser difference in what "today" is. FullCalendar needs no
  `<ClientOnly>` on SPA routes.
- **Components (NFR-3)** — **Nuxt UI v4** (adopted, trial S3) supplies the
  slideover (mobile sidebar drawer), dropdown menus (`⋯`, `⋮`), the modal for
  quick-add and the event sheet, and date inputs. The trial confirmed focus moving
  into an opened dialog, `aria-labelledby`/`aria-describedby`, page scroll lock,
  Escape to close, focus returning to the trigger, and menu roles with arrow-key
  navigation. Conditions:
  - Wrap the app's global element rules (`button`, `a`, …) in `@layer base`. They
    are unlayered, so they override Nuxt UI's layered styles and leave its buttons
    unstyled.
  - Do **not** use `UDrawer`: it depends on `vaul-vue`, which is unmaintained and
    ships no license metadata (§12). Use `USlideover` and `UModal`.
  - Defaults are 32 px high (buttons, menu items, close buttons), below the 44 px
    tap-target rule. The sizes are overridden; `e2e/a11y.spec.ts` and the settings, time zone,
    event sheet and admin access specs check 44 px, but nothing checks the sidebar toggles, the
    split view or the calendar grid.
  - Wrap the app in `<UApp>` and import Tailwind and Nuxt UI in the main CSS file.
  - Nuxt UI's default primary (blue 500) is 3.7:1 against white, below WCAG AA. The light scheme
    uses shade 600 (5.2:1) through `--ui-primary` in `main.css`; dark keeps the lighter shade.
  - Reka UI restores focus on close only to a `DialogTrigger`. A modal or slideover driven by `:open`
    loses focus to the page, so pass `content.onCloseAutoFocus` and focus the element that opened it
    (done in `QuickAddModal`, `EventSheet` and the layout's sidebar slideover).
  - The top bar has two rows below 1024 px: toggle, period title and the quick-add / `⋮` buttons on top,
    date navigation and the view switcher below in a strip that scrolls sideways. A single row does not
    fit at 360 px and hid the switcher.
  - **Date/time picker** — keep the browser's native inputs. The phone-specific focus issue was
    resolved by the temporary UI workaround; the native picker remains a little unintuitive, which
    is accepted. A custom picker is **not planned**.

  Fallback if a blocker appears: Reka UI (headless) with the existing CSS tokens.

- **FullCalendar v7** (`@fullcalendar/vue3`, plugins via subpath imports) renders
  the day/week/month/list views.
- **Split view (FR-6)** — **every** calendar in the selected view gets its **own
  horizontal band** (no overlap); a band that is **empty for the current view** is
  **hidden**. Built (spike S2): one **FullCalendar Premium resource timeline**
  (`@fullcalendar/vue3-scheduler/resource-timeline`), each calendar a row with a sticky label. The
  state (`splitBands`) decides which rows exist, so empty bands are hidden there and not by
  FullCalendar. Fallback if a phone test rejects it: one instance per calendar, stacked, with a
  shared date (it needs app-side empty-band hiding and has no sticky labels). Readable on a 360 px
  phone with `slotMinWidth` 100–110 and a 100 px label column. Extending split to **all** view types is a **planned experiment**
  (post-initial-release), not a requirement.

- **PWA / "Add to Home Screen" (backlog, after the initial release).** The app shell scrolls
  internally, so the mobile browser's address bar stays visible while using the site. Stopgap, done:
  "Full screen" in the ⋮ menu (Fullscreen API) hides the bar on request on Android; iPhone Safari
  has no such API. Its limit, found on an Android phone: in full screen the browser spends the first
  Back on leaving full screen, before the app's history steps can close a dialog, and page code
  cannot intercept that. The installed app is the real fix and the only one on iPhone: it runs without
  the address bar and keeps the fixed top bar. Keep it optional; the app stays fully usable in the
  browser. The files are small, the acceptance is not, so it waits for a deployment with HTTPS and
  two real phones. Work list:
  - A web app manifest (`display: standalone`, `start_url` and `scope` `/`, name, colours) with
    icons (192 and 512 px, one maskable), an `apple-touch-icon` and `theme-color` for both
    schemes. The icon artwork is a design decision. No service worker (security review: none).
  - HTTPS: browsers only install a site over HTTPS; over plain HTTP, as in a LAN test, "Add to
    Home Screen" makes a shortcut that still opens a tab.
  - Safe areas: `viewport-fit=cover` and `env(safe-area-inset-*)` padding on the top bar and the
    bottom sheet, for notched phones in the installed app.
  - Sign-in: the OIDC redirect leaves the app's origin. Check the round trip inside the installed
    app on Android and iPhone (an installed iPhone app has its own storage: a fresh sign-in).
  - Check on a phone: in the installed app one Back closes a dialog (full screen in the browser
    spends it on leaving full screen).
  - Tests: manifest and icons served with the right types, no request leaves the origin, CSP
    unchanged (`manifest-src` falls back to `default-src 'self'`).
- **Mobile** — responsive layout; the sidebar collapses; the split view stacks
  bands vertically.
- **Editability (Phase 1)** — the mock-up is **read-only rendering plus
  quick-add**; clicking/tapping an event opens the event details/edit sheet.
  Drag/resize editing is **not** a Phase 1 acceptance criterion and is deferred
  to Phase 2 (FR-9, two-way writes), where it must be backed by the real API.
  Quick-add (FR-24) is the Phase 1 creation path.

### FullCalendar v7 integration notes

- **Imports** — v7 moved the plugins into the framework package. Import from
  subpaths: `@fullcalendar/vue3/daygrid`, `@fullcalendar/vue3/timegrid`,
  `@fullcalendar/vue3/list`, `@fullcalendar/vue3/interaction`,
  `@fullcalendar/vue3/multimonth`, … `@fullcalendar/core` is a v7 types stub;
  do **not** depend on it directly. `temporal-polyfill` is required.
- **SSR** — FullCalendar renders **empty on the server**. The app is an SPA, so
  this only matters for a server-rendered route (for example the public view);
  there, mount it inside `<ClientOnly>` to avoid hydration mismatches.
- **CSS** — import `skeleton.css` **and** one theme stylesheet (for example
  `@fullcalendar/vue3/themes/classic/theme.css`); without the theme the calendar
  is unstyled. With Tailwind v4 (S3), FullCalendar rendered correctly: its CSS is
  unlayered, so it wins over Tailwind's layered base styles.
- **Dark mode** — also import `themes/classic/palette.css` (it holds both schemes). Its dark variables
  sit under `[data-color-scheme=dark]`: pass the `colorScheme` prop (or `options.colorScheme`) from
  Nuxt's colour mode, or set the attribute on an ancestor. The app re-points the palette variables at
  the Nuxt UI tokens in `main.css`. Event colours are chosen in code per scheme (text contrast ≥ 4.5).
  Custom theming is possible through class-name props if the variables are not enough.
  The root declares `color-scheme` (CSS and `<meta>`), and the ⋮ menu has a "Dark mode" switch: the
  system's scheme until flipped, then on is dark and off is light, kept in the browser. Limit: the
  "night mode" of Huawei Browser darkens pages on its own even then, which leaves the dark scheme
  low in contrast (seen on a phone). A page cannot switch it off; the answer is to turn it off for
  the site in that browser.
- **Interaction** — `editable` and `selectable` default to **`false`**. Dragging,
  resizing and selection require the **`interaction`** plugin; date clicks and
  selections are registered by the same plugin.
- **Touch** — v7 uses `PointerDragging`. Long-press starts drag/selection:
  `longPressDelay` defaults to **1000 ms**; `eventLongPressDelay` and
  `selectLongPressDelay` override it per interaction. Long-press is **not
  discoverable**, so every touch flow needs a visible alternative.
- **Sizing** — v7 resizes automatically via `ResizeObserver`;
  `handleWindowResize` no longer exists. Use `height`/`contentHeight`,
  `aspectRatio`, `expandRows`, `dayMaxEvents`/`dayMaxEventRows`, `dayNarrowWidth`,
  `eventMinWidth`, `eventMinHeight`, `eventShortHeight`, `slotMinWidth`, and
  per-view `views` overrides instead of viewport media queries inside the
  calendar.
- **Narrow day columns** — `dayMinWidth` (columns pan sideways inside the calendar) needs the Premium
  plugin `@fullcalendar/vue3-scheduler/scrollgrid` and the licence key; without them the page throws
  "Must import @fullcalendar/scrollgrid". Unit tests in happy-dom do not reach this path (no
  layout), so only a browser check caught it; the Playwright suite now covers it (§12).
- **Keyboard access to scrollers** — the panning day columns and the resource timeline scroll sideways
  on narrow screens without a tab stop (axe: `scrollable-region-focusable`). `useKeyboardScrollers`
  gives such regions `tabindex="0"` after each render, and `EventSheet` does the same for its body. No
  role or label is added: FullCalendar's grid markup does not allow an extra group between rows and
  cells.
- **Mobile** — drag/resize on touch is error-prone. Provide **explicit edit
  affordances** (tap event → sheet with Edit/Delete; quick-add button) and keep
  tap targets ≥ 44 px. Never make long-press the only path to an action.

---

## 10. Deployment

A **`docker-compose.yml`** with two services: the app (Nuxt 4 / Nitro) and Radicale.
Kanidm is an existing external service. Radicale has **no published port**: only the
app can reach it. The SQLite file and Radicale's data live on named volumes.

```yaml
# docker-compose.yml (excerpt; the full file is in the repo)
services:
  web-calendar:
    image: web-calendar:latest
    restart: unless-stopped
    ports:
      - '127.0.0.1:3000:3000'
    environment:
      NUXT_OIDC_ISSUER: 'https://idm.example.com/oauth2/openid/web-calendar'
      NUXT_OIDC_CLIENT_ID: 'web-calendar' # public client used by the SPA
      NUXT_OIDC_ALLOWED_CLIENTS: '' # more clients whose JWTs the gateway accepts
      NUXT_TOKEN_HASH_KEY: '${NUXT_TOKEN_HASH_KEY}' # openssl rand -base64 48
      NUXT_GROUP_SYNC_TOKEN: '${NUXT_GROUP_SYNC_TOKEN}' # read-only, kanidm-setup.md §3
      NUXT_GROUP_SYNC_INTERVAL_SEC: '60'
      NUXT_DB_PATH: /data/web-calendar.db
      NUXT_RADICALE_URL: http://radicale:5232
      TZ: '${TZ:-Europe/Berlin}' # organization time zone (FR-29)
    volumes:
      - web-calendar-data:/data # SQLite file
      - radicale-groups:/groups # Radicale's group file, written by the app
    healthcheck: # probes every 2 s while starting
      start_interval: 2s
  radicale:
    image: ghcr.io/kozea/radicale:3.9.0 # the project's own image
    restart: unless-stopped
    depends_on:
      web-calendar:
        condition: service_healthy # the app creates the group file first
    volumes:
      - radicale-data:/var/lib/radicale
      - radicale-groups:/etc/radicale/groups:ro
      - ./deploy/radicale/rights:/etc/radicale/rights:ro # static, owner-only rules
      - ./deploy/radicale/config:/etc/radicale/config:ro
volumes:
  web-calendar-data:
  radicale-data:
  radicale-groups:
```

- **Config via env vars.** Secrets (the group-sync credential, the token-hashing key)
  are injected at runtime, not baked into the image. The server needs no Kanidm
  client secret: it only verifies public-key signatures.
- **Kanidm setup** — the commands for the groups, the public client and its scopes are
  in [kanidm-setup.md](kanidm-setup.md).
- **Radicale config** — `auth.type = http_x_remote_user`; `rights.type = from_file`
  with a static owner-only file; `[group] type = htgroup` and `[sharing] type = csv`
  with `collection_by_map = true` (§8); no CORS headers (same origin). The rights file is bind-mounted
  read-only, so the app can change the group file but never the static rules. Radicale refuses to start
  without the group file: the app's start command creates it empty (`/groups/htgroup`) and Radicale
  waits for the app to be healthy. A new named volume takes the ownership of the image directory
  mounted on it, so the Dockerfile creates `/groups` owned by `node` and no root init step is needed.
- **Config names** — the compose file, `.env.example`, `nuxt.config.ts` and
  `server/validate-config.mjs` use the names above. The container refuses to start without
  `NUXT_OIDC_ISSUER` (https, last segment = the client id), `NUXT_TOKEN_HASH_KEY` or
  `NUXT_TOKEN_HASH_KEYS` (each key ≥ 32 characters) and `NUXT_RADICALE_URL`; `NUXT_GROUP_SYNC_TOKEN`
  only warns until group sync exists. Security settings: `NUXT_OUTBOUND_ALLOWED_HOSTS` (required in production, or
  `NUXT_OUTBOUND_ALLOW_ANY_HOST=true`), `NUXT_EXTERNAL_SEAL_KEY` (optional) (64 hex characters or base64 of 32 bytes); a malformed value stops the server.
- **Persistence and backup** — the SQLite file and Radicale's data are the two things
  to back up. The SQLite file is in WAL mode, so it is copied with `VACUUM INTO`
  (`scripts/backup-db.mjs`, `npm run backup`; it checks the copy and never changes the
  source), not with a file copy. Radicale has no quota: `npm run radicale:usage <collections dir>`
  (`scripts/radicale-usage.mjs`, run on the host) reports size and items per home and exits
  non-zero when one passes a threshold.
- **Build** — a multi-stage Dockerfile (build the Nuxt app, then run it on a slim
  Node image). `better-sqlite3` ships prebuilt binaries for every platform; Nitro copies them
  into `.output`, and the build stage fails if the addon cannot be loaded from there.
  The build stage runs `npm ci --ignore-scripts`: the image's npm 11.12 would otherwise run
  `node-gyp rebuild` for `better-sqlite3` (Python and a compiler needed; npm 11.19 honours its
  `gypfile: false`). The image was built and started with Compose on 2026-10-29: both services
  healthy, migrations applied, the group file created.
- **Test stack** — `dev/spike-s1` runs Kanidm and Radicale (the project's own image) for
  experiments (it earlier also ran OpenCloud and oauth2-proxy, spike S1). It is not
  part of the app.

---

## 11. Phasing

Aligned with the requirements' delivery phasing (all requirements are in scope;
this is the **order**):

| Phase                        | Focus                                                                                 | Key requirements                                                | Design pieces                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **1 — UI shell / mock-up**   | The webpage + a mock-up of all UI (sidebar with views at top, view types incl. split) | FR-21…FR-25, FR-6, FR-20                                        | §9 (sidebar, view types, split view mock-up, mobile); trial S2                                                                    |
| **2 — Core calendar + auth** | Calendar features, authentication, the CalDAV gateway (owner-only access)             | FR-7…FR-13, FR-30, FR-31, FR-3…FR-5, FR-20, FR-28, FR-29, FR-32 | §6 (login, local JWT verification, app tokens), §7 (gateway, reads, writes, recurrence), §5 (users, tokens, calendars); S4, S6–S8 |
| **3 — Organizational**       | Grouping/views, resources, sharing and access administration                          | FR-1…FR-2, FR-14…FR-19                                          | §8 (access rules, rules writer, sharing), §5 (views, resources, ACL); S5                                                          |

### Phase 3 status (2026-11-01)

**Phase 3 was first run on 2026-11-01:** the unit suite and the e2e suite (demo mode, mocked
answers, seven browser projects) pass; migrations 005, 006 and 008 ran on a copy of the dev database
(§5); the real-login e2e (`npm run test:e2e:live`, 20 tests) passes with the Phase 3 build against
the test stack's Kanidm and Radicale; and the built app ran against that stack with a throwaway
database, driven as alice and bob with real tokens (below). Not run: the app against a production
Kanidm and Radicale, or a database that holds data. Details are in §5 (schema, resources), §8
(audit log, sharing, groups, access administration, shared views). The per-task working notes were
removed before the merge; they are in git history (`git show 352d101:docs/phase3-notes/README.md`).

| Task                                                            | State                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Audit log and admin guard                                       | built (migration 005, `defineAdminHandler`, rate limit)                                           |
| Schema rework (access rules, resources, bookings)               | built (migration 006, DB modules)                                                                 |
| S5 follow-ups (`f` on map shares, many shares)                  | done by measurement against Radicale 3.9.0                                                        |
| Group sync                                                      | built, wired to the audit log and to the groups of the access rules                               |
| Sharing writer, gateway pre-check, nightly audit job            | built; plugin `server/plugins/sharing.ts`                                                         |
| Admin views (FR-2)                                              | built (routes and sidebar controls)                                                               |
| Access administration (FR-14/15)                                | built (API and `/admin/access`), wired to the sharing writer by `server/plugins/access-wiring.ts` |
| Resources part 1 (entities, bookings, availability blocks)      | built; blocks written through the sharing writer's store by `server/plugins/resources.ts`         |
| Resources part 2, server (availability, manager queue, updates) | built; routes `GET /api/resources/availability`, `requests`, `updates`                            |
| Resources part 2, client (booking form, requests page, toast)   | built; page `/resources/requests`                                                                 |
| Resources part 3 (reconcile of moved or deleted events)         | built (migration 008, `booking_sync`); loop in `server/plugins/resources.ts`                      |
| Sharing writer: Radicale assumptions                            | checked against Radicale 3.9.0 (`dev/spike-s1/tools/verify_sharing_shapes.py`); one bug fixed     |

**Open for Phase 3** (found at integration):

- Checked live (Radicale 3.9.0, 2026-11-01, the real `reconcile-reader` as each user): `stamp` gives
  a changing `ctag|sync-token` and `findEvent` finds, or does not find, a UID, in an own calendar, in
  one with a space and a non-ASCII letter in its name, and through a user share and a group share
  (the share's stamp equals the source's; a member's `rw` write shows at the source). A calendar
  that is not in the home, a share the member has not accepted or has disabled, a share the owner
  disabled or deleted all answer **404** (`no_collection`); another user's calendar that is not
  shared answers **403** (`forbidden`); both go to the manager queue as `calendar_unavailable`.
  A share hidden by the member still reads fine but is **missing from the home listing**, so a
  moved event in a hidden share is not found by `searchElsewhere`. Group membership resolves the
  share (a member reads it; a non-member gets 404 and does not see it). The text match of the UID
  query is a substring match; `matchEvent` already compares the exact UID line.
- The reconcile loop in the running app (2026-11-01; the built app on port 3401, reconcile interval
  10 s, sharing interval 900 s, a throwaway database, real Kanidm tokens for alice and bob, one
  scripted run of 73 checks after 10 setup checks, all passed). **Verified live:**
  - A booking from an own calendar the discovery had not seen yet is accepted and stored by its path
    (201); the first reconcile read came about 90 s after start, and a log line
    `[resources] booking reconcile: …` appears when a run cancels or loses something.
  - An event moved to another own calendar is followed (the stored path changes, no orphan mark).
  - A deleted event: the first and second look mark the booking orphaned (attempts 1 and 2, one
    `resource_booking.orphaned` audit entry, `event_missing`), the third look cancels it
    (`resource_booking.cancelled`, `event_removed`, actor `system:resources`, attempts 3), and its
    availability block leaves Radicale.
  - An unchanged event clears the orphaned state: a deleted event that comes back with the same UID,
    slot and marks after the first look gets `orphaned_at` and the attempts reset by the next look,
    and the booking is not cancelled.
  - A booking from a share (`/<bob>/shared-<id>/`, made by the sharing writer after an admin granted
    `read`) is stored by that path, read as the booker, and left alone while the event is there.
    After the share is revoked, disabled by the member, or disabled by the owner, the next run sends
    the booking to the manager queue (attempts at the limit, one `resource_booking.orphaned` entry
    with `calendar_unavailable` and `cause: missing`, because Radicale answers 404 in all three
    cases), the stored stamp of the share path is deleted, the booking appears in
    `GET /api/resources/requests` with `orphanedAt`, and it is never cancelled, also over three more
    runs. A booking from an unknown share is refused with 403 `calendar_not_readable`, one from
    another user's home with 400 `invalid_event`. SIGTERM stops the app in about 2 s.
  - After a revoke, the writer's run re-accepts a share the member disabled, and the next look clears
    that booking's orphan state; a share the owner disabled stays disabled (the writer accepts only
    as the member), so its booking stays in the queue.

  **Not verified live** (unit tests only, or not at all): a soft orphan from an unreadable event (5xx
  or timeout; no way to make Radicale do that on the test stack); a 403 on a collection (only the
  reader was checked, for another user's unshared calendar); a share hidden by the member, or a
  booking made from one; a share with only `free_busy`; a group share booked from through the app
  (the reader reads one); an event moved into a share; a home with more than 20 calendars; the
  block repair timers (60 s, then 10 min); the default interval of 300 s and its clamp; a database
  that holds data or a production Radicale and Kanidm.

- **Found live, fixed:** Radicale's `map/list` answers a member with the shares mapped _to_ them as
  well (the S5 notes recorded it, "the member's own list shows the shares he receives", but the writer
  did not account for it). Each row has an `Owner` field. The sharing writer lists every known user as an owner, so it took a
  member's received shares for its own, planned to delete them as "unknown", and Radicale answered
  403 to the member. Every run then logged `Radicale differs from the access rules after
reconcile … cannot remove … map/delete answered 403 …` and wrote a `sharing.mismatch` audit entry,
  and the alarm never went quiet; access and revocation were not affected. `listShares` in
  `radicale-client.ts` now keeps only rows whose `Owner` is the principal it asked for (a row
  without `Owner` is kept). The fake Radicale in the tests lists a member's received shares and
  answers 403 to a delete by a non-owner, as the real one does; the regression tests fail without
  the fix (5 of 12 in `sharing-reconcile.test.ts`). Checked live afterwards (2026-11-01, sharing
  interval 10 s): with bob holding a received share the writer ran six more times without a
  mismatch line, a `sharing.mismatch` audit entry or a removal of his share, his path kept answering,
  and revoking the grant still removed it (404 for bob). A side effect of the test runs: the writer also removes shares the app's database does not know (the stack's
  `/{user}/team/`), as designed.
- The manager queue cannot tell a moved from a missing or unreadable event except by the audit
  entry; the `free_busy` narrowing of the detail check is imprecise for mixed grants (§5, part 2).

**Before the first real use** (run migrations 005, 006 and 008 on a copy of a database that holds
data, and watch the first live reconcile log): the sharing writer's list
shapes are now checked against Radicale 3.9.0 (a group share's `User` as `:group`, the `{user}`
placeholder echoed back; the flags are `EnabledByUser` and so on, which the writer misread until
the check), and `token/list` and `token/delete` answer 404 there because `collection_by_token` is
off, which the reconcile already ignores; a calendar owned by a member and named like
`shared-<digits>` is treated as a share by the pre-check.

---

## 12. Open Items / Risks

### Spikes

- **S1 — Calendar access with Kanidm tokens. Done 2026-10-29.** Test stack:
  `dev/spike-s1` (Kanidm 1.11.2, OpenCloud 9.0.0, Radicale 3.9.0, oauth2-proxy
  7.15.5); details in its README.
  - OpenCloud's `/caldav/` accepts OIDC bearer tokens, but **only from the one
    Kanidm client it is configured with** (`web`). A token from another client gets
    401: `key ID was not found in the JWKS`. Userinfo verification fails the same
    way. Kanidm scopes the issuer, signing keys and userinfo endpoint per client;
    OpenCloud has a single issuer. Kanidm's token exchange returned
    `invalid_request` for every request shape tried.
  - Kanidm's **introspection** endpoint, called by a confidential client, reports
    `active: true` for tokens of other clients (`client_id`, `aud`, `username`, `sub`,
    `scope`, `exp`). oauth2-proxy with extra JWT issuers also accepted both clients.
  - Kanidm access tokens are ES256 JWTs valid for 900 s and carry only `sub`; name,
    email and groups are in the ID token. The refresh grant works.
  - **Browser:** Kanidm sends `Access-Control-Allow-Origin: *` on discovery, JWKS,
    userinfo and the token endpoint (including successful token responses).
    OpenCloud sends no CORS headers on `/caldav/`; Radicale's `[headers]` setting
    fixes that, but OpenCloud's own 401s carry none. An nginx gateway handled CORS
    on 401s too. Checked with `Origin` headers, not in a real browser (the browser
    does not trust the test CA).
  - **Radicale 3.9.0:** rights backends `authenticated`, `owner_only` (default),
    `owner_write`, `from_file` (regex rules, first match wins, permission letters
    `R r W w f` and more); `[group]` backends `none`, `from_auth`, `htgroup`;
    `[sharing]` (by token or by map, `csv` or `files` database). No WebDAV ACL is
    documented. Not tested.
  - **Decision (this design):** the app is the gateway and verifies tokens locally
    against an allow-list of Kanidm clients (§6); OpenCloud is not in the CalDAV
    path. It can still be added as a generic external account using its own client
    `web`.
- **S2 — FullCalendar Premium split view. Done 2026-10-29: use the Premium resource timeline.**
  - _Packages:_ `@fullcalendar/vue3-scheduler` 7.1.3 (peer: `@fullcalendar/vue3` 7.1.3), subpaths
    `/resource-timeline`, `/resource-timegrid`, `/resource-daygrid`, `/timeline`, `/scrollgrid`. Its
    `package.json` says `SEE LICENSE IN LICENSE.md`: tri-licensed (commercial, CC BY-NC-ND, AGPLv3);
    allow-list it by hand in the licence audit. Key: `'AGPL-My-Frontend-And-Backend-Are-Open-Source'`
    (no paid key). Option names in v7: `resourceColumnsWidth` (not `resourceAreaWidth`).
  - _Timeline (calendars as rows):_ works; a busy day grows its row (one line per event), quiet rows
    are 36 px; `filterResourcesWithEvents` hides empty rows (the app uses `splitBands` instead); the date
    header is sticky and the label column is its own pane; `interaction` is not needed for display or
    clicks. 15 non-empty rows fit one screen at 768×1024. At 360×640 it is tight: `slotMinWidth` 90–120
    and a 100 px label column make it readable, with horizontal scroll.
  - _Resource time grid / day grid:_ calendars as columns, not bands; unusable at 360 px.
  - _Stacked instances (fallback):_ works, but empty-band hiding is app-side, there are no sticky labels
    and the DOM is about 3× larger. Not needed.
  - _Bundle:_ +29 kB gzip for the resource timeline, +33 kB with timegrid, daygrid and scrollgrid.
- **S3 — Nuxt UI trial. Done 2026-10-29: adopt.** Run in a throwaway copy inside the
  Dev Container (the repo was not changed): `@nuxt/ui` 4.12.0 and Tailwind CSS v4 on
  the current Nuxt 4.6 / FullCalendar 7.1 project, with a page using a slideover,
  drawer, modal, dropdown menu and a FullCalendar month grid.
  - _Works:_ `nuxt build`; `npm run check` (Prettier, ESLint 10, `nuxt typecheck`);
    FullCalendar renders correctly next to Tailwind; keyboard and focus behavior of
    the slideover and dropdown menu (§9); icons are served by the app itself
    (`/api/_nuxt_icon`), with no request to `api.iconify.design` observed.
  - _Size_ (client, raw / gzip): the current app is 195 kB / 70 kB JS and 7 kB / 2 kB
    CSS. Adding a FullCalendar month page gives 432 kB / 141 kB JS and 23 kB / 6 kB
    CSS. Adding Nuxt UI with four overlay components gives 822 kB / 258 kB JS and
    223 kB / 32 kB CSS.
  - _Dependencies:_ 195 packages added (176 MIT, 12 MPL-2.0 `lightningcss` binaries
    that are build-time only, 5 Apache-2.0, 1 CC0, 1 without license metadata). The
    server runtime in `.output` has 42 packages: MIT, Apache-2.0 and BSD, plus
    `vaul-vue`. MPL-2.0 is compatible with AGPLv3 through its secondary-license
    clause.
  - _Audit:_ 7 low and 1 high before, 8 low and 1 high after, in the same
    Nuxt/Nitro chain.
  - _Install scripts:_ npm 11 asks for `allowScripts` entries for a second `esbuild`
    (0.27.7) and `vue-demi`.
  - _Not tested:_ touch behavior, screen readers, colour contrast, `UDrawer`
    swiping, and the 44 px tap-target overrides.
  - _Open license gap:_ `vaul-vue` 0.4.1 (pulled in by `UDrawer`) has no `license`
    field and no license file in its npm package. Its GitHub repository (unovue)
    states MIT and says the package is no longer maintained, recommending Reka UI's
    Drawer. Treat it as unverified until the AGPL audit in §2 is signed off, and
    avoid `UDrawer`.
- **S4 — Radicale and recurrence. Done 2026-10-30** (`dev/spike-tscaldav`, through the
  gateway). `expand` in `calendar-query` works and is correct: a weekly series across the
  25 Oct daylight-saving change gives the right UTC instants, `EXDATE` and a moved
  `RECURRENCE-ID` override are applied, `BYSETPOS` (last weekday of the month) is right,
  all-day instances keep a date `RECURRENCE-ID`, floating and UTC events pass through.
  Instances come back in UTC. `time-range` returns the master and its overrides.
  `free-busy-query` works (a cancelled event counts as free). **Libraries:** `ts-caldav`
  0.4.5 was rejected (its event model drops `BYSETPOS`, all but the first `CATEGORIES`
  value and `ATTENDEE`/`ORGANIZER` parameters, reads floating times as UTC, and
  `updateEvent` rewrites the whole resource and drops overrides; one unparseable
  component fails the whole read). `tsdav` 2.5.0 works as a transport that returns raw
  `.ics` (lossless, `If-Match` gives `412`, accepts our `fetch`); edits patch the raw
  resource with `ical.js`.
- **S10 — Time zones in Radicale. Done 2026-10-30.** Observed behaviour (Radicale 3.9.0,
  `dev/spike-tscaldav/tz-probe.mjs`), not read from its source.
  - A floating event (`DTSTART:20261104T100000`) is stored exactly as sent; it is not
    converted to UTC.
  - `calendar-timezone` is never set by Radicale itself. A client can set it (for example
    in `MKCALENDAR`); Radicale stores it and returns it in `PROPFIND`.
  - Radicale does not use it in its own arithmetic: `time-range` and `free-busy-query`
    read the floating `10:00` as `10:00Z`, with or without the property set to
    `Europe/Berlin`. Other uses (for example `expand`) were not tested.
  - Consequence: the property is only a hint for clients that read it. The web client reads
    floating times as organization time and pads its query ranges (§7).
- **S5 — Radicale access mechanics. Done 2026-10-29.** Tested directly against
  Radicale 3.9.0 in `dev/spike-s1` with `X-Remote-User` set to Kanidm `sub` values;
  results are in the table in §8.
  - The rights file is static (restart needed); group files and map shares are live;
    `f` gives the free/busy-only view; group and user shares list in a member's
    home as calendars and honor `r` and `rw`.
  - _Follow-up, 2026-11-01_ (`dev/spike-s1/tools/s5_shares.py`, tables in git history,
    `git show 352d101:docs/phase3-notes/s5-spike.md`): a map share accepts `f` and gives exactly the free/busy
    view (`free-busy-query` 200 without titles; `GET`, Depth 1, `calendar-query` and writes
    403); `r` and `rw` as expected. Share limits: calendars only, one share per (calendar,
    user), user shares need the member's `enable` and `unhide`. With 2000 shares: create
    about 10 ms, full list 37 ms, member home `PROPFIND` 0.4 ms per share (222 ms at 500).
    No fallback for FR-18 and FR-19 is needed.
  - _Still open:_ real clients (S7); group shares at scale; more than 2000 shares; concurrent
    writers during a reconcile.
- **S6 — Gateway prototype. Done 2026-10-29** (`server/utils/gateway`, `server/utils/auth`; notes in
  §7). Verified by hand against the real Kanidm and Radicale through `nuxt dev` and through the
  production build (`.output`): `PROPFIND` with a real token gives 207; a spoofed `X-Remote-User`,
  `X-Script-Name` or `X-Forwarded-*` changes nothing; no token, a bad token and an ID token give 401;
  traversal gives 400; `POST` gives 405; the `.well-known` redirect, the CORS preflight and a Basic
  app token work. Covered by the integration test (`GATEWAY_IT=1`): a full `PUT`/`GET`/`REPORT`/
  `MOVE`/`DELETE` cycle, a chunked `PUT` and the 413 on an oversized body. Unit tests cover the
  rejections (algorithm, `typ`, `iss`, `aud`, expiry, scope, unlisted client, `kid` rotation).
  _Not verified:_ a real key rotation, and Kanidm unreachable with a cold cache (unit-tested only).
- **S7 — Third-party clients.** Thunderbird, DAVx5 and iOS against `/caldav/` with
  app tokens (Basic) and via `/.well-known/caldav`; discovery of personal and shared
  calendars; OIDC-capable clients with bearer tokens.
- **S8 — Real-browser login.** The SPA code + PKCE flow with a certificate the
  browser trusts (for example mkcert): consent, silent renewal, state preservation,
  CORS to an external account. _Done 2026-10-30:_ `tsdav` (with `xml-js`) works in Chromium
  and WebKit through the gateway (PROPFIND, REPORT, MKCALENDAR, a `412`, abort, a bad token);
  the app uses only its low-level `davRequest` (the high-level calls add requests, follow
  `.well-known` redirects a browser cannot see and hide error statuses), about 29 kB gzip.
  _Still open:_ consent, silent renewal and CORS to an external account in a real browser.
- **S9 — Reading group membership from Kanidm. Done 2026-10-29; the sync built in Phase 3.** A fresh service
  account cannot read groups: `GET /v1/group/<name>` returned `null`, also in
  `idm_service_desk`. Kanidm 1.11.2 has no CLI or API for custom access profiles and
  no read-only group-read group. **Working route:** put the service account in
  `idm_group_admins` and use its **read-only API token** (the default): the token
  lists group members (`member` attribute) and a write attempt returns 403 with the
  membership unchanged. The `groups` scope does not help here: it only puts the
  _caller's_ groups into that user's own tokens. _Residual:_ the account's group has
  write power, so the read-only flag is the only barrier; use an expiry and never a
  `--readwrite` token. _Alternative to try later:_ Kanidm's LDAP interface with a
  service-account bind. _Found while building the sync (Phase 3):_ the group lists members as SPNs
  only, and in the test stack the same token cannot read persons (`/v1/person/<spn>` and
  `/v1/raw/search` return `null` or nothing; `/scim/v1/*` and `/v1/internal/uuid/*` answer 404). The
  sync therefore maps SPN to `sub` through the app's `users` table, and a member who never signed
  in blocks a run (§8). LDAP (`entryuuid`) or a Kanidm grant to read persons would remove that.

### Risks and decisions still open

- **Group membership from Kanidm** — decided: a service account polled every **60 s**.
  The group file needs whole-group membership, which tokens do not carry, and the
  account reads them with a read-only token (S9, residual risk: the account's group
  has write power). The interval is a security setting: a removed member keeps
  access for up to 60 s. Kanidm unreachable: handled (the last file is kept and the log is
  loud, five failures escalate). Open: a member who never signed in makes every run fail, so
  removals are not applied while someone in a group has not signed in yet (fail closed, stale
  file); decide between an LDAP bind and a Kanidm grant to read persons. The Radicale
  volume directory must be writable by the app user (`/groups` is chowned to `node` in the
  Dockerfile).
- **Gateway is security-critical** — header spoofing, open-proxy paths and request
  limits must be tested (S6).
- **Revocation latency** — a revoked bearer token works until it expires, at most 15
  minutes (decided: local JWT verification only). App tokens are revoked at once, and those of a
  user who left `web_calendar_users` at the next group sync run.
- **Tokens in the browser** — XSS exposure; strict CSP, no third-party scripts,
  refresh token in memory only. App tokens are long-lived secrets: hashed, expiring.
- **Share and group writer correctness** — built (§8): reconcile of `calendar_acl` against
  Radicale's share list, atomic group file writes, backoff when Radicale is unreachable, a nightly
  audit job; fixture tests pass. The API shapes S5 did not show (group share `User` as `:group` in
  list output, the `{user}` placeholder echoed back, `token/list` and `token/delete`) were checked
  against Radicale 3.9.0 on 2026-11-01 (§11). Open: the first run of the real app against a real
  Radicale; if the shapes differ there the reconcile deletes and recreates every run and alarms. A group share to a member who also has a user share of the
  same calendar may get `409` (one share per source and user) and shows as a difference. A calendar
  removed in Radicale keeps its row. Each owner costs one list request (two with tokens) per run.
  Not covered by any test: bob and alice end to end against a real Radicale.
- **Live-fetch latency** — 10–20 requests per view change, and no local copy when
  Radicale is down (decided: an error, no stale data). Measure with the 30 s
  in-browser cache.
- **Recurring edits** — decided and built: ask each time, "this instance" preselected;
  the mechanics and the `VTIMEZONE` source (generated from Intl) are in §7.
- **Resource booking mechanism and FR-19** — decided 2026-10-31: a resource is a first-class
  entity (not a calendar); bookings are app-DB rows referenced from the booker's event via
  `X-WEB-CALENDAR-RESOURCE` / `X-WEB-CALENDAR-BOOKING` / `X-WEB-CALENDAR-BOOKING-STATUS`;
  accept/decline is app-side state with an audit trail (not CalDAV scheduling). Availability
  for third-party clients is a derived calendar collection with approved blocks as `BUSY` and
  pending as `BUSY-TENTATIVE`. See §5 resource model. Part 1 is built (unit tests pass);
  the open parts are listed in the Phase 3 status (§11). The booking limits are placeholders.
- **Public view credentials** — service credential and published list. Decided
  when the feature is scheduled.
- **AGPLv3 dependency audit** — confirm every dependency is AGPLv3-compatible before
  adding it (the core stack above is; new deps must be checked, including the
  browser OIDC library and CalDAV client).
- **Touch interaction gap** — long-press is the only built-in touch gesture for
  drag/selection and is not discoverable. Every action needs a visible,
  keyboard-reachable alternative; verify at 360×640 portrait and 640×360
  landscape.
- **Phone browser date-picker behavior** — resolved in real-device testing. The native picker is
  still a little unintuitive, but a custom picker is not planned.
- **Editing scope** — Phase 1 is read-only + quick-add. Enabling `editable`
  without a real store would fake persistence; drag/resize stays off until
  Phase 2 wires the API.
- **Dependency audit** — the S3 baseline showed 7 low and 1 high findings in the Nuxt/Nitro chain
  (`node-forge` via `listhen`). Updated 2026-11-01 (Nuxt 4.6.3, `npm audit fix`): the `node-forge`
  and `esbuild` advisories are gone; `audit:prod` allows `glob`, `minimatch` and `deepmerge`, all
  in build tools and absent from `.output/server`. Do not run `npm audit fix --force` (it
  downgrades Nuxt). Re-check on every upstream release.
- **Quality tooling** — Vite+ was removed on 2026-10-29 (too new: it forced `vite`
  to a fork through `overrides`). Replacement: ESLint 10 (`@nuxt/eslint`) +
  Prettier (single quotes, no semicolons, 100 columns) + `nuxt typecheck`, with
  `npm test` running plain `vitest run`. `npm run check` and `npm test` pass in the
  Dev Container. TypeScript is held at 5.9: TypeScript 7 is the native compiler and ships no classic compiler
  library, which `vue-tsc` and `typescript-eslint` (peer `<6.1.0`) load. Tried 2026-11-01 and not
  adopted: Vize 0.627 (experimental) with the TypeScript 7.1 beta and its content mapper gave 8,531
  syntax errors in 173 Nuxt UI `.vue` files; `vize check` caught planted errors but reported 34
  false positives on code `vue-tsc` passes (Nuxt UI slot types, component template refs) and took
  16 s against 3 s. Golar 0.1.11 (`nuxt typecheck --checker golar`, bundles typescript-go) also
  tried: it matched `vue-tsc` on nine planted errors and on the whole project, in about a third of
  the time, and was left out only because replacing `vue-tsc` does not remove the old `typescript`
  that `typescript-eslint` needs. ESLint alternatives were weighed and not adopted: Oxlint (type-aware
  linting on the TypeScript 7 engine, no official Vue template coverage) and Biome (Vue support
  experimental) cover far less than the 106 `eslint-plugin-vue` rules in use. Decided 2026-11-01:
  keep ESLint, `vue-tsc` and TypeScript 5.9; revisit when `typescript-eslint` supports TypeScript 7
  and Golar is past 0.x.
- **Browser-level tests** — decided and built (2026-10-29): Playwright with Chromium and WebKit in
  the Dev Container, tests in `e2e/` against the production build. Projects: phone portrait and
  landscape (touch), tablet, desktop, phone and desktop in dark mode, WebKit phone. Covered: no
  sideways page scroll and no console errors in every view, the controls by tap and keyboard,
  focus return after dialogs, the split view's bands, and an axe scan (WCAG 2.1 A/AA) of every view,
  the quick-add dialog and the event sheet. **Known gap against WCAG 2.1 AA** (review
  2026-11-01): the scan allow-lists, by selector, three `aria-required-children` findings inside
  FullCalendar's own markup (the pannable time grid and the resource timeline hang their cells off
  `aria-owns` lists, the year view lists months without list items); they need a change in
  FullCalendar, not in this app. Two findings of the same scan, `label-content-name-mismatch`
  (WCAG 2.5.3) on the column headers and the month titles, are fixed in `app/utils/fullcalendar.ts`
  (`navLinkName`, `nameDayHeader`). The suite found real problems the unit tests could not
  (the scroll grid error was reproduced by removing the plugin; the event sheet's description list;
  scrollers without a tab stop). Playwright (Apache-2.0) and axe-core (MPL-2.0) are dev-only. Known
  upstream findings inside FullCalendar's markup are listed with their reasons in
  `e2e/a11y.spec.ts`: time-grid day headers named with the long date, the year view's month titles
  and lists, and the aria-owns rows of the pannable grid and the resource timeline. Not covered:
  real devices, screen readers, drag and long-press (editing is off), and login (Phase 2).
- **Colour contrast** — reviewed 2026-11-01 beyond the event colours: text 4.5:1 and the edge of a
  control 3:1 (WCAG 1.4.3, 1.4.11), in both schemes, from the tokens and from what was painted. The
  axe scan reports no violation but skips placeholders and the edges of controls, and sets aside what
  it cannot decide ("incomplete": text over the hatched "Busy" entries, labels another element
  overlaps). Those 112 elements were measured from pixels: all read at 5.0:1 or better, the hatch
  lowest. Found and fixed in `main.css`: the dimmed text tier, where Nuxt UI puts placeholders and
  faint icons, was 2.6:1 (light) and 3.7:1 (dark) and is now the muted colour (4.8:1 and 6.8:1); the
  edge of fields, selects, checkboxes, radios and of a switch that is off was 1.2 to 1.7:1 and is now
  `--app-control-border` (3.4 to 4.6:1 on the three surfaces). The lines of the calendar keep Nuxt
  UI's border colours, they are decoration. An open ⋮ menu hides the page with `aria-hidden` and
  keeps the focus inside; axe reports that (`aria-hidden-focus`) because it accepts it only behind a
  dialog, so that scan leaves the rule out and a test checks that Tab cannot leave the menu. Tests:
  `e2e/contrast.spec.ts`, `e2e/a11y.spec.ts`. Margins are thin in one place: muted text on the
  sidebar is 4.55:1 in the light scheme. Not covered: hover and disabled states, and a high-contrast mode.
- **Security backlog** (audit scope: `docs/security-review.md`; latest dated review:
  `docs/security-review-2026-11-01.md`) — done: the first review's
  findings, a key id on app-token hashes with rotation, IPv6 /64 grouping in the login throttle,
  the Radicale usage report, gateway tests against the production build
  (`npm run test:gateway:prod`), `npm run audit:prod` (three known advisories allowed) and a
  live key rotation test against Kanidm. Phase 3: the audit log, `requireAdmin` with a rate limit,
  the sharing writer with its pre-check, the group sync and the resource blocks are built (unit and
  e2e tests pass; §8). Open: the dependency audit on each Nuxt release; the public view and its
  controls. **No CI for now** (decided 2026-11-01): the repo is private, Codeberg's hosted Woodpecker
  needs a public repo, and the live-login suite cannot run on a hosted runner anyway (it needs the
  Kanidm and Radicale test stack). A release is gated by a manual run of the checks on the
  maintainer's machine, in the Dev Container: `check`, `test`, `test:e2e`, `audit:prod`,
  `test:gateway:prod` and `test:e2e:live` (README "Release checks"). The repo has no CI configuration.
- **External accounts, residual risks** — the Radicale host is refused by name, and by address
  only when `NUXT_RADICALE_URL` is an IP literal, so a listed internal name that resolves to the
  Radicale container would get through; worst-case memory of the proxy is about 32 × 10 MiB; an
  internal server with a private CA needs `NODE_EXTRA_CA_CERTS`; the rejection of `ext:` refs in admin
  views is built with the admin views (`parseViewInput(body, { allowExternal: false })`, unit
  tests pass); external calendars are read-only for now. Found by review and left
  open: a seal has no per-account version, so after a user name or origin is changed and then
  changed back, the first seal opens again (add `credential_version` to the account and to the
  seal's associated data); the host list has no port, so a listed internal host is reachable on every
  port with GET, PROPFIND and REPORT (allow `host:port` entries, or default private hosts to 80 and
  443); the gateway authenticates before it checks a declared body length, so an unauthenticated
  request with a huge declared length is drained before the `401`.
  The browser half has no cap on calendars per account, objects per calendar or events per
  calendar, so a huge external calendar can freeze the tab, and it paces nothing against the
  proxy's 60-burst, 20-per-second bucket (a `429` shows as "Too many requests" and is not
  retried); an import that is left or fails to decode a non-UTF-8 file says nothing; a "Check
  connection" that started before an edit can overwrite the cleared status.
- **Database migrations** — decided: numbered `.sql` files and a small runner
  applied at startup, with hand-written TypeScript types. Revisit Drizzle if the
  types drift.
- **SQLite under concurrency** — app data is small and WAL handles the expected
  load (≤10 concurrent); if load grows, migrate to Postgres (the data model is
  portable).

---

## 13. Phase 1 — Implementation Steps

Phase 1 is the **UI shell / mock-up**: a working mock-up of **all** the UI
(sidebar with views at the top, every view type incl. split, mobile), driven by
**mock data** — no real backend, auth, or CalDAV calls yet. It satisfies
**FR-21…FR-25, FR-6, FR-20** (design §9).

Trials **S3** (Nuxt UI) and **S2** (Premium split view) are done and adopted (§12).

**Status (2026-10-29):** Steps 1–7 are built and were checked by hand at 360×640, 640×360, 768×1024 and
1280×800 in light and dark. Steps 8 and 9: touch behaviour and the landscape top bar (two rows take 113
of 360 px) were checked on a phone (2026-11-01) and the colour-contrast review is done (§12, "Colour
contrast"); screen readers are open. Quick-add adds to an in-memory store; the `⋯` and `⋮`
menu items and Edit and Delete only show a toast.

| Step | What                       | Requirements               |
| ---- | -------------------------- | -------------------------- |
| 1    | Project scaffolding        | —                          |
| 2    | Mock data layer            | —                          |
| 3    | App shell / layout         | FR-20                      |
| 4    | Sidebar                    | FR-21                      |
| 5    | Top bar                    | FR-22, FR-23, FR-24, FR-25 |
| 6    | Main area — standard views | FR-22                      |
| 7    | Split view                 | FR-6                       |
| 8    | Mobile                     | FR-20                      |
| 9    | Polish / review            | all of the above           |

**Step 1 — Project scaffolding**

- Initialize a **Nuxt 4** project; add **FullCalendar v7** (`@fullcalendar/vue3`;
  the Premium packages and their licence key are in §2).
- Add the **Docker** container + `docker-compose.yml` (§10) and a dev workflow
  (`npm run dev`).
- _Acceptance:_ `npm run dev` serves the app; `docker compose up` builds and runs
  the container.

**Step 2 — Mock data layer**

- A single mock-data module that provides **views, calendars, resources,
  categories, filters, and events** — enough to populate every UI section and to
  exercise the split view (incl. some **empty** calendars to test band-hiding).
- _Acceptance:_ the module exports the mock data; the UI can import it.

**Step 3 — App shell / layout**

- The overall layout: **left sidebar + top bar + main area**, responsive.
- Run the app as a **SPA** (`ssr: false`). Once switched, the SSR-only workarounds
  (the `useState` date anchor in `useMockData`) are no longer needed.
- Sidebar: fixed on desktop, **off-canvas drawer** (with a visible toggle and
  backdrop) below 768 px. Top bar wraps or scrolls horizontally instead of
  clipping. The main area fills the remaining viewport height so the calendar
  scrolls internally rather than the page.
- Keep the viewport meta tag (`width=device-width, initial-scale=1`) and use
  CSS breakpoints; do not branch layout on user-agent.
- _Acceptance:_ the three regions render; **no horizontal page scroll** at
  360×640, 640×360 (landscape), 768×1024 and 1280×800; the sidebar toggle is
  reachable and closes the drawer; content is not clipped at 200 % zoom.
  `e2e/screen-sizes.spec.ts` sweeps 320×256 (the size WCAG 1.4.10 names for 400 %) to 2560×1440,
  640×400 (200 % of a 1280×800 window) and a 1280×400 window, in every view; it checks the
  page, the area that holds the view and the reach of every top-bar control. It does not check
  that no content inside the calendar is clipped.
- _NFR-1 data:_ the demo has 9 calendars. Opening it with `?demo-load=busy` adds 8 more (17 in
  all) and a busy day of 11 added entries (`app/data/mock-busy.ts`, read by `useMockData`, so only
  where mock data is shown, never for a live calendar). `e2e/busy-day.spec.ts` checks the Split view
  with it: each calendar has a band, every entry is on screen, none covers another, no sideways
  page scroll, and a cut-off title opens in full in the entry sheet. At that density most titles
  of one-hour entries are cut off with an ellipsis in the Day span (an hour is about 60 px wide);
  the test does not judge that.

**Step 4 — Sidebar (FR-21)**

- Sections top → bottom: **views** (icon + `⋯` menu), **calendars** (visibility
  toggle), **resources** (visibility toggle), **categories** (add control),
  **filters** (add control + chooser) — all from mock data.
- Build the drawer and menus with Nuxt UI (adopted; conditions in §9): install
  `@nuxt/ui` and Tailwind, wrap the app in `<UApp>`, and move the global element
  rules into `@layer base`. Replace the hand-rolled mobile drawer from Step 3 with
  `USlideover`.
- _Acceptance:_ every section renders with mock data; toggles/menus are
  interactive.

**Step 5 — Top bar (FR-22, FR-23, FR-24, FR-25)**

- **View-type switcher** (day, 5-day, week, month, year, split, list), **date
  navigation** (prev / today / next), **quick-add**, **overflow (`⋮`) menu**.
- Quick-add opens a form (title, calendar, start/end) and appends the event to
  the **in-memory mock store**, so the new event appears in the current view.
- The switcher exposes the current view (`aria-pressed` or a tablist); the
  overflow menu closes on Escape/outside click and returns focus to its trigger.
- On mobile, keep all controls reachable: the switcher scrolls horizontally and
  every control has a **≥ 44 px** tap target. Quick-add must be a visible button
  or FAB, never a long-press or hover action.
- _Acceptance:_ switching view type and navigating dates updates the main area;
  quick-add adds a visible event; overflow opens and closes by keyboard; all
  controls are keyboard-operable (touch-only verification is Step 8).

**Step 6 — Main area, standard views (FR-22)**

- Integrate **FullCalendar v7**; register the `daygrid`, `timegrid`, `list` and
  `interaction` plugins via their `@fullcalendar/vue3/*` subpaths; import
  `skeleton.css` plus a theme stylesheet. In the SPA, `<ClientOnly>` is not
  needed.
- Set `editable: false` and `selectable: false` in Phase 1. Event click/tap
  opens the event details/edit sheet; date click may open quick-add.
- Use the sizing options from §9 (`height`/`contentHeight`, `dayMaxEvents`,
  `dayNarrowWidth`, `eventMinHeight`, per-view overrides) so month and time-grid
  views stay legible on narrow screens.
- _Acceptance:_ day, 5-day, week, month, year and list render mock events;
  switching views preserves the selected date; **no console errors**; event click
  opens the sheet; nothing is editable by accident (no drag/resize handlers
  registered while `editable` is off).

**Step 7 — Split view (FR-6)**

- Implement the direction chosen in spike S2: **Premium resource views** with the
  calendars as rows, or the fallback of **one FullCalendar instance per
  calendar**, stacked vertically, with **synchronized date navigation**. Either
  way, **hide bands that are empty** for the current view.
- Give each band a **sticky calendar label** (name + colour) so bands stay
  identifiable while scrolling; share one date/view state and push it to every
  instance (fallback) instead of letting each band navigate independently.
- Keep the options consistent (`height`, `dayMaxEvents`, view overrides); avoid a
  nested page scroll.
- _Acceptance:_ every non-empty calendar in the selected view gets its own band;
  empty bands are hidden; prev/today/next and view switches stay synchronized
  across bands; 9 calendars remain scrollable without layout breakage on desktop
  and mobile.

**Step 8 — Mobile (FR-20)**

- Responsive layout (sidebar drawer, top bar from Step 5); the split view stacks
  bands vertically (the natural mobile layout).
- Touch model: **tap** opens the event sheet; **long-press** is only a
  supplementary shortcut (default 1000 ms), never the only path. Provide visible
  Edit/Delete actions in the sheet, and keep drag/resize disabled until Phase 2.
- Tune FullCalendar for narrow widths (`dayMaxEvents`, `dayNarrowWidth`,
  `eventMinWidth`, `eventMinHeight`, `eventShortHeight`, `slotMinWidth`,
  `aspectRatio`) and verify both portrait and landscape.
- _Acceptance:_ on 360×640 and 640×360 touch viewports, every user-facing Phase 1
  task is doable **with touch only**: switch views, navigate dates, open the
  sidebar, quick-add an event, open an event sheet. No horizontal page scroll,
  no hover-only action, tap targets ≥ 44 px, and the split view remains readable.

**Step 9 — Polish / review**

- Review the mock-up against **FR-21…FR-25, FR-6, FR-20**; polish styling and
  spacing. Check keyboard reachability, focus visibility, colour contrast,
  `aria` labels, and reduced-motion preferences.
- Re-check the §9 integration notes: subpath imports only, no direct
  `@fullcalendar/core`, theme CSS, no console errors.
- Record any new findings in this document and the README.
- _Acceptance:_ the mock-up matches the requirements; `npm run check`,
  `npm test` and `npm run build` pass in the Dev Container; the responsive
  matrix (360×640, 640×360, 768×1024, 1280×800) and keyboard/touch paths are
  verified;
  `npm audit` output is unchanged or explained.

**Definition of done (Phase 1)** — a single Docker container runs a Nuxt 4 SPA
that shows the full sidebar (views/calendars/resources/categories/filters), the
top bar (view-type switcher, date nav, quick-add, overflow), every standard view
plus the split view (with empty-band hiding), all from mock data and with only
placeholder OIDC/CalDAV configuration. Quick-add creates an in-memory event,
events open the event details/edit sheet, and every user-facing Phase 1 task is
usable with touch only on 360×640 portrait and 640×360 landscape viewports.
