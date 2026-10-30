# Web Calendar — Requirements

> Status: **Draft v1.4** — for review and iteration.
> Q11–Q13 were resolved in v1.2. Q14–Q18 (access control, data freshness, recurrence and
> time zone, third-party access, authentication model) were recorded on 2026-10-29 after
> spike S1; v1.4 supersedes v1.3's "access control delegated to an external backend". See §8.

---

## 1. Vision

A **standalone**, **self-hosted**, web-based calendar for **teams and
organizations** (30–50 users) whose defining strength is **aggregating entries
from multiple calendars into a single, unified view — done really well**.

It replaces **GroupOffice calendar**, which is too tightly coupled to the
GroupOffice suite (not standalone), is poor on mobile, and forces special
calendars (holidays, birthdays). The new tool keeps the parts of GroupOffice
that are liked — its feature set and **left sidebar** — as a baseline.

Publishing events to a **public audience** is a planned feature, but is **not**
part of the initial release.

---

## 2. Users & Personas

| Persona                       | Who                                   | Primary goal                                                                                              |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Team member**               | One of 30–50 org members              | See the events from the calendars _they_ want to see, optionally grouped by pre-defined views; coordinate |
| **Team admin**                | Someone who manages views & resources | Define admin views; manage resources and who may access which calendar                                    |
| **Public viewer** _(planned)_ | Anyone outside the org                | Browse published events in a read-only view                                                               |

---

## 3. Scope

### In scope

- **Views** — templates for a **group of calendars** that filter which
  calendars are shown; **both user-defined and admin-defined**
- **Multiple view types** (day / 5-day / week / month / year / **split** /
  list) to keep busy days readable
- A **built-in CalDAV calendar service** (Radicale, part of the app's stack) and
  **external CalDAV accounts** the user adds (any CalDAV URL, with OIDC, basic or
  no authentication), plus **iCal** URL subscriptions
- **CalDAV access for third-party clients** (Thunderbird, phones) to the built-in
  calendars, with the same access rules
- **OIDC** authentication
- **Access control** at every granularity (per-user, per-team, per-role,
  per-calendar), administered in the app and **enforced by the CalDAV backend**;
  public / not-logged-in access is limited to the planned public view
- **Recurring events** and a single, configured **organization time zone**
- **Resources** — bookable entities (rooms, cars, …) not owned by a single
  calendar, that events can block
- **Mobile-friendly** UI
- **Left sidebar** listing views, calendars, resources, categories and filters
  (carried over from GroupOffice)

### Nice to have

- **Two-way CalDAV** — create/edit events that write back to the CalDAV server
  (can slip past the initial release)

### Planned (post-initial-release)

- **Public / event publishing** — a dedicated public URL/view for an external
  audience to browse published events (builds on the public visibility level in
  access control)
- **Split view across all view types** — extending the split view (FR-6) to
  work with **every** view type (day/week/month/…) is an **experiment to plan
  for after the initial release**, not a requirement; only if a nice design
  emerges.

### Out of scope (for now)

- Full Google Calendar / Outlook feature parity
- Per-user or multiple time zones
- Native mobile apps
- Being part of a larger groupware suite (the opposite is a goal — see C-5)

---

## 4. Functional Requirements

### 4.1 Views _(core UX)_

A **view** is a **template for a group of calendars** — it filters **which**
calendars are shown. It is independent of the _view type_ (how they are laid
out). Views appear at the **top of the sidebar**.

- **FR-1** A **view** is a named **template for a group of calendars** that
  defines which calendars are **shown/hidden**.
- **FR-2** Views can be created by **both users and admins** (user-defined and
  admin-defined).
- **FR-3** Selecting a view **filters which calendars are shown** in the main
  area.
- **FR-4** Within a view, each calendar is **visually distinguishable** (color,
  label).
- **FR-5** Users can **filter** within a view (show/hide individual calendars).
- **FR-6** The **Split view** shows **every** calendar in the selected view in
  its **own horizontal band/row** (stacked), so multiple calendars are displayed
  **without overlapping** — the primary mechanism for readability with many
  calendars. A band that is **empty for the current view** may be **hidden** to
  save space.

### 4.2 Calendar sources

- **FR-7** Users can **import a calendar from an iCal (`.ics`) URL or file**.
- **FR-8** Users see the calendars of the **built-in calendar service** they have
  access to without any account setup, and can **add external CalDAV accounts**
  (a CalDAV URL plus an authentication mode: basic or none; OIDC later). Credentials
  and tokens for external accounts are kept in the user's browser and are **never
  stored on the server**. Browsers cannot call arbitrary CalDAV servers (CORS), so
  the app's server forwards each request without keeping anything (decided
  2026-10-30; design §6, §7). The credentials of an account are sent only to that
  account's origin, and administrators cannot reference external accounts in shared
  views.
