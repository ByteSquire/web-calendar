// @vitest-environment node
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { findUserBySub, setUserTimeZone, upsertUser } from '../../server/db/users'
import { parseTimeZoneInput } from '../../server/utils/api/time-zone'
import { apiError, createUsers, openTestDb } from './api-fixtures'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))

let db: Database

afterEach(() => {
  db.close()
})

describe('migration 002_user_time_zone.sql', () => {
  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  it('adds users.time_zone, empty for the users that exist already', () => {
    const migrations = loadMigrationsFromDir(migrationsDir)
    runMigrations(
      db,
      migrations.filter((migration) => migration.name === '001_init.sql'),
    )
    db.prepare('INSERT INTO users (oidc_sub) VALUES (?)').run('sub-before')

    expect(runMigrations(db, migrations)).toContain('002_user_time_zone.sql')
    expect(db.prepare('SELECT time_zone FROM users').pluck().all()).toEqual([null])
  })

  it('takes NULL or a name, but not an empty string', () => {
    runMigrations(db, loadMigrationsFromDir(migrationsDir))
    const insert = db.prepare('INSERT INTO users (oidc_sub, time_zone) VALUES (?, ?)')
    insert.run('sub-1', null)
    insert.run('sub-2', 'Europe/Berlin')
    expect(() => insert.run('sub-3', '')).toThrow(/CHECK constraint/)
  })
})

describe('setUserTimeZone', () => {
  let alice: number
  let bob: number

  beforeEach(() => {
    db = openTestDb()
    ;({ alice, bob } = createUsers(db))
  })

  it("starts as the browser's zone, which is null", () => {
    expect(findUserBySub(db, 'sub-alice')!.timeZone).toBeNull()
  })

  it('stores a zone, returns it and changes only that user', () => {
    expect(setUserTimeZone(db, alice, 'Australia/Sydney')).toBe('Australia/Sydney')
    expect(findUserBySub(db, 'sub-alice')!.timeZone).toBe('Australia/Sydney')
    expect(findUserBySub(db, 'sub-bob')!.timeZone).toBeNull()
  })

  it('changes a zone and clears it again with null', () => {
    setUserTimeZone(db, alice, 'Australia/Sydney')
    expect(setUserTimeZone(db, alice, 'Asia/Tokyo')).toBe('Asia/Tokyo')
    expect(setUserTimeZone(db, alice, null)).toBeNull()
    expect(findUserBySub(db, 'sub-alice')!.timeZone).toBeNull()
  })

  it('touches updated_at', () => {
    const old = '2020-01-01T00:00:00.000Z'
    db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(old, bob)
    setUserTimeZone(db, bob, 'UTC')
    const updatedAt = db.prepare('SELECT updated_at FROM users WHERE id = ?').pluck().get(bob)
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(updatedAt).not.toBe(old)
  })

  it('answers 404 for a user that does not exist', () => {
    expect(() => setUserTimeZone(db, 9999, 'UTC')).toThrow(apiError(404))
  })

  it('survives the profile refresh that every request does', () => {
    setUserTimeZone(db, alice, 'Australia/Sydney')
    expect(upsertUser(db, { sub: 'sub-alice' }).timeZone).toBe('Australia/Sydney')
    expect(
      upsertUser(db, { sub: 'sub-alice', username: 'alicia', name: 'Alicia', isAdmin: true })
        .timeZone,
    ).toBe('Australia/Sydney')
  })
})

describe('parseTimeZoneInput', () => {
  function parsed(body: unknown) {
    const result = parseTimeZoneInput(body)
    return result.ok ? result.value : result.fields
  }

  it.each([
    'Europe/Berlin',
    'America/Argentina/Buenos_Aires',
    'America/Port-au-Prince',
    'Etc/GMT+5',
    'Asia/Kolkata',
    'UTC',
  ])('accepts %s as it is', (zone) => {
    expect(parsed({ timeZone: zone })).toEqual({ timeZone: zone })
  })

  it('keeps the spelling that was sent', () => {
    expect(parsed({ timeZone: 'europe/berlin' })).toEqual({ timeZone: 'europe/berlin' })
  })

  it("takes null to use the browser's zone again, and ignores other fields", () => {
    expect(parsed({ timeZone: null })).toEqual({ timeZone: null })
    expect(parsed({ timeZone: 'UTC', extra: 1 })).toEqual({ timeZone: 'UTC' })
  })

  const NO_BODY = [
    { field: 'body', message: 'must be a JSON object' },
    { field: 'timeZone', message: 'is required' },
  ]
  const REQUIRED = [{ field: 'timeZone', message: 'is required' }]
  const NOT_A_STRING = [{ field: 'timeZone', message: 'must be a string or null' }]
  const NOT_A_ZONE = [
    { field: 'timeZone', message: 'must be a time zone name such as Europe/Berlin' },
  ]
  const TOO_LONG = [{ field: 'timeZone', message: 'must have at most 64 characters' }]

  it.each([
    ['no body', undefined, NO_BODY],
    ['a list', [], NO_BODY],
    ['no field, which would clear the zone by accident', {}, REQUIRED],
    ['a number', { timeZone: 5 }, NOT_A_STRING],
    ['a boolean', { timeZone: false }, NOT_A_STRING],
    ['a list of names', { timeZone: ['UTC'] }, NOT_A_STRING],
    ['an object', { timeZone: {} }, NOT_A_STRING],
    ['an empty string', { timeZone: '' }, NOT_A_ZONE],
    ['only spaces', { timeZone: '  ' }, NOT_A_ZONE],
    ['a padded name', { timeZone: ' Europe/Berlin' }, NOT_A_ZONE],
    ['a name with a line break', { timeZone: 'Europe/Berlin\n' }, NOT_A_ZONE],
    ['a name Intl does not know', { timeZone: 'Mars/Olympus' }, NOT_A_ZONE],
    ['a city without its region', { timeZone: 'Berlin' }, NOT_A_ZONE],
    ['a UTC offset', { timeZone: '+01:00' }, NOT_A_ZONE],
    ['an offset after UTC', { timeZone: 'UTC+1' }, NOT_A_ZONE],
    ['a path', { timeZone: '../../etc/passwd' }, NOT_A_ZONE],
    ['markup', { timeZone: '<script>alert(1)</script>' }, NOT_A_ZONE],
    ['a name with other letters', { timeZone: 'Europe/Zürich' }, NOT_A_ZONE],
    ['a repeated slash', { timeZone: 'Europe//Berlin' }, NOT_A_ZONE],
    ['a name that is too long', { timeZone: `Europe/${'A'.repeat(60)}` }, TOO_LONG],
    ['a megabyte', { timeZone: 'A'.repeat(1_000_000) }, TOO_LONG],
  ])('rejects %s', (_label, body, fields) => {
    expect(parsed(body)).toEqual(fields)
  })

  it('does not repeat the input in its messages', () => {
    for (const hostile of ['<script>alert(1)</script>', '../../etc/passwd', 'Mars/Olympus']) {
      expect(JSON.stringify(parsed({ timeZone: hostile }))).not.toContain(hostile)
    }
  })
})
