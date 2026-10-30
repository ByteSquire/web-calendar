// GET /api/me (FR-13): the app user of the caller. The `users` row is created by `requireAppUser`;
// here the profile and the admin flag are refreshed from the OIDC userinfo endpoint, best effort.
import type { Database } from 'better-sqlite3'
import { upsertUser } from '../../db/users'
import type { User } from '../../db/types'
import { isAdminByGroups, type UserinfoResult } from './userinfo'

export interface Me {
  id: number
  sub: string
  username: string | null
  name: string | null
  email: string | null
  /**
   * Whether the userinfo answer used for this response says so. False when userinfo failed or has
   * no `groups` claim. It is for the SPA to show or hide admin screens; the server never decides
   * anything from it (that is `requireAdmin`).
   */
  isAdmin: boolean
  /** The IANA zone the user chose to see times in (FR-32); null means the browser's zone. */
  timeZone: string | null
}

export interface ResolveMeOptions {
  db: Database
  adminGroup: string
  /** Asks (or remembers) userinfo for the caller; see `UserinfoClient`. */
  userinfo: (sub: string, accessToken: string | null) => Promise<UserinfoResult>
  /** Called with a message that never contains the token. */
  warn: (message: string) => void
}

/** The token of an `Authorization: Bearer` header, or null. */
export function bearerToken(headers: Headers): string | null {
  const match = /^bearer\s+(\S+)\s*$/i.exec(headers.get('authorization') ?? '')
  return match ? match[1]! : null
}

function toMe(user: Omit<User, 'isAdmin'>, isAdmin: boolean): Me {
  return {
    id: user.id,
    sub: user.sub,
    username: user.username,
    name: user.name,
    email: user.email,
    isAdmin,
    timeZone: user.timeZone,
  }
}

/**
 * Takes the profile from userinfo when it answers for this very user, stores it and returns the
 * stored row. When userinfo fails, the stored values stand unchanged: the identity provider being
 * slow must not lock anybody out of the app. `isAdmin` comes from that same answer only; without
 * a `groups` claim (or without an answer) it is false, and the stored flag is neither used nor
 * changed.
 */
export async function resolveMe(
  options: ResolveMeOptions,
  user: Omit<User, 'isAdmin'>,
  accessToken: string | null,
): Promise<Me> {
  const result = await options.userinfo(user.sub, accessToken)
  if (!result.ok) {
    const status = result.status === undefined ? '' : ` (HTTP ${result.status})`
    options.warn(`[me] userinfo not used: ${result.reason}${status}`)
    return toMe(user, false)
  }

  const { profile } = result
  const isAdmin = profile.groups ? isAdminByGroups(profile.groups, options.adminGroup) : false
  const stored = upsertUser(options.db, {
    sub: user.sub,
    username: profile.username,
    name: profile.name,
    email: profile.email,
    // Kept as a note ("last seen as admin") and only when the claim was there to judge.
    isAdmin: profile.groups ? isAdmin : undefined,
  })
  return toMe(stored, isAdmin)
}
