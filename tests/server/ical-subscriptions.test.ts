// @vitest-environment node
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../server/db/connection'
import {
  listIcalSubscriptions,
  MAX_ICAL_SUBSCRIPTIONS_PER_USER,
} from '../../server/db/ical-subscriptions'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { upsertUser } from '../../server/db/users'
import { createAddressPolicy, type Resolver } from '../../server/utils/ical-proxy/ssrf'
import {
  addSubscription,
  changeSubscription,
  removeSubscription,
} from '../../server/utils/ical-proxy/subscriptions'

// The endpoint logic around the store: validation, the SSRF check of the address, and the API
// errors (400 / 404 / 409) the routes turn into HTTP responses.

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))

const ZONE: Record<string, string[]> = {
  'feeds.example': ['93.184.216.34'],
  'other.example': ['93.184.216.35'],
  'intranet.example': ['10.0.0.5'],
  'rebind.example': ['93.184.216.34', '127.0.0.1'],
}

const resolve = vi.fn<Resolver>(async (hostname) => {
  const addresses = ZONE[hostname]
  if (!addresses) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  return addresses.map((address) => ({ address, family: 4 }))
})
const policy = createAddressPolicy({ allowPrivate: false, resolve })

let db: Database
let alice: number
let bob: number

beforeEach(() => {
  resolve.mockClear()
  db = openDatabase(':memory:')
  runMigrations(db, loadMigrationsFromDir(migrationsDir))
  alice = upsertUser(db, { sub: 'sub-alice', username: 'alice' }).id
  bob = upsertUser(db, { sub: 'sub-bob', username: 'bob' }).id
})

afterEach(() => {
  db.close()
})

const body = (url: string, extra: Record<string, unknown> = {}) => ({
  name: 'Feed',
  url,
  ...extra,
})

function apiError(statusCode: number, extra: Record<string, unknown> = {}) {
  return expect.objectContaining({ name: 'ApiError', statusCode, ...extra })
}

function urlFieldError() {
  return apiError(400, {
    data: { fields: [expect.objectContaining({ field: 'url' })] },
  })
}

