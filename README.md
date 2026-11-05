# Web Calendar

Standalone, self-hosted web calendar for teams and organizations. See
[`docs/requirements.md`](docs/requirements.md) and [`docs/design.md`](docs/design.md).

## Container-only workflow

Node.js is **not** required on the host — everything (install, build, check,
run) happens inside Docker containers based on Node 24 LTS.

> Docker must be able to see this directory. It lives under the host home
> directory, so the Dev Container bind mount works.

### Dev Container (recommended for development)

The repository includes a standard Dev Container configuration in
`.devcontainer/`. It uses the official Node 24 devcontainer image, keeps
`node_modules` in a per-workspace named volume, and forwards port 3000. It
works with Dev Container-aware IDEs such as VS Code, Cursor, Zed, and DevPod.

1. Open this folder in your IDE's Dev Container mode. In VS Code, install the
   extension first:

   ```sh
   code --install-extension ms-vscode-remote.remote-containers
   ```

   Then run **Dev Containers: Reopen in Container** from the command palette.

2. In the integrated terminal, start the app:

   ```sh
   npm run dev
   ```

Open <http://localhost:3000> (forwarded automatically). No Node.js installation
is needed on the host. IDE terminals run as the unprivileged `node` user
(`containerUser` in `devcontainer.json`); when you use `docker exec` directly,
pass `-u node` so build artifacts do not end up root-owned. Dependencies are
installed during the image build and seeded into the `node_modules` volume, so
the container is usable even if your IDE does not run `postCreateCommand`.
After changing dependencies, run `npm ci` again in the container terminal.

### Build and checks

Run these in the Dev Container terminal:

```sh
npm run build      # nuxt build (production output)
npm run check      # fmt:check + lint + typecheck
npm test           # vitest run: Vitest suite
npm run lint       # eslint . (lint:fix applies autofixes)
npm run fmt        # prettier --write .
npm run typecheck  # nuxt typecheck
npm run test:e2e   # builds the app, then runs the Playwright browser tests (e2e/)
npm audit
npm run audit:prod        # npm audit --omit=dev, failing on any advisory not on the known list
npm run test:gateway:prod # builds into a temp dir, runs the gateway integration suites against it
npm run radicale:usage -- <collections dir>   # size and items per Radicale home (run on the host)
npm run backup -- <database file> <backup dir> # a consistent copy of the SQLite file (see Production)
```

Linting is ESLint through `@nuxt/eslint` (flat config in `eslint.config.mjs`).
Formatting is Prettier (`.prettierrc`: single quotes, no semicolons, 100 columns), and
`eslint-config-prettier` keeps the two from conflicting. Type checking is
`nuxt typecheck`, which needs `typescript` and `vue-tsc`; TypeScript is kept on 5.9
because `vue-tsc` support for TypeScript 7 is unverified. The code was last formatted
by Oxfmt (from the removed Vite+ toolchain), so the first `npm run fmt` may produce
small diffs.

### Browser tests

`e2e/` holds Playwright tests that run against the production build (`node .output/server/index.mjs`
on port 3100, started by `playwright.config.ts`) in Chromium and WebKit. The projects are the
responsive matrix: a phone in portrait and landscape (touch), a tablet, a desktop, a phone and a
desktop in dark mode, and a WebKit phone. The tests check that no view scrolls the page sideways or
logs errors, that the controls work by tap and keyboard, that focus returns after dialogs, the split
view's bands, and an axe scan (WCAG 2.1 A and AA) of every view and dialog. `npm run test:e2e` builds
first; `npx playwright test --project=phone` runs one project against the existing build, and
`npx playwright show-report` opens the last report.

The Dev Container image installs the browsers. In an older container run
`npx playwright install-deps chromium webkit` as root, then `npx playwright install chromium webkit`.
A few findings sit inside FullCalendar's own markup and are listed, with the reason, in
`e2e/a11y.spec.ts`; any other violation fails the test.

