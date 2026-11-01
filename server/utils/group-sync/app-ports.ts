import type { Database } from 'better-sqlite3'
import { recordAudit } from '../../db/audit-log'
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

export function createAppPorts(getDb: () => Database, log: Logger = console): GroupSyncPorts {
  return {
    listExtraGroups: () => listAclGroupNames(getDb(), log),
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
}
