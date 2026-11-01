# Admin views (FR-2)

## Built

- `server/api/admin/views/index.post.ts`, `[id].put.ts`, `[id].delete.ts` (`defineAdminHandler`). Audit actions
  `admin_view.created|updated|deleted`, target = view id, details `{ name }`.
- `server/db/views.ts`: `createAdminView` (limit `MAX_ADMIN_VIEWS` 100, 409), `updateAdminView`, `deleteAdminView`
  (all `WHERE is_admin = 1`, owner NULL). User functions keep `is_admin = 0`, so user routes answer 404 for a shared view.
- `server/utils/api/views.ts`: `parseViewInput(body, { allowExternal })`; admin routes pass `false` and reject `ext:` refs
  per field (`calendars[i].ref`). `readCalendarRef` (validation.ts, not owned) is unchanged; the check sits after it.
- Refs are shape-checked only; no calendar is looked up (Radicale answers 403 for what a viewer cannot read).
- UI: `SidebarContent` (add input "Add shared view" from `visibleCalendarIds`, rename/delete dialogs),
  `SidebarViewItem` (Shared badge, actions Rename / Update from selection / Delete for admins; none for others),
  `AdminViewRenameModal.vue`, `SidebarAddInput` (async submit), `app/utils/live/admin-views.ts` (requests, wording).
- Admin flag: live mode reads `/api/me` again in `SidebarContent` (the loader drops `isAdmin`). Without a server
  (demo and component tests) the controls show and change the local list only.

## Needs integration

- Optional: loader could keep `me.isAdmin` in state so the extra `/api/me` call goes away.
- design.md §8/§12: shared views are managed via `/api/admin/views`, `ext:` refs refused there; security-review 7.3:
  audit actions above, server enforces, UI hiding is cosmetic. README: mention shared views.

## Tests (run at integration, pass)

`tests/server/admin-views.test.ts`, `tests/admin-views.test.ts`, `e2e/admin-views.spec.ts`.

## Risks

- Existing refs of other users' calendars in a shared view are not checked; they just show nothing.
- Demo: the mock user acts as admin; changes are lost on reload.
- Unrun tests: dropdown menu roles in e2e, and `input` event handling in the component test, may need a tweak.
