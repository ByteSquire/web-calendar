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
  gateway (`/caldav/`), and the security headers. Not built yet: access administration, shared
  views and resources (Phase 3) and the public view. Spikes S1 to S6 and S8 to S10 are done; S7
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

- `web-calendar` is the app (Nuxt 4 / Nitro). It listens on `127.0.0.1:3000`, so put a
  reverse proxy with TLS in front. It runs as the unprivileged `node` user on a read-only
  file system, and keeps its SQLite file at `/data/web-calendar.db` on the
  `web-calendar-data` volume.
- `radicale` is the CalDAV store (`ghcr.io/kozea/radicale:3.9.0`). It has **no published
  port**: it trusts the `X-Remote-User` header, so only the app may reach it on the
  Compose network. Its configuration is [`deploy/radicale/config`](deploy/radicale/config)
  and its static, owner-only rules are [`deploy/radicale/rights`](deploy/radicale/rights),
  bind-mounted read-only. Calendars live on the `radicale-data` volume.
- Radicale's group file is in the `radicale-groups` volume. Radicale refuses to start
  without it, so the app creates an empty one at `/groups/htgroup` when it starts, and
  Radicale starts only after the app is healthy. Radicale mounts the volume read-only; the
  app's group sync rewrites the file every `NUXT_GROUP_SYNC_INTERVAL_SEC` seconds (60 by
  default, 300 at most) and keeps the previous version as `htgroup.prev`. The members are
  Kanidm `sub` UUIDs, which the app knows from the users' sign-ins: a group member who has
  never signed in makes the run fail (the file stays as it was, and the log says who) until
  they do. A group change seen in `/api/me` triggers a run at once. See
  [`docs/kanidm-setup.md`](docs/kanidm-setup.md) section 3 for the token.
- The sharing writer turns the access rules (`calendar_acl`) into Radicale map shares at start, after
  every access change and every `NUXT_SHARING_RECONCILE_INTERVAL_SEC` seconds. It talks to Radicale
  through its own internal client (never through `/caldav/`), removes any share the database does
  not know and records that in the audit log. If Radicale is unreachable it retries with backoff
  and leaves the rules unapplied. The gateway also checks from the database that a caller may touch
  a path. Shared calendars appear in a member's home as `shared-<id>`; do not name your own
  calendars like that.

Set up:

1. Create the groups and the OAuth2 client in Kanidm: [`docs/kanidm-setup.md`](docs/kanidm-setup.md).
2. Copy `.env.example` to `.env`, set `NUXT_OIDC_ISSUER`, and generate the token key:
   `openssl rand -base64 48`.
3. Start the stack:

   ```sh
   docker compose up --build
   ```

Open <http://localhost:3000>. To change `deploy/radicale/rights` or `deploy/radicale/config`,
edit the file, then run `docker compose restart radicale`: Radicale reads both only at
startup.

Back up the two volumes `web-calendar-data` and `radicale-data`.

### Environment

Copy `.env.example` to `.env` next to `docker-compose.yml` (or export the variables).
Compose reads `.env` for interpolation and passes the values into the container;
`nuxt.config.ts` declares the matching `runtimeConfig` keys, so `useRuntimeConfig()` sees
them at runtime. `server/validate-config.mjs` checks the required ones when the container
starts and exits with a message if they are wrong. The defaults in the table repeat those
in `nuxt.config.ts`; an empty value in `.env` falls back to them.

