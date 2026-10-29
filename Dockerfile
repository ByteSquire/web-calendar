# --- Build stage ---
FROM node:24.15-bookworm-slim AS build
WORKDIR /app

# Install dependencies from the lockfile for reproducible builds. Install scripts are skipped:
# better-sqlite3 ships prebuilt binaries, but the npm of this image (11.12) still runs
# `node-gyp rebuild` for it, which needs Python and a compiler (npm 11.19 honours its
# `gypfile: false`). The other scripts are not needed for the build; `nuxt build` prepares itself.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# Build the Nuxt app.
COPY . .
RUN npm run build

# better-sqlite3 ships prebuilt binaries but picks the file at run time, so Nitro's file tracer may
# not copy it into .output. Fail the build here instead of at the first database call.
RUN cd .output/server && node -e "new (require('better-sqlite3'))(':memory:').close()"

# --- Runtime stage ---
FROM node:24.15-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The Nitro output is self-contained; dev dependencies never reach the runtime image.
COPY --from=build /app/.output ./.output
COPY --from=build /app/server/validate-config.mjs ./server/validate-config.mjs

# Persist the SQLite database on a mounted volume. /groups holds Radicale's group file: a new named
# volume mounted there takes over this ownership, so the unprivileged app can write it.
RUN mkdir -p /data /groups && chown node:node /data /groups

# Run unprivileged.
USER node

EXPOSE 3000
# Validate required config at startup, make sure Radicale's group file exists (Radicale will not start
# without it; the app rewrites it from Phase 3), then start the server. `exec` makes node the main
# process, so it receives the stop signal and closes the database cleanly.
CMD ["sh", "-c", "node server/validate-config.mjs && { [ -e /groups/htgroup ] || : > /groups/htgroup; } && exec node .output/server/index.mjs"]
