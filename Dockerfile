# --- Build stage ---
FROM node:24-slim AS build
WORKDIR /app

# Install dependencies from the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Build the Nuxt app.
COPY . .
RUN npm run build

# --- Runtime stage ---
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output

# Persist the SQLite database on a mounted volume.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run unprivileged.
USER node

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
