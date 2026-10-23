# Web Calendar — Requirements

> Status: **Draft v1.2** — for review and iteration.
> The open questions in §8 have been resolved; see the recorded decisions there.

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

| Persona | Who | Primary goal |
|---|---|---|
| **Team member** | One of 30–50 org members | See the events from the calendars *they* want to see, optionally grouped by pre-defined views; coordinate |
| **Team admin** | Someone who manages calendars & access | Define views; configure who can see which calendars; manage resources |
| **Public viewer** *(planned)* | Anyone outside the org | Browse published events in a read-only view |

---

## 3. Scope

### In scope
- **Views** — templates for a **group of calendars** that filter which
  calendars are shown; **both user-defined and admin-defined**
- **Multiple view types** (day / 5-day / week / month / year / **split** /
  list) to keep busy days readable
- Calendar sources via **iCal** and **CalDAV**
- **OIDC** authentication
- **Access control** at every granularity (per-user, per-team, per-role,
  per-calendar, and public / not-logged-in)
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
- Native mobile apps
- Being part of a larger groupware suite (the opposite is a goal — see C-5)

---

## 4. Functional Requirements

### 4.1 Views *(core UX)*
A **view** is a **template for a group of calendars** — it filters **which**
calendars are shown. It is independent of the *view type* (how they are laid
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
- **FR-8** Users can **connect a CalDAV account** to sync their calendar(s).
- **FR-9** *(nice to have)* CalDAV sync is **two-way** — users can create/edit
  events that write back to the CalDAV server.
- **FR-10** The system **refreshes / re-syncs** connected sources on a schedule
  or on demand.
- **FR-11** Calendars are **user-defined and flexible** — the system does **not
  force special calendar types** (e.g. holidays and birthdays are ordinary,
  optional calendars — not forced categories).

### 4.3 Authentication
- **FR-12** Users authenticate via **OIDC** against an existing identity provider.
- **FR-13** The system maps an authenticated identity to a user account and their
  accessible calendars.

### 4.4 Access control
- **FR-14** Access control supports **all** of these granularity levels:
  **per-user, per-team, per-role, per-calendar**, and **public / not-logged-in**
  visibility.
- **FR-15** The system **enforces** the configured access control so users only
  see what they're permitted to see.

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

### 4.8 Public publishing *(planned)*
- **FR-26** *(planned)* A dedicated **public publishing** experience — a public
  URL/view for an external audience to browse published events (builds on the
  public visibility level in FR-14).
- **FR-27** *(planned)* The public view is **accessible without organization
  authentication**.

---

## 5. Non-functional Requirements

- **NFR-1 (Readability — primary)** At **10–20 calendars** with varying entries
  per month, a busy day with **~10 entries** must remain **readable**. The
  **Split view** (each calendar in its own band) is the primary mechanism for
  this. Performance is a secondary concern.
- **NFR-2 (Security)** OIDC authentication; strict per-user / per-team isolation
  of calendar data; no cross-tenant data leakage.
- **NFR-3 (Accessibility)** The web UI meets **WCAG 2.1 AA**.
- **NFR-4 (Reliability)** Defined availability target and graceful degradation
  when an external source (iCal/CalDAV) is unreachable.
- **NFR-5 (Standards compliance)** iCalendar (**RFC 5545**), CalDAV
  (**RFC 4791**), and OpenID Connect.
- **NFR-6 (Portability)** Because sources are iCal/CalDAV, user data is not
  locked into a proprietary format.

---

## 6. Constraints & Assumptions

- **C-1** Must integrate with **iCal**, **CalDAV**, and **OIDC**.
- **C-2** **Must be self-hosted.**
- **C-3** Technology stack is **free to choose**.
- **C-4** Should use an **existing CalDAV backend** (e.g. Radicale) rather than
  implementing CalDAV from scratch — the app acts as a **CalDAV client**. A
  backend that **supports OIDC** is preferable, as it simplifies the
  authentication workflow.
- **C-5** Must be **standalone** — not part of a larger groupware suite (a key
  differentiator from GroupOffice).
- **A-1** An existing OIDC identity provider is available.
- **A-2** Team members already have calendars in iCal/CalDAV form to connect.
- **A-3** **GroupOffice** is the current tool being replaced; its features and
  left sidebar are a liked baseline to study.

---

## 7. Delivery phasing

The work is delivered in three phases (all requirements are in scope; this is
the **order** of delivery):

| Phase | Focus | Key requirements |
|---|---|---|
| **1 — UI shell / mock-up** | The webpage and a **mock-up of all UI** (all screens, sidebar with views at the top, view types incl. **split**) | FR-21…FR-25, FR-6, FR-20 |
| **2 — Core calendar + auth** | Calendar features and authentication | FR-7…FR-13, FR-3…FR-5, FR-20 |
| **3 — Organizational** | Grouping / views (templates for calendar groups), resources | FR-1…FR-2, FR-14…FR-19 |

---

## 8. Decisions (formerly Open Questions)

- **Q11 — CalDAV backend choice.** *Deferred.* The specific backend is not
  decided yet; we **assume a suiting backend has been found**. C-4 still holds —
  use an **existing CalDAV backend** (OIDC support preferred) rather than
  implementing CalDAV from scratch. The concrete choice is left to design.
- **Q12 — Resources model.** *Resolved — hybrid.* A resource **is its own
  calendar** (it can hold events that book it for a time range) **and** must be
  **easily referenced by events in other calendars**. **ACL:** a resource
  calendar shows **full details only to users with access to the calendar that
  booked the event**; otherwise the booking shows as a **"blocked"** (free/busy)
  entry. (Captured in FR-16 and FR-18.)
- **Q13 — Split view scope.** *Resolved.* **Every** calendar in the selected view
  gets its **own band**; a band that is **empty for the current view** may be
  **hidden** to save space. Extending the split view to **all** view types is a
  **planned experiment** (post-initial-release), **not** a requirement. (Captured
  in FR-6 and the Planned section.)
