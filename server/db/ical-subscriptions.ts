import type { Database } from 'better-sqlite3'
import type { IcalSubscriptionRow } from './types'

/** At most this many subscriptions per user (shared ones do not count). */
export const MAX_ICAL_SUBSCRIPTIONS_PER_USER = 50

export class IcalSubscriptionError extends Error {
  constructor(
    readonly code: 'limit_reached' | 'duplicate',
    message: string,
  ) {
    super(message)
    this.name = 'IcalSubscriptionError'
  }
}

/** What the API shows. `ref` is the calendar ref the rest of the app uses (`ics:<id>`). */
export interface IcalSubscription {
  id: number
  ref: string
  name: string
  url: string
  color: string | null
  /** Shared with everyone, read-only for users (owner_id is NULL). */
  shared: boolean
}

/** Already validated and normalised (server/utils/ical-proxy/subscription-input.ts). */
export interface IcalSubscriptionInput {
  name: string
  url: string
  color: string | null
}

function toSubscription(row: IcalSubscriptionRow): IcalSubscription {
  return {
    id: row.id,
    ref: `ics:${row.id}`,
    name: row.name,
    url: row.url,
    color: row.color,
    shared: row.owner_id === null,
  }
}

/** The user's own subscriptions and the shared ones, oldest first. */
export function listIcalSubscriptions(db: Database, userId: number): IcalSubscription[] {
  return db
    .prepare<[number], IcalSubscriptionRow>(
      'SELECT * FROM ical_subscriptions WHERE owner_id = ? OR owner_id IS NULL ORDER BY id',
    )
    .all(userId)
    .map(toSubscription)
}

/** A subscription the user may read: their own or a shared one. Null for anyone else's. */
export function findVisibleIcalSubscription(
  db: Database,
  userId: number,
  id: number,
): IcalSubscription | null {
  const row = db
    .prepare<[number, number], IcalSubscriptionRow>(
      'SELECT * FROM ical_subscriptions WHERE id = ? AND (owner_id = ? OR owner_id IS NULL)',
    )
    .get(id, userId)
  return row ? toSubscription(row) : null
}

function hasOwnUrl(db: Database, userId: number, url: string, exceptId: number): boolean {
  return (
    db
      .prepare<[number, string, number], { found: 1 }>(
        'SELECT 1 AS found FROM ical_subscriptions WHERE owner_id = ? AND url = ? AND id <> ?',
      )
      .get(userId, url, exceptId) !== undefined
  )
}

function duplicateError(): IcalSubscriptionError {
  return new IcalSubscriptionError('duplicate', 'You already subscribed to this address')
}

/** Throws `IcalSubscriptionError` at the limit and for a url the user already has. */
export function createIcalSubscription(
  db: Database,
  userId: number,
  input: IcalSubscriptionInput,
): IcalSubscription {
  const create = db.transaction(() => {
    const { count } = db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM ical_subscriptions WHERE owner_id = ?',
      )
      .get(userId)!
    if (count >= MAX_ICAL_SUBSCRIPTIONS_PER_USER) {
      throw new IcalSubscriptionError(
        'limit_reached',
        `At most ${MAX_ICAL_SUBSCRIPTIONS_PER_USER} calendar subscriptions are allowed per user`,
      )
    }
    if (hasOwnUrl(db, userId, input.url, 0)) throw duplicateError()
    return db
      .prepare<[number, string, string, string | null], IcalSubscriptionRow>(
        'INSERT INTO ical_subscriptions (owner_id, name, url, color) VALUES (?, ?, ?, ?) RETURNING *',
      )
      .get(userId, input.name, input.url, input.color)!
  })
  return toSubscription(create.immediate())
}

/**
 * Changes one of the user's own subscriptions. Returns null when there is no such row of theirs,
 * a shared one included (those are read-only).
 */
export function updateIcalSubscription(
  db: Database,
  userId: number,
  id: number,
  input: IcalSubscriptionInput,
): IcalSubscription | null {
  const update = db.transaction(() => {
    const own = db
      .prepare<[number, number], { found: 1 }>(
        'SELECT 1 AS found FROM ical_subscriptions WHERE id = ? AND owner_id = ?',
      )
      .get(id, userId)
    if (!own) return undefined
    if (hasOwnUrl(db, userId, input.url, id)) throw duplicateError()
    return db
      .prepare<[string, string, string | null, number], IcalSubscriptionRow>(
        'UPDATE ical_subscriptions SET name = ?, url = ?, color = ? WHERE id = ? RETURNING *',
      )
      .get(input.name, input.url, input.color, id)
  })
  const row = update.immediate()
  return row ? toSubscription(row) : null
}

/** Deletes one of the user's own subscriptions. False when there is no such row of theirs. */
export function deleteIcalSubscription(db: Database, userId: number, id: number): boolean {
  return (
    db.prepare('DELETE FROM ical_subscriptions WHERE id = ? AND owner_id = ?').run(id, userId)
      .changes > 0
  )
}
