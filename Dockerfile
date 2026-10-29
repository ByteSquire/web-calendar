# --- Build stage ---
FROM node:24.15-bookworm-slim AS build
WORKDIR /app

# Install dependencies from the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Build the Nuxt app.
COPY . .
RUN npm run build

# --- Runtime stage ---
FROM node:24.15-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The Nitro output is self-contained; dev dependencies never reach the runtime image.
COPY --from=build /app/.output ./.output
COPY --from=build /app/server/validate-config.mjs ./server/validate-config.mjs

# Persist the SQLite database on a mounted volume.
RUN mkdir -p /data && chown node:node /data

# Run unprivileged.
USER node

EXPOSE 3000
# Validate required config at startup, then start the server.
CMD node server/validate-config.mjs && node .output/server/index.mjs
