import { createHmac, randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { AppTokenRow } from './types'

/** FR-31: at most this many unexpired tokens per user. */
export const MAX_APP_TOKENS_PER_USER = 10
const MAX_LABEL_LENGTH = 100
const TOKEN_PREFIX = 'wcal_'
/** `last_used_at` is refreshed at most this often, so a busy client does not write on every request. */
const LAST_USED_INTERVAL_MS = 60_000

export class AppTokenError extends Error {
  constructor(
    readonly code: 'limit_reached' | 'invalid_label',
    message: string,
  ) {
    super(message)
    this.name = 'AppTokenError'
  }
}

export interface CreatedAppToken {
  id: number
  /** The secret. It is shown once and cannot be recovered. */
  token: string
  expiresAt: string
}

/** What a user sees in the token list; never the secret or its hash. */
export interface AppTokenSummary {
  id: number
  label: string
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
}

export interface VerifiedAppToken {
  sub: string
  username: string
  userId: number
}

function hashToken(hashKey: string, token: string): string {
  if (!hashKey) throw new Error('The app token hash key is not configured')
  return createHmac('sha256', hashKey).update(token).digest('hex')
}

/** Creates a token that expires after one year. A user at the limit gets an `AppTokenError`. */
export function createAppToken(
  db: Database,
  hashKey: string,
  userId: number,
  label: string,
  now = new Date(),
): CreatedAppToken {
  const cleanLabel = label.trim()
  if (!cleanLabel || cleanLabel.length > MAX_LABEL_LENGTH) {
    throw new AppTokenError(
      'invalid_label',
      `A token label needs 1 to ${MAX_LABEL_LENGTH} characters`,
    )
  }

  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const tokenHash = hashToken(hashKey, token)
  const expires = new Date(now)
  expires.setUTCFullYear(expires.getUTCFullYear() + 1)
  const expiresAt = expires.toISOString()

  const create = db.transaction(() => {
    const { count } = db
      .prepare<[number, string], { count: number }>(
        'SELECT COUNT(*) AS count FROM app_tokens WHERE user_id = ? AND expires_at > ?',
      )
      .get(userId, now.toISOString())!
    if (count >= MAX_APP_TOKENS_PER_USER) {
      throw new AppTokenError(
        'limit_reached',
        `At most ${MAX_APP_TOKENS_PER_USER} app tokens are allowed per user`,
      )
    }
    const { lastInsertRowid } = db
      .prepare(
        'INSERT INTO app_tokens (user_id, label, token_hash, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(userId, cleanLabel, tokenHash, expiresAt)
    return Number(lastInsertRowid)
  })
  return { id: create.immediate(), token, expiresAt }
}

/** All tokens of the user, newest first, expired ones included so they can be removed. */
export function listAppTokens(db: Database, userId: number): AppTokenSummary[] {
  return db
    .prepare<
      [number],
      Pick<AppTokenRow, 'id' | 'label' | 'created_at' | 'expires_at' | 'last_used_at'>
    >(
      `SELECT id, label, created_at, expires_at, last_used_at FROM app_tokens
       WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(userId)
    .map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
    }))
}

/** Deletes the token at once. Returns false when the user has no such token. */
export function revokeAppToken(db: Database, userId: number, id: number): boolean {
  return (
    db.prepare('DELETE FROM app_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
  )
}

/**
 * Checks the Basic-auth credentials of a CalDAV client. Returns the owner of the token, or null
 * for an unknown, expired or revoked token and when `username` is not the owner's name.
 */
export function verifyAppToken(
  db: Database,
  hashKey: string,
  username: string,
  token: string,
  now = new Date(),
): VerifiedAppToken | null {
  const row = db
    .prepare<
      [string, string],
      Pick<AppTokenRow, 'id' | 'expires_at'> & {
        user_id: number
        oidc_sub: string
        username: string
      }
    >(
      // users.username compares case-insensitively.
      `SELECT t.id, t.expires_at, u.id AS user_id, u.oidc_sub, u.username
       FROM app_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND u.username = ?`,
    )
    .get(hashToken(hashKey, token), username)
  if (!row || row.expires_at <= now.toISOString()) return null

  db.prepare(
    'UPDATE app_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)',
  ).run(now.toISOString(), row.id, new Date(now.getTime() - LAST_USED_INTERVAL_MS).toISOString())
  return { sub: row.oidc_sub, username: row.username, userId: row.user_id }
}
