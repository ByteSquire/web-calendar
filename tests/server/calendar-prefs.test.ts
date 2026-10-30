// @vitest-environment node
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteCalendarPref,
  listCalendarPrefs,
  MAX_PREFS_PER_USER,
  setCalendarPref,
} from '../../server/db/calendar-prefs'
import { parseCalendarPrefInput, parseCalendarPrefRef } from '../../server/utils/api/calendar-prefs'
import { apiError, createUsers, openTestDb } from './api-fixtures'

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

const WORK = 'dav:/caldav/sub-alice/work/'
const HOME = 'dav:/caldav/sub-alice/home/'

function parsed(body: unknown) {
  const result = parseCalendarPrefInput(body)
  return result.ok ? result.value : result.fields.map((f) => f.field)
}

describe('parseCalendarPrefInput', () => {
  it('keeps what the client sent and leaves out what it did not', () => {
    expect(parsed({ ref: WORK })).toEqual({ ref: WORK, color: undefined, visible: undefined })
    expect(parsed({ ref: WORK, color: '#ABCDEF', visible: false })).toEqual({
      ref: WORK,
      color: '#abcdef',
      visible: false,
    })
    expect(parsed({ ref: WORK, color: null })).toEqual({
      ref: WORK,
      color: null,
      visible: undefined,
    })
    expect(parsed({ ref: 'ics:4', visible: true, extra: 1 })).toEqual({
      ref: 'ics:4',
      color: undefined,
      visible: true,
    })
  })

  it.each([
    ['no body', undefined, ['body', 'ref']],
    ['null', null, ['body', 'ref']],
    ['a list', [], ['body', 'ref']],
    ['no ref', { color: '#112233' }, ['ref']],
    ['a null ref', { ref: null }, ['ref']],
    ['a bad ref', { ref: 'calendar-1' }, ['ref']],
    ['an empty ref', { ref: '' }, ['ref']],
    ['a ref with only the prefix', { ref: 'dav:' }, ['ref']],
    ['a huge ref', { ref: `ics:${'x'.repeat(100_000)}` }, ['ref']],
    ['a bad color', { ref: WORK, color: 'blue' }, ['color']],
    ['a short color', { ref: WORK, color: '#123' }, ['color']],
    ['visible as a string', { ref: WORK, visible: 'true' }, ['visible']],
    ['visible as a number', { ref: WORK, visible: 1 }, ['visible']],
    ['visible as null', { ref: WORK, visible: null }, ['visible']],
    ['everything wrong', { ref: 1, color: 2, visible: 3 }, ['ref', 'color', 'visible']],
  ])('rejects %s', (_label, body, fields) => {
    expect(parsed(body)).toEqual(fields)
  })
})

describe('parseCalendarPrefRef', () => {
  it.each([
    [{ ref: WORK }, { ok: true, value: WORK }],
    [{ ref: 'ics:9' }, { ok: true, value: 'ics:9' }],
    [{}, { ok: false, fields: [{ field: 'ref', message: 'is required' }] }],
    [
      { ref: ['ics:1', 'ics:2'] },
      { ok: false, fields: [{ field: 'ref', message: 'must be a string' }] },
    ],
  ])('%j', (query, expected) => {
    expect(parseCalendarPrefRef(query)).toEqual(expected)
  })

  it('rejects a ref with a bad shape', () => {
    expect(parseCalendarPrefRef({ ref: 'nope' }).ok).toBe(false)
    expect(parseCalendarPrefRef({ ref: '' }).ok).toBe(false)
  })
})

