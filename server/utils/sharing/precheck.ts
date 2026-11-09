import type { Database } from 'better-sqlite3'
import { sharedCalendarId } from '../../../shared/utils/shared-calendar-name'
import type { GroupMembership } from './membership'
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

/** Why a request was refused before it reached Radicale; it names no person and no event. */
export interface PathRefusal {
  method: string
  /** The request would change something (PUT, DELETE, …), not only read. */
  write: boolean
  /** The calendar of the access page the path names, when it names one. */
  calendarId: number | null
  reason:
    | 'no-rule' // a calendar of the access page, but no rule gives the caller this access
    | 'availability' // the free/busy availability share, which is read-only
    | 'other-home' // another principal's home: its root, or a collection the access page lacks
    | 'unreadable-path'
}

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

export function createPathPrecheck(
  db: Database,
  membership: GroupMembership,
  options: { onRefused?: (refusal: PathRefusal) => void } = {},
): PathPrecheck {
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

  async function decide(
    sub: string,
    request: PathCheckRequest,
  ): Promise<true | Omit<PathRefusal, 'method' | 'write'>> {
    const segments = segmentsOf(request.upstreamPath)
    if (segments === null) return { calendarId: null, reason: 'unreadable-path' }
    const [home, collection] = segments
    // The store root: principal discovery.
    if (home === undefined) return true
    if (home === sub) {
      if (collection === undefined) return true
      const id = sharedCalendarId(collection)
      if (id !== null) {
        return (await granted(id, sub, request.method)) || { calendarId: id, reason: 'no-rule' }
      }
      // The free/busy share is for everyone who is authenticated, to read only.
      if (collection === AVAILABILITY_SHARE_NAME && WRITE_METHODS.has(request.method)) {
        return { calendarId: null, reason: 'availability' }
      }
      return true
    }
    // Another principal's home: only a calendar the rules grant, never the home itself.
    if (collection === undefined) return { calendarId: null, reason: 'other-home' }
    const row = byPath.get(`/${home}/${collection}/`)
    if (!row) return { calendarId: null, reason: 'other-home' }
    return (await granted(row.id, sub, request.method)) || { calendarId: row.id, reason: 'no-rule' }
  }

  return async function precheck(sub, request) {
    const decision = await decide(sub, request)
    if (decision === true) return true
    options.onRefused?.({
      method: request.method,
      write: WRITE_METHODS.has(request.method),
      ...decision,
    })
    return false
  }
}

const REFUSAL_LOG_WINDOW_MS = 10 * 60 * 1000
const REFUSAL_LOG_KEYS = 200

/**
 * A log line per kind of refusal and calendar, at most every 10 minutes: enough to see that the
 * access rules and Radicale differ (Radicale offered a calendar the rules do not grant), without a
 * client being able to flood the log. Names the calendar's id, never the person or the event.
 */
export function refusalLogger(
  log: (message: string) => void,
  now: () => number = Date.now,
): (refusal: PathRefusal) => void {
  const last = new Map<string, number>()
  return (refusal) => {
    const key = `${refusal.reason}|${refusal.calendarId ?? ''}|${refusal.write}`
    const time = now()
    const seen = last.get(key)
    if (seen !== undefined && time - seen < REFUSAL_LOG_WINDOW_MS) return
    last.delete(key)
    last.set(key, time)
    if (last.size > REFUSAL_LOG_KEYS) last.delete(last.keys().next().value!)
    const access = refusal.write ? 'write' : 'read'
    const message =
      refusal.reason === 'no-rule'
        ? `${refusal.method} refused before Radicale: no access rule gives the caller ${access} access to calendar ${refusal.calendarId}; if Radicale offers it to them, its shares and the access page differ (see the rules of calendar ${refusal.calendarId})`
        : refusal.reason === 'availability'
          ? `${refusal.method} refused before Radicale: the resource availability share is read-only`
          : refusal.reason === 'other-home'
            ? `${refusal.method} refused before Radicale: a path in another principal's home that no calendar of the access page is`
            : `${refusal.method} refused before Radicale: the path cannot be decoded`
    log(message)
  }
}
