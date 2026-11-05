import type { Database } from 'better-sqlite3'
import { recordAudit } from '../../db/audit-log'
import { listCustomGroupsForFile, replaceImportedGroups } from '../../db/groups'
import { isGroupName } from './format'
import type { GroupSyncAuditEvent, GroupSyncPorts } from './ports'
import type { Logger } from './types'

/** The actor of entries the server writes on its own. */
export const SYSTEM_ACTOR = 'system:group-sync'

/**
 * Groups the access rules of calendars and resources refer to. A name the sync cannot read (for
 * example an SPN) is left out and logged, so one bad rule cannot stop the sync for everybody; the
 * group then has no members in the file, which denies access.
 */
export function listAclGroupNames(db: Database, log: Pick<Logger, 'warn'>): string[] {
  const names = db
    .prepare(
      `SELECT principal FROM calendar_acl WHERE principal_type = 'group'
       UNION SELECT principal FROM resource_acl WHERE principal_type = 'group'
       ORDER BY 1`,
    )
    .pluck()
    .all() as string[]
  const usable = names.filter((name) => isGroupName(name))
  for (const name of names) {
    if (!isGroupName(name)) {
      log.warn(`[group-sync] the access rules name a group the sync cannot read: ${name}`)
    }
  }
  return usable
}

/**
 * Deletes the app tokens of every user whose `sub` is not in `members` (security review 2026-11-01,
 * finding 2). An app token is checked against the local database only, so without this a user who
 * was removed from the users group, disabled or deleted in Kanidm keeps CalDAV access to their own
 * calendar for as long as the token lives (up to a year). Only tokens made before `createdBefore`
 * are touched: a user added to the group after the run read it may sign in and make a token while
 * the run is still going, and that token must survive. Returns who lost how many, in one
 * transaction.
 */
export function revokeTokensOfNonMembers(
  db: Database,
  members: ReadonlySet<string>,
  createdBefore: Date,
): { username: string; revoked: number }[] {
  const before = createdBefore.toISOString()
  const holders = db
    .prepare<[string], { userId: number; sub: string; username: string }>(
      `SELECT DISTINCT u.id AS userId, u.oidc_sub AS sub, u.username AS username
       FROM app_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.created_at < ?`,
    )
    .all(before)
    .filter((holder) => !members.has(holder.sub))
  if (holders.length === 0) return []
  const remove = db.prepare('DELETE FROM app_tokens WHERE user_id = ? AND created_at < ?')
  return db.transaction(() =>
    holders.map((holder) => ({
      username: holder.username,
      revoked: remove.run(holder.userId, before).changes,
    })),
  )()
}

export function createAppPorts(getDb: () => Database, log: Logger = console): GroupSyncPorts {
  const ports: GroupSyncPorts = {
    listExtraGroups: () => listAclGroupNames(getDb(), log),
    listCustomGroups: () => listCustomGroupsForFile(getDb()),
    importKanidmGroups: (groups) => {
      replaceImportedGroups(getDb(), groups)
    },
    revokeTokensOfNonMembers: (members, createdBefore) => {
      const gone = revokeTokensOfNonMembers(getDb(), members, createdBefore)
      for (const { username, revoked } of gone) {
        ports.audit({
          action: 'group_sync.tokens_revoked',
          target: username,
          details: { revoked, reason: 'no longer in the users group' },
        })
      }
      return { users: gone.length, revoked: gone.reduce((sum, one) => sum + one.revoked, 0) }
    },
    audit: (event: GroupSyncAuditEvent) => {
      // An audit failure must not end a run: the log line is the fallback.
      try {
        recordAudit(getDb(), { actorSub: SYSTEM_ACTOR, ...event })
      } catch (error) {
        log.error(
          `[group-sync] audit entry ${event.action} could not be written: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        )
      }
    },
  }
  return ports
}
