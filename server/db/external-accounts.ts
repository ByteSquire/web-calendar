import type { Database } from 'better-sqlite3'
import {
  MAX_EXTERNAL_ACCOUNTS,
  type ExternalAccount,
  type ExternalAuthMode,
} from '../../shared/types/external'
import type { ExternalAccountRow } from './types'

// The non-secret part of a user's external CalDAV accounts (FR-8). Every function takes the user's
// id and only ever sees that user's rows, so another user's account id is simply "not found".

export class ExternalAccountError extends Error {
  constructor(
    readonly code: 'limit_reached' | 'duplicate',
    message: string,
  ) {
    super(message)
    this.name = 'ExternalAccountError'
  }
}

/** An account as the API shows it, and the origin the server derived from its address. */
export interface StoredExternalAccount {
  account: ExternalAccount
  /** `new URL(url).origin`. Not part of the API shape; the proxy and the seal use it. */
  origin: string
}

/** Already validated and normalised (server/utils/external/account-input.ts). */
export interface ExternalAccountFields {
  name: string
  /** Normalised `href`, no fragment. */
  url: string
  /** `new URL(url).origin`. */
  origin: string
  authMode: ExternalAuthMode
  /** Set exactly when `authMode` is `basic`. */
  username: string | null
  color: string | null
}

function toStored(row: ExternalAccountRow): StoredExternalAccount {
  return {
    origin: row.origin,
    account: {
      id: row.id,
      name: row.name,
      url: row.url,
      authMode: row.auth_mode,
      username: row.username,
      color: row.color,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  }
}

/** The user's accounts, oldest first. */
export function listExternalAccounts(db: Database, userId: number): ExternalAccount[] {
  return db
    .prepare<[number], ExternalAccountRow>(
      'SELECT * FROM external_accounts WHERE user_id = ? ORDER BY id',
    )
    .all(userId)
    .map((row) => toStored(row).account)
}

/** One of the user's accounts. Null for a missing id and for someone else's alike. */
export function findExternalAccount(
  db: Database,
  userId: number,
  id: number,
): StoredExternalAccount | null {
  const row = db
    .prepare<[number, number], ExternalAccountRow>(
      'SELECT * FROM external_accounts WHERE id = ? AND user_id = ?',
    )
    .get(id, userId)
  return row ? toStored(row) : null
}

function hasUrl(db: Database, userId: number, url: string, exceptId: number): boolean {
  return (
    db
      .prepare<[number, string, number], { found: 1 }>(
        'SELECT 1 AS found FROM external_accounts WHERE user_id = ? AND url = ? AND id <> ?',
      )
      .get(userId, url, exceptId) !== undefined
  )
}

function duplicateError(): ExternalAccountError {
  return new ExternalAccountError('duplicate', 'You already added an account with this address')
}

/** Throws `ExternalAccountError` at the limit and for an address the user already has. */
export function createExternalAccount(
  db: Database,
  userId: number,
  fields: ExternalAccountFields,
): StoredExternalAccount {
  const create = db.transaction(() => {
    const { count } = db
      .prepare<[number], { count: number }>(
        'SELECT COUNT(*) AS count FROM external_accounts WHERE user_id = ?',
      )
      .get(userId)!
    if (count >= MAX_EXTERNAL_ACCOUNTS) {
      throw new ExternalAccountError(
        'limit_reached',
        `At most ${MAX_EXTERNAL_ACCOUNTS} external accounts are allowed per user`,
      )
    }
    if (hasUrl(db, userId, fields.url, 0)) throw duplicateError()
    return db
      .prepare<
        [number, string, string, string, string, string | null, string | null],
        ExternalAccountRow
      >(
        `INSERT INTO external_accounts (user_id, name, url, origin, auth_mode, username, color)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        userId,
        fields.name,
        fields.url,
        fields.origin,
        fields.authMode,
        fields.username,
        fields.color,
      )!
  })
  return toStored(create.immediate())
}

/** Replaces the fields of one of the user's accounts. Null when there is no such row of theirs. */
export function updateExternalAccount(
  db: Database,
  userId: number,
  id: number,
  fields: ExternalAccountFields,
): StoredExternalAccount | null {
  const update = db.transaction(() => {
    if (!findExternalAccount(db, userId, id)) return undefined
    if (hasUrl(db, userId, fields.url, id)) throw duplicateError()
    return db
      .prepare<
        [string, string, string, string, string | null, string | null, number, number],
        ExternalAccountRow
      >(
        `UPDATE external_accounts
         SET name = ?, url = ?, origin = ?, auth_mode = ?, username = ?, color = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND user_id = ? RETURNING *`,
      )
      .get(
        fields.name,
        fields.url,
        fields.origin,
        fields.authMode,
        fields.username,
        fields.color,
        id,
        userId,
      )
  })
  const row = update.immediate()
  return row ? toStored(row) : null
}

/** Deletes one of the user's accounts. False when there is no such row of theirs. */
export function deleteExternalAccount(db: Database, userId: number, id: number): boolean {
  return (
    db.prepare('DELETE FROM external_accounts WHERE id = ? AND user_id = ?').run(id, userId)
      .changes > 0
  )
}
