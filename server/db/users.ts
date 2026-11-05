import type { Database } from 'better-sqlite3'
import { completeSidebarOrder, type SidebarSectionId } from '../../shared/utils/sidebar-sections'
import { found } from '../utils/api/errors'
import type { User, UserRow } from './types'

export interface UserInput {
  /** The OIDC `sub`, the stable key of a user. */
  sub: string
  username?: string
  name?: string
  email?: string
  /** Stored as an informational note only, never as authorization; see `UserRow.is_admin`. */
  isAdmin?: boolean
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    sub: row.oidc_sub,
    username: row.username,
    name: row.name,
    email: row.email,
    isAdmin: row.is_admin === 1,
    lastSeenAt: row.last_seen_at,
    timeZone: row.time_zone,
    sidebarOrder: readSidebarOrder(row.sidebar_order),
  }
}

/** The stored order, complete; null when none was stored or the column holds something else. */
function readSidebarOrder(stored: string | null): SidebarSectionId[] | null {
  if (stored === null) return null
  try {
    return completeSidebarOrder(JSON.parse(stored))
  } catch {
    return null
  }
}

function clean(value: string | undefined): string | null {
  return value?.trim() || null
}

/**
 * Creates the user on first use. Afterwards it refreshes `last_seen_at` and the profile fields
 * that are given; an omitted field keeps its stored value. A username belongs to one user: when
 * it moves to this one, the previous holder (a stale row after a rename) loses it.
 */
export function upsertUser(db: Database, input: UserInput, now = new Date()): User {
  if (!input.sub) throw new Error('A user needs an OIDC sub')
  const username = clean(input.username)
  const params = {
    sub: input.sub,
    username,
    name: clean(input.name),
    email: clean(input.email),
    isAdmin: input.isAdmin === undefined ? null : Number(input.isAdmin),
    seenAt: now.toISOString(),
  }

  const run = db.transaction(() => {
    if (username) {
      db.prepare('UPDATE users SET username = NULL WHERE username = ? AND oidc_sub <> ?').run(
        username,
        input.sub,
      )
    }
    return db
      .prepare<typeof params, UserRow>(
        `INSERT INTO users (oidc_sub, username, name, email, is_admin, last_seen_at)
         VALUES (@sub, @username, @name, @email, COALESCE(@isAdmin, 0), @seenAt)
         ON CONFLICT (oidc_sub) DO UPDATE SET
           username = COALESCE(@username, username),
           name = COALESCE(@name, name),
           email = COALESCE(@email, email),
           is_admin = COALESCE(@isAdmin, is_admin),
           last_seen_at = @seenAt
         RETURNING *`,
      )
      .get(params)!
  })
  return toUser(run.immediate())
}

/**
 * Stores the zone the user wants to see times in (FR-32), or clears it with `null` so the browser's
 * zone applies. The name is checked by the caller (server/utils/api/time-zone.ts). Returns the
 * stored value.
 */
export function setUserTimeZone(
  db: Database,
  userId: number,
  timeZone: string | null,
): string | null {
  const row = db
    .prepare<[string | null, number], Pick<UserRow, 'time_zone'>>(
      'UPDATE users SET time_zone = ? WHERE id = ? RETURNING time_zone',
    )
    .get(timeZone, userId)
  return found(row).time_zone
}

/**
 * Stores the order the user keeps the sidebar's sections in (FR-21). The ids are checked by the
 * caller (server/utils/api/sidebar-order.ts). Returns the stored order, complete.
 */
export function setUserSidebarOrder(
  db: Database,
  userId: number,
  order: readonly SidebarSectionId[],
): SidebarSectionId[] {
  const row = db
    .prepare<[string, number], Pick<UserRow, 'sidebar_order'>>(
      'UPDATE users SET sidebar_order = ? WHERE id = ? RETURNING sidebar_order',
    )
    .get(JSON.stringify(order), userId)
  return readSidebarOrder(found(row).sidebar_order) ?? completeSidebarOrder(null)
}

export function findUserBySub(db: Database, sub: string): User | null {
  const row = db.prepare<[string], UserRow>('SELECT * FROM users WHERE oidc_sub = ?').get(sub)
  return row ? toUser(row) : null
}

/** Case-insensitive, like Kanidm's account names. */
export function findUserByUsername(db: Database, username: string): User | null {
  const row = db.prepare<[string], UserRow>('SELECT * FROM users WHERE username = ?').get(username)
  return row ? toUser(row) : null
}
