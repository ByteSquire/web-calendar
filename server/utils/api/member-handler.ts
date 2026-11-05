// The frame of the group routes that a group's members (or an admin) may call. It is the admin frame
// without the admin check: the same authentication, the same per-actor rate limit, `audit()` as the
// actor, and `atomic()` for a change with its audit entry. The route decides membership itself (the
// database holds it), and asks `isAdmin()` only when the answer needs the identity provider.
import type { Database } from 'better-sqlite3'
import type { H3Event } from 'h3'
import { recordAudit } from '../../db/audit-log'
import type { Identity } from '../auth/authenticate'
import { checkRateLimit, requestIdOf, type AdminHandlerOptions } from './admin-handler'
import { decideAdminFor, defineApiHandler, type ApiUser } from './handler'

export interface MemberContext {
  db: Database
  user: ApiUser
  identity: Identity
  /** Whether the caller is in the admin group, asked of the identity provider (once per request). */
  isAdmin(): Promise<boolean>
  /** Writes one audit entry as the caller; `details` is redacted before it is stored. */
  audit(action: string, target?: string, details?: Record<string, unknown>): void
  /** Runs `work` in one transaction together with the audit entries it writes (see AdminContext). */
  atomic<T>(work: () => T): T
}

export function defineMemberHandler<T>(
  handler: (event: H3Event, context: MemberContext) => T | Promise<T>,
  options: AdminHandlerOptions = {},
) {
  return defineApiHandler(async (event, { db, user, identity }) => {
    checkRateLimit(event, identity.sub, options.limiter)
    const requestId = requestIdOf(event)
    let admin: Promise<boolean> | undefined
    return handler(event, {
      db,
      user,
      identity,
      isAdmin: () => {
        admin ??= decideAdminFor(event, identity).then((decision) => decision.admin)
        return admin
      },
      audit: (action, target, details) =>
        recordAudit(db, { actorSub: identity.sub, action, target, details, requestId }),
      atomic: (work) => db.transaction(work)(),
    })
  })
}
