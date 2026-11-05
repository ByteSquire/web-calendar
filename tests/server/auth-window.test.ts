// @vitest-environment node
// The sign-in window (NUXT_SIGNIN_WINDOW_DAYS): the setting's range and the cutoff string that is
// compared with `users.last_seen_at`, which is stored as ISO text.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIGNIN_WINDOW_DAYS,
  parseSigninWindowDays,
  signinCutoff,
  signinWindowMsOf,
} from '../../server/utils/auth/window'
import { openTestDb } from './api-fixtures'
import { upsertUser } from '../../server/db/users'

const DAY = 24 * 60 * 60 * 1000

describe('the window setting', () => {
  it('is 30 days when the setting is empty or missing', () => {
    expect(DEFAULT_SIGNIN_WINDOW_DAYS).toBe(30)
    expect(parseSigninWindowDays('')).toBe(30)
    expect(parseSigninWindowDays('  ')).toBe(30)
    expect(parseSigninWindowDays(undefined)).toBe(30)
  })

  it('takes a whole number of days from 1 to 365, spaces around it ignored', () => {
    expect(parseSigninWindowDays('1')).toBe(1)
    expect(parseSigninWindowDays('365')).toBe(365)
    expect(parseSigninWindowDays(' 7 ')).toBe(7)
    expect(signinWindowMsOf('2')).toBe(2 * DAY)
  })

  it.each(['0', '366', '-1', '1.5', '30d', 'abc', '1e2', '0x10', '+5', '99999'])(
    'refuses %j, so a typo stops the server instead of changing the window',
    (value) => {
      expect(() => parseSigninWindowDays(value)).toThrow(/NUXT_SIGNIN_WINDOW_DAYS/)
    },
  )
})

describe('the cutoff', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z')

  it('is the ISO text of now minus the window', () => {
    expect(signinCutoff(30 * DAY, NOW)).toBe('2026-05-16T12:00:00.000Z')
  })

  it('compares as text with the last_seen_at that upsertUser stores', () => {
    const db = openTestDb()
    try {
      const cutoff = signinCutoff(30 * DAY, NOW)
      const stored = (sub: string, at: Date) => {
        upsertUser(db, { sub, username: sub }, at)
        return db
          .prepare<[string, string], { inside: number }>(
            'SELECT last_seen_at >= ? AS inside FROM users WHERE oidc_sub = ? ',
          )
          .get(cutoff, sub)!.inside
      }
      // The same text format on both sides: the boundary is inclusive, a millisecond earlier is out.
      expect(stored('on-the-line', new Date(NOW.getTime() - 30 * DAY))).toBe(1)
      expect(stored('a-ms-late', new Date(NOW.getTime() - 30 * DAY - 1))).toBe(0)
      expect(stored('fresh', NOW)).toBe(1)
      expect(
        db.prepare<[], { last_seen_at: string }>('SELECT last_seen_at FROM users LIMIT 1').get()!
          .last_seen_at,
      ).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    } finally {
      db.close()
    }
  })
})
