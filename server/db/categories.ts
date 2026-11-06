// Categories (FR-2 for users): a name with an optional color. `owner_id` NULL means shared with
// everybody; those are read-only here. Events carry categories as plain text (iCal CATEGORIES), so
// nothing references these rows and deleting one changes no event.
import type { Database } from 'better-sqlite3'
import { conflict } from '../utils/api/errors'
import type { CategoryRow } from './types'

/** Not in the spec; stops one account from filling the table. */
export const MAX_CATEGORIES_PER_USER = 200

export interface CategoryEntry {
  id: number
  name: string
  color: string | null
  /** Shared with everybody; read-only. */
  shared: boolean
}

/** A validated create or update body. */
export interface CategoryInput {
  name: string
  color: string | null
}

function toCategory(row: CategoryRow): CategoryEntry {
  return { id: row.id, name: row.name, color: row.color, shared: row.owner_id === null }
}

/** `categories_owner_name` is unique per owner and case-insensitive; the index is the authority. */
function duplicate(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
}

function duplicateError() {
  return conflict('duplicate', 'You already have a category with this name')
}

/** The user's own and the shared categories, oldest first. */
export function listCategories(db: Database, userId: number): CategoryEntry[] {
  return db
    .prepare<[number], CategoryRow>(
      'SELECT * FROM categories WHERE owner_id IS NULL OR owner_id = ? ORDER BY id',
    )
    .all(userId)
    .map(toCategory)
}

/** Throws a 409 `duplicate` for a name the user has (in any letter case) and `limit_reached` at the cap. */
export function createCategory(db: Database, userId: number, input: CategoryInput): CategoryEntry {
  const create = db.transaction(() => {
    const { count } = db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM categories WHERE owner_id = ?',
      )
      .get(userId)!
    if (count >= MAX_CATEGORIES_PER_USER) {
      throw conflict(
        'limit_reached',
        `At most ${MAX_CATEGORIES_PER_USER} categories are allowed per user`,
      )
    }
    return db
      .prepare<[string, string | null, number], CategoryRow>(
        'INSERT INTO categories (name, color, owner_id) VALUES (?, ?, ?) RETURNING *',
      )
      .get(input.name, input.color, userId)!
  })
  try {
    return toCategory(create.immediate())
  } catch (error) {
    throw duplicate(error) ? duplicateError() : error
  }
}

/** Replaces name and color. Null when the category is not one of the user's own (shared ones too). */
export function updateCategory(
  db: Database,
  userId: number,
  id: number,
  input: CategoryInput,
): CategoryEntry | null {
  try {
    const row = db
      .prepare<[string, string | null, number, number], CategoryRow>(
        'UPDATE categories SET name = ?, color = ? WHERE id = ? AND owner_id = ? RETURNING *',
      )
      .get(input.name, input.color, id, userId)
    return row ? toCategory(row) : null
  } catch (error) {
    throw duplicate(error) ? duplicateError() : error
  }
}

export function deleteCategory(db: Database, userId: number, id: number): boolean {
  return (
    db.prepare('DELETE FROM categories WHERE id = ? AND owner_id = ?').run(id, userId).changes > 0
  )
}

/** Replaces name and colour of a category shared with everybody (admins). Null when there is none. */
export function updateSharedCategory(
  db: Database,
  id: number,
  input: CategoryInput,
): CategoryEntry | null {
  try {
    const row = db
      .prepare<[string, string | null, number], CategoryRow>(
        'UPDATE categories SET name = ?, color = ? WHERE id = ? AND owner_id IS NULL RETURNING *',
      )
      .get(input.name, input.color, id)
    return row ? toCategory(row) : null
  } catch (error) {
    throw duplicate(error) ? duplicateError() : error
  }
}

/** Deletes a category shared with everybody (admins); events keep the name as plain text. */
export function deleteSharedCategory(db: Database, id: number): CategoryEntry | null {
  const row = db
    .prepare<[number], CategoryRow>(
      'DELETE FROM categories WHERE id = ? AND owner_id IS NULL RETURNING *',
    )
    .get(id)
  return row ? toCategory(row) : null
}
