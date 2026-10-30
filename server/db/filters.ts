// Saved filters (FR-5): a named text, category or status filter that belongs to one user.
import type { Database } from 'better-sqlite3'
import { conflict } from '../utils/api/errors'
import type { FilterKind, FilterRow } from './types'

export const MAX_FILTERS_PER_USER = 100
export const FILTER_KINDS: readonly FilterKind[] = ['text', 'category', 'status']
export const FILTER_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const

export interface FilterEntry {
  id: number
  name: string
  kind: FilterKind
  value: string
}

/** A validated create or update body. */
export type FilterInput = Omit<FilterEntry, 'id'>

function toFilter(row: FilterRow): FilterEntry {
  return { id: row.id, name: row.name, kind: row.kind, value: row.value }
}

/** The user's own filters, oldest first. */
export function listFilters(db: Database, userId: number): FilterEntry[] {
  return db
    .prepare<[number], FilterRow>('SELECT * FROM filters WHERE owner_id = ? ORDER BY id')
    .all(userId)
    .map(toFilter)
}

/** Throws a 409 `limit_reached` when the user has `MAX_FILTERS_PER_USER` filters already. */
export function createFilter(db: Database, userId: number, input: FilterInput): FilterEntry {
  const create = db.transaction(() => {
    const { count } = db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM filters WHERE owner_id = ?',
      )
      .get(userId)!
    if (count >= MAX_FILTERS_PER_USER) {
      throw conflict(
        'limit_reached',
        `At most ${MAX_FILTERS_PER_USER} filters are allowed per user`,
      )
    }
    return db
      .prepare<[number, string, string, string], FilterRow>(
        'INSERT INTO filters (owner_id, name, kind, value) VALUES (?, ?, ?, ?) RETURNING *',
      )
      .get(userId, input.name, input.kind, input.value)!
  })
  return toFilter(create.immediate())
}

/** Replaces name, kind and value. Null when the user has no such filter. */
export function updateFilter(
  db: Database,
  userId: number,
  id: number,
  input: FilterInput,
): FilterEntry | null {
  const row = db
    .prepare<[string, string, string, number, number], FilterRow>(
      'UPDATE filters SET name = ?, kind = ?, value = ? WHERE id = ? AND owner_id = ? RETURNING *',
    )
    .get(input.name, input.kind, input.value, id, userId)
  return row ? toFilter(row) : null
}

export function deleteFilter(db: Database, userId: number, id: number): boolean {
  return db.prepare('DELETE FROM filters WHERE id = ? AND owner_id = ?').run(id, userId).changes > 0
}
