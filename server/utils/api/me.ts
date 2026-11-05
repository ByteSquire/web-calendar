// GET /api/me (FR-13): the app user of the caller. The `users` row is created by `requireAppUser`;
// here the profile and the admin flag are refreshed from the OIDC userinfo endpoint, best effort.
import type { Database } from 'better-sqlite3'
import type { SidebarSectionId } from '../../../shared/utils/sidebar-sections'
import { upsertUser } from '../../db/users'
import type { User } from '../../db/types'
import { matchesAdminGroup, parseGroupsClaim } from '../groups/claim'
import { importUserGroups, type ImportOutcome } from '../groups/import'
import { chooseGroups, type TokenGroups } from '../groups/source'
import type { UserinfoResult } from './userinfo'

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
  /** The order the user keeps the sidebar's sections in (FR-21), complete; null means the default. */
  sidebarOrder: SidebarSectionId[] | null
}

export interface ResolveMeOptions {
  db: Database
  adminGroup: string
  /** Asks (or remembers) userinfo for the caller; see `UserinfoClient`. */
  userinfo: (sub: string, accessToken: string | null) => Promise<UserinfoResult>
  /** Called with a message that never contains the token. */
  warn: (message: string) => void
  /** Groups that are never offered for import (`parseIgnoreList`). */
  groupsIgnore: readonly string[]
  /** Called after an import changed memberships or names: the group file and the shares follow. */
  onGroupsImported?: (outcome: ImportOutcome) => void
  now?: () => Date
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
    sidebarOrder: user.sidebarOrder,
  }
}

/**
 * Takes the profile from userinfo when it answers for this very user, stores it and returns the
 * stored row. When userinfo fails, the stored values stand unchanged: the identity provider being
 * slow must not lock anybody out of the app. `isAdmin` and the groups come from userinfo, or from
 * the verified token's own claim where userinfo cannot give any (`chooseGroups`); without a
 * `groups` claim (or without an answer) `isAdmin` is false, and the stored flag is neither used
 * nor changed. The groups are imported (`importUserGroups`); a failure of that is logged and does
 * not touch the answer.
 */
export async function resolveMe(
  options: ResolveMeOptions,
  user: Omit<User, 'isAdmin'>,
  accessToken: string | null,
  tokenGroups?: TokenGroups,
): Promise<Me> {
  const result = await options.userinfo(user.sub, accessToken)
  const groups = chooseGroups(result, tokenGroups)
  // Said when userinfo failed and the token's own claim has no groups to stand in for it.
  if (!result.ok && (!groups.ok || groups.entries === undefined)) {
    const status = result.status === undefined ? '' : ` (HTTP ${result.status})`
    options.warn(`[me] userinfo not used: ${result.reason}${status}`)
  }
  if (!groups.ok) return toMe(user, false)

  const profile = result.ok ? result.profile : undefined
  const isAdmin = groups.entries ? matchesAdminGroup(groups.entries, options.adminGroup) : false
  const stored = upsertUser(options.db, {
    sub: user.sub,
    username: profile?.username,
    name: profile?.name,
    email: profile?.email,
    // Kept as a note ("last seen as admin") and only when the claim was there to judge.
    isAdmin: groups.entries ? isAdmin : undefined,
  })
  if (groups.entries) {
    try {
      const outcome = importUserGroups(
        options.db,
        user.sub,
        parseGroupsClaim(groups.entries, { ignore: options.groupsIgnore }),
        options.now?.() ?? new Date(),
        { adminGroup: options.adminGroup },
      )
      for (const message of outcome.warnings) options.warn(message)
      if (outcome.membershipsChanged || outcome.renamed > 0) options.onGroupsImported?.(outcome)
    } catch (error) {
      options.warn(
        `[me] the groups could not be stored: ${error instanceof Error ? error.message : 'unexpected error'}`,
      )
    }
  }
  return toMe(stored, isAdmin)
}