describe('calendar prefs in the database', () => {
  it('starts a new pref visible and without color', () => {
    expect(setCalendarPref(db, alice, { ref: WORK })).toEqual({
      ref: WORK,
      color: null,
      visible: true,
    })
    expect(listCalendarPrefs(db, alice)).toEqual([{ ref: WORK, color: null, visible: true }])
  })

  it('creates a pref with the given values', () => {
    expect(setCalendarPref(db, alice, { ref: WORK, color: '#112233', visible: false })).toEqual({
      ref: WORK,
      color: '#112233',
      visible: false,
    })
  })

  it('keeps a field the update leaves out', () => {
    setCalendarPref(db, alice, { ref: WORK, color: '#112233', visible: false })

    expect(setCalendarPref(db, alice, { ref: WORK, visible: true })).toEqual({
      ref: WORK,
      color: '#112233',
      visible: true,
    })
    expect(setCalendarPref(db, alice, { ref: WORK, color: '#445566' })).toEqual({
      ref: WORK,
      color: '#445566',
      visible: true,
    })
    expect(setCalendarPref(db, alice, { ref: WORK })).toEqual({
      ref: WORK,
      color: '#445566',
      visible: true,
    })
    expect(listCalendarPrefs(db, alice)).toHaveLength(1)
  })

  it('clears the color override with null and leaves the visibility', () => {
    setCalendarPref(db, alice, { ref: WORK, color: '#112233', visible: false })
    expect(setCalendarPref(db, alice, { ref: WORK, color: null })).toEqual({
      ref: WORK,
      color: null,
      visible: false,
    })
  })

  it('lets a first update with color null create a row without color', () => {
    expect(setCalendarPref(db, alice, { ref: HOME, color: null, visible: false })).toEqual({
      ref: HOME,
      color: null,
      visible: false,
    })
  })

  it('lists sorted by ref, whatever the order of creation', () => {
    for (const ref of ['ics:2', WORK, 'ext:a:https://x/', HOME, 'ics:1']) {
      setCalendarPref(db, alice, { ref })
    }
    expect(listCalendarPrefs(db, alice).map((p) => p.ref)).toEqual([
      HOME,
      WORK,
      'ext:a:https://x/',
      'ics:1',
      'ics:2',
    ])
  })

  it('keeps users apart', () => {
    setCalendarPref(db, alice, { ref: WORK, color: '#112233' })
    setCalendarPref(db, bob, { ref: WORK, color: '#abcdef', visible: false })

    expect(listCalendarPrefs(db, alice)).toEqual([{ ref: WORK, color: '#112233', visible: true }])
    expect(listCalendarPrefs(db, bob)).toEqual([{ ref: WORK, color: '#abcdef', visible: false }])

    deleteCalendarPref(db, bob, WORK)
    expect(listCalendarPrefs(db, bob)).toEqual([])
    expect(listCalendarPrefs(db, alice)).toHaveLength(1)
  })

  it('deletes one pref and is quiet about a pref that is not there', () => {
    setCalendarPref(db, alice, { ref: WORK })
    setCalendarPref(db, alice, { ref: HOME })
    deleteCalendarPref(db, alice, WORK)
    expect(listCalendarPrefs(db, alice).map((p) => p.ref)).toEqual([HOME])
    expect(() => deleteCalendarPref(db, alice, WORK)).not.toThrow()
    expect(() => deleteCalendarPref(db, alice, 'ics:404')).not.toThrow()
  })

  it('treats refs as exact strings', () => {
    setCalendarPref(db, alice, { ref: 'ics:1' })
    setCalendarPref(db, alice, { ref: 'ics:1 ' })
    setCalendarPref(db, alice, { ref: 'ics:1/' })
    expect(listCalendarPrefs(db, alice)).toHaveLength(3)
  })

  it('allows 500 refs per user; changing an existing one still works at the limit', () => {
    for (let i = 0; i < MAX_PREFS_PER_USER; i += 1)
      setCalendarPref(db, alice, { ref: `ics:${i + 1}` })

    expect(() => setCalendarPref(db, alice, { ref: 'ics:501' })).toThrow(
      apiError(409, 'limit_reached'),
    )
    expect(setCalendarPref(db, alice, { ref: 'ics:7', visible: false }).visible).toBe(false)
    expect(listCalendarPrefs(db, alice)).toHaveLength(MAX_PREFS_PER_USER)
    expect(() => setCalendarPref(db, bob, { ref: 'ics:501' })).not.toThrow()

    deleteCalendarPref(db, alice, 'ics:1')
    expect(() => setCalendarPref(db, alice, { ref: 'ics:501' })).not.toThrow()
  })
})
