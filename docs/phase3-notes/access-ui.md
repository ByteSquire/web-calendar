# Access administration (FR-14/15)

## Built

- API (all `defineAdminHandler`, so admin check, 60/min limit): `GET /api/admin/access/calendars`
  (calendars with rules, `applied`, `groupsAvailable`), `PUT /api/admin/access/calendars/:id`
  (`{ rules: [{ principalType, principal, permission }] }`, one `replaceCalendarAcl` transaction),
  `GET /api/admin/access/users` (sub, name, username only).
- `server/utils/access/`: `ports.ts` (`AccessPorts`, `setAccessPorts`, `getAccessPorts`), `config.ts`
  (token + Kanidm origin from runtime config), `groups.ts` (group lookup via the group-sync client),
  `rules.ts` (parsing and principal checks), `service.ts` (views, `applyRules`).
- UI: `app/pages/admin/access.vue`, `app/components/admin/AccessRuleList.vue`, `AccessAddForm.vue`,
  `app/utils/admin/access.ts`, `app/composables/useAdminAccess.ts`; menu entry "Calendar access" in
  `OverflowMenu.vue` (live mode, admins only).

## Decisions

- Types offered: person, group, everyone signed in. `public` is refused (FR-27: public visibility is the
  public view). Permissions offered: `free_busy`, `read`, `write`; `admin` is refused (never reaches Radicale).
- A user principal must be a lower-case UUID that exists in `users.oidc_sub` (case folded to lower). The
  owner gets no rule (400). A group must match `isGroupName` and exist in Kanidm (`GET /v1/group/<name>`
  with the sync token; `null` answer = "not a Kanidm group"). No token: every group rule is refused with
  "the Kanidm sync token is not configured". Kanidm down: 409 `group_check_unavailable`, nothing stored.
- Only principals NEW to the calendar are checked, so an old rule never blocks editing another one.
- An unchanged PUT writes no audit row and does not call the port. Audit: `acl.replaced`, target
  `calendar:<id>`, details `{before, after, added, removed, principalTypes}` (no principals, no tokens).
- Admin flag in the browser: `useState('admin-flag')` filled from `/api/me` (`isAdmin`); non-admins are
  sent to `/` with `router.replace`. Display only. Demo mode: entry hidden; the page works only if
  `/api/me` answers `isAdmin` (e2e mocks it), otherwise it redirects.
- (c) Sidebar, views and split view: the loader only creates calendars Radicale lists, `calendarIdsForView`
  drops refs not in `calendars`, `visibleEvents` and `buildSplitBands` filter by visible ids. No gap found;
  pinned by `tests/admin-access-visibility.test.ts`. Residual: the state holds whatever the loader gives it,
  so correctness rests on Radicale not listing/403-ing (FR-15).

## Port wiring (integration)

```ts
// e.g. server/plugins/sharing.ts, once the sharing writer exists
import { setAccessPorts } from '../utils/access/ports'
import { requestSharingReconcile } from '../utils/sharing/active' // path of the other agent
setAccessPorts({ onAclChanged: () => requestSharingReconcile() })
```

The route catches a throwing port (warning), the rules stay saved.

## Doc changes needed

- design.md §8: admin page `/admin/access`, the routes above, "applied" shown from `applied_at`, groups
  validated against Kanidm with the sync token, `admin`/`public` not offered.
- README: add the admin page to the feature list / routes.
- security-review §7.1: principals validated at write time (user exists, group exists in Kanidm); §7.3:
  `acl.replaced` audit action, rule counts only.

## Tests (written, NOT run)

`tests/server/admin-access.test.ts`, `tests/admin-access-utils.test.ts`, `tests/admin-access-visibility.test.ts`,
`tests/admin-access-page.test.ts` (nuxt env), `tests/admin-access-menu.test.ts` (nuxt env),
`e2e/admin-access.spec.ts`. The existing menu tests needed no change (the entry shows only when the flag is true).

## Risks

- Component tests drive Nuxt UI radio groups by their labels and the group input by `autocapitalize`; a Nuxt UI
  markup difference could need a selector fix. The person picker (USelectMenu) is covered only by the utils.
- Two `/api/me` calls (loader and flag) per session; cheap, userinfo is cached a minute server side.
- A TOCTOU between group check and write is accepted (Kanidm group removed in between).
