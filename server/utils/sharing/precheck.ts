import type { Database } from 'better-sqlite3'
import type { GroupMembership } from './membership'
import { sharedCalendarId } from './names'
import { AVAILABILITY_SHARE_NAME } from './types'

// The gateway's second opinion (security review §7.1): before a request reaches Radicale, SQLite
// must say the caller owns the path or `calendar_acl` grants them something on it. Radicale stays
// the enforcement point; this catches a drift between the two.

export interface PathCheckRequest {
  method: string
  /** The path Radicale would receive (`/sub/cal/x.ics`), percent-encoded. */
  upstreamPath: string
}

export type PathPrecheck = (sub: string, request: PathCheckRequest) => Promise<boolean>

const WRITE_METHODS = new Set(['PUT', 'DELETE', 'PROPPATCH', 'MKCOL', 'MKCALENDAR', 'MOVE', 'COPY'])
const SHARING_PERMISSIONS = ['free_busy', 'read', 'write']

interface GrantRow {
  principal_type: string
  principal: string | null
  permission: string
}

function segmentsOf(upstreamPath: string): string[] | null {
  const segments: string[] = []
  for (const raw of upstreamPath.split('/').filter((part) => part !== '')) {
    try {
      segments.push(decodeURIComponent(raw))
    } catch {
      return null
    }
  }
  return segments
}

export function createPathPrecheck(db: Database, membership: GroupMembership): PathPrecheck {
  const byId = db.prepare<[number], GrantRow>(
    'SELECT principal_type, principal, permission FROM calendar_acl WHERE calendar_id = ?',
  )
  const byPath = db.prepare<[string], { id: number }>(
    'SELECT id FROM calendars WHERE collection_path = ?',
  )

  async function granted(calendarId: number, sub: string, method: string): Promise<boolean> {
    const needsWrite = WRITE_METHODS.has(method)
    // The group file is read only when a group rule has to be looked at.
    let groups: ReadonlySet<string> | undefined
    for (const row of byId.all(calendarId)) {
      if (!SHARING_PERMISSIONS.includes(row.permission)) continue
      if (needsWrite && row.permission !== 'write') continue
      // Anybody who got past authentication is a person of this app: the group of everyone is the
      // people who signed in within the window, and a caller who is authenticated now has.
      if (row.principal_type === 'authenticated') return true
      if (row.principal_type === 'user') {
        if (row.principal === sub) return true
      } else if (row.principal_type === 'group' && row.principal !== null) {
        groups ??= await membership.groupsOf(sub)
        if (groups.has(row.principal)) return true
      }
    }
    return false
  }

  return async function precheck(sub, request) {
    const segments = segmentsOf(request.upstreamPath)
    if (segments === null) return false
    const [home, collection] = segments
    // The store root: principal discovery.
    if (home === undefined) return true
    if (home === sub) {
      if (collection === undefined) return true
      const id = sharedCalendarId(collection)
      if (id !== null) return granted(id, sub, request.method)
      // The free/busy share is for everyone who is authenticated, to read only.
      if (collection === AVAILABILITY_SHARE_NAME) return !WRITE_METHODS.has(request.method)
      return true
    }
    // Another principal's home: only a calendar the rules grant, never the home itself.
    if (collection === undefined) return false
    const row = byPath.get(`/${home}/${collection}/`)
    return row ? granted(row.id, sub, request.method) : false
  }
}
