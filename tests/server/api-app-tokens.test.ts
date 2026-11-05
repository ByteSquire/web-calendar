// @vitest-environment node
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAppToken, MAX_APP_TOKENS_PER_USER, verifyAppToken } from '../../server/db/app-tokens'
import {
  createToken,
  listTokens,
  MAX_TOKEN_LABEL_LENGTH,
  parseTokenInput,
  revokeAllTokens,
  revokeToken,
} from '../../server/utils/api/app-tokens'
import { apiError, createUsers, openTestDb } from './api-fixtures'

const KEY = 'test-hash-key'
const NOW = new Date('2026-10-30T10:00:00.000Z')
/** Far wider than the tests' clocks, so these tests are about tokens, not about the window. */
const WINDOW = 3650 * 24 * 60 * 60 * 1000

let db: Database
let alice: number
let bob: number

beforeEach(() => {
  db = openTestDb()
  ;({ alice, bob } = createUsers(db))
})

afterEach(() => {
  db.close()
})

function parsed(body: unknown) {
  const result = parseTokenInput(body)
  return result.ok ? result.value : result.fields.map((f) => f.field)
}

describe('parseTokenInput', () => {
  it.each([
    [{ label: 'Thunderbird' }, { label: 'Thunderbird' }],
    [{ label: '  Phone  ' }, { label: 'Phone' }],
    [{ label: 'x'.repeat(MAX_TOKEN_LABEL_LENGTH) }, { label: 'x'.repeat(MAX_TOKEN_LABEL_LENGTH) }],
    [{ label: 'Laptop', expiresAt: '2099-01-01', userId: 9 }, { label: 'Laptop' }],
  ])('accepts %j', (body, expected) => {
    expect(parsed(body)).toEqual(expected)
  })

  it.each([
    ['no body', undefined, ['body', 'label']],
    ['null', null, ['body', 'label']],
    ['a string', 'Phone', ['body', 'label']],
    ['a list', ['Phone'], ['body', 'label']],
    ['an empty object', {}, ['label']],
    ['an empty label', { label: '' }, ['label']],
    ['a blank label', { label: '   ' }, ['label']],
    ['a null label', { label: null }, ['label']],
    ['a numeric label', { label: 5 }, ['label']],
    ['a list as label', { label: ['a'] }, ['label']],
    ['a label over the limit', { label: 'x'.repeat(MAX_TOKEN_LABEL_LENGTH + 1) }, ['label']],
    ['a huge label', { label: 'x'.repeat(5_000_000) }, ['label']],
  ])('rejects %s', (_label, body, fields) => {
    expect(parsed(body)).toEqual(fields)
  })
})

describe('createToken', () => {
  it('returns the secret once, with the trimmed label and the expiry', () => {
    const created = createToken(db, KEY, alice, { label: ' Thunderbird ' }, NOW)
    expect(created).toEqual({
      id: expect.any(Number),
      label: 'Thunderbird',
      token: expect.stringMatching(/^wcal_[A-Za-z0-9_-]{43}$/),
      expiresAt: '2027-10-30T10:00:00.000Z',
    })
    // the token works for CalDAV Basic auth under the owner's name
    expect(verifyAppToken(db, KEY, 'alice', created.token, WINDOW, NOW)).toMatchObject({
      userId: alice,
    })
    expect(verifyAppToken(db, KEY, 'bob', created.token, WINDOW, NOW)).toBeNull()
  })

  it('answers 400 with the field for a bad label and creates nothing', () => {
    for (const body of [undefined, {}, { label: '' }, { label: 'x'.repeat(65) }, { label: 3 }]) {
      expect(() => createToken(db, KEY, alice, body, NOW)).toThrow(
        expect.objectContaining({
          name: 'ApiError',
          statusCode: 400,
          data: {
            fields: expect.arrayContaining([
              expect.objectContaining({ field: expect.any(String) }),
            ]),
          },
        }),
      )
    }
    expect(listTokens(db, alice, NOW).tokens).toEqual([])
  })

  it('answers 409 limit_reached for the 11th token', () => {
    for (let i = 0; i < MAX_APP_TOKENS_PER_USER; i += 1) {
      createToken(db, KEY, alice, { label: `t${i}` }, NOW)
    }
    expect(() => createToken(db, KEY, alice, { label: 'one too many' }, NOW)).toThrow(
      apiError(409, 'limit_reached'),
    )
    expect(listTokens(db, alice, NOW).tokens).toHaveLength(10)
    expect(() => createToken(db, KEY, bob, { label: 'mine' }, NOW)).not.toThrow()
  })

  it('does not hide a missing hash key behind a 4xx error', () => {
    expect(() => createToken(db, '', alice, { label: 'x' }, NOW)).toThrow(/hash key/)
  })
})

