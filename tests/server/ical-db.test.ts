// @vitest-environment node
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/connection'
import {
  createIcalSubscription,
  deleteIcalSubscription,
  findVisibleIcalSubscription,
  IcalSubscriptionError,
  listIcalSubscriptions,
  MAX_ICAL_SUBSCRIPTIONS_PER_USER,
  updateIcalSubscription,
} from '../../server/db/ical-subscriptions'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { upsertUser } from '../../server/db/users'

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))

let db: Database
let alice: number
let bob: number

beforeEach(() => {
  db = openDatabase(':memory:')
  runMigrations(db, loadMigrationsFromDir(migrationsDir))
  alice = upsertUser(db, { sub: 'sub-alice', username: 'alice' }).id
  bob = upsertUser(db, { sub: 'sub-bob', username: 'bob' }).id
})

afterEach(() => {
  db.close()
})

function input(n: number, color: string | null = null) {
  return { name: `Calendar ${n}`, url: `https://example.com/${n}.ics`, color }
}

/** There is no API for shared subscriptions yet; an administrator inserts them. */
function insertShared(name: string, url: string): number {
  return Number(
    db
      .prepare('INSERT INTO ical_subscriptions (owner_id, name, url) VALUES (NULL, ?, ?)')
      .run(name, url).lastInsertRowid,
  )
}

describe('createIcalSubscription', () => {
  it('stores the row and returns it with its calendar ref', () => {
    const created = createIcalSubscription(db, alice, input(1, '#112233'))
    expect(created).toEqual({
      id: expect.any(Number),
      ref: `ics:${created.id}`,
      name: 'Calendar 1',
      url: 'https://example.com/1.ics',
      color: '#112233',
      shared: false,
    })
    expect(
      db.prepare('SELECT owner_id FROM ical_subscriptions WHERE id = ?').pluck().get(created.id),
    ).toBe(alice)
  })

  it('keeps a missing color as null', () => {
    expect(createIcalSubscription(db, alice, input(1)).color).toBeNull()
  })

  it('refuses a url the user already has', () => {
    createIcalSubscription(db, alice, input(1))
    expect(() => createIcalSubscription(db, alice, { ...input(2), url: input(1).url })).toThrow(
      expect.objectContaining({ name: 'IcalSubscriptionError', code: 'duplicate' }),
    )
    expect(listIcalSubscriptions(db, alice)).toHaveLength(1)
  })

  it('lets two users have the same url', () => {
    createIcalSubscription(db, alice, input(1))
    expect(() => createIcalSubscription(db, bob, input(1))).not.toThrow()
  })

  it('lets a user subscribe to a url that a shared subscription already has', () => {
    insertShared('Holidays', input(1).url)
    expect(() => createIcalSubscription(db, alice, input(1))).not.toThrow()
  })

  it('stops at the limit of the user, and only theirs', () => {
    for (let n = 1; n <= MAX_ICAL_SUBSCRIPTIONS_PER_USER; n++) {
      createIcalSubscription(db, alice, input(n))
    }
    expect(() => createIcalSubscription(db, alice, input(999))).toThrow(
      expect.objectContaining({ code: 'limit_reached' }),
    )
    expect(() => createIcalSubscription(db, bob, input(999))).not.toThrow()
    expect(listIcalSubscriptions(db, alice)).toHaveLength(MAX_ICAL_SUBSCRIPTIONS_PER_USER)
  })

  it('does not count shared subscriptions against the limit', () => {
    for (let n = 1; n <= 5; n++) insertShared(`Shared ${n}`, `https://shared.example/${n}.ics`)
    for (let n = 1; n <= MAX_ICAL_SUBSCRIPTIONS_PER_USER; n++) {
      createIcalSubscription(db, alice, input(n))
    }
  })

  it('frees a place when a subscription is deleted', () => {
    const first = createIcalSubscription(db, alice, input(0))
    for (let n = 1; n < MAX_ICAL_SUBSCRIPTIONS_PER_USER; n++) {
      createIcalSubscription(db, alice, input(n))
    }
    deleteIcalSubscription(db, alice, first.id)
    expect(() => createIcalSubscription(db, alice, input(999))).not.toThrow()
  })

  it('throws the store error type', () => {
    createIcalSubscription(db, alice, input(1))
    expect(() => createIcalSubscription(db, alice, input(1))).toThrow(IcalSubscriptionError)
  })
})

describe('listIcalSubscriptions', () => {
  it('shows own and shared subscriptions, never those of others', () => {
    const own = createIcalSubscription(db, alice, input(1))
    createIcalSubscription(db, bob, input(2))
    const sharedId = insertShared('Holidays', 'https://shared.example/holidays.ics')

    expect(listIcalSubscriptions(db, alice)).toEqual([
      own,
      {
        id: sharedId,
        ref: `ics:${sharedId}`,
        name: 'Holidays',
        url: 'https://shared.example/holidays.ics',
        color: null,
        shared: true,
      },
    ])
    expect(listIcalSubscriptions(db, bob).map((entry) => entry.name)).toEqual([
      'Calendar 2',
      'Holidays',
    ])
  })

  it('is empty for a user with nothing', () => {
    expect(listIcalSubscriptions(db, alice)).toEqual([])
  })
})

