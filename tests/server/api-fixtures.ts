// Shared setup of the API tests: a migrated in-memory database with two users.
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { expect } from 'vitest'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { upsertUser } from '../../server/db/users'
import { processDiscoveryStore } from '../../server/utils/auth/discovery'

/** The issuer the route tests configure through their mocked `apiConfig`. */
export const TEST_ISSUER = 'https://idm.test/oauth2/openid/web-calendar'

/**
 * Puts the discovery document of `issuer` where the userinfo client looks for it. In production the
 * token verifier fills it when it fetches the signing keys; the route tests skip the verifier, and
 * without a document userinfo answers `no-endpoint`.
 */
export function seedUserinfoEndpoint(issuer = TEST_ISSUER): void {
  processDiscoveryStore().remember({
    issuer,
    jwksUri: `${issuer}/public_key.jwk`,
    userinfoEndpoint: `${issuer}/userinfo`,
  })
}

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))

export function openTestDb(): Database {
  const db = openDatabase(':memory:')
  runMigrations(db, loadMigrationsFromDir(migrationsDir))
  return db
}

export function createUsers(db: Database): { alice: number; bob: number } {
  return {
    alice: upsertUser(db, { sub: 'sub-alice', username: 'alice' }).id,
    bob: upsertUser(db, { sub: 'sub-bob', username: 'bob' }).id,
  }
}

/** `expect(...).toThrow(apiError(409, 'limit_reached'))` */
export function apiError(statusCode: number, code?: string) {
  return expect.objectContaining({
    name: 'ApiError',
    statusCode,
    ...(code ? { data: expect.objectContaining({ code }) } : {}),
  })
}

/**
 * A minimal stand-in for Nitro's hook registry (`hookable`, which is not a direct dependency of
 * this project): handlers are called in order, one after the other.
 */
export function createTestHooks<Events extends Record<string, (...args: never[]) => unknown>>() {
  const handlers = new Map<keyof Events, ((...args: never[]) => unknown)[]>()
  return {
    hook<Name extends keyof Events>(name: Name, handler: Events[Name]) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    async callHook<Name extends keyof Events>(name: Name, ...args: Parameters<Events[Name]>) {
      for (const handler of handlers.get(name) ?? []) await handler(...args)
    },
  }
}