### Mock data (Phase 1)

`app/data/mock.ts` provides the views, calendars, resources, categories, filters
and events used by the UI mock-up. Domain types live in
`shared/types/calendar.ts`. `createMockData(anchor)` is deterministic; in
components, call `useMockData()`, which anchors the data once per request so SSR
and client renders match.

### FullCalendar, mobile and editing notes (Phase 1)

- **Mount client-only.** FullCalendar renders empty during SSR; wrap it in
  `<ClientOnly>` to avoid hydration mismatches. This stops mattering for app routes
  once the app is an SPA (planned, design §9); it still applies to any SSR route.
  Import `skeleton.css` plus a theme stylesheet, or the calendar is unstyled.
- **Interaction plugin.** `editable` and `selectable` default to `false`.
  Drag/resize and selection require `@fullcalendar/vue3/interaction`. Phase 1
  keeps them off and is **read-only plus quick-add**; drag/resize editing is
  deferred to Phase 2, where it must be backed by the real API.
- **Touch.** v7 uses pointer events with long-press (`longPressDelay`, default
  1000 ms; `eventLongPressDelay` / `selectLongPressDelay` override it).
  Long-press is not discoverable, so provide explicit buttons: tap an event to
  open the event details/edit sheet, and keep quick-add visible.
- **Sizing.** v7 resizes via `ResizeObserver`; `handleWindowResize` no longer
  exists. Use `height`/`contentHeight`, `aspectRatio`, `expandRows`,
  `dayMaxEvents`/`dayMaxEventRows`, `dayNarrowWidth`, `eventMinWidth`,
  `eventMinHeight`, `eventShortHeight`, `slotMinWidth` and per-view `views`
  overrides.
- **Mobile target.** Verify at 360×640 portrait and 640×360 landscape: no horizontal
  page scroll, tap targets ≥ 44 px, no hover-only actions, split view readable.
  Full details are in `docs/design.md` §9 and §13.

### Known issues / security status (as of 2026-11-01)

- `npm run audit:prod` allows three advisories, each with its reason in `scripts/audit-prod.mjs`:
  `glob`, `minimatch` and `deepmerge`. They sit in the build tools of Nuxt (nitropack,
  `@vercel/nft`, archiver), not in `.output/server`, and npm's own fix for them is a downgrade of
  Nuxt to 4.1.3. Do **not** run `npm audit fix --force`. `npm audit fix` without `--force` is safe;
  the `node-forge` advisories of October were cleared that way. Re-check on every Nuxt release.
- The project is on **Nuxt 4.6.3** (latest stable). Nuxt 5 is still in development
  and only available via the opt-in `future.compatibilityVersion: 5` flag from
  Nuxt 4.2+ — not recommended for this project yet. When Nuxt 5 reaches stable,
  upgrade and re-run `npm audit`.
