// The frame of every `/api/**` route that works with the signed-in user: it authenticates the
// caller, hands the route the user and the database, keeps the answer out of any cache and turns
// API errors into HTTP errors. Routes stay a few lines; the rules live in the plain modules.
import type { Database } from 'better-sqlite3'
import { createError, defineEventHandler, setResponseHeader, type H3Event } from 'h3'
import type { User } from '../../db/types'
import type { Identity } from '../auth/authenticate'
import { requireUser } from '../auth/nitro'
import { requireAppUser } from '../current-user'
import { getDb } from '../db'
import { decideAdmin } from './admin'
import { apiConfig } from './config'
import { API_STATUS_TEXT, ApiError, forbidden } from './errors'
import { bearerToken } from './me'
import { tokenExpiresAtMs } from './userinfo-client'
import { getUserinfoClient } from './userinfo-service'

/**
 * The caller as a handler sees them. The stored `is_admin` flag is left out on purpose: it is a
 * possibly stale copy of a group, and `if (user.isAdmin)` would make it a permission. Admin
 * routes call `requireAdmin`.
 */
export type ApiUser = Omit<User, 'isAdmin'>

export interface ApiContext {
  db: Database
  user: ApiUser
  identity: Identity
}

/** An `ApiError` as the h3 error that carries its status, message and `data`; others are unchanged. */
export function apiErrorToHttp(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error
  return createError({
    statusCode: error.statusCode,
    statusMessage: API_STATUS_TEXT[error.statusCode],
    message: error.message,
    data: error.data,
  })
}

// An explicit list, so a field added to `User` later does not reach the handlers unnoticed.
function toApiUser(user: User): ApiUser {
  return {
    id: user.id,
    sub: user.sub,
    username: user.username,
    name: user.name,
    email: user.email,
    lastSeenAt: user.lastSeenAt,
    timeZone: user.timeZone,
  }
}

/**
 * Lets the request pass only when the identity provider says now that the caller is in the admin
 * group (403 otherwise, and for every doubt: userinfo not reachable, no `groups` claim). The only
 * admin check there is; it asks userinfo with the caller's own token on every call (a call that is
 * already running for the same user is joined, an answer from the past is not used), so removing
 * somebody from the group takes effect at once.
 */
export async function requireAdmin(event: H3Event): Promise<void> {
  const identity = await requireUser(event)
  const decision = await decideAdminFor(event, identity.sub)
  if (decision.admin) return
  console.warn(`[admin] ${event.path} refused: ${decision.reason}`)
  throw apiErrorToHttp(forbidden())
}

/**
 * Whether the caller is in the admin group, asked of the identity provider with the caller's own
 * token (see `requireAdmin`). Never throws for a refusal; the member frame uses it to decide.
 */
export async function decideAdminFor(event: H3Event, sub: string) {
  const accessToken = bearerToken(event.headers)
  const { oidcIssuer, adminGroup } = apiConfig()
  return decideAdmin({
    userinfo: getUserinfoClient(),
    issuer: oidcIssuer,
    adminGroup,
    sub,
    accessToken,
    tokenExpiresAtMs: tokenExpiresAtMs(accessToken),
  })
}

export function defineApiHandler<T>(
  handler: (event: H3Event, context: ApiContext) => T | Promise<T>,
) {
  return defineEventHandler(async (event): Promise<T> => {
    // The answers are about one user and may hold a secret (a new app token): never cache them.
    setResponseHeader(event, 'cache-control', 'no-store')
    const { identity, user } = await requireAppUser(event)
    try {
      return await handler(event, { db: getDb(), user: toApiUser(user), identity })
    } catch (error) {
      throw apiErrorToHttp(error)
    }
  })
}
