import type { Database } from 'better-sqlite3'
import type { ResourceRow, ResourceType } from './types'

// Bookable things (design §5). A resource is not a calendar; its availability comes from bookings.

export interface ResourceFields {
  name: string
  type: ResourceType
  location: string | null
  capacity: number | null
  description: string | null
}

/**
 * Creates a resource and its default rule "any authenticated user may book" in one transaction.
 * Managers are added to resource_acl by the caller.
 */
export function createResource(db: Database, fields: ResourceFields): ResourceRow {
  const create = db.transaction(() => {
    const row = db
      .prepare<[string, string, string | null, number | null, string | null], ResourceRow>(
        `INSERT INTO resources (name, type, location, capacity, description)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(fields.name, fields.type, fields.location, fields.capacity, fields.description)!
    db.prepare(
      `INSERT INTO resource_acl (resource_id, principal_type, principal, "right")
       VALUES (?, 'authenticated', NULL, 'book')`,
    ).run(row.id)
    return row
  })
  return create.immediate()
}

export function getResource(db: Database, id: number): ResourceRow | null {
  return db.prepare<[number], ResourceRow>('SELECT * FROM resources WHERE id = ?').get(id) ?? null
}

/** Resources by name (then id); deactivated ones only with `includeInactive`. */
export function listResources(
  db: Database,
  options: { includeInactive?: boolean } = {},
): ResourceRow[] {
  const where = options.includeInactive ? '' : 'WHERE active = 1'
  return db
    .prepare<[], ResourceRow>(`SELECT * FROM resources ${where} ORDER BY name COLLATE NOCASE, id`)
    .all()
}

/** Changes the given fields (and `active`). Null when there is no such resource. */
export function updateResource(
  db: Database,
  id: number,
  patch: Partial<ResourceFields> & { active?: boolean },
): ResourceRow | null {
  const update = db.transaction(() => {
    const current = getResource(db, id)
    if (!current) return null
    const next = {
      name: patch.name ?? current.name,
      type: patch.type ?? current.type,
      location: patch.location === undefined ? current.location : patch.location,
      capacity: patch.capacity === undefined ? current.capacity : patch.capacity,
      description: patch.description === undefined ? current.description : patch.description,
      active: patch.active === undefined ? current.active : patch.active ? 1 : 0,
    }
    return db
      .prepare<
        [string, string, string | null, number | null, string | null, number, number],
        ResourceRow
      >(
        `UPDATE resources SET name = ?, type = ?, location = ?, capacity = ?, description = ?,
           active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? RETURNING *`,
      )
      .get(next.name, next.type, next.location, next.capacity, next.description, next.active, id)!
  })
  return update.immediate()
}

/** Stops new bookings; existing ones stay. Null when there is no such resource. */
export function deactivateResource(db: Database, id: number): ResourceRow | null {
  return updateResource(db, id, { active: false })
}