- The container refuses to start without `NUXT_OIDC_ISSUER`, `NUXT_TOKEN_HASH_KEY` and
  `NUXT_RADICALE_URL` (`server/validate-config.mjs`), even though Phase 1 uses mock
  data. See [Environment](#environment).
- The design of 2026-10-29 is recorded in `docs/design.md` (v1.3). The deployment files
  (`docker-compose.yml`, `deploy/`, `.env.example`, `server/validate-config.mjs`) follow
  it. Built: the UI (sidebar, top bar, every view type incl. the split view, quick-add, event
  sheet; mock data in demo mode), the browser login (Kanidm, PKCE), live calendars from Radicale
  with recurrence and time zones (organization zone, the browser's, or a per-user setting),
  creating, editing and deleting events, a settings page (app tokens, preferences, iCal
  subscriptions, `.ics` file import, external CalDAV accounts), the token verifier and CalDAV
  gateway (`/caldav/`), and the security headers. Phase 3 is built; its unit and e2e tests pass, its migrations ran on a copy of the dev database,
  and the built app ran against the test stack's Kanidm and Radicale (the live e2e, and a booking
  and reconcile drive; not yet run: production, or a database with data): the audit log, access
  administration (`/admin/access`, menu entry "Calendar access", admins only), shared views managed
  by admins from the sidebar, the sharing writer, groups imported from the sign-in claim and the
  group file the app writes, groups with their own calendars (`/groups`, menu entry "Groups") and resources
  (bookings and availability blocks, availability reads, the booking form, the page
  `/resources/requests` for requests and "My bookings", the administrator page `/admin/resources`,
  and the reconcile of moved or deleted booking events). The app speaks English and German: the
  language of the browser, or Settings → Language (`docs/i18n.md` has the rules for adding texts).
  Not built yet: the public view. Spikes S1 to S6 and S8 to S10 are done; S7
  (real clients) is open (design §12). A test stack
  for the spikes is in `dev/spike-s1`.

### Dependency versions (as of 2026-10-24)

- Nuxt `^4.6.2`, Vue `^3.5.44`, vue-router `^5.4.0`, Node `^24.15.0`
  (Nuxt 4.6.2 requires `^22.22.3 || ^24.15.0 || >=26.0.0`)
- FullCalendar `7.1.3` (`@fullcalendar/vue3` and `@fullcalendar/vue3-scheduler`, same
  version, AGPLv3 licence key; see design §2) + `temporal-polyfill`.
  v7 moved the plugins into the framework package: import them from subpaths
  such as `@fullcalendar/vue3/daygrid`, `@fullcalendar/vue3/timegrid`,
  `@fullcalendar/vue3/list`, `@fullcalendar/vue3/interaction`,
  `@fullcalendar/vue3/multimonth`. `@fullcalendar/core` is a v7 stub and is **not** a direct
  dependency; standalone `@fullcalendar/*` plugin packages are v6-only.

### Production

`docker-compose.yml` runs two services (design §10); Kanidm is an existing external service.
To run it as a Cosmos ServApp instead, with Kanidm and Radicale optionally included, see
[`deploy/cosmos/`](deploy/cosmos/README.md).

- `web-calendar` is the app (Nuxt 4 / Nitro). It listens on `127.0.0.1:3000`, so put a
  reverse proxy with TLS in front. It runs as the unprivileged `node` user on a read-only
  file system, and keeps its SQLite file at `/data/web-calendar.db` on the
  `web-calendar-data` volume. [`deploy/reverse-proxy/`](deploy/reverse-proxy/README.md) has nginx
  and Caddy examples.
- `radicale` is the CalDAV store (`ghcr.io/kozea/radicale:3.9.0`). It has **no published
  port**: it trusts the `X-Remote-User` header, so only the app may reach it, on a Compose
  network that only these two services share (`internal: true`, so it has no route out
  either). Its configuration is [`deploy/radicale/config`](deploy/radicale/config)
  and its static, owner-only rules are [`deploy/radicale/rights`](deploy/radicale/rights),
  bind-mounted read-only. Calendars live on the `radicale-data` volume.
- Radicale's group file is in the `radicale-groups` volume. Radicale refuses to start
  without it, so the app creates an empty one at `/groups/htgroup` when it starts, and
  Radicale starts only after the app is healthy. Radicale mounts the volume read-only; the app
  writes the file itself, from its database, at start, two seconds after a change, when a person
  new to the file signs in, and every hour, and only when the content differs. It keeps the previous
  version as `htgroup.prev` and leaves the file as it was when a write fails. `NUXT_GROUPS_FILE`
  changes the path. The file lists the app's groups, the groups imported from the identity provider
  (below) and `web_calendar_users`, everyone who signed in within the last
  `NUXT_SIGNIN_WINDOW_DAYS` days. No service account or token at the identity provider is needed.
- **Sign-in window.** An app token (for Thunderbird, phones) works only while its owner has signed in
  within the last `NUXT_SIGNIN_WINDOW_DAYS` days (30 by default, 1 to 365). Signing in to the web app,
  or with an OIDC bearer token from a calendar app, renews it; using the app token does not. A token
  past the window is refused and works again after the owner signs in. This is the only thing that ends
  the app tokens of someone who left the identity provider: it can take up to the window after their
  last sign-in, and no administrator control shortens it. Imported and app groups are not bounded by
  the window.
- The sharing writer turns the access rules (`calendar_acl`) into Radicale map shares at start, after
  every access change and every `NUXT_SHARING_RECONCILE_INTERVAL_SEC` seconds. It talks to Radicale
  through its own internal client (never through `/caldav/`), removes any share the database does
  not know and records that in the audit log. If Radicale is unreachable it retries with backoff
  and leaves the rules unapplied. The gateway also checks from the database that a caller may touch
  a path. Shared calendars appear in a member's home as `shared-<id>`; do not name your own
  calendars like that.
- **Groups.** The page `/groups` (menu entry "Groups", for everybody signed in) lists the groups a
  person is in. Admins create groups there and choose their members. They can also import groups
  from the identity provider: at each sign-in the app reads the person's `groups` claim (the claim's
  name is `NUXT_OIDC_GROUPS_CLAIM`), and the groups it sees appear under "Groups from your identity
  provider", which only admins see, once one of their members has signed in. An admin imports the ones
  to use; an imported group is read-only and its members are added and removed as each person signs in,
  so it starts empty and its membership is as old as the last sign-in. A calendar app that signs in
  with an OIDC bearer token refreshes that in the background, at most every five minutes, if its token
  carries the groups scope. Groups named by `NUXT_OIDC_GROUPS_IGNORE` (Kanidm's built-in ones by
  default), the admin group and `web_calendar_users` are never offered; if the identity provider has a
  group named like one made in the app, the app's wins and the other cannot be imported. Which
  providers send what, and which key an imported group has (a rename at the provider only follows when
  the provider sends an id): [`docs/oidc-providers.md`](docs/oidc-providers.md). The built-in group
  `web_calendar_users` is everyone who signed in within the window; it can be shared with but owns no
  calendars and has no member list. Every member of a group creates, renames, recolours, deletes and
  shares the calendars the group owns, with people or other groups, to view or to edit; a group's
  calendar belongs to the group, so it stays when a member leaves. A group with calendars cannot be
  deleted, and the name of an app group cannot be changed. A member sees a
  new calendar or share within a few seconds. Members can share a calendar with anybody; every
  share is in the audit log. Design: `docs/design.md` §8 "Groups" and "Groups and group calendars".

