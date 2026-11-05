// The frame of every admin route: the same authentication as `defineApiHandler`, then the one
// admin check (`requireAdmin`, which asks the identity provider on every call), then a per-actor
// rate limit, and an `audit()` that writes to the audit log as the actor.
import type { Database } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { createError, getRequestHeader, setResponseHeader, type H3Event } from 'h3'
import { recordAudit } from '../../db/audit-log'
import { createAdminLimiter, type AdminLimiter } from './admin-limit'
import { defineApiHandler, requireAdmin, type ApiUser } from './handler'
import type { Identity } from '../auth/authenticate'

export interface AdminContext {
  db: Database
  user: ApiUser
  identity: Identity
  /** Writes one audit entry as the caller; `details` is redacted before it is stored. */
  audit(action: string, target?: string, details?: Record<string, unknown>): void
  /**
   * Runs `work` in one database transaction: a change and its `audit()` entry are stored together
   * or not at all, so no change can exist without its audit row (security review 2026-11-01,
   * finding 10). Anything thrown inside, an audit failure included, undoes the change. Keep
   * side effects outside the database (a reconcile request) for after it returns.
   */
  atomic<T>(work: () => T): T
}

export interface AdminHandlerOptions {
  /** Tests inject their own; the default is one shared limiter (about 60 per minute). */
  limiter?: AdminLimiter
}

let sharedLimiter: AdminLimiter | undefined

/**
 * Takes one request from the caller's bucket, or answers 429 with `Retry-After`. Shared by the
 * admin and the group-member frames: both are "about 60 per minute per user".
 */
export function checkRateLimit(event: H3Event, sub: string, limiter?: AdminLimiter): void {
  const wait = (limiter ?? (sharedLimiter ??= createAdminLimiter())).take(sub)
  if (wait !== null) {
    setResponseHeader(event, 'retry-after', wait)
    throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' })
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/

/** The caller's `X-Request-Id` when it is short and plain, else a new one. */
export function requestIdOf(event: H3Event): string {
  const given = getRequestHeader(event, 'x-request-id')
  return given && SAFE_REQUEST_ID.test(given) ? given : randomUUID()
}

export function defineAdminHandler<T>(
  handler: (event: H3Event, context: AdminContext) => T | Promise<T>,
  options: AdminHandlerOptions = {},
) {
  return defineApiHandler(async (event, { db, user, identity }) => {
    // Before the admin check: it costs a call to the identity provider.
    checkRateLimit(event, identity.sub, options.limiter)
    await requireAdmin(event)
    const requestId = requestIdOf(event)
    return handler(event, {
      db,
      user,
      identity,
      audit: (action, target, details) =>
        recordAudit(db, { actorSub: identity.sub, action, target, details, requestId }),
      atomic: (work) => db.transaction(work)(),
    })
  })
}
