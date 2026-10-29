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
npm audit
```

Linting is ESLint through `@nuxt/eslint` (flat config in `eslint.config.mjs`).
Formatting is Prettier (`.prettierrc`: single quotes, no semicolons, 100 columns), and
`eslint-config-prettier` keeps the two from conflicting. Type checking is
`nuxt typecheck`, which needs `typescript` and `vue-tsc`; TypeScript is kept on 5.9
because `vue-tsc` support for TypeScript 7 is unverified. The code was last formatted
by Oxfmt (from the removed Vite+ toolchain), so the first `npm run fmt` may produce
small diffs.

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

### Known issues / security status (as of 2026-10-24)

- `npm audit` reports **7 high-severity vulnerabilities**, all in the
  Nuxt/Nitro dependency chain (`node-forge` → `listhen` → `nitropack` → `nuxt`).
  The underlying advisory (CVE-2026-85393, node-forge RSA PKCS#1 v1.5 signature
  verification) currently has **no patched version**; a fix was incomplete as of
  the Oct 2026 advisory update. Remediation is expected with the next upstream
  releases (e.g. Nuxt 5). Practical production risk is low: the vulnerable
  `listhen` path is used by Nitro's dev/preview server, not by the production
  `node-server` entry point. Do **not** run `npm audit fix --force`; it proposes
  downgrading Nuxt to 4.1.3.
- The project is on **Nuxt 4.6.2** (latest stable). Nuxt 5 is still in development
  and only available via the opt-in `future.compatibilityVersion: 5` flag from
  Nuxt 4.2+ — not recommended for this project yet. When Nuxt 5 reaches stable,
  upgrade and re-run `npm audit`.
- The container refuses to start without OIDC and CalDAV settings
  (`server/validate-config.mjs`), even though Phase 1 uses mock data. Copy
  `.env.example` to `.env` (placeholder values are fine) before `docker compose up`.
- Design decisions of 2026-10-29 are recorded in `docs/design.md` (v1.1) but not yet
  applied to the code or config: the app becomes an SPA (`ssr: false`), access control
  moves to the CalDAV backend, calendars are fetched live instead of synced
  (`NUXT_SYNC_INTERVAL_MIN` becomes obsolete), and Nuxt UI is adopted (trial S3 passed)
  but not yet installed. Open spikes S1, S2 and S4 are listed in design §12.

### Dependency versions (as of 2026-10-24)

- Nuxt `^4.6.2`, Vue `^3.5.44`, vue-router `^5.4.0`, Node `^24.15.0`
  (Nuxt 4.6.2 requires `^22.22.3 || ^24.15.0 || >=26.0.0`)
- FullCalendar `^7.1.3` (`@fullcalendar/vue3` only) + `temporal-polyfill`.
  v7 moved the plugins into the framework package: import them from subpaths
  such as `@fullcalendar/vue3/daygrid`, `@fullcalendar/vue3/timegrid`,
  `@fullcalendar/vue3/list`, `@fullcalendar/vue3/interaction`,
  `@fullcalendar/vue3/multimonth`. `@fullcalendar/core` is a v7 stub and is **not** a direct
  dependency; standalone `@fullcalendar/*` plugin packages are v6-only.

### Production

```sh
docker compose up --build
```

Open <http://localhost:3000>. The app runs as the unprivileged `node` user;
the SQLite volume (`/data`) is prepared for later phases.

### Environment

Copy `.env.example` to `.env` next to `docker-compose.yml` (or export the
variables). Compose reads `.env` for interpolation and passes every `NUXT_*`
value into the container; `nuxt.config.ts` declares the matching
`runtimeConfig` keys, so `useRuntimeConfig()` sees them at runtime. `TZ`
controls date handling (defaults to `UTC`).

Production builds must run on the Docker host — the Dev Container does not
include a Docker CLI.

## License

AGPL-3.0-only. See [`LICENSE`](LICENSE).