- **FR-9** _(nice to have)_ CalDAV sync is **two-way** — users can create/edit
  events that write back to the CalDAV server.
- **FR-10** Calendar data is **fetched live** for the visible date range and cached
  only briefly; users can **refresh on demand**. There is no background sync.
- **FR-11** Calendars are **user-defined and flexible** — the system does **not
  force special calendar types** (e.g. holidays and birthdays are ordinary,
  optional calendars — not forced categories).

### 4.3 Authentication

- **FR-12** Users authenticate via **OIDC** against an existing identity provider.
- **FR-13** The system maps an authenticated identity to an app user (for views,
  categories, filters, preferences and access rules). The app holds **no
  long-lived user tokens on the server**: it checks the token sent with each
  request and stores none.

### 4.4 Access control

- **FR-14** Access control supports **all** of these granularity levels:
  **per-user, per-team, per-role, per-calendar**, and **public / not-logged-in**
  visibility. Admins manage who may access which calendar **in the app**; the app
  turns those rules into the CalDAV backend's own access rules.
- **FR-15** The **CalDAV backend enforces** the rules, for every client (the web
  app and third-party clients alike), so users only see what they're permitted to
  see. Views that reference inaccessible calendars omit them.
- **Public / not-logged-in** visibility exists only through the planned public
  view (FR-26/27), which publishes an explicit list of calendars.

### 4.5 Resources

- **FR-16** **Resources** are first-class entities (e.g. physical locations,
  cars, or other bookable things). A resource **is its own calendar** — it can
  hold events that book it for a time range — yet it is **not owned by a single
  calendar** and must be **easily referenced by events in other calendars**.
- **FR-17** An event from a calendar can **block / reserve** a resource, marking
  it unavailable for the event's time range.
- **FR-18** Resources can be viewed for **availability** (free/busy) across the
  calendar. A resource calendar shows **full event details only to users who
  have access to the calendar that booked the event**; to everyone else the
  booking appears as a **"blocked"** (free/busy-only) entry with no details.
- **FR-19** Bookings of a resource can be **accepted or declined** (per
  GroupOffice).

### 4.6 Mobile usability

- **FR-20** The UI is **usable on mobile devices** (a key differentiator from
  GroupOffice, which is poor on mobile).

### 4.7 UI baseline (GroupOffice)

The GroupOffice calendar UI is a liked baseline. The new UI should provide, at
minimum:

- **FR-21** A **left sidebar** with, from top to bottom: **views** (each with an
  icon and a `⋯` menu), **calendars** (each with a visibility toggle),
  **resources** (each with a visibility toggle), **categories** (with an add
  control), and **filters** (with an add control and a chooser).
- **FR-22** A **view-type switcher** offering at least **day, 5-day, week,
  month, year, split, and list** views.
- **FR-23** **Date navigation** — previous, **today**, and next.
- **FR-24** A **quick-add** control to create an event.
- **FR-25** An **overflow (`⋮`) menu** for additional options.

### 4.8 Events

- **FR-28** **Recurring events** (repeat rules, exceptions, cancelled instances)
  display correctly in every view type.
- **FR-29** There is one configured **organization time zone**: a deployment setting
  (`TZ`, an IANA name, default `Europe/Berlin`), never hard-coded. It is the reference:
  floating times (no zone) are read in it, it is the fallback display zone, and the app
  shows it as "organization time" next to the viewer's time. The web client reads it
  from the app (`/api/config`). For CalDAV clients, calendars the app creates will carry
  it as a `calendar-timezone` hint (planned; Radicale stores it but ignores it, and
  most clients ignore it).
- **FR-32** Each user sees times in **their own time zone**: the browser's, by default.
  A timed event moves to the viewer's zone (a 09:00 Berlin meeting is 19:00 for someone
  in Sydney, on the right day); **all-day events stay on their dates**. A per-user
  setting that overrides the browser's zone is planned. Standard CalDAV clients convert
  on their own, as the data carries each event's zone.

### 4.9 Third-party CalDAV access

- **FR-30** The built-in calendars are reachable by **standard CalDAV clients**
  (Thunderbird, phone apps) at a **CalDAV URL on the app's own host**, with
  discovery through `/.well-known/caldav`. Clients that support OIDC may use it;
  others sign in with a username and an **app token**.