describe('listTokens', () => {
  it('lists the own tokens newest first, with the limit and without any secret', () => {
    const first = createToken(db, KEY, alice, { label: 'first' }, NOW)
    const second = createToken(db, KEY, alice, { label: 'second' }, NOW)
    createToken(db, KEY, bob, { label: 'bobs' }, NOW)

    const list = listTokens(db, alice, NOW)
    expect(list.limit).toBe(10)
    expect(list.tokens.map((t) => t.id)).toEqual([second.id, first.id])
    expect(list.tokens[0]).toEqual({
      id: second.id,
      label: 'second',
      createdAt: expect.stringMatching(/Z$/),
      expiresAt: second.expiresAt,
      lastUsedAt: null,
      expired: false,
    })
    const json = JSON.stringify(list)
    expect(json).not.toContain(first.token)
    expect(json).not.toContain(second.token)
    expect(json).not.toMatch(/hash|bobs/i)
  })

  it('marks an expired token, which stays listed so it can be removed', () => {
    const old = createAppToken(db, KEY, alice, 'old', new Date('2025-01-01T00:00:00.000Z'))
    const fresh = createToken(db, KEY, alice, { label: 'fresh' }, NOW)

    const byId = new Map(listTokens(db, alice, NOW).tokens.map((t) => [t.id, t]))
    expect(byId.get(old.id)?.expired).toBe(true)
    expect(byId.get(fresh.id)?.expired).toBe(false)

    // the expiry second itself counts as expired, like the check on login
    expect(
      listTokens(db, alice, new Date(fresh.expiresAt)).tokens.find((t) => t.id === fresh.id)
        ?.expired,
    ).toBe(true)
    expect(
      listTokens(db, alice, new Date(Date.parse(fresh.expiresAt) - 1)).tokens.find(
        (t) => t.id === fresh.id,
      )?.expired,
    ).toBe(false)
  })

  it('shows when a token was last used', () => {
    const { id, token } = createToken(db, KEY, alice, { label: 'phone' }, NOW)
    const used = new Date('2026-10-31T08:00:00.000Z')
    verifyAppToken(db, KEY, 'alice', token, WINDOW, used)
    expect(listTokens(db, alice, NOW).tokens.find((t) => t.id === id)?.lastUsedAt).toBe(
      used.toISOString(),
    )
  })
})

describe('revokeToken', () => {
  it('revokes an own token, which stops working at once', () => {
    const { id, token } = createToken(db, KEY, alice, { label: 'phone' }, NOW)
    revokeToken(db, alice, String(id))
    expect(listTokens(db, alice, NOW).tokens).toEqual([])
    expect(verifyAppToken(db, KEY, 'alice', token, WINDOW, NOW)).toBeNull()
  })

  it('answers 404 for the token of another user and leaves it alone', () => {
    const mine = createToken(db, KEY, alice, { label: 'alice' }, NOW)
    expect(() => revokeToken(db, bob, String(mine.id))).toThrow(apiError(404))
    expect(listTokens(db, alice, NOW).tokens).toHaveLength(1)
    expect(verifyAppToken(db, KEY, 'alice', mine.token, WINDOW, NOW)).not.toBeNull()
  })

  it('answers 404 for an unknown id, a repeat and ids that are no numbers', () => {
    const { id } = createToken(db, KEY, alice, { label: 'phone' }, NOW)
    revokeToken(db, alice, String(id))
    for (const raw of [String(id), '99999', '0', '-1', '1.5', 'abc', '', undefined, null, ['1']]) {
      expect(() => revokeToken(db, alice, raw)).toThrow(apiError(404))
    }
  })

  it('frees a slot', () => {
    const tokens = Array.from({ length: MAX_APP_TOKENS_PER_USER }, (_, i) =>
      createToken(db, KEY, alice, { label: `t${i}` }, NOW),
    )
    revokeToken(db, alice, String(tokens[0]!.id))
    expect(() => createToken(db, KEY, alice, { label: 'again' }, NOW)).not.toThrow()
  })
})

describe('revokeAllTokens', () => {
  it('revokes every own token at once, which stops them all working', () => {
    const phone = createToken(db, KEY, alice, { label: 'phone' }, NOW)
    const laptop = createToken(db, KEY, alice, { label: 'laptop' }, NOW)
    expect(revokeAllTokens(db, alice)).toEqual({ revoked: 2 })
    expect(listTokens(db, alice, NOW).tokens).toEqual([])
    expect(verifyAppToken(db, KEY, 'alice', phone.token, WINDOW, NOW)).toBeNull()
    expect(verifyAppToken(db, KEY, 'alice', laptop.token, WINDOW, NOW)).toBeNull()
  })

  it('leaves another user untouched and reports zero for an empty list', () => {
    const mine = createToken(db, KEY, alice, { label: 'alice' }, NOW)
    expect(revokeAllTokens(db, bob)).toEqual({ revoked: 0 })
    expect(listTokens(db, alice, NOW).tokens).toHaveLength(1)
    expect(verifyAppToken(db, KEY, 'alice', mine.token, WINDOW, NOW)).not.toBeNull()
  })

  it('frees every slot, so a full user can create tokens again', () => {
    Array.from({ length: MAX_APP_TOKENS_PER_USER }, (_, i) =>
      createToken(db, KEY, alice, { label: `t${i}` }, NOW),
    )
    revokeAllTokens(db, alice)
    expect(() => createToken(db, KEY, alice, { label: 'again' }, NOW)).not.toThrow()
  })
})
