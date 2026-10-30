// @vitest-environment node
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCategory,
  deleteCategory,
  listCategories,
  MAX_CATEGORIES_PER_USER,
  updateCategory,
} from '../../server/db/categories'
import { MAX_CATEGORY_NAME_LENGTH, parseCategoryInput } from '../../server/utils/api/categories'
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
  const result = parseCategoryInput(body)
  return result.ok ? result.value : result.fields.map((f) => f.field)
}

function insertShared(name: string, color: string | null = null): number {
  return Number(
    db
      .prepare('INSERT INTO categories (name, color, owner_id) VALUES (?, ?, NULL)')
      .run(name, color).lastInsertRowid,
  )
}

describe('parseCategoryInput', () => {
  it.each([
    ['name and color', { name: ' Work ', color: '#AABBCC' }, { name: 'Work', color: '#aabbcc' }],
    ['no color', { name: 'Work' }, { name: 'Work', color: null }],
    ['a null color', { name: 'Work', color: null }, { name: 'Work', color: null }],
    [
      'extra fields',
      { name: 'W', color: '#000000', shared: true, id: 2 },
      { name: 'W', color: '#000000' },
    ],
    [
      'the longest name',
      { name: 'n'.repeat(MAX_CATEGORY_NAME_LENGTH) },
      { name: 'n'.repeat(MAX_CATEGORY_NAME_LENGTH), color: null },
    ],
  ])('accepts %s', (_label, body, expected) => {
    expect(parsed(body)).toEqual(expected)
  })

  it.each([
    ['no body', undefined, ['body', 'name']],
    ['null', null, ['body', 'name']],
    ['a list', [], ['body', 'name']],
    ['a string', 'Work', ['body', 'name']],
    ['an empty object', {}, ['name']],
    ['a blank name', { name: '\t' }, ['name']],
    ['a numeric name', { name: 7 }, ['name']],
    ['a name over the limit', { name: 'x'.repeat(MAX_CATEGORY_NAME_LENGTH + 1) }, ['name']],
    ['a huge name', { name: 'x'.repeat(3_000_000) }, ['name']],
    ['a short color', { name: 'W', color: '#fff' }, ['color']],
    ['a named color', { name: 'W', color: 'red' }, ['color']],
    ['an empty color', { name: 'W', color: '' }, ['color']],
    ['a numeric color', { name: 'W', color: 0xffffff }, ['color']],
    ['name and color wrong', { name: '', color: 'x' }, ['name', 'color']],
  ])('rejects %s', (_label, body, fields) => {
    expect(parsed(body)).toEqual(fields)
  })
})

describe('categories in the database', () => {
  it('creates, lists, updates and deletes an own category', () => {
    const created = createCategory(db, alice, { name: 'Work', color: '#112233' })
    expect(created).toEqual({
      id: expect.any(Number),
      name: 'Work',
      color: '#112233',
      shared: false,
    })
    expect(listCategories(db, alice)).toEqual([created])

    const changed = updateCategory(db, alice, created.id, { name: 'Office', color: null })
    expect(changed).toEqual({ id: created.id, name: 'Office', color: null, shared: false })
    expect(listCategories(db, alice)).toEqual([changed])

    expect(deleteCategory(db, alice, created.id)).toBe(true)
    expect(deleteCategory(db, alice, created.id)).toBe(false)
    expect(listCategories(db, alice)).toEqual([])
  })

  it('lists own and shared categories by id and flags the shared ones', () => {
    const shared = insertShared('Holiday', '#ff0000')
    const own = createCategory(db, alice, { name: 'Work', color: null })
    const bobs = createCategory(db, bob, { name: 'Private', color: null })
    const sharedLater = insertShared('Company')

    expect(listCategories(db, alice)).toEqual([
      { id: shared, name: 'Holiday', color: '#ff0000', shared: true },
      { id: own.id, name: 'Work', color: null, shared: false },
      { id: sharedLater, name: 'Company', color: null, shared: true },
    ])
    expect(listCategories(db, bob).map((c) => c.id)).toEqual([shared, bobs.id, sharedLater])
  })

  describe('names', () => {
    it('are unique per user, in any letter case', () => {
      createCategory(db, alice, { name: 'Work', color: null })
      for (const name of ['Work', 'work', 'WORK']) {
        expect(() => createCategory(db, alice, { name, color: null })).toThrow(
          apiError(409, 'duplicate'),
        )
      }
      expect(listCategories(db, alice)).toHaveLength(1)
    })

    it('may repeat across users and next to a shared category', () => {
      insertShared('Work')
      createCategory(db, bob, { name: 'Work', color: null })
      expect(() => createCategory(db, alice, { name: 'Work', color: null })).not.toThrow()
      expect(listCategories(db, alice).map((c) => c.name)).toEqual(['Work', 'Work'])
    })

    it('cannot be changed into the name of another own category', () => {
      createCategory(db, alice, { name: 'Work', color: null })
      const other = createCategory(db, alice, { name: 'Home', color: null })
      expect(() => updateCategory(db, alice, other.id, { name: 'WORK', color: null })).toThrow(
        apiError(409, 'duplicate'),
      )
      expect(listCategories(db, alice).map((c) => c.name)).toEqual(['Work', 'Home'])
    })

    it('can change only in letter case', () => {
      const category = createCategory(db, alice, { name: 'work', color: null })
      expect(updateCategory(db, alice, category.id, { name: 'Work', color: null })?.name).toBe(
        'Work',
      )
    })
  })

  it('keeps users apart', () => {
    const mine = createCategory(db, alice, { name: 'Work', color: null })
    expect(listCategories(db, bob)).toEqual([])
    expect(updateCategory(db, bob, mine.id, { name: 'hijacked', color: null })).toBeNull()
    expect(deleteCategory(db, bob, mine.id)).toBe(false)
    expect(listCategories(db, alice)).toEqual([mine])
  })

  it('treats a shared category as read-only for everybody', () => {
    const shared = insertShared('Holiday', '#ff0000')
    for (const user of [alice, bob]) {
      expect(updateCategory(db, user, shared, { name: 'Mine now', color: null })).toBeNull()
      expect(deleteCategory(db, user, shared)).toBe(false)
    }
    expect(listCategories(db, alice)).toEqual([
      { id: shared, name: 'Holiday', color: '#ff0000', shared: true },
    ])
  })

  it('stops at the cap of 200 own categories; shared ones do not count', () => {
    insertShared('Shared')
    for (let i = 0; i < MAX_CATEGORIES_PER_USER; i += 1) {
      createCategory(db, alice, { name: `c${i}`, color: null })
    }
    expect(() => createCategory(db, alice, { name: 'one more', color: null })).toThrow(
      apiError(409, 'limit_reached'),
    )
    expect(() => createCategory(db, bob, { name: 'mine', color: null })).not.toThrow()
  })
})