| Variable                              | Required | Default                  | Meaning                                                                                                                                                                            |
| ------------------------------------- | -------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_OIDC_ISSUER`                    | yes      |                          | Issuer of the app's own Kanidm client: an https URL that ends with the client id, such as `…/oauth2/openid/web-calendar`                                                           |
| `NUXT_TOKEN_HASH_KEY`                 | yes\*    |                          | Key for hashing app tokens, at least 32 characters (\*not needed when `NUXT_TOKEN_HASH_KEYS` is set)                                                                               |
| `NUXT_RADICALE_URL`                   | yes      | `http://radicale:5232`   | Internal URL of Radicale; set by the compose file                                                                                                                                  |
| `NUXT_OIDC_CLIENT_ID`                 | no       | `web-calendar`           | The app's own public client; the issuer must end with it                                                                                                                           |
| `NUXT_OIDC_ALLOWED_CLIENTS`           | no       | empty (the client above) | Further Kanidm clients whose tokens the CalDAV gateway accepts, comma-separated                                                                                                    |
| `NUXT_GROUP_SYNC_TOKEN`               | no       |                          | Read-only Kanidm API token for the group sync (the container warns and starts without it; then the group file stays empty). Expires within 90 days: rotate it                      |
| `NUXT_GROUP_SYNC_INTERVAL_SEC`        | no       | `60`                     | Seconds between group syncs, at most `300`; a removed member keeps access for up to this long                                                                                      |
| `NUXT_GROUP_SYNC_FILE`                | no       | `/groups/htgroup`        | Radicale's group file (`.data/htgroup` outside production)                                                                                                                         |
| `NUXT_SHARING_RECONCILE_INTERVAL_SEC` | no       | `300`                    | Seconds between sharing reconciles (access rules to Radicale shares), at most `900`; an access change also triggers one                                                            |
| `NUXT_SHARING_AUDIT_INTERVAL_HOURS`   | no       | `24`                     | Hours between the consistency audits that list every home as each user and compare with the access rules (1 to 168)                                                                |
| `NUXT_SHARING_SHARED_OWNERS`          | no       | empty                    | Service principals (`_team`, comma-separated) whose calendars are mirrored as shared calendars                                                                                     |
| `NUXT_GATEWAY_CORS_ORIGINS`           | no       | empty (no CORS)          | Origins of external browser apps that may call `/caldav/`, comma-separated                                                                                                         |
| `NUXT_GATEWAY_TRUST_FORWARDED_FOR`    | no       | `false`                  | `true` behind a reverse proxy that overwrites `X-Forwarded-For`: its last hop is the client address for the login throttle. Leave it off without a proxy                           |
| `NUXT_OIDC_KEY_MAX_AGE_SEC`           | no       | `3600`                   | Age after which the cached Kanidm signing keys are refetched in the background                                                                                                     |
| `NUXT_GATEWAY_MAX_BODY_BYTES`         | no       | `10485760`               | Largest request body the gateway forwards                                                                                                                                          |
| `NUXT_OIDC_ADMIN_GROUP`               | no       | `calendar_admins`        | Kanidm group whose members are admins                                                                                                                                              |
| `NUXT_ICAL_PROXY_CACHE_TTL_SEC`       | no       | `300`                    | Seconds an iCal subscription is served from the proxy's cache                                                                                                                      |
| `NUXT_ICAL_PROXY_MAX_BYTES`           | no       | `5242880`                | Largest `.ics` file the proxy accepts                                                                                                                                              |
| `NUXT_ICAL_PROXY_TIMEOUT_MS`          | no       | `10000`                  | Time allowed for fetching a subscription                                                                                                                                           |
| `NUXT_TOKEN_HASH_KEYS`                | no       | empty                    | Key list for rotation, `2:<new>,1:<old>`; the first entry hashes new tokens (design §6)                                                                                            |
| `NUXT_OUTBOUND_ALLOWED_HOSTS`         | no       | empty (any public host)  | Comma-separated hosts (`name`, `*.suffix`) that iCal subscriptions and external accounts may reach                                                                                 |
| `NUXT_EXTERNAL_SEAL_KEY`              | no       | empty                    | 64 hex characters or base64 of 32 bytes; without it external accounts with a login are off. Changing it voids every saved external password                                        |
| `NUXT_ICAL_PROXY_ALLOW_PRIVATE`       | no       | `false`                  | `true` lets subscriptions point at private addresses; tests only                                                                                                                   |
| `NUXT_DEMO`                           | no       | `false`                  | `true` skips the login and shows mock data; previews and browser tests only                                                                                                        |
| `NUXT_DB_PATH`                        | fixed    | `/data/web-calendar.db`  | SQLite file; set by the compose file                                                                                                                                               |
| `TZ`                                  | no       | `Europe/Berlin`          | Organization time zone, an IANA name (floating times, fallback and label); users see their browser's zone unless they chose another in Settings. Anything else stops the container |

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

## License

AGPL-3.0-only. See [`LICENSE`](LICENSE).
