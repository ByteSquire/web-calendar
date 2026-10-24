# Web Calendar

Standalone, self-hosted web calendar for teams and organizations. See
[`docs/requirements.md`](docs/requirements.md) and [`docs/design.md`](docs/design.md).

## Container-only workflow

Node.js is **not** required on the host — everything (install, build, test,
run) happens inside Docker containers based on Node 24 LTS.

> Docker must be able to see this directory. It lives under the host home
> directory, so the Dev Container bind mount works.

### Dev Container (recommended for development)

The repository includes a standard Dev Container configuration in
`.devcontainer/`. It uses the official Node 24 devcontainer image, keeps
`node_modules` in a named volume, and forwards port 3000. It works with Dev
Container-aware IDEs such as VS Code, Cursor, Zed, and DevPod.

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
is needed on the host. The container runs as the unprivileged `node` user.
Dependencies are installed during the image build and seeded into the
`node_modules` volume, so the container is usable even if your IDE does not run
`postCreateCommand`. After changing dependencies, run `npm ci` again in the
container terminal.

### Build and checks

Run these in the Dev Container terminal:

```sh
npm run build   # nuxt build (production output)
npm run check   # vp check: format + lint + type-aware typecheck
npm run lint    # vp lint
npm run fmt     # vp fmt (writes changes)
npm audit
```

Quality tooling runs on **Vite+** (`vite-plus` 1.4.0, the `vp` CLI bundling
Oxfmt, Oxlint and Vitest). Nuxt still owns `npm run dev` and `npm run build`;
`vp dev`/`vp build` are deliberately not used because they bypass Nuxt. The
root `vite.config.ts` contains only the Vite+ `fmt` and `lint` blocks, and is
ignored by Nuxt itself.

### Known issues / security status (as of 2026-10-24)

- `npm audit` reports **7 high-severity vulnerabilities**, all in the
  Nuxt/Nitro dependency chain (`node-forge` → `listhen` → `nitropack` → `nuxt`).
  The underlying advisory (CVE-2026-85393, node-forge RSA PKCS#1 v1.5 signature
  verification) currently has **no patched version**; a fix was incomplete as of
  the Oct 2026 advisory update. Remediation is expected with the next upstream
  releases (e.g. Nuxt 5).
- The project is on **Nuxt 4.6.2** (latest stable). Nuxt 5 is still in development
  and only available via the opt-in `future.compatibilityVersion: 5` flag from
  Nuxt 4.2+ — not recommended for this project yet. When Nuxt 5 reaches stable,
  upgrade and re-run `npm audit`.
- `npm run dev` prints
  `WARN [NUXT_B5004] External configuration files are not supported: vite.config.ts`.
  Nuxt 4.6.2 ignores that file — it exists only for the Vite+ toolchain. Nuxt's
  documentation states that a `vite.config` importing from `vite-plus` should
  not trigger this warning, but that exemption is not yet in 4.6.2. It is
  harmless: build, dev server and checks all pass.

### Dependency versions (as of 2026-10-24)

- Nuxt `^4.6.2`, Vue `^3.5.44`, vue-router `^5.4.0`, Node `>=24.11.0`
- FullCalendar `^7.1.3` (`@fullcalendar/core`, `@fullcalendar/vue3`) + `temporal-polyfill`
  (`^7` moved plugins into the framework packages; standalone `@fullcalendar/*`
  plugin packages are v6-only).
- Vite+ `1.4.0` (`vite-plus`, dev dependency; pins `vite` to
  `@voidzero-dev/vite-plus-core@1.4.0` via `overrides`).

### Production

```sh
docker compose up --build
```

Open <http://localhost:3000>. The app runs as the unprivileged `node` user;
the SQLite volume (`/data`) is prepared for later phases.

### Environment

Copy `.env.example` to `.env` next to `docker-compose.yml` for local
configuration, or export the `NUXT_*` variables before running Compose.

## License

AGPL-3.0-only. See [`LICENSE`](LICENSE).
