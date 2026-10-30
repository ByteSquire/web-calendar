// @vitest-environment node
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createView,
  deleteView,
  listViews,
  MAX_CALENDARS_PER_VIEW,
  MAX_VIEWS_PER_USER,
  updateView,
  type ViewInput,
} from '../../server/db/views'
import { MAX_VIEW_NAME_LENGTH, parseViewInput } from '../../server/utils/api/views'
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

function input(overrides: Partial<ViewInput> = {}): ViewInput {
  return {
    name: 'Team',
    icon: 'users',
    calendars: [
      { ref: WORK, color: '#1d4ed8' },
      { ref: 'ics:7', color: null },
    ],
    ...overrides,
  }
}

function parsed(body: unknown) {
  const result = parseViewInput(body)
  return result.ok ? result.value : result.fields.map((f) => f.field)
}

/** An admin view as a later phase will create it. */
function insertAdminView(name: string, ownerId: number | null = null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO views (name, icon, owner_id, is_admin, definition)
         VALUES (?, 'shield', ?, 1, '[{"ref":"ics:1","color":"#ff0000"}]')`,
      )
      .run(name, ownerId).lastInsertRowid,
  )
}

describe('parseViewInput', () => {
  it('reads a complete body', () => {
    expect(
      parsed({
        name: ' Team ',
        icon: 'star',
        calendars: [
          { ref: WORK, color: '#ABCDEF' },
          { ref: 'ext:acc:https://x.example/c/' },
          { ref: 'ics:3', color: null },
        ],
      }),
    ).toEqual({
      name: 'Team',
      icon: 'star',
      calendars: [
        { ref: WORK, color: '#abcdef' },
        { ref: 'ext:acc:https://x.example/c/', color: null },
        { ref: 'ics:3', color: null },
      ],
    })
  })

  it('defaults the icon to calendar, also for null', () => {
    expect(parsed({ name: 'A', calendars: [] })).toMatchObject({ icon: 'calendar' })
    expect(parsed({ name: 'A', icon: null, calendars: [] })).toMatchObject({ icon: 'calendar' })
  })

  it('allows a view without calendars and ignores extra fields', () => {
    expect(
      parsed({
        name: 'A',
        calendars: [{ ref: 'ics:1', color: null, label: 'x' }],
        isAdmin: true,
        ownerId: 99,
        id: 5,
      }),
    ).toEqual({ name: 'A', icon: 'calendar', calendars: [{ ref: 'ics:1', color: null }] })
    expect(parsed({ name: 'A', calendars: [] })).toMatchObject({ calendars: [] })
  })

  it.each([
    ['no body', undefined, ['body', 'name', 'calendars']],
    ['null', null, ['body', 'name', 'calendars']],
    ['a list', [], ['body', 'name', 'calendars']],
    ['a string', 'Team', ['body', 'name', 'calendars']],
    ['an empty object', {}, ['name', 'calendars']],
    ['a missing name', { calendars: [] }, ['name']],
    ['a blank name', { name: '  ', calendars: [] }, ['name']],
    ['a numeric name', { name: 5, calendars: [] }, ['name']],
    [
      'a name over the limit',
      { name: 'x'.repeat(MAX_VIEW_NAME_LENGTH + 1), calendars: [] },
      ['name'],
    ],
    ['a huge name', { name: 'x'.repeat(2_000_000), calendars: [] }, ['name']],
    ['an unknown icon', { name: 'A', icon: 'rocket', calendars: [] }, ['icon']],
    ['a numeric icon', { name: 'A', icon: 1, calendars: [] }, ['icon']],
    ['missing calendars', { name: 'A' }, ['calendars']],
    ['null calendars', { name: 'A', calendars: null }, ['calendars']],
    ['calendars as an object', { name: 'A', calendars: { ref: 'ics:1' } }, ['calendars']],
    ['calendars as a string', { name: 'A', calendars: 'ics:1' }, ['calendars']],
    ['a calendar that is a string', { name: 'A', calendars: ['ics:1'] }, ['calendars[0]']],
    ['a null calendar', { name: 'A', calendars: [null] }, ['calendars[0]']],
    [
      'a calendar without ref',
      { name: 'A', calendars: [{ color: '#112233' }] },
      ['calendars[0].ref'],
    ],
    ['a bad ref', { name: 'A', calendars: [{ ref: 'nope' }] }, ['calendars[0].ref']],
    [
      'a bad color',
      { name: 'A', calendars: [{ ref: 'ics:1' }, { ref: 'ics:2', color: 'red' }] },
      ['calendars[1].color'],
    ],
    [
      'a duplicate ref',
      { name: 'A', calendars: [{ ref: 'ics:1' }, { ref: 'ics:2' }, { ref: 'ics:1' }] },
      ['calendars[2].ref'],
    ],
    [
      'several problems at once',
      { name: '', icon: 'x', calendars: [{ ref: 'bad', color: 'bad' }] },
      ['name', 'icon', 'calendars[0].ref', 'calendars[0].color'],
    ],
  ])('rejects %s', (_label, body, fields) => {
    expect(parsed(body)).toEqual(fields)
  })

  it('takes exactly the maximum number of calendars and no more', () => {
    const refs = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ ref: `ics:${i + 1}`, color: null }))
    expect(parsed({ name: 'A', calendars: refs(MAX_CALENDARS_PER_VIEW) })).toMatchObject({
      name: 'A',
    })
    expect(parsed({ name: 'A', calendars: refs(MAX_CALENDARS_PER_VIEW + 1) })).toEqual([
      'calendars',
    ])
    // A silly list is refused at once instead of being checked entry by entry.
    expect(parsed({ name: 'A', calendars: refs(100_000) })).toEqual(['calendars'])
  })

  it('does not report more than a handful of problems for a list of bad entries', () => {
    const calendars = Array.from({ length: MAX_CALENDARS_PER_VIEW }, () => ({ ref: 'bad' }))
    const result = parseViewInput({ name: 'A', calendars })
    expect(result.ok).toBe(false)
    expect(result.ok ? 0 : result.fields.length).toBe(20)
  })
})

describe('views in the database', () => {
  it('round-trips the definition: refs, colors and their order', () => {
    const calendars = [
      { ref: 'ics:9', color: null },
      { ref: 'ext:acc:https://cal.example/dav/a b/"q"/', color: '#00ff00' },
      { ref: WORK, color: '#1d4ed8' },
      { ref: 'ics:1', color: '#000000' },
    ]
    const created = createView(db, alice, input({ calendars }))
    expect(created).toEqual({
      id: expect.any(Number),
      name: 'Team',
      icon: 'users',
      calendars,
      isAdmin: false,
      ownerId: alice,
    })
    expect(listViews(db, alice)).toEqual([created])

    const stored = db.prepare('SELECT definition FROM views WHERE id = ?').pluck().get(created.id)
    expect(JSON.parse(stored as string)).toEqual(calendars)
  })

  it('updates name, icon and calendars of an own view', () => {
    const { id } = createView(db, alice, input())
    const updated = updateView(
      db,
      alice,
      id,
      input({ name: 'Renamed', icon: 'layers', calendars: [{ ref: HOME, color: '#abcdef' }] }),
    )
    expect(updated).toEqual({
      id,
      name: 'Renamed',
      icon: 'layers',
      calendars: [{ ref: HOME, color: '#abcdef' }],
      isAdmin: false,
      ownerId: alice,
    })
    expect(listViews(db, alice)).toEqual([updated])
  })

  it('lists newest views last and keeps the ids stable', () => {
    const first = createView(db, alice, input({ name: 'one' }))
    const second = createView(db, alice, input({ name: 'two' }))
    const third = createView(db, alice, input({ name: 'three' }))
    deleteView(db, alice, second.id)
    updateView(db, alice, first.id, input({ name: 'one again' }))
    expect(listViews(db, alice).map((v) => [v.id, v.name])).toEqual([
      [first.id, 'one again'],
      [third.id, 'three'],
    ])
  })

  it('keeps the views of two users apart', () => {
    const mine = createView(db, alice, input({ name: 'alice view' }))
    const his = createView(db, bob, input({ name: 'bob view' }))
    expect(listViews(db, alice).map((v) => v.id)).toEqual([mine.id])
    expect(listViews(db, bob).map((v) => v.id)).toEqual([his.id])
  })

  it('cannot change or delete the view of another user', () => {
    const mine = createView(db, alice, input({ name: 'alice view' }))
    expect(updateView(db, bob, mine.id, input({ name: 'hijacked' }))).toBeNull()
    expect(deleteView(db, bob, mine.id)).toBe(false)
    expect(listViews(db, alice)).toEqual([mine])
    expect(updateView(db, alice, 99_999, input())).toBeNull()
    expect(deleteView(db, alice, 99_999)).toBe(false)
  })

  it('deleting is final and a second delete finds nothing', () => {
    const { id } = createView(db, alice, input())
    expect(deleteView(db, alice, id)).toBe(true)
    expect(deleteView(db, alice, id)).toBe(false)
    expect(listViews(db, alice)).toEqual([])
  })

  describe('admin views', () => {
    it('are listed for everybody, after nobody else’s own views', () => {
      const own = createView(db, alice, input({ name: 'mine' }))
      const bobs = createView(db, bob, input({ name: 'bobs' }))
      const admin = insertAdminView('Everyone')
      const owned = insertAdminView('Made by bob', bob)

      expect(listViews(db, alice).map((v) => v.id)).toEqual([own.id, admin, owned])
      expect(listViews(db, bob).map((v) => v.id)).toEqual([bobs.id, admin, owned])
      expect(listViews(db, alice).find((v) => v.id === admin)).toEqual({
        id: admin,
        name: 'Everyone',
        icon: 'shield',
        calendars: [{ ref: 'ics:1', color: '#ff0000' }],
        isAdmin: true,
        ownerId: null,
      })
    })

    it('are read-only, even for the user who owns the row', () => {
      const admin = insertAdminView('Everyone')
      const owned = insertAdminView('Made by bob', bob)
      for (const id of [admin, owned]) {
        expect(updateView(db, bob, id, input({ name: 'changed' }))).toBeNull()
        expect(deleteView(db, bob, id)).toBe(false)
        expect(updateView(db, alice, id, input({ name: 'changed' }))).toBeNull()
        expect(deleteView(db, alice, id)).toBe(false)
      }
      expect(listViews(db, alice).map((v) => v.name)).toEqual(['Everyone', 'Made by bob'])
    })

    it('do not count against the limit of the owner', () => {
      for (let i = 0; i < MAX_VIEWS_PER_USER; i += 1) insertAdminView(`a${i}`, alice)
      expect(() => createView(db, alice, input())).not.toThrow()
    })
  })

  it('allows 100 views per user and answers 409 for the 101st', () => {
    for (let i = 0; i < MAX_VIEWS_PER_USER; i += 1) createView(db, alice, input({ name: `v${i}` }))
    expect(() => createView(db, alice, input())).toThrow(apiError(409, 'limit_reached'))
    expect(listViews(db, alice)).toHaveLength(MAX_VIEWS_PER_USER)
    // the limit is per user, and a deleted view makes room
    expect(() => createView(db, bob, input())).not.toThrow()
    deleteView(db, alice, listViews(db, alice)[0]!.id)
    expect(() => createView(db, alice, input())).not.toThrow()
  })

  it('does not reuse the id of a deleted view', () => {
    const first = createView(db, alice, input())
    deleteView(db, alice, first.id)
    expect(createView(db, alice, input()).id).toBeGreaterThan(first.id)
  })

  it('survives a stored definition that is not what this module writes', () => {
    const id = Number(
      db
        .prepare(`INSERT INTO views (name, owner_id, definition) VALUES ('odd', ?, ?)`)
        .run(
          alice,
          JSON.stringify([
            { ref: 'ics:1', color: 5 },
            'text',
            null,
            { ref: '' },
            { x: 1 },
            { ref: 'ics:2' },
          ]),
        ).lastInsertRowid,
    )
    expect(listViews(db, alice).find((v) => v.id === id)).toMatchObject({
      icon: 'calendar',
      calendars: [
        { ref: 'ics:1', color: null },
        { ref: 'ics:2', color: null },
      ],
    })

    db.prepare('INSERT INTO views (name, owner_id, definition) VALUES (?, ?, ?)').run(
      'object',
      alice,
      '{"ref":"ics:1"}',
    )
    expect(listViews(db, alice).at(-1)).toMatchObject({ name: 'object', calendars: [] })
  })
})