- **FR-31** Users **create, list and revoke app tokens** in the app. A token is
  shown once, **expires after one year**, is limited to **10 per user**, and is
  stored only in hashed form. Tokens can be revoked individually and all at once, the
  list shows the last use, and the hashing key can be rotated without invalidating
  existing tokens.

### 4.10 Public publishing _(planned)_

- **FR-26** _(planned)_ A dedicated **public publishing** experience — a public
  URL/view for an external audience to browse published events (builds on the
  public visibility level in FR-14).
- **FR-27** _(planned)_ The public view is **accessible without organization
  authentication**. Published calendars are served through a dedicated unauthenticated
  endpoint with a property allow-list (never descriptions, attendees or attachments),
  random non-enumerable addresses, rate limiting and a short cache; publishing is an
  audited admin action.

---

## 5. Non-functional Requirements

- **NFR-1 (Readability — primary)** At **10–20 calendars** with varying entries
  per month, a busy day with **~10 entries** must remain **readable**. The
  **Split view** (each calendar in its own band) is the primary mechanism for
  this. Performance is a secondary concern.
- **NFR-2 (Security)** OIDC authentication; strict per-user / per-team isolation
  of calendar data, enforced by the CalDAV backend; no cross-tenant data leakage.
  The CalDAV backend is reachable **only** through the app's authenticating
  endpoint. Bearer tokens are **verified locally** against the identity provider's
  published signing keys, restricted to an allow-list of clients and a required
  scope, and never stored. A revoked bearer token works until it expires (up to 15
  minutes); app tokens are hashed, expire and are revoked immediately. In the
  browser, tokens live in memory only. Every response of the app carries a
  `Content-Security-Policy` (`script-src 'self'`, `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri 'none'`), `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`, verified by an automated browser test of every
  view. Authentication failures are rate-limited per client and per user name, and a
  correct credential is never refused because of someone else's failures.
  Administrative rights are decided per request from the identity provider's group
  membership, never from a stored copy; administrative actions and every change to
  access rules are written to an audit log with actor, time and target. The CalDAV
  backend's identity header is set by at most three named components (the gateway, the
  sharing writer, the public endpoint), each with its own tests, and the backend is
  reachable from nothing else. _(Security review 2026-10-30, `docs/security-review.md`.)_
- **NFR-3 (Accessibility)** The web UI meets **WCAG 2.1 AA**.
- **NFR-4 (Reliability)** Defined availability target and graceful degradation
  when an external source (iCal/CalDAV) is unreachable: that calendar shows an
  error with a retry while the others keep working. **No stale data is served**:
  the app keeps no copy of calendar data beyond 30 s in the browser's memory. (The
  planned public view, FR-26/27, may serve data up to 60 s old: the one exception.)
- **NFR-5 (Standards compliance)** iCalendar (**RFC 5545**), CalDAV
  (**RFC 4791**), and OpenID Connect.
- **NFR-6 (Portability)** Because sources are iCal/CalDAV, user data is not
  locked into a proprietary format.
- **NFR-7 (Operability and secure defaults)** The server refuses to start with an
  invalid or missing security setting; a settings error is never discovered at the first
  request. All security settings are listed in `.env.example` with their defaults, and
  the container's health check exercises the token verifier.

---

## 6. Constraints & Assumptions