describe('findVisibleIcalSubscription', () => {
  it('finds own and shared subscriptions but not those of others', () => {
    const own = createIcalSubscription(db, alice, input(1))
    const others = createIcalSubscription(db, bob, input(2))
    const sharedId = insertShared('Holidays', 'https://shared.example/holidays.ics')

    expect(findVisibleIcalSubscription(db, alice, own.id)).toEqual(own)
    expect(findVisibleIcalSubscription(db, alice, sharedId)).toMatchObject({ shared: true })
    expect(findVisibleIcalSubscription(db, bob, sharedId)).toMatchObject({ shared: true })
    expect(findVisibleIcalSubscription(db, alice, others.id)).toBeNull()
    expect(findVisibleIcalSubscription(db, alice, 9999)).toBeNull()
  })
})

describe('updateIcalSubscription', () => {
  it('changes name, url and color', () => {
    const { id } = createIcalSubscription(db, alice, input(1, '#112233'))
    const updated = updateIcalSubscription(db, alice, id, {
      name: 'Renamed',
      url: 'https://example.com/other.ics',
      color: null,
    })
    expect(updated).toEqual({
      id,
      ref: `ics:${id}`,
      name: 'Renamed',
      url: 'https://example.com/other.ics',
      color: null,
      shared: false,
    })
    expect(findVisibleIcalSubscription(db, alice, id)).toEqual(updated)
  })

  it('keeps the url of the row itself without calling it a duplicate', () => {
    const { id } = createIcalSubscription(db, alice, input(1))
    expect(updateIcalSubscription(db, alice, id, { ...input(1), name: 'Same url' })).toMatchObject({
      name: 'Same url',
    })
  })

  it('refuses a url that another row of the user has', () => {
    createIcalSubscription(db, alice, input(1))
    const second = createIcalSubscription(db, alice, input(2))
    expect(() => updateIcalSubscription(db, alice, second.id, input(1))).toThrow(
      expect.objectContaining({ code: 'duplicate' }),
    )
    expect(findVisibleIcalSubscription(db, alice, second.id)!.url).toBe(input(2).url)
  })

  it('lets another user use the url', () => {
    createIcalSubscription(db, alice, input(1))
    const theirs = createIcalSubscription(db, bob, input(2))
    expect(updateIcalSubscription(db, bob, theirs.id, input(1))).not.toBeNull()
  })

  it('returns null for the row of another user and leaves it alone', () => {
    const theirs = createIcalSubscription(db, bob, input(1))
    expect(
      updateIcalSubscription(db, alice, theirs.id, {
        name: 'Mine now',
        url: 'https://x.example/',
        color: null,
      }),
    ).toBeNull()
    expect(findVisibleIcalSubscription(db, bob, theirs.id)).toEqual(theirs)
  })

  it('returns null for a shared subscription: those are read-only', () => {
    const sharedId = insertShared('Holidays', 'https://shared.example/holidays.ics')
    expect(updateIcalSubscription(db, alice, sharedId, input(1))).toBeNull()
    expect(findVisibleIcalSubscription(db, alice, sharedId)).toMatchObject({
      name: 'Holidays',
      shared: true,
    })
  })

  it('returns null for an id that does not exist, even with a duplicate url', () => {
    createIcalSubscription(db, alice, input(1))
    expect(updateIcalSubscription(db, alice, 9999, input(1))).toBeNull()
  })

  it('refreshes updated_at', () => {
    const { id } = createIcalSubscription(db, alice, input(1))
    db.prepare("UPDATE ical_subscriptions SET updated_at = '2000-01-01T00:00:00.000Z'").run()
    updateIcalSubscription(db, alice, id, { ...input(1), name: 'Touched' })
    const updatedAt = db
      .prepare('SELECT updated_at FROM ical_subscriptions WHERE id = ?')
      .pluck()
      .get(id) as string
    expect(updatedAt > '2000-01-01T00:00:00.000Z').toBe(true)
  })
})

describe('deleteIcalSubscription', () => {
  it('deletes an own subscription', () => {
    const { id } = createIcalSubscription(db, alice, input(1))
    expect(deleteIcalSubscription(db, alice, id)).toBe(true)
    expect(listIcalSubscriptions(db, alice)).toEqual([])
    expect(deleteIcalSubscription(db, alice, id)).toBe(false)
  })

  it('does not delete the row of another user', () => {
    const theirs = createIcalSubscription(db, bob, input(1))
    expect(deleteIcalSubscription(db, alice, theirs.id)).toBe(false)
    expect(findVisibleIcalSubscription(db, bob, theirs.id)).toEqual(theirs)
  })

  it('does not delete a shared subscription', () => {
    const sharedId = insertShared('Holidays', 'https://shared.example/holidays.ics')
    expect(deleteIcalSubscription(db, alice, sharedId)).toBe(false)
    expect(findVisibleIcalSubscription(db, alice, sharedId)).not.toBeNull()
  })

  it('goes away with its owner', () => {
    createIcalSubscription(db, alice, input(1))
    db.prepare('DELETE FROM users WHERE id = ?').run(alice)
    expect(db.prepare('SELECT COUNT(*) FROM ical_subscriptions').pluck().get()).toBe(0)
  })
})
