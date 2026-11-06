// Admin › People without HTTP: everybody who signed in once, and for one person what the app holds
// about them (groups, calendars, links). Read only. No e-mail address, no token and no link secret:
// the page is for finding out who sees what, not a copy of the identity provider.
import type { Database } from 'better-sqlite3'
import { listCalendarsOfOwner } from '../../db/calendars'
import { listCalendarLinksOfUser, type LinkLevel } from '../../db/calendar-links'
import { listGroupsOfPerson } from '../../db/groups'
import type { GroupSource } from '../../db/types'
import { listCalendarsSharedWith, type SharedCalendarView } from './service'

/** At most this many people in the list; `truncated` says there are more. */
export const MAX_LISTED_PEOPLE = 2000

export interface PersonSummary {
  id: number
  sub: string
  name: string | null
  username: string | null
  /**
   * The admin group was in the person's groups at their last sign-in. Informational only: it goes
   * stale, and nothing decides on it (the admin check asks the identity provider every time).
   */
  adminAtLastSignIn: boolean
  lastSeenAt: string | null
}

export interface PersonDetail extends PersonSummary {
  groups: { id: number; name: string; source: GroupSource; manager: boolean }[]
  calendars: { id: number; name: string }[]
  shared: Omit<SharedCalendarView, 'canManage' | 'groupId'>[]
  links: {
    id: number
    label: string
    calendarName: string
    level: LinkLevel
    createdAt: string
    lastUsedAt: string | null
  }[]
}

interface PersonRow {
  id: number
  oidc_sub: string
  name: string | null
  username: string | null
  is_admin: 0 | 1
  last_seen_at: string | null
}

const PERSON_SQL =
  "SELECT id, oidc_sub, NULLIF(name, '') AS name, username, is_admin, last_seen_at FROM users"

function toSummary(row: PersonRow): PersonSummary {
  return {
    id: row.id,
    sub: row.oidc_sub,
    name: row.name,
    username: row.username,
    adminAtLastSignIn: row.is_admin === 1,
    lastSeenAt: row.last_seen_at,
  }
}

export function listPeopleForAdmin(db: Database): { people: PersonSummary[]; truncated: boolean } {
  const rows = db
    .prepare<[number], PersonRow>(
      `${PERSON_SQL} ORDER BY COALESCE(name, username, oidc_sub) COLLATE NOCASE, id LIMIT ?`,
    )
    .all(MAX_LISTED_PEOPLE + 1)
  return {
    people: rows.slice(0, MAX_LISTED_PEOPLE).map(toSummary),
    truncated: rows.length > MAX_LISTED_PEOPLE,
  }
}

export function getPersonForAdmin(db: Database, id: number): PersonDetail | null {
  const row = db.prepare<[number], PersonRow>(`${PERSON_SQL} WHERE id = ?`).get(id)
  if (!row) return null
  return {
    ...toSummary(row),
    groups: listGroupsOfPerson(db, row.oidc_sub),
    calendars: listCalendarsOfOwner(db, row.id).map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
    })),
    shared: listCalendarsSharedWith(db, { id: row.id, sub: row.oidc_sub }).map(
      ({ id: calendarId, name, kind, owner }) => ({ id: calendarId, name, kind, owner }),
    ),
    links: listCalendarLinksOfUser(db, row.id).map((link) => ({
      id: link.id,
      label: link.label,
      calendarName: link.calendar_name,
      level: link.level,
      createdAt: link.created_at,
      lastUsedAt: link.last_used_at,
    })),
  }
}