- **C-1** Must integrate with **iCal**, **CalDAV**, and **OIDC**.
- **C-2** **Must be self-hosted.**
- **C-3** Technology stack is **free to choose**.
- **C-4** Should use an **existing CalDAV backend** (Radicale, bundled in the
  app's stack) rather than implementing CalDAV from scratch. The app acts as a
  **CalDAV client** and as the **authenticating gateway** in front of the backend,
  because no available backend verifies Kanidm tokens from arbitrary clients
  (spike S1).
- **C-5** Must be **standalone** — not part of a larger groupware suite (a key
  differentiator from GroupOffice).
- **C-6** The **CalDAV backend is the source of truth** for calendars and events.
  The app is the source of truth for **who may access which calendar** and stores
  app-level data: views, categories, filters, iCal subscriptions, resource
  metadata, access rules, app tokens and preferences. It keeps no copy of events.
- **A-1** An existing OIDC identity provider is available.
- **A-2** Team members already have calendars in iCal/CalDAV form to connect.
- **A-3** **GroupOffice** is the current tool being replaced; its features and
  left sidebar are a liked baseline to study.
- **A-4** The identity provider (Kanidm) publishes each OAuth2 client's signing keys
  and accepts a custom scope, so the app's server can verify tokens from an
  allow-list of its clients locally. **Verified** in spikes S1 and S6.

---

## 7. Delivery phasing

The work is delivered in three phases (all requirements are in scope; this is
the **order** of delivery):

| Phase                        | Focus                                                                                                            | Key requirements                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **1 — UI shell / mock-up**   | The webpage and a **mock-up of all UI** (all screens, sidebar with views at the top, view types incl. **split**) | FR-21…FR-25, FR-6, FR-20                                        |
| **2 — Core calendar + auth** | Calendar features, authentication, the CalDAV gateway (owner-only access), recurring events                      | FR-7…FR-13, FR-30, FR-31, FR-3…FR-5, FR-20, FR-28, FR-29, FR-32 |
| **3 — Organizational**       | Grouping / views (templates for calendar groups), resources                                                      | FR-1…FR-2, FR-14…FR-19                                          |

---

## 8. Decisions (formerly Open Questions)

- **Q11 — CalDAV backend choice.** _Deferred._ The specific backend is not
  decided yet; we **assume a suiting backend has been found**. C-4 still holds —
  use an **existing CalDAV backend** (OIDC support preferred) rather than
  implementing CalDAV from scratch. The concrete choice is left to design.
- **Q12 — Resources model.** _Resolved — hybrid._ A resource **is its own
  calendar** (it can hold events that book it for a time range) **and** must be
  **easily referenced by events in other calendars**. **ACL:** a resource
  calendar shows **full details only to users with access to the calendar that
  booked the event**; otherwise the booking shows as a **"blocked"** (free/busy)
  entry. (Captured in FR-16 and FR-18.)
- **Q13 — Split view scope.** _Resolved._ **Every** calendar in the selected view
  gets its **own band**; a band that is **empty for the current view** may be
  **hidden** to save space. Extending the split view to **all** view types is a
  **planned experiment** (post-initial-release), **not** a requirement. (Captured
  in FR-6 and the Planned section.)
- **Q14 — Access control source.** _Resolved (revised after spike S1)._ v1.3
  delegated access control to an external backend (OpenCloud/Radicale) called with
  the user's own token. S1 showed that OpenCloud accepts tokens from one Kanidm
  client only, and Radicale itself has no groups or sharing UI. Now: admins manage
  access **in the app**, the app maintains the CalDAV backend's shares and group
  files, and **the backend enforces them** for all clients. (Captured in FR-14,
  FR-15, C-6.) Radicale's mechanics were verified in spike S5: its rights file is
  static, while group files and sharing take effect immediately.
- **Q15 — Data freshness.** _Resolved._ Calendar data is fetched **live** for the
  visible range, with a 30 s in-memory cache in the browser and no stale fallback.
  No background sync, so no stored credentials or offline tokens. (Captured in
  FR-10 and NFR-4.)
- **Q16 — Recurrence and time zones.** _Resolved._ Recurring events are common;
  the organization works in **one time zone**; users elsewhere see times in their own
  zone (2026-10-30). (Captured in FR-28, FR-29 and FR-32.)
- **Q17 — Third-party CalDAV clients.** _Resolved._ Thunderbird and phones must
  be able to use the built-in calendars with the same access rules. This rules out
  keeping all calendars under one service account with app-side filtering.
  (Captured in FR-30 and FR-31.)
- **Q18 — Authentication model.** _Resolved._ The app has its own Kanidm client
  for logging in; tokens stay in the browser; the app's server **verifies each token
  locally against an allow-list of clients** and stores none. Third-party
  clients use **app tokens**. External CalDAV accounts authenticate per account with
  credentials kept in the browser and passed through the app's server per request. A shared client with OpenCloud is not needed. (Captured in
  FR-8, FR-12, FR-13, FR-30, FR-31, NFR-2, A-4.)
- **Q19 — Operating defaults.** _Resolved 2026-10-29._ Organization time zone
  `Europe/Berlin` by default, set with `TZ`; viewers see their own zone (FR-32). Editing a recurring event **asks every time** (this instance,
  this and following, or the whole series, with "this instance" preselected). App
  tokens last **1 year**, at most **10 per user**. An outage shows an **error**, never
  stale data. Group membership for Radicale is synced from Kanidm every **60 s**
  (a service account with a read-only API token: design §12, S9). Real-client tests: Thunderbird,
  DAVx5 (Android) and iOS/macOS Calendar.
- **Open — Public view credentials.** How the planned public view reads published
  calendars without a logged-in user (likely a service credential limited to an
  explicit published list) is decided when that feature is scheduled.
