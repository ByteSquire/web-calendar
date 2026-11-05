import { createHmac, randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { signinCutoff } from '../utils/auth/window'
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

/** A key that hashes app tokens, with the id stored in `app_tokens.key_version` of its tokens. */
export interface TokenKey {
  version: number
  key: string
}

/**
 * The configured hash keys (L7): new tokens are hashed with `current`, and `keys` lists every key a
 * stored token may have been hashed with, `current` included. Built from the environment by
 * `parseTokenKeyring` in server/utils/auth/token-keys.ts.
 */
export interface TokenKeyring {
  current: TokenKey
  keys: readonly TokenKey[]
}

/** What the token functions take: a keyring, or one key, which is key version 1. */
export type TokenHashKeys = string | TokenKeyring

function toKeyring(hashKeys: TokenHashKeys): TokenKeyring {
  if (typeof hashKeys !== 'string') return hashKeys
  const only = { version: 1, key: hashKeys }
  return { current: only, keys: [only] }
}

// The hash is the same for every key version: HMAC-SHA256 of the token, in hex. The version lives
// in its own column, so tokens hashed before the column existed (version 1) still match.
function hashToken(hashKey: string, token: string): string {
  if (!hashKey) throw new Error('The app token hash key is not configured')
  return createHmac('sha256', hashKey).update(token).digest('hex')
}

/**
 * Creates a token that expires after one year, hashed with the current key. A user at the limit
 * gets an `AppTokenError`.
 */
export function createAppToken(
  db: Database,
  hashKeys: TokenHashKeys,
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

  const { current } = toKeyring(hashKeys)
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const tokenHash = hashToken(current.key, token)
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
        'INSERT INTO app_tokens (user_id, label, token_hash, key_version, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(userId, cleanLabel, tokenHash, current.version, expiresAt)
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

/** Deletes every one of the user's tokens at once (security review 2026-11-01, finding 3). Returns
 *  how many were deleted. */
export function revokeAllAppTokens(db: Database, userId: number): number {
  return db.prepare('DELETE FROM app_tokens WHERE user_id = ?').run(userId).changes
}

/**
 * Checks the Basic-auth credentials of a CalDAV client. Returns the owner of the token, or null
 * for an unknown, expired or revoked token and when `username` is not the owner's name.
 *
 * A token is accepted only with the key version its row records. One that was hashed with an older
 * key is hashed again with the current one on this login, so a rotated key retires itself as the
 * tokens are used. A token whose version is no longer configured is unknown.
 */
export function verifyAppToken(
  db: Database,
  hashKeys: TokenHashKeys,
  username: string,
  token: string,
  windowMs: number,
  now = new Date(),
): VerifiedAppToken | null {
  const keyring = toKeyring(hashKeys)
  const hashes = keyring.keys.map(({ version, key }) => ({ version, hash: hashToken(key, token) }))
  const rows = db
    .prepare<
      unknown[],
      Pick<AppTokenRow, 'id' | 'token_hash' | 'key_version' | 'expires_at'> & {
        user_id: number
        oidc_sub: string
        username: string
        last_seen_at: string | null
      }
    >(
      // users.username compares case-insensitively.
      `SELECT t.id, t.token_hash, t.key_version, t.expires_at, u.id AS user_id, u.oidc_sub, u.username,
              u.last_seen_at
       FROM app_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash IN (${hashes.map(() => '?').join(', ')}) AND u.username = ?`,
    )
    .all(...hashes.map(({ hash }) => hash), username)
  const row = rows.find((candidate) =>
    hashes.some(
      ({ version, hash }) => version === candidate.key_version && hash === candidate.token_hash,
    ),
  )
  if (!row || row.expires_at <= now.toISOString()) return null
  // The owner must have signed in within the window (NUXT_SIGNIN_WINDOW_DAYS): a token cannot
  // outlive the person's presence at the identity provider by more than that. Only a sign-in to the
  // web app or an OIDC bearer call renews it; using this token does not. Seen exactly at the
  // cutoff still counts. Both sides are ISO text of the same shape, so they compare as times.
  if (row.last_seen_at === null || row.last_seen_at < signinCutoff(windowMs, now)) return null

  if (row.key_version !== keyring.current.version) {
    // Guarded by the old version, so two logins at once cannot undo each other.
    db.prepare(
      'UPDATE app_tokens SET token_hash = ?, key_version = ? WHERE id = ? AND key_version = ?',
    ).run(
      hashes.find(({ version }) => version === keyring.current.version)!.hash,
      keyring.current.version,
      row.id,
      row.key_version,
    )
  }
  db.prepare(
    'UPDATE app_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)',
  ).run(now.toISOString(), row.id, new Date(now.getTime() - LAST_USED_INTERVAL_MS).toISOString())
  return { sub: row.oidc_sub, username: row.username, userId: row.user_id }
}