Set up:

1. Create the groups and the OAuth2 client in Kanidm: [`docs/kanidm-setup.md`](docs/kanidm-setup.md)
   (another provider: [`docs/oidc-providers.md`](docs/oidc-providers.md)).
2. Copy `.env.example` to `.env`, set `NUXT_OIDC_ISSUER`, generate the token key
   (`openssl rand -base64 48`), and set `NUXT_OUTBOUND_ALLOWED_HOSTS` to the hosts your users may
   subscribe to or connect to (the container refuses to start with an empty list, unless you
   knowingly set `NUXT_OUTBOUND_ALLOW_ANY_HOST=true`).
3. Start the stack:

   ```sh
   docker compose up --build
   ```

Open <http://localhost:3000>. To change `deploy/radicale/rights` or `deploy/radicale/config`,
edit the file, then run `docker compose restart radicale`: Radicale reads both only at
startup.

Back up the two volumes `web-calendar-data` and `radicale-data`. Do not copy the SQLite file
itself while the app runs: it is in WAL mode, so committed data can still be in the `-wal` file.
[`scripts/backup-db.mjs`](scripts/backup-db.mjs) makes a consistent copy with `VACUUM INTO`,
checks it, and does not change the source. The runtime image has no scripts, so run it on the
host in a throwaway container (the header of the script has the exact command):

