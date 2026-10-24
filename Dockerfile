# --- Build stage ---
FROM node:20-slim AS build
WORKDIR /app

# Install dependencies (better-sqlite3 ships prebuilt binaries, so no native
# toolchain is required for the current dependency set).
COPY package.json package-lock.json* ./
RUN npm install

# Build the Nuxt app.
COPY . .
RUN npm run build

# --- Runtime stage ---
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output

# Persist the SQLite database on a mounted volume.
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
