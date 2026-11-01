# Phase 3 notes

Working notes of the Phase 3 tasks, one file per task. Their content is folded into
[`design.md`](../design.md) (§5, §8, §11, §12), [`security-review.md`](../security-review.md) (§7)
and the [README](../../README.md). The tests named here were written per task and run at integration on 2026-11-01 (unit and e2e
suites pass; failures found then are fixed); the notes still describe each task as it was handed in.

- [`audit-log.md`](audit-log.md) — the `audit_log` table, redaction, and `defineAdminHandler` with its rate limit.
- [`schema-rework.md`](schema-rework.md) — migration 006: access rules, resources, resource ACL, bookings, and their DB modules.
- [`s5-spike.md`](s5-spike.md) — the S5 follow-ups: `f` on map shares, and measurements with up to 2000 shares.
- [`group-sync.md`](group-sync.md) — the Kanidm to `htgroup` sync, SPN to `sub` mapping, alarms and audit actions.
- [`admin-views.md`](admin-views.md) — shared views (FR-2): admin routes and sidebar controls.
- [`sharing-writer.md`](sharing-writer.md) — `calendar_acl` to Radicale map shares, gateway pre-check, nightly audit job, block store.
- [`access-ui.md`](access-ui.md) — access administration (FR-14/15): API, the `/admin/access` page and its decisions.
- [`resources-core.md`](resources-core.md) — resources part 1: entities, bookings, availability blocks (server side).
- [`resources-availability.md`](resources-availability.md) — resources part 2, server: availability, manager queue and updates routes.
- [`resources-ui.md`](resources-ui.md) — resources part 2, client: availability display, booking flow, requests page, update toast.
- [`booking-reconcile.md`](booking-reconcile.md) — resources part 3: reconcile of moved or deleted events, `booking_sync`.
- [`sharing-verify.md`](sharing-verify.md) — the sharing writer's Radicale assumptions checked against Radicale 3.9.0.

This folder is working material. The project owner may delete it once the docs are merged.
