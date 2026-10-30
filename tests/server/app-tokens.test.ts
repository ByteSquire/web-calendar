// @vitest-environment node
import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AppTokenError,
  createAppToken,
  listAppTokens,
  MAX_APP_TOKENS_PER_USER,
  revokeAppToken,
  verifyAppToken,
} from '../../server/db/app-tokens'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { upsertUser } from '../../server/db/users'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))
const KEY = 'test-hash-key'
const NOW = new Date('2026-10-29T10:00:00.000Z')

let db: Database
let alice: number
let bob: number

beforeEach(() => {
  db = openDatabase(':memory:')
  runMigrations(db, loadMigrationsFromDir(migrationsDir))
  alice = upsertUser(db, { sub: 'sub-alice', username: 'alice' }, NOW).id
  bob = upsertUser(db, { sub: 'sub-bob', username: 'bob' }, NOW).id
})

afterEach(() => {
  db.close()
})

function minutesAfter(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

function lastUsed(id: number): string | null {
  return db.prepare('SELECT last_used_at FROM app_tokens WHERE id = ?').pluck().get(id) as
    string | null
}

describe('createAppToken', () => {
  it('returns a wcal_ token with 32 random bytes that expires after one year', () => {
    const created = createAppToken(db, KEY, alice, 'Thunderbird', NOW)
    expect(created.token).toMatch(/^wcal_[A-Za-z0-9_-]{43}$/)
    expect(created.expiresAt).toBe('2027-10-29T10:00:00.000Z')
    expect(created.id).toEqual(expect.any(Number))
    expect(createAppToken(db, KEY, alice, 'Other', NOW).token).not.toBe(created.token)
  })

  it('stores only the keyed hash of the token', () => {
    const { token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    const rows = db.prepare('SELECT * FROM app_tokens').all() as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_hash).toBe(createHmac('sha256', KEY).update(token).digest('hex'))
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(JSON.stringify(rows)).not.toContain(token.slice('wcal_'.length))
  })

  it('trims the label and rejects an empty or very long one', () => {
    createAppToken(db, KEY, alice, '  Laptop  ', NOW)
    expect(listAppTokens(db, alice)[0]!.label).toBe('Laptop')
    for (const label of ['', '   ', 'x'.repeat(101)]) {
      expect(() => createAppToken(db, KEY, alice, label, NOW)).toThrow(
        expect.objectContaining({ name: 'AppTokenError', code: 'invalid_label' }),
      )
    }
  })

  it('refuses to work without a hash key', () => {
    expect(() => createAppToken(db, '', alice, 'x', NOW)).toThrow(/hash key/)
    expect(() => verifyAppToken(db, '', 'alice', 'wcal_x', NOW)).toThrow(/hash key/)
  })
})

describe('limit', () => {
  function fill(userId: number, count: number, at = NOW) {
    return Array.from({ length: count }, (_, i) => createAppToken(db, KEY, userId, `t${i}`, at))
  }

  it('allows 10 unexpired tokens and throws a typed error for the 11th', () => {
    fill(alice, MAX_APP_TOKENS_PER_USER)
    const attempt = () => createAppToken(db, KEY, alice, 'one too many', NOW)
    expect(attempt).toThrow(AppTokenError)
    expect(attempt).toThrow(expect.objectContaining({ code: 'limit_reached' }))
    expect(listAppTokens(db, alice)).toHaveLength(10)
  })

  it('counts per user', () => {
    fill(alice, MAX_APP_TOKENS_PER_USER)
    expect(() => createAppToken(db, KEY, bob, 'mine', NOW)).not.toThrow()
  })

  it('frees a slot when a token is revoked', () => {
    const tokens = fill(alice, MAX_APP_TOKENS_PER_USER)
    revokeAppToken(db, alice, tokens[0]!.id)
    expect(() => createAppToken(db, KEY, alice, 'again', NOW)).not.toThrow()
  })

  it('does not count expired tokens', () => {
    fill(alice, MAX_APP_TOKENS_PER_USER, new Date('2025-01-01T00:00:00.000Z'))
    expect(() => createAppToken(db, KEY, alice, 'fresh', NOW)).not.toThrow()
    expect(listAppTokens(db, alice)).toHaveLength(11)
  })
})

describe('listAppTokens', () => {
  it('lists the own tokens, newest first, without secret or hash', () => {
    const first = createAppToken(db, KEY, alice, 'first', NOW)
    const second = createAppToken(db, KEY, alice, 'second', NOW)
    createAppToken(db, KEY, bob, 'not mine', NOW)

    const list = listAppTokens(db, alice)
    expect(list.map((t) => t.id)).toEqual([second.id, first.id])
    expect(list[0]).toEqual({
      id: second.id,
      label: 'second',
      createdAt: expect.stringMatching(/Z$/),
      expiresAt: second.expiresAt,
      lastUsedAt: null,
    })
    const json = JSON.stringify(list)
    expect(json).not.toContain(first.token)
    expect(json).not.toContain('hash')
  })

  it('still lists an expired token so it can be removed', () => {
    createAppToken(db, KEY, alice, 'old', new Date('2020-01-01T00:00:00.000Z'))
    expect(listAppTokens(db, alice)).toHaveLength(1)
  })
})

describe('verifyAppToken', () => {
  it('returns the owner for a valid token and username', () => {
    const { token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    expect(verifyAppToken(db, KEY, 'alice', token, minutesAfter(NOW, 5))).toEqual({
      sub: 'sub-alice',
      username: 'alice',
      userId: alice,
    })
  })

  it('compares the username without regard to case', () => {
    const { token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    expect(verifyAppToken(db, KEY, 'ALICE', token, NOW)?.username).toBe('alice')
  })

  it('rejects the token of another user', () => {
    const { id, token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    expect(verifyAppToken(db, KEY, 'bob', token, NOW)).toBeNull()
    expect(lastUsed(id)).toBeNull()
  })

  it('rejects an unknown token and a token under a different hash key', () => {
    const { token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    expect(verifyAppToken(db, KEY, 'alice', 'wcal_unknown', NOW)).toBeNull()
    expect(verifyAppToken(db, KEY, 'alice', token.slice(0, -1), NOW)).toBeNull()
    expect(verifyAppToken(db, 'another-key', 'alice', token, NOW)).toBeNull()
  })

  it('rejects an expired token, from the moment of expiry', () => {
    const { token, expiresAt } = createAppToken(db, KEY, alice, 'Phone', NOW)
    const expiry = new Date(expiresAt)
    expect(verifyAppToken(db, KEY, 'alice', token, new Date(expiry.getTime() - 1))).not.toBeNull()
    expect(verifyAppToken(db, KEY, 'alice', token, expiry)).toBeNull()
    expect(verifyAppToken(db, KEY, 'alice', token, minutesAfter(expiry, 1))).toBeNull()
  })

  it('rejects a revoked token at once', () => {
    const { id, token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    expect(verifyAppToken(db, KEY, 'alice', token, NOW)).not.toBeNull()
    expect(revokeAppToken(db, alice, id)).toBe(true)
    expect(verifyAppToken(db, KEY, 'alice', token, NOW)).toBeNull()
  })

  it('rejects a token whose owner has no username', () => {
    const anonymous = upsertUser(db, { sub: 'sub-anon' }, NOW).id
    const { token } = createAppToken(db, KEY, anonymous, 'x', NOW)
    expect(verifyAppToken(db, KEY, '', token, NOW)).toBeNull()
    expect(verifyAppToken(db, KEY, 'alice', token, NOW)).toBeNull()
  })

  it('follows a rename of the owner', () => {
    const { token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    upsertUser(db, { sub: 'sub-alice', username: 'alicia' }, NOW)
    expect(verifyAppToken(db, KEY, 'alice', token, NOW)).toBeNull()
    expect(verifyAppToken(db, KEY, 'alicia', token, NOW)?.userId).toBe(alice)
  })

  it('records last use, at most once a minute', () => {
    const { id, token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    expect(lastUsed(id)).toBeNull()

    const first = minutesAfter(NOW, 1)
    verifyAppToken(db, KEY, 'alice', token, first)
    expect(lastUsed(id)).toBe(first.toISOString())

    verifyAppToken(db, KEY, 'alice', token, new Date(first.getTime() + 30_000))
    expect(lastUsed(id)).toBe(first.toISOString())

    const later = new Date(first.getTime() + 60_000)
    verifyAppToken(db, KEY, 'alice', token, later)
    expect(lastUsed(id)).toBe(later.toISOString())
    expect(listAppTokens(db, alice)[0]!.lastUsedAt).toBe(later.toISOString())
  })
})

describe('revokeAppToken', () => {
  it('only removes the token of the given user', () => {
    const { id, token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    expect(revokeAppToken(db, bob, id)).toBe(false)
    expect(verifyAppToken(db, KEY, 'alice', token, NOW)).not.toBeNull()
    expect(revokeAppToken(db, alice, id)).toBe(true)
    expect(revokeAppToken(db, alice, id)).toBe(false)
    expect(listAppTokens(db, alice)).toEqual([])
  })
})

describe('rotating the hash key (L7)', () => {
  const KEY_2 = 'second-hash-key'
  const KEY_3 = 'third-hash-key'
  const key = (version: number, value: string) => ({ version, key: value })
  /** Current key first, as `parseTokenKeyring` returns it. */
  const keyring = (...keys: { version: number; key: string }[]) => ({
    current: keys[0]!,
    keys,
  })
  const hash = (value: string, token: string) =>
    createHmac('sha256', value).update(token).digest('hex')
  const stored = (id: number) =>
    db.prepare('SELECT token_hash, key_version FROM app_tokens WHERE id = ?').get(id) as {
      token_hash: string
      key_version: number
    }

  it('records the version of the current key with a new token, and hashes it with that key', () => {
    const { id, token } = createAppToken(
      db,
      keyring(key(2, KEY_2), key(1, KEY)),
      alice,
      'Phone',
      NOW,
    )
    expect(stored(id)).toEqual({ token_hash: hash(KEY_2, token), key_version: 2 })
  })

  it('treats a plain key as version 1: the same hash as before the column existed', () => {
    const { id, token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    expect(stored(id)).toEqual({ token_hash: hash(KEY, token), key_version: 1 })
  })

  it('moves the existing tokens to a new current key, one login at a time', () => {
    const phone = createAppToken(db, KEY, alice, 'Phone', NOW)
    const laptop = createAppToken(db, KEY, alice, 'Laptop', NOW)
    const rotated = keyring(key(2, KEY_2), key(1, KEY))

    expect(verifyAppToken(db, rotated, 'alice', phone.token, NOW)).toMatchObject({ userId: alice })
    expect(stored(phone.id)).toEqual({ token_hash: hash(KEY_2, phone.token), key_version: 2 })
    // The other token has not been used since the rotation.
    expect(stored(laptop.id)).toEqual({ token_hash: hash(KEY, laptop.token), key_version: 1 })

    // Both keep working, the first one now through the current key.
    expect(verifyAppToken(db, rotated, 'alice', phone.token, NOW)).not.toBeNull()
    expect(verifyAppToken(db, rotated, 'alice', laptop.token, NOW)).not.toBeNull()
    expect(stored(laptop.id).key_version).toBe(2)
  })

  it('moves a token on the very login that finds it, whatever last_used_at says', () => {
    const { id, token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    verifyAppToken(db, KEY, 'alice', token, NOW)
    const rotated = keyring(key(2, KEY_2), key(1, KEY))
    verifyAppToken(db, rotated, 'alice', token, minutesAfter(NOW, 0.5))
    expect(lastUsed(id)).toBe(NOW.toISOString())
    expect(stored(id).key_version).toBe(2)
  })

  it('lets a retired key go once its tokens have moved, and leaves the others unknown', () => {
    const moved = createAppToken(db, KEY, alice, 'Moved', NOW)
    const idle = createAppToken(db, KEY, alice, 'Idle', NOW)
    verifyAppToken(db, keyring(key(2, KEY_2), key(1, KEY)), 'alice', moved.token, NOW)

    const retired = keyring(key(2, KEY_2))
    expect(verifyAppToken(db, retired, 'alice', moved.token, NOW)).not.toBeNull()
    expect(verifyAppToken(db, retired, 'alice', idle.token, NOW)).toBeNull()
    // Nothing was touched for the unknown one.
    expect(stored(idle.id)).toEqual({ token_hash: hash(KEY, idle.token), key_version: 1 })
  })

  it('verifies with the key version the row records, not with whichever key matches', () => {
    const { token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    // The key that made the token is listed, but under another version than the row says.
    expect(verifyAppToken(db, keyring(key(3, KEY), key(1, KEY_3)), 'alice', token, NOW)).toBeNull()
    expect(
      verifyAppToken(db, keyring(key(1, KEY_3), key(2, KEY_2)), 'alice', token, NOW),
    ).toBeNull()
  })

  it('keeps working across two rotations in a row', () => {
    const { id, token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    verifyAppToken(db, keyring(key(2, KEY_2), key(1, KEY)), 'alice', token, NOW)
    const third = keyring(key(3, KEY_3), key(2, KEY_2), key(1, KEY))
    expect(verifyAppToken(db, third, 'alice', token, NOW)).not.toBeNull()
    expect(stored(id)).toEqual({ token_hash: hash(KEY_3, token), key_version: 3 })
  })

  it('goes back when the old key is put first again: the token follows', () => {
    const { id, token } = createAppToken(db, keyring(key(2, KEY_2), key(1, KEY)), alice, 'x', NOW)
    expect(
      verifyAppToken(db, keyring(key(1, KEY), key(2, KEY_2)), 'alice', token, NOW),
    ).not.toBeNull()
    expect(stored(id).key_version).toBe(1)
  })

  it('does not move a token that is expired, of another user, or wrong', () => {
    const { id, token, expiresAt } = createAppToken(db, KEY, alice, 'Phone', NOW)
    const rotated = keyring(key(2, KEY_2), key(1, KEY))
    expect(verifyAppToken(db, rotated, 'bob', token, NOW)).toBeNull()
    expect(verifyAppToken(db, rotated, 'alice', `${token}x`, NOW)).toBeNull()
    expect(verifyAppToken(db, rotated, 'alice', token, new Date(expiresAt))).toBeNull()
    expect(stored(id)).toEqual({ token_hash: hash(KEY, token), key_version: 1 })
  })

  it('refuses an empty key anywhere in the keyring', () => {
    const { token } = createAppToken(db, KEY, alice, 'Phone', NOW)
    expect(() =>
      verifyAppToken(db, keyring(key(2, KEY_2), key(1, '')), 'alice', token, NOW),
    ).toThrow(/hash key/)
  })

  it('gives tokens that existed before the column the version 1 (migration 003)', () => {
    const fresh = openDatabase(':memory:')
    const migrations = loadMigrationsFromDir(migrationsDir)
    runMigrations(
      fresh,
      migrations.filter((migration) => migration.name < '003'),
    )
    const user = upsertUser(fresh, { sub: 'sub-carol', username: 'carol' }, NOW).id
    const token = 'wcal_from-before-the-column'
    fresh
      .prepare(
        'INSERT INTO app_tokens (user_id, label, token_hash, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(user, 'Old', hash(KEY, token), '2027-10-29T10:00:00.000Z')

    expect(runMigrations(fresh, migrations)).toContain('003_app_token_key_version.sql')
    expect(fresh.prepare('SELECT key_version FROM app_tokens').pluck().all()).toEqual([1])
    expect(verifyAppToken(fresh, KEY, 'carol', token, NOW)).toMatchObject({ username: 'carol' })
    expect(() => fresh.prepare('UPDATE app_tokens SET key_version = 0').run()).toThrow(
      /CHECK constraint/,
    )
    fresh.close()
  })
})