```sh
docker run --rm --user 1000:1000 -v web-calendar_web-calendar-data:/data \
  -v "$PWD/scripts:/scripts:ro" -v "$PWD/backups:/backups" \
  node:24-bookworm-slim node /scripts/backup-db.mjs /data/web-calendar.db /backups
```

`radicale-data` includes `sharing.csv`, which is authorization state, so back it up too. Keep the
token hash key apart from the backups, encrypt the backups, and after a restore let the sharing
writer reconcile (it does at start). For a restore, stop the app, replace `web-calendar.db` with
the copy (delete the old `-wal` and `-shm` files), and start it again.
Restoring into a new, empty volume (a new host, say): the volume's folder must belong to uid 1000
as well as the file (`docker run --rm --user 0 -v <volume>:/data node:24-bookworm-slim chown
1000:1000 /data`), or SQLite cannot create its `-wal` file and the app stops at start with
"attempt to write a readonly database". Tried on 2026-11-02: a backup made while the app ran, with
a view added just before, restored into a new volume; the app started on it and the view was there.

### Environment

Copy `.env.example` to `.env` next to `docker-compose.yml` (or export the variables).
Compose reads `.env` for interpolation and passes the values into the container;
`nuxt.config.ts` declares the matching `runtimeConfig` keys, so `useRuntimeConfig()` sees
them at runtime. `server/validate-config.mjs` checks the required ones when the container
starts and exits with a message if they are wrong. The defaults in the table repeat those
in `nuxt.config.ts`; an empty value in `.env` falls back to them.