describe('addSubscription', () => {
  it('stores the normalised address of a valid feed', async () => {
    const created = await addSubscription(
      db,
      policy,
      alice,
      body('webcal://Feeds.Example/team.ics#top', { color: '#AABBCC' }),
    )
    expect(created).toMatchObject({
      name: 'Feed',
      url: 'https://feeds.example/team.ics',
      color: '#aabbcc',
      shared: false,
    })
  })

  it('reports every invalid field at once', async () => {
    await expect(
      addSubscription(db, policy, alice, { name: '', url: 'ftp://x', color: 'x' }),
    ).rejects.toEqual(
      apiError(400, {
        data: {
          fields: [
            expect.objectContaining({ field: 'name' }),
            expect.objectContaining({ field: 'color' }),
            expect.objectContaining({ field: 'url' }),
          ],
        },
      }),
    )
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each([
    'http://127.0.0.1/cal.ics',
    'http://2130706433/cal.ics',
    'http://[::ffff:7f00:1]/cal.ics',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/cal.ics',
    'http://localhost:3000/cal.ics',
    'webcal://localhost/cal.ics',
    'https://intranet.example/cal.ics',
    'https://rebind.example/cal.ics',
  ])('refuses %s with a 400 on the url field', async (url) => {
    await expect(addSubscription(db, policy, alice, body(url))).rejects.toEqual(urlFieldError())
    expect(listIcalSubscriptions(db, alice)).toEqual([])
  })

  it('says whether the address is blocked or the host unknown', async () => {
    await expect(addSubscription(db, policy, alice, body('http://10.0.0.1/'))).rejects.toEqual(
      apiError(400, {
        data: {
          fields: [{ field: 'url', message: 'must not point to a private or reserved network' }],
        },
      }),
    )
    await expect(
      addSubscription(db, policy, alice, body('https://nowhere.example/')),
    ).rejects.toEqual(
      apiError(400, {
        data: { fields: [{ field: 'url', message: 'has a host name that cannot be resolved' }] },
      }),
    )
  })

  it('allows private addresses when the guard is off', async () => {
    const lax = createAddressPolicy({ allowPrivate: true, resolve })
    const created = await addSubscription(db, lax, alice, body('http://127.0.0.1:8080/a.ics'))
    expect(created.url).toBe('http://127.0.0.1:8080/a.ics')
  })

  it('answers 409 for a duplicate address and at the limit', async () => {
    await addSubscription(db, policy, alice, body('https://feeds.example/a.ics'))
    await expect(
      addSubscription(db, policy, alice, body('webcal://feeds.example/a.ics')),
    ).rejects.toEqual(apiError(409, { data: { code: 'duplicate' } }))

    for (let n = 1; n < MAX_ICAL_SUBSCRIPTIONS_PER_USER; n++) {
      await addSubscription(db, policy, alice, body(`https://feeds.example/${n}.ics`))
    }
    await expect(
      addSubscription(db, policy, alice, body('https://feeds.example/one-more.ics')),
    ).rejects.toEqual(apiError(409, { data: { code: 'limit_reached' } }))
  })
})

describe('changeSubscription', () => {
  it('changes an own subscription and checks a new address', async () => {
    const { id } = await addSubscription(db, policy, alice, body('https://feeds.example/a.ics'))
    const changed = await changeSubscription(
      db,
      policy,
      alice,
      id,
      body('https://other.example/b.ics', { name: 'Renamed', color: '#000000' }),
    )
    expect(changed).toMatchObject({ id, name: 'Renamed', url: 'https://other.example/b.ics' })
    await expect(
      changeSubscription(db, policy, alice, id, body('http://127.0.0.1/b.ics')),
    ).rejects.toEqual(urlFieldError())
    expect(listIcalSubscriptions(db, alice)[0]!.url).toBe('https://other.example/b.ics')
  })

  it('does not resolve the host again when only the name changes', async () => {
    const { id } = await addSubscription(db, policy, alice, body('https://feeds.example/a.ics'))
    // The source being down must not stop a rename: this resolver fails for everything.
    const down = vi.fn<Resolver>(() => Promise.reject(new Error('ENOTFOUND')))
    const renamed = await changeSubscription(
      db,
      createAddressPolicy({ allowPrivate: false, resolve: down }),
      alice,
      id,
      body('https://feeds.example/a.ics', { name: 'Team' }),
    )
    expect(renamed.name).toBe('Team')
    expect(down).not.toHaveBeenCalled()
  })

  it('answers 404 for a missing id, the row of another user and a shared row', async () => {
    const theirs = await addSubscription(db, policy, bob, body('https://feeds.example/a.ics'))
    const shared = Number(
      db
        .prepare(
          "INSERT INTO ical_subscriptions (owner_id, name, url) VALUES (NULL, 'S', 'https://s.example/')",
        )
        .run().lastInsertRowid,
    )
    for (const id of [9999, theirs.id, shared]) {
      await expect(
        changeSubscription(db, policy, alice, id, body('https://other.example/x.ics')),
      ).rejects.toEqual(apiError(404))
    }
    expect(listIcalSubscriptions(db, bob)[0]).toMatchObject({ url: 'https://feeds.example/a.ics' })
  })

  it('answers 404 before it looks at the body', async () => {
    await expect(changeSubscription(db, policy, alice, 9999, null)).rejects.toEqual(apiError(404))
  })

  it('answers 409 for the address of another subscription of the user', async () => {
    await addSubscription(db, policy, alice, body('https://feeds.example/a.ics'))
    const second = await addSubscription(db, policy, alice, body('https://feeds.example/b.ics'))
    await expect(
      changeSubscription(db, policy, alice, second.id, body('https://feeds.example/a.ics')),
    ).rejects.toEqual(apiError(409, { data: { code: 'duplicate' } }))
  })
})

describe('removeSubscription', () => {
  it('removes an own subscription once', async () => {
    const { id } = await addSubscription(db, policy, alice, body('https://feeds.example/a.ics'))
    removeSubscription(db, alice, id)
    expect(listIcalSubscriptions(db, alice)).toEqual([])
    expect(() => removeSubscription(db, alice, id)).toThrow(apiError(404))
  })

  it('answers 404 for the row of another user and a shared row', async () => {
    const theirs = await addSubscription(db, policy, bob, body('https://feeds.example/a.ics'))
    const shared = Number(
      db
        .prepare(
          "INSERT INTO ical_subscriptions (owner_id, name, url) VALUES (NULL, 'S', 'https://s.example/')",
        )
        .run().lastInsertRowid,
    )
    expect(() => removeSubscription(db, alice, theirs.id)).toThrow(apiError(404))
    expect(() => removeSubscription(db, alice, shared)).toThrow(apiError(404))
    expect(listIcalSubscriptions(db, bob)).toHaveLength(2)
  })
})
