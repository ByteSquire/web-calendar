import type { H3Event } from 'h3'
import { upsertUser } from '../db/users'
import type { User } from '../db/types'
import type { Identity } from './auth/authenticate'
import { requireUser } from './auth/nitro'
import { getDb } from './db'

/**
 * The caller of an `/api/**` request as an app user: the bearer token is checked (`requireUser`),
 * then the `users` row is created on first use and `last_seen_at` is refreshed (design §5, FR-13).
 * Handlers that need the row id use this instead of `requireUser`.
 */
export async function requireAppUser(event: H3Event): Promise<{ identity: Identity; user: User }> {
  const identity = await requireUser(event)
  const user = upsertUser(getDb(), { sub: identity.sub })
  return { identity, user }
}
