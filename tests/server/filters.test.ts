// @vitest-environment node
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFilter,
  deleteFilter,
  listFilters,
  MAX_FILTERS_PER_USER,
  updateFilter,
  type FilterInput,
} from '../../server/db/filters'
import {
  MAX_FILTER_NAME_LENGTH,
  MAX_FILTER_VALUE_LENGTH,
  parseFilterInput,
} from '../../server/utils/api/filters'
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

function parsed(body: unknown) {
  const result = parseFilterInput(body)
  return result.ok ? result.value : result.fields.map((f) => f.field)
}

const FILTER: FilterInput = { name: 'Meetings', kind: 'text', value: 'standup' }

describe('parseFilterInput', () => {
  it.each([
    [
      'a text filter',
      { name: ' Meetings ', kind: 'text', value: ' standup ' },
      { name: 'Meetings', kind: 'text', value: 'standup' },
    ],
    [
      'a category filter',
      { name: 'Work', kind: 'category', value: 'Project X' },
      { name: 'Work', kind: 'category', value: 'Project X' },
    ],
    [
      'extra fields',
      { name: 'A', kind: 'text', value: 'b', id: 3, ownerId: 9, extra: {} },
      { name: 'A', kind: 'text', value: 'b' },
    ],
    [
      'the longest name and value',
      {
        name: 'n'.repeat(MAX_FILTER_NAME_LENGTH),
        kind: 'text',
        value: 'v'.repeat(MAX_FILTER_VALUE_LENGTH),
      },
      {
        name: 'n'.repeat(MAX_FILTER_NAME_LENGTH),
        kind: 'text',
        value: 'v'.repeat(MAX_FILTER_VALUE_LENGTH),
      },
    ],
  ])('accepts %s', (_label, body, expected) => {
    expect(parsed(body)).toEqual(expected)
  })

  it.each(['confirmed', 'tentative', 'cancelled'])('accepts the status %s', (status) => {
    expect(parsed({ name: 'S', kind: 'status', value: status })).toEqual({
      name: 'S',
      kind: 'status',
      value: status,
    })
  })

  it.each([
    ['no body', undefined, ['body', 'name', 'kind', 'value']],
    ['null', null, ['body', 'name', 'kind', 'value']],
    ['a list', [{ name: 'A' }], ['body', 'name', 'kind', 'value']],
    ['an empty object', {}, ['name', 'kind', 'value']],
    ['a missing name', { kind: 'text', value: 'v' }, ['name']],
    ['a blank name', { name: ' ', kind: 'text', value: 'v' }, ['name']],
    [
      'a name over the limit',
      { name: 'x'.repeat(MAX_FILTER_NAME_LENGTH + 1), kind: 'text', value: 'v' },
      ['name'],
    ],
    ['a numeric name', { name: 1, kind: 'text', value: 'v' }, ['name']],
    ['a missing kind', { name: 'A', value: 'v' }, ['kind']],
    ['an unknown kind', { name: 'A', kind: 'regex', value: 'v' }, ['kind']],
    ['a kind with other case', { name: 'A', kind: 'Text', value: 'v' }, ['kind']],
    ['a missing value', { name: 'A', kind: 'text' }, ['value']],
    ['a blank value', { name: 'A', kind: 'text', value: '   ' }, ['value']],
    ['a null value', { name: 'A', kind: 'text', value: null }, ['value']],
    ['a numeric value', { name: 'A', kind: 'text', value: 5 }, ['value']],
    [
      'a value over the limit',
      { name: 'A', kind: 'text', value: 'x'.repeat(MAX_FILTER_VALUE_LENGTH + 1) },
      ['value'],
    ],
    ['a huge value', { name: 'A', kind: 'category', value: 'x'.repeat(1_000_000) }, ['value']],
    ['an unknown status', { name: 'A', kind: 'status', value: 'busy' }, ['value']],
    ['a status with other case', { name: 'A', kind: 'status', value: 'Confirmed' }, ['value']],
    ['everything wrong', { name: '', kind: 'x', value: '' }, ['name', 'kind', 'value']],
  ])('rejects %s', (_label, body, fields) => {
    expect(parsed(body)).toEqual(fields)
  })

  it('does not hold a free text value to the status list', () => {
    expect(parsed({ name: 'A', kind: 'text', value: 'busy' })).toMatchObject({ value: 'busy' })
    expect(parsed({ name: 'A', kind: 'category', value: 'busy' })).toMatchObject({ value: 'busy' })
  })
})

describe('filters in the database', () => {
  it('creates, lists, updates and deletes', () => {
    const created = createFilter(db, alice, FILTER)
    expect(created).toEqual({ id: expect.any(Number), ...FILTER })
    expect(listFilters(db, alice)).toEqual([created])

    const changed = updateFilter(db, alice, created.id, {
      name: 'Cancelled',
      kind: 'status',
      value: 'cancelled',
    })
    expect(changed).toEqual({
      id: created.id,
      name: 'Cancelled',
      kind: 'status',
      value: 'cancelled',
    })
    expect(listFilters(db, alice)).toEqual([changed])

    expect(deleteFilter(db, alice, created.id)).toBe(true)
    expect(deleteFilter(db, alice, created.id)).toBe(false)
    expect(listFilters(db, alice)).toEqual([])
  })

  it('lists in creation order, by id', () => {
    const a = createFilter(db, alice, { ...FILTER, name: 'b' })
    const b = createFilter(db, alice, { ...FILTER, name: 'a' })
    const c = createFilter(db, alice, { ...FILTER, name: 'c' })
    updateFilter(db, alice, a.id, { ...FILTER, name: 'z' })
    expect(listFilters(db, alice).map((f) => f.id)).toEqual([a.id, b.id, c.id])
  })

  it('keeps users apart: no reading, changing or deleting of another user’s filter', () => {
    const mine = createFilter(db, alice, FILTER)
    const his = createFilter(db, bob, { ...FILTER, name: 'bob' })

    expect(listFilters(db, alice)).toEqual([mine])
    expect(listFilters(db, bob)).toEqual([his])
    expect(updateFilter(db, bob, mine.id, { ...FILTER, name: 'hijacked' })).toBeNull()
    expect(deleteFilter(db, bob, mine.id)).toBe(false)
    expect(listFilters(db, alice)).toEqual([mine])
    expect(updateFilter(db, alice, 99_999, FILTER)).toBeNull()
  })

  it('allows 100 filters per user and answers 409 for the 101st', () => {
    for (let i = 0; i < MAX_FILTERS_PER_USER; i += 1) {
      createFilter(db, alice, { ...FILTER, name: `f${i}` })
    }
    expect(() => createFilter(db, alice, FILTER)).toThrow(apiError(409, 'limit_reached'))
    expect(() => createFilter(db, bob, FILTER)).not.toThrow()
    deleteFilter(db, alice, listFilters(db, alice)[0]!.id)
    expect(() => createFilter(db, alice, FILTER)).not.toThrow()
  })
})