| Variable                                | Required      | Default                              | Meaning                                                                                                                                                                                  |
| --------------------------------------- | ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_OIDC_ISSUER`                      | yes           |                                      | Issuer of the identity provider, an https URL exactly as its discovery document writes it. Kanidm: ends with the client id, `…/oauth2/openid/web-calendar`; Keycloak: `…/realms/<realm>` |
| `NUXT_TOKEN_HASH_KEY`                   | yes\*         |                                      | Key for hashing app tokens, at least 32 characters (\*not needed when `NUXT_TOKEN_HASH_KEYS` is set)                                                                                     |
| `NUXT_RADICALE_URL`                     | yes           | `http://radicale:5232`               | Internal URL of Radicale; set by the compose file                                                                                                                                        |
| `NUXT_OIDC_CLIENT_ID`                   | no            | `web-calendar`                       | The app's own public client; with Kanidm the issuer must end with it                                                                                                                     |
| `NUXT_OIDC_ALLOWED_CLIENTS`             | no            | empty (the client above)             | Further clients whose tokens the CalDAV gateway accepts, comma-separated (Kanidm: one issuer each; other providers: they share the issuer above)                                         |
| `NUXT_OIDC_SCOPE`                       | no            | `openid profile email groups caldav` | Scopes the browser asks for                                                                                                                                                              |
| `NUXT_OIDC_REQUIRED_SCOPE`              | no            | `caldav`                             | Scope every access token must carry, in `scope` or `scp`; ID tokens have none, which keeps them out                                                                                      |
| `NUXT_OIDC_AUDIENCE`                    | no            | empty                                | Further `aud` values that make an access token ours, comma-separated (the API identifier of Auth0 or Entra)                                                                              |
| `NUXT_OIDC_JWKS_HOSTS`                  | no            | empty (the issuer's host)            | Host names besides the issuer's own that the signing keys may be fetched from, comma-separated; the server warns at every start when it is set                                           |
| `NUXT_GROUPS_FILE`                      | no            | `/groups/htgroup`                    | Radicale's group file, written by the app from its database (`.data/htgroup` outside production). Replaces `NUXT_GROUP_SYNC_FILE`; the old `NUXT_GROUP_SYNC_*` are ignored               |
| `NUXT_SIGNIN_WINDOW_DAYS`               | no            | `30`                                 | Days after a person's last sign-in in which their app tokens work and they are in `web_calendar_users`, 1 to 365; a web or OIDC bearer sign-in renews it, an app token does not          |
| `NUXT_OIDC_GROUPS_CLAIM`                | no            | `groups`                             | The claim that lists a person's groups, in userinfo and the access token, as written (`cognito:groups` works). Groups are imported from it at sign-in                                    |
| `NUXT_OIDC_GROUPS_IGNORE`               | no            | `idm_*,system_*,domain_*`            | Groups never offered for import: names or `prefix*`, comma-separated, case ignored. The default hides Kanidm's built-in groups                                                           |
| `NUXT_SHARING_RECONCILE_INTERVAL_SEC`   | no            | `300`                                | Seconds between sharing reconciles (access rules to Radicale shares), at most `900`; an access change also triggers one                                                                  |
| `NUXT_SHARING_AUDIT_INTERVAL_HOURS`     | no            | `24`                                 | Hours between the consistency audits that list every home as each user and compare with the access rules (1 to 168)                                                                      |
| `NUXT_SHARING_SHARED_OWNERS`            | no            | empty                                | Service principals (`_team`, comma-separated) whose calendars are mirrored as shared calendars                                                                                           |
| `NUXT_RESOURCES_RECONCILE_INTERVAL_SEC` | no            | `300`                                | Seconds between checks of the events of bookings for moved or deleted events, at most `900`; the first check is 90 s after start                                                         |
| `NUXT_RESOURCES_MANAGER_CANCEL`         | no            | `true`                               | `false` stops a manager of a resource cancelling the bookings of others; the requester can always cancel their own                                                                       |
| `NUXT_GATEWAY_CORS_ORIGINS`             | no            | empty (no CORS)                      | Origins of external browser apps that may call `/caldav/`, comma-separated                                                                                                               |
| `NUXT_GATEWAY_TRUST_FORWARDED_FOR`      | no            | `false`                              | `true` behind a reverse proxy that appends to `X-Forwarded-For`: its last hop is the client address for the login throttle. Leave it off without a proxy                                 |
| `NUXT_OIDC_KEY_MAX_AGE_SEC`             | no            | `3600`                               | Age after which the cached signing keys are refetched in the background                                                                                                                  |
| `NUXT_GATEWAY_MAX_BODY_BYTES`           | no            | `10485760`                           | Largest request body the gateway forwards                                                                                                                                                |
| `NUXT_GATEWAY_MAX_CONCURRENT_PER_USER`  | no            | `8`                                  | Requests one signed-in user may have in flight at once through `/caldav/`; the next ones get `429` until one finishes                                                                    |
| `NUXT_OIDC_ADMIN_GROUP`                 | no            | `calendar_admins`                    | Group whose members are admins: its name, SPN, id or path as the provider writes it in the groups claim                                                                                  |
| `NUXT_ICAL_PROXY_CACHE_TTL_SEC`         | no            | `300`                                | Seconds an iCal subscription is served from the proxy's cache                                                                                                                            |
| `NUXT_ICAL_PROXY_MAX_BYTES`             | no            | `5242880`                            | Largest `.ics` file the proxy accepts                                                                                                                                                    |
| `NUXT_ICAL_PROXY_TIMEOUT_MS`            | no            | `10000`                              | Time allowed for fetching a subscription                                                                                                                                                 |
| `NUXT_TOKEN_HASH_KEYS`                  | no            | empty                                | Key list for rotation, `2:<new>,1:<old>`; the first entry hashes new tokens (design §6)                                                                                                  |
| `NUXT_OUTBOUND_ALLOWED_HOSTS`           | in production | empty                                | Comma-separated hosts (`name`, `*.suffix`) that iCal subscriptions and external accounts may reach. In production an empty list is refused unless the next variable is `true`            |
| `NUXT_OUTBOUND_ALLOW_ANY_HOST`          | no            | `false`                              | `true` lets the server contact any public host when no list is set; ignored when a list is set                                                                                           |
| `NUXT_EXTERNAL_SEAL_KEY`                | no            | empty                                | 64 hex characters or base64 of 32 bytes; without it external accounts with a login are off. Changing it voids every saved external password                                              |
| `NUXT_ICAL_PROXY_ALLOW_PRIVATE`         | no            | `false`                              | `true` lets subscriptions point at private addresses; tests only                                                                                                                         |
| `NUXT_DEMO`                             | no            | `false`                              | `true` skips the login and shows mock data; previews and browser tests only                                                                                                              |
| `NUXT_DB_PATH`                          | fixed         | `/data/web-calendar.db`              | SQLite file; set by the compose file                                                                                                                                                     |
| `TZ`                                    | no            | `Europe/Berlin`                      | Organization time zone, an IANA name (floating times, fallback and label); users see their browser's zone unless they chose another in Settings. Anything else stops the container       |

Production builds must run on the Docker host — the Dev Container does not
include a Docker CLI.

### Test stack (Kanidm and Radicale)

`dev/spike-s1` runs a throwaway Kanidm and a Radicale set up like the production one, to
develop and test the app against real services. It uses self-signed certificates, known
ports and throwaway passwords, and it is not part of the app.

```sh
cd dev/spike-s1
./spike.sh up          # creates test certificates, starts Kanidm and Radicale
./spike.sh bootstrap   # Kanidm users, groups and OAuth2 clients
./spike.sh token alice # a real access token for the test user alice
./spike.sh down        # stop; `./spike.sh reset` also deletes the data
```

Kanidm is then at `https://idm.localhost:8443` (issuer
`https://idm.localhost:8443/oauth2/openid/web-calendar`) and Radicale at
`http://127.0.0.1:5232`, published on the loopback interface only for development. See
[`dev/spike-s1/README.md`](dev/spike-s1/README.md) for the accounts, all commands and what
each spike tested.

`idm.localhost` is the loopback address of your own machine. Open the app from `http://localhost`
(the dev server and the live tests do). If the app is served from a public name instead, newer
Chrome, Edge, Brave and Firefox block the browser's calls to Kanidm (they show it as a CORS error)
until you allow "Apps on device" / "Device apps and services" for that site.

### Release checks (run on your machine)

The checks have no CI (design §12): a release is gated by this manual run on the maintainer's
machine, before the version tag is pushed ([Release image](#release-image)). Replace `intelligent_mayer` with the name of your Dev Container; `-w` is needed because
`docker exec` does not start in the workspace. The Dev Container has no Docker CLI, so the steps
that start or connect the test stack run on the **host**; everything else runs in the container.

1. In the container, in this order (`check` is `fmt:check`, `lint`, `typecheck` and
   `typecheck:e2e`; `test:e2e` builds the app first):

   ```sh
   docker exec -u node -w /workspaces/web-calendar intelligent_mayer npm run check
   docker exec -u node -w /workspaces/web-calendar intelligent_mayer npm test
   docker exec -u node -w /workspaces/web-calendar intelligent_mayer npm run test:e2e
   docker exec -u node -w /workspaces/web-calendar intelligent_mayer npm run audit:prod
   docker exec -u node -w /workspaces/web-calendar intelligent_mayer npm run test:gateway:prod
   ```

2. The live-login suite (`test:e2e:live`) uses the real Kanidm and Radicale of the
   [test stack](#test-stack-kanidm-and-radicale) and the build that `test:e2e` just made:

   ```sh
   # host, in dev/spike-s1 of the repo (needs docker, openssl, curl and python3)
   ./spike.sh up
   ./spike.sh bootstrap   # says "Already bootstrapped" and does nothing on later runs
   docker network connect spike-s1_default intelligent_mayer

   # container
   docker exec -u node -w /workspaces/web-calendar intelligent_mayer npm run test:e2e:live

   # host again
   docker network disconnect spike-s1_default intelligent_mayer
   ./spike.sh down        # or ./spike.sh reset: also deletes the data and dev/spike-s1/.local/
   ```

   The `network connect` lets the container resolve `idm.localhost` and `radicale`; if it says the
   container is already connected, carry on. The suite reads the test CA and the users' passwords
   from `dev/spike-s1/.local/`, which the container sees through the workspace mount. Disconnect
   before `down`: Docker does not remove a network while a container is still in it.

**Pass:** every command above exits 0, and `audit:prod` reports only the three known advisories
(`glob`, `minimatch` and `deepmerge`, see Known issues). Any other advisory makes it exit 1; exit 2
means the audit could not run, which is a fail too.

When GG Coder runs these checks it needs the maintainer's approval each time; it does not start a
full run on its own.

### Release image

[`.forgejo/workflows/release-image.yml`](.forgejo/workflows/release-image.yml) builds the image on
Codeberg's hosted Forgejo Actions runner and pushes it to `codeberg.org/<owner>/web-calendar`, the
image the [Cosmos ServApp](deploy/cosmos/README.md) installs. It runs the build only; the checks
above stay on your machine. To spare Codeberg's resources it uses the small runner in its lazy
variant, which starts the job when Codeberg has capacity to spare, at the latest within a day; for
an urgent release, change `runs-on` to `codeberg-small`.

Once:

1. Codeberg runs hosted jobs only for public repositories under a free license: make the
   repository public, then tick **Actions** under **Settings → Units**.
2. Create an access token under **Settings → Applications** (your user settings) with the scope
   `package` set to read and write, and nothing else. The automatic token of a workflow cannot
   push images. Store it as the repository secret `REGISTRY_TOKEN` under **Settings → Actions →
   Secrets**.

Each release:

1. Set `version` in `package.json` (here `0.2.0`), run the
   [release checks](#release-checks-run-on-your-machine) and commit.
2. Tag the commit with the same version and push the tag:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

The workflow stops if the tag is not `v` plus a version (`v1.2.3`, or `v1.2.3-rc.1` for a
pre-release) or does not match `package.json`. The image gets the version as its tag (`0.2.0`),
plus `0.2` and `latest` when it is the newest release of its line and of all; a pre-release gets
only its own tag. To build a release again, for a fixed base image say, start the workflow by hand
under **Actions** with the existing tag. A new package starts private: to let Cosmos pull without a
login, make it public under **Packages → web-calendar → Settings**.

On GitHub, [`.github/workflows/release-image.yml`](.github/workflows/release-image.yml) does the
same for `ghcr.io/<owner>/<repository>`, with the same tags and checks, when the version tag reaches
a GitHub copy of the repository (a push mirror from Codeberg carries the tags). It needs no setup:
the workflow's own token may push the package, which takes the visibility of the repository. It
runs on `ubuntu-latest`, the smallest GitHub runner with Docker: `ubuntu-slim` has no Docker daemon
and runs unprivileged, so no image builder works there. Codeberg reads only `.forgejo/workflows`
and GitHub only `.github/workflows`, so each forge runs its own.

## License

Copyright (C) 2026 ByteSquire

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

The package is declared `AGPL-3.0-only`. See [`LICENSE`](LICENSE). The source files, tests included,
carry no headers: the copyright and license of every file are recorded once in
[`REUSE.toml`](REUSE.toml), following the [REUSE specification](https://reuse.software/spec-3.3/).
The REUSE tool looks for the license text in [`LICENSES/`](LICENSES/AGPL-3.0-only.txt), which holds
a copy of `LICENSE`.

FullCalendar Premium (v7) is used under its AGPLv3 license, with its AGPLv3 license key
(design §2).
