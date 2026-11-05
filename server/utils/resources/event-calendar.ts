// Can this user read the calendar a booking event lives in? One rule for booking time and for
// availability, so "who may book from it" and "who sees the details" cannot disagree. The gateway
// pre-check decides who reaches the path; free/busy grants are narrowed away here, because
// free/busy must not reveal who booked.
import type { Database } from 'better-sqlite3'
import { USERS_GROUP } from '../groups/config'
import { sharedCalendarId, splitCollectionPath } from '../sharing/names'
import { createPathPrecheck } from '../sharing/precheck'
import { AVAILABILITY_SHARE_NAME } from '../sharing/types'
import type { Actor } from './service'

interface AclRow {
  principal_type: string
  principal: string | null
}

/**
 * The `calendars.collection_path` a stored booking path stands for. Discovery never stores share
 * names, so `/<sub>/shared-<id>[-<group>]/` maps back to the calendar with that id (null if there
 * is none); any other path is its own. Null also for a path that is not a calendar path and for
 * the read-only availability share, which holds no events.
 */
export function canonicalCalendarPath(db: Database, storedPath: string): string | null {
  const parts = splitCollectionPath(storedPath)
  if (!parts || parts.name === AVAILABILITY_SHARE_NAME) return null
  const id = sharedCalendarId(parts.name)
  if (id === null) return storedPath
  const row = db
    .prepare<[number], { collection_path: string }>(
      'SELECT collection_path FROM calendars WHERE id = ?',
    )
    .get(id)
  return row?.collection_path ?? null
}

function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/** Whether `actor` may read the calendar a booking path points at, cached per path. */
export function eventCalendarReader(
  db: Database,
  actor: Actor,
): (path: string) => Promise<boolean> {
  const groups = new Set([...actor.groups, USERS_GROUP])
  const precheck = createPathPrecheck(db, {
    groupsOf: async () => groups,
    all: async () => new Map(),
  })
  const detailed = db.prepare<[string], AclRow>(
    `SELECT a.principal_type, a.principal FROM calendar_acl a
     JOIN calendars c ON c.id = a.calendar_id
     WHERE c.collection_path = ? AND a.permission IN ('read', 'write')`,
  )
  const sub = actor.sub
  const grantsDetail = (row: AclRow): boolean => {
    if (row.principal_type === 'user') return row.principal === sub
    if (row.principal_type === 'group') return row.principal !== null && groups.has(row.principal)
    return row.principal_type === 'authenticated'
  }
  const cache = new Map<string, Promise<boolean>>()
  const check = async (storedPath: string): Promise<boolean> => {
    const canonical = canonicalCalendarPath(db, storedPath)
    if (canonical === null) return false
    const ok = await precheck(actor.sub, { method: 'GET', upstreamPath: encodedPath(canonical) })
    if (!ok) return false
    return canonical.startsWith(`/${actor.sub}/`) || detailed.all(canonical).some(grantsDetail)
  }
  return (path) => {
    let answer = cache.get(path)
    if (!answer) {
      answer = check(path)
      cache.set(path, answer)
    }
    return answer
  }
}
