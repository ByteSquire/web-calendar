// @vitest-environment node
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXTERNAL_NAME_MAX_LENGTH,
  EXTERNAL_PASSWORD_MAX_LENGTH,
  EXTERNAL_URL_MAX_LENGTH,
  EXTERNAL_USERNAME_MAX_LENGTH,
  MAX_EXTERNAL_ACCOUNTS,
  type ExternalAccountResult,
} from '../../shared/types/external'
import {
  createExternalAccount,
  deleteExternalAccount,
  findExternalAccount,
  listExternalAccounts,
  updateExternalAccount,
} from '../../server/db/external-accounts'
import {
  addAccount,
  changeAccount,
  listAccounts,
  removeAccount,
  resealAccount,
  type AccountDeps,
} from '../../server/utils/external/accounts'
import { createSealer, type Sealer } from '../../server/utils/external/seal'
import { parseHostList } from '../../server/utils/ical-proxy/host-list'
import { createAddressPolicy, type Resolver } from '../../server/utils/ical-proxy/ssrf'
import { apiError, createUsers, openTestDb } from './api-fixtures'

// The account endpoints as plain functions: validation, the host policy, sealing, isolation between
// users, limits. Nothing here talks to a network; names resolve through a stub.

const sealer: Sealer = createSealer(Buffer.alloc(32, 5))

const ZONE: Record<string, string[]> = {
  'cal.example.org': ['93.184.216.34'],
  'dav.example.net': ['93.184.216.35'],
  'moved.example.org': ['93.184.216.36'],
  'intranet.corp.example': ['10.0.0.5'],
  'loop.corp.example': ['127.0.0.1'],
  'private.example.org': ['192.168.1.1'],
}
const resolve = vi.fn<Resolver>(async (hostname) => {
  const addresses = ZONE[hostname]
  if (!addresses) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  return addresses.map((address) => ({ address, family: 4 }))
})

let db: Database
let alice: { id: number; sub: string }
let bob: { id: number; sub: string }

function deps(overrides: Partial<AccountDeps> = {}): AccountDeps {
  return {
    db,
    policy: createAddressPolicy({ allowPrivate: false, resolve }),
    sealer,
    allowInsecureLogins: false,
    ...overrides,
  }
}

beforeEach(() => {
  resolve.mockClear()
  db = openTestDb()
  const ids = createUsers(db)
  alice = { id: ids.alice, sub: 'sub-alice' }
  bob = { id: ids.bob, sub: 'sub-bob' }
})
afterEach(() => db.close())

const none = (extra: Record<string, unknown> = {}) => ({
  name: 'Holidays',
  url: 'https://cal.example.org/dav/',
  authMode: 'none',
  ...extra,
})
const basic = (extra: Record<string, unknown> = {}) => ({
  name: 'Work',
  url: 'https://cal.example.org/dav/',
  authMode: 'basic',
  username: 'alice',
  password: 'pw-alice',
  ...extra,
})

async function add(user: { id: number; sub: string }, body: unknown, d = deps()) {
  return addAccount(d, user, body)
}

function opens(result: ExternalAccountResult, user: { sub: string }, origin: string) {
  return sealer.open(result.sealed, { sub: user.sub, accountId: result.account.id, origin })
}

describe('adding an account without a login', () => {
  it('stores the normalised address and answers the account with no seal', async () => {
    const result = await add(
      alice,
      none({ name: '  Holidays  ', url: 'HTTPS://Cal.Example.ORG:443/dav/a b/', color: '#AABBCC' }),
    )
    expect(result.sealed).toBeNull()
    expect(result.account).toEqual({
      id: expect.any(Number),
      name: 'Holidays',
      url: 'https://cal.example.org/dav/a%20b/',
      authMode: 'none',
      username: null,
      color: '#aabbcc',
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    })
    expect(findExternalAccount(db, alice.id, result.account.id)?.origin).toBe(
      'https://cal.example.org',
    )
  })

  it('derives the origin the way the URL parser writes it: lower case, default port left out', async () => {
    const cases: [string, string][] = [
      ['https://Cal.Example.ORG/dav/', 'https://cal.example.org'],
      ['https://cal.example.org:443/dav/', 'https://cal.example.org'],
      ['http://cal.example.org:80/dav/', 'http://cal.example.org'],
      ['https://cal.example.org:8443/dav/', 'https://cal.example.org:8443'],
      ['http://cal.example.org:8080/', 'http://cal.example.org:8080'],
    ]
    for (const [url, origin] of cases) {
      const { account } = await add(alice, none({ url }))
      expect(findExternalAccount(db, alice.id, account.id)?.origin, url).toBe(origin)
      removeAccount(db, alice.id, account.id)
    }
  })

  it('allows plain http without a login', async () => {
    const { account } = await add(alice, none({ url: 'http://cal.example.org/dav/' }))
    expect(account.url).toBe('http://cal.example.org/dav/')
  })

  it('takes no color as null and ignores unknown fields', async () => {
    const { account } = await add(alice, { ...none(), color: null, admin: true, id: 99 })
    expect(account.color).toBeNull()
    expect(account.id).not.toBe(99)
  })

  it('keeps the query of the address, drops nothing else', async () => {
    const { account } = await add(alice, none({ url: 'https://cal.example.org/dav?user=x' }))
    expect(account.url).toBe('https://cal.example.org/dav?user=x')
  })
})

describe('adding an account with a login', () => {
  it('answers a seal that opens for this user, this account and this origin, and nothing else', async () => {
    const result = await add(alice, basic())
    expect(result.account).toMatchObject({ authMode: 'basic', username: 'alice' })
    expect(result.sealed).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(opens(result, alice, 'https://cal.example.org')).toEqual({
      username: 'alice',
      password: 'pw-alice',
    })
    expect(opens(result, bob, 'https://cal.example.org')).toBeNull()
    expect(opens(result, alice, 'https://dav.example.net')).toBeNull()
    expect(
      sealer.open(result.sealed, {
        sub: alice.sub,
        accountId: result.account.id + 1,
        origin: 'https://cal.example.org',
      }),
    ).toBeNull()
  })

  it('stores no password and no seal: nothing in the database holds them', async () => {
    const result = await add(alice, basic({ password: 'a-very-secret-password' }))
    const rows = db.prepare('SELECT * FROM external_accounts').all()
    const text = JSON.stringify(rows)
    expect(text).not.toContain('a-very-secret-password')
    expect(text).not.toContain(result.sealed!)
    expect(Object.keys(rows[0] as object).sort()).toEqual(
      [
        'auth_mode',
        'color',
        'created_at',
        'id',
        'name',
        'origin',
        'updated_at',
        'url',
        'user_id',
        'username',
      ].sort(),
    )
    // Not in the answer's account either.
    expect(JSON.stringify(result.account)).not.toContain('a-very-secret-password')
  })

  it('refuses with logins_disabled when the server has no seal key', async () => {
    await expect(add(alice, basic(), deps({ sealer: null }))).rejects.toEqual(
      apiError(400, 'logins_disabled'),
    )
    expect(listExternalAccounts(db, alice.id)).toEqual([])
  })

  it('still adds an account without a login when logins are disabled', async () => {
    await expect(add(alice, none(), deps({ sealer: null }))).resolves.toMatchObject({
      sealed: null,
    })
  })

  it('needs the password: credential_required, nothing stored', async () => {
    for (const password of [undefined, null, '']) {
      await expect(add(alice, basic({ password }))).rejects.toEqual(
        apiError(400, 'credential_required'),
      )
    }
    expect(listExternalAccounts(db, alice.id)).toEqual([])
  })

  it('refuses a login over plain http, except for the switch for tests', async () => {
    const body = basic({ url: 'http://cal.example.org/dav/' })
    await expect(add(alice, body)).rejects.toEqual(apiError(400, 'invalid_url'))
    await expect(add(alice, body, deps({ allowInsecureLogins: true }))).resolves.toMatchObject({
      account: { authMode: 'basic' },
    })
  })
})

describe('validation', () => {
  const rejects = async (body: unknown, field: string, code: 'invalid_url' | undefined) => {
    const error = await add(alice, body).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error, JSON.stringify(body)).toMatchObject({
      name: 'ApiError',
      statusCode: 400,
      data: { fields: expect.arrayContaining([expect.objectContaining({ field })]) },
    })
    expect((error as { data: { code?: string } }).data.code).toBe(code)
  }

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { href: 'https://cal.example.org/' }],
    ['empty', ''],
    ['blank', '   '],
    ['not a URL', 'cal.example.org/dav'],
    ['a relative path', '/dav/'],
    ['ftp', 'ftp://cal.example.org/'],
    ['webcal', 'webcal://cal.example.org/dav/'],
    ['file', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['no host', 'https://'],
    ['user info', 'https://user@cal.example.org/'],
    ['user info with a password', 'https://user:pw@cal.example.org/'],
    ['a fragment', 'https://cal.example.org/dav/#top'],
    ['a bare #', 'https://cal.example.org/dav/#'],
    ['a port out of range', 'https://cal.example.org:99999/'],
    ['too long', `https://cal.example.org/${'a'.repeat(EXTERNAL_URL_MAX_LENGTH)}`],
  ])('refuses an address that is %s, with the invalid_url code', async (_name, url) => {
    await rejects(none({ url }), 'url', 'invalid_url')
  })

  it('keeps the address within the limit after normalisation', async () => {
    const url = `https://cal.example.org/${'ä'.repeat(EXTERNAL_URL_MAX_LENGTH / 4)}`
    await rejects(none({ url }), 'url', 'invalid_url')
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['a number', 7],
    ['too long', 'n'.repeat(EXTERNAL_NAME_MAX_LENGTH + 1)],
    ['with a newline', 'Work\nCalendar'],
    ['with a NUL', 'Work\0'],
    ['with a tab', 'Work\tCalendar'],
    ['with a line separator', 'Work Calendar'],
    ['with DEL', 'Work\u007f'],
  ])('refuses a name that is %s', async (_name, name) => {
    await rejects(none({ name }), 'name', undefined)
  })

  it('accepts a name of the longest allowed length and ordinary punctuation', async () => {
    const name = `${'n'.repeat(EXTERNAL_NAME_MAX_LENGTH - 3)}: ä`
    await expect(add(alice, none({ name }))).resolves.toBeDefined()
  })

  it.each([
    ['missing', undefined],
    ['unknown', 'digest'],
    ['oidc (not in the first version)', 'oidc'],
    ['upper case', 'BASIC'],
    ['a number', 1],
  ])('refuses a login mode that is %s', async (_name, authMode) => {
    await rejects(none({ authMode }), 'authMode', undefined)
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['padded', ' alice'],
    ['with a colon', 'ali:ce'],
    ['with a newline', 'ali\nce'],
    ['with a NUL', 'ali\0ce'],
    ['too long', 'u'.repeat(EXTERNAL_USERNAME_MAX_LENGTH + 1)],
    ['a number', 5],
  ])('refuses a user name that is %s for a login', async (_name, username) => {
    await rejects(basic({ username }), 'username', undefined)
  })

  it('accepts a user name that is an email address, and the longest one', async () => {
    await expect(add(alice, basic({ username: 'alice@example.org' }))).resolves.toBeDefined()
    await expect(
      add(alice, basic({ url: 'https://cal.example.org/b/', username: 'u'.repeat(256) })),
    ).resolves.toBeDefined()
  })

  it('refuses a user name for an account without a login', async () => {
    await rejects(none({ username: 'alice' }), 'username', undefined)
  })

  it('refuses a password that is too long, not a string, or given without a login', async () => {
    await rejects(
      basic({ password: 'p'.repeat(EXTERNAL_PASSWORD_MAX_LENGTH + 1) }),
      'password',
      undefined,
    )
    await rejects(basic({ password: 12345 }), 'password', undefined)
    await rejects(none({ password: 'secret' }), 'password', undefined)
    await expect(
      add(alice, basic({ password: 'p'.repeat(EXTERNAL_PASSWORD_MAX_LENGTH) })),
    ).resolves.toBeDefined()
  })

  it('accepts a password with a colon, blanks and non-ASCII characters', async () => {
    const result = await add(alice, basic({ password: ' pä:ss wörd ' }))
    expect(opens(result, alice, 'https://cal.example.org')?.password).toBe(' pä:ss wörd ')
  })

  it.each(['red', '#12345', '#1234567', '#gggggg', 12])('refuses the color %j', async (color) => {
    await rejects(none({ color }), 'color', undefined)
  })

  it.each([undefined, null, 'a string', [], 42])('refuses the body %j', async (body) => {
    await expect(add(alice, body)).rejects.toEqual(apiError(400))
  })

  it('reports every problem at once', async () => {
    const error = await add(alice, { name: '', url: 'nope', authMode: 'x' }).catch((e) => e)
    expect(error.data.fields.map((f: { field: string }) => f.field).sort()).toEqual([
      'authMode',
      'name',
      'url',
    ])
  })
})

describe('the host policy', () => {
  const listed = (list: string) =>
    deps({
      policy: createAddressPolicy({
        allowPrivate: false,
        resolve,
        allowedHosts: parseHostList(list).list,
      }),
    })

  it('refuses a host that is not on the administrator’s list with host_not_allowed', async () => {
    const error = await add(
      alice,
      none({ url: 'https://dav.example.net/' }),
      listed('cal.example.org'),
    ).catch((e) => e)
    expect(error).toEqual(apiError(400, 'host_not_allowed'))
    expect(error.data.fields).toEqual([
      { field: 'url', message: 'must name a host that the administrator allows' },
    ])
    expect(resolve).not.toHaveBeenCalled()
    expect(listExternalAccounts(db, alice.id)).toEqual([])
  })

  it('refuses an unlisted host for an account with a login too, before anything is sealed', async () => {
    await expect(
      add(alice, basic({ url: 'https://dav.example.net/' }), listed('cal.example.org')),
    ).rejects.toEqual(apiError(400, 'host_not_allowed'))
  })

  it('accepts a listed host and a listed internal host', async () => {
    const d = listed('cal.example.org, *.corp.example')
    await expect(add(alice, none(), d)).resolves.toBeDefined()
    await expect(
      add(alice, none({ url: 'https://intranet.corp.example/dav/' }), d),
    ).resolves.toBeDefined()
  })

  it('refuses a listed name that resolves to loopback', async () => {
    await expect(
      add(alice, none({ url: 'https://loop.corp.example/dav/' }), listed('*.corp.example')),
    ).rejects.toEqual(apiError(400, 'host_not_allowed'))
  })

  it('without a list refuses private addresses and accepts public ones', async () => {
    await expect(add(alice, none({ url: 'https://intranet.corp.example/dav/' }))).rejects.toEqual(
      apiError(400, 'host_not_allowed'),
    )
    await expect(add(alice, none({ url: 'https://private.example.org/' }))).rejects.toEqual(
      apiError(400, 'host_not_allowed'),
    )
    await expect(add(alice, none({ url: 'http://127.0.0.1/dav/' }))).rejects.toEqual(
      apiError(400, 'host_not_allowed'),
    )
    await expect(add(alice, none({ url: 'http://169.254.169.254/latest/' }))).rejects.toEqual(
      apiError(400, 'host_not_allowed'),
    )
    await expect(add(alice, none({ url: 'http://localhost:3000/' }))).rejects.toEqual(
      apiError(400, 'host_not_allowed'),
    )
    await expect(add(alice, none())).resolves.toBeDefined()
  })

  it('refuses a name that does not resolve, as an address problem', async () => {
    await expect(add(alice, none({ url: 'https://nothing.example.org/' }))).rejects.toEqual(
      apiError(400, 'invalid_url'),
    )
  })

  it('refuses the CalDAV store’s host', async () => {
    const d = deps({
      policy: createAddressPolicy({
        allowPrivate: false,
        resolve,
        allowedHosts: parseHostList('*.corp.example').list,
        refusedHosts: ['intranet.corp.example'],
      }),
    })
    await expect(add(alice, none({ url: 'https://intranet.corp.example/' }), d)).rejects.toEqual(
      apiError(400, 'host_not_allowed'),
    )
  })
})

describe('isolation between users, limits, duplicates', () => {
  it('lists only the caller’s accounts', async () => {
    await add(alice, none({ name: 'A' }))
    await add(bob, none({ name: 'B', url: 'https://dav.example.net/' }))
    expect(listAccounts(db, sealer, alice.id).accounts.map((a) => a.name)).toEqual(['A'])
    expect(listAccounts(db, sealer, bob.id).accounts.map((a) => a.name)).toEqual(['B'])
  })

  it('says whether logins are possible', () => {
    expect(listAccounts(db, sealer, alice.id).loginsEnabled).toBe(true)
    expect(listAccounts(db, null, alice.id).loginsEnabled).toBe(false)
  })

  it('answers 404 for another user’s account on every operation, and leaves it alone', async () => {
    const mine = await add(alice, basic())
    const id = mine.account.id
    await expect(changeAccount(deps(), bob, id, { name: 'Mine now' })).rejects.toEqual(
      apiError(404),
    )
    expect(() => resealAccount(deps(), bob, id, { password: 'x' })).toThrow(apiError(404))
    expect(() => removeAccount(db, bob.id, id)).toThrow(apiError(404))
    expect(findExternalAccount(db, bob.id, id)).toBeNull()
    expect(findExternalAccount(db, alice.id, id)?.account.name).toBe('Work')
    // Nothing changed hands, not even for the DB functions underneath.
    expect(updateExternalAccount(db, bob.id, id, { ...findFields(), name: 'x' })).toBeNull()
    expect(deleteExternalAccount(db, bob.id, id)).toBe(false)
  })

  function findFields() {
    return {
      name: 'x',
      url: 'https://cal.example.org/dav/',
      origin: 'https://cal.example.org',
      authMode: 'none' as const,
      username: null,
      color: null,
    }
  }

  it('answers 404 for an id that does not exist', async () => {
    await expect(changeAccount(deps(), alice, 999, { name: 'x' })).rejects.toEqual(apiError(404))
    expect(() => resealAccount(deps(), alice, 999, { password: 'x' })).toThrow(apiError(404))
    expect(() => removeAccount(db, alice.id, 999)).toThrow(apiError(404))
  })

  it('lets two users have the same address', async () => {
    await add(alice, none())
    await expect(add(bob, none())).resolves.toBeDefined()
  })

  it('refuses a second account with the same address (duplicate, 409)', async () => {
    await add(alice, none())
    await expect(add(alice, none({ name: 'Again' }))).rejects.toEqual(apiError(409, 'duplicate'))
    // Spelled differently, the same normalised address.
    await expect(add(alice, none({ url: 'HTTPS://CAL.example.org:443/dav/' }))).rejects.toEqual(
      apiError(409, 'duplicate'),
    )
  })

  it(`allows ${MAX_EXTERNAL_ACCOUNTS} accounts per user and then refuses with limit_reached (409)`, async () => {
    for (let i = 0; i < MAX_EXTERNAL_ACCOUNTS; i++) {
      await add(alice, none({ name: `Account ${i}`, url: `https://cal.example.org/dav/${i}/` }))
    }
    await expect(add(alice, none({ url: 'https://cal.example.org/dav/extra/' }))).rejects.toEqual(
      apiError(409, 'limit_reached'),
    )
    // Another user has their own allowance; a removed account frees a slot.
    await expect(add(bob, none())).resolves.toBeDefined()
    const first = listExternalAccounts(db, alice.id)[0]!
    removeAccount(db, alice.id, first.id)
    await expect(
      add(alice, none({ url: 'https://cal.example.org/dav/extra/' })),
    ).resolves.toBeDefined()
  })

  it('goes away with the user', async () => {
    await add(alice, none())
    db.prepare('DELETE FROM users WHERE id = ?').run(alice.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM external_accounts').get()).toEqual({ n: 0 })
  })
})

describe('changing an account', () => {
  it('renames and recolors a login without a password and without a new seal', async () => {
    const created = await add(alice, basic())
    const result = await changeAccount(deps(), alice, created.account.id, {
      name: 'Renamed',
      color: '#112233',
    })
    expect(result.sealed).toBeNull()
    expect(result.account).toMatchObject({
      id: created.account.id,
      name: 'Renamed',
      color: '#112233',
      url: 'https://cal.example.org/dav/',
      authMode: 'basic',
      username: 'alice',
    })
    // The seal the browser holds is still good: nothing it is bound to has changed.
    expect(opens(created, alice, 'https://cal.example.org')).toBeTruthy()
  })

  it('changes the path within the same origin without a password', async () => {
    const created = await add(alice, basic())
    const result = await changeAccount(deps(), alice, created.account.id, {
      url: 'https://cal.example.org/other/path/',
    })
    expect(result.sealed).toBeNull()
    expect(result.account.url).toBe('https://cal.example.org/other/path/')
  })

  it('keeps what the body leaves out, and clears the color with null', async () => {
    const created = await add(alice, none({ color: '#abcdef' }))
    const kept = await changeAccount(deps(), alice, created.account.id, {})
    expect(kept.account).toMatchObject({ name: 'Holidays', color: '#abcdef' })
    const cleared = await changeAccount(deps(), alice, created.account.id, { color: null })
    expect(cleared.account.color).toBeNull()
  })

  it('needs the password again for a new origin, and then seals for the new origin only', async () => {
    const created = await add(alice, basic())
    const change = { url: 'https://dav.example.net/dav/' }
    await expect(changeAccount(deps(), alice, created.account.id, change)).rejects.toEqual(
      apiError(400, 'credential_required'),
    )
    // Nothing was changed by the refusal.
    expect(findExternalAccount(db, alice.id, created.account.id)?.account.url).toBe(
      'https://cal.example.org/dav/',
    )
    const result = await changeAccount(deps(), alice, created.account.id, {
      ...change,
      password: 'new-pw',
    })
    expect(result.account.url).toBe('https://dav.example.net/dav/')
    expect(opens(result, alice, 'https://dav.example.net')).toEqual({
      username: 'alice',
      password: 'new-pw',
    })
    // The old seal is bound to the old origin and does not open for the new one.
    expect(opens(created, alice, 'https://dav.example.net')).toBeNull()
    expect(findExternalAccount(db, alice.id, created.account.id)?.origin).toBe(
      'https://dav.example.net',
    )
  })

  it('treats another scheme or port as another origin', async () => {
    const created = await add(alice, basic())
    for (const url of ['https://cal.example.org:8443/dav/', 'http://cal.example.org/dav/']) {
      await expect(
        changeAccount(deps({ allowInsecureLogins: true }), alice, created.account.id, { url }),
      ).rejects.toEqual(apiError(400, 'credential_required'))
    }
  })

  it('needs the password again for a new user name', async () => {
    const created = await add(alice, basic())
    await expect(
      changeAccount(deps(), alice, created.account.id, { username: 'alice2' }),
    ).rejects.toEqual(apiError(400, 'credential_required'))
    const result = await changeAccount(deps(), alice, created.account.id, {
      username: 'alice2',
      password: 'pw2',
    })
    expect(opens(result, alice, 'https://cal.example.org')).toEqual({
      username: 'alice2',
      password: 'pw2',
    })
    expect(result.account.username).toBe('alice2')
  })

  it('needs the password when an account without a login gets one', async () => {
    const created = await add(alice, none())
    await expect(
      changeAccount(deps(), alice, created.account.id, { authMode: 'basic', username: 'alice' }),
    ).rejects.toEqual(apiError(400, 'credential_required'))
    await expect(
      changeAccount(deps(), alice, created.account.id, { authMode: 'basic' }),
    ).rejects.toEqual(apiError(400))
    const result = await changeAccount(deps(), alice, created.account.id, {
      authMode: 'basic',
      username: 'alice',
      password: 'pw',
    })
    expect(result.account).toMatchObject({ authMode: 'basic', username: 'alice' })
    expect(opens(result, alice, 'https://cal.example.org')?.password).toBe('pw')
  })

  it('drops a login without a password and clears the user name', async () => {
    const created = await add(alice, basic())
    const result = await changeAccount(deps(), alice, created.account.id, { authMode: 'none' })
    expect(result.sealed).toBeNull()
    expect(result.account).toMatchObject({ authMode: 'none', username: null })
    // A password given for an account that ends up without a login is a mistake.
    const again = await add(alice, basic({ url: 'https://dav.example.net/' }))
    await expect(
      changeAccount(deps(), alice, again.account.id, { authMode: 'none', password: 'x' }),
    ).rejects.toEqual(apiError(400))
  })

  it('reseals when the password is given even if nothing else changed', async () => {
    const created = await add(alice, basic())
    const result = await changeAccount(deps(), alice, created.account.id, { password: 'changed' })
    expect(opens(result, alice, 'https://cal.example.org')?.password).toBe('changed')
  })

  it('validates a change like a new account', async () => {
    const created = await add(alice, none())
    await expect(
      changeAccount(deps(), alice, created.account.id, { url: 'https://u:p@cal.example.org/' }),
    ).rejects.toEqual(apiError(400, 'invalid_url'))
    await expect(changeAccount(deps(), alice, created.account.id, { name: '' })).rejects.toEqual(
      apiError(400),
    )
    await expect(changeAccount(deps(), alice, created.account.id, 'nope')).rejects.toEqual(
      apiError(400),
    )
    await expect(
      changeAccount(deps(), alice, created.account.id, { color: 'blue' }),
    ).rejects.toEqual(apiError(400))
  })

  it('refuses a change of an address to plain http for a login', async () => {
    const created = await add(alice, basic())
    await expect(
      changeAccount(deps(), alice, created.account.id, {
        url: 'http://cal.example.org/dav/',
        password: 'x',
      }),
    ).rejects.toEqual(apiError(400, 'invalid_url'))
  })

  it('refuses a new address that duplicates another account of the user', async () => {
    await add(alice, none({ url: 'https://dav.example.net/' }))
    const second = await add(alice, none())
    await expect(
      changeAccount(deps(), alice, second.account.id, { url: 'https://dav.example.net/' }),
    ).rejects.toEqual(apiError(409, 'duplicate'))
    // The same address as its own is fine.
    await expect(
      changeAccount(deps(), alice, second.account.id, {
        url: 'https://cal.example.org/dav/',
        name: 'X',
      }),
    ).resolves.toBeDefined()
  })

  it('checks the new address against the host policy; a rename needs no DNS', async () => {
    const created = await add(alice, none())
    const list = (text: string) =>
      deps({
        policy: createAddressPolicy({
          allowPrivate: false,
          resolve,
          allowedHosts: parseHostList(text).list,
        }),
      })
    await expect(
      changeAccount(list('cal.example.org'), alice, created.account.id, {
        url: 'https://dav.example.net/',
      }),
    ).rejects.toEqual(apiError(400, 'host_not_allowed'))
    resolve.mockClear()
    await expect(
      changeAccount(list('cal.example.org'), alice, created.account.id, { name: 'Renamed' }),
    ).resolves.toBeDefined()
    expect(resolve).not.toHaveBeenCalled()
    // A host that has left the list: the change is refused, even a rename.
    await expect(
      changeAccount(list('dav.example.net'), alice, created.account.id, { name: 'Renamed again' }),
    ).rejects.toEqual(apiError(400, 'host_not_allowed'))
  })

  it('refuses to change an account to one with a login when the server has no seal key', async () => {
    const created = await add(alice, none())
    await expect(
      changeAccount(deps({ sealer: null }), alice, created.account.id, {
        authMode: 'basic',
        username: 'alice',
        password: 'x',
      }),
    ).rejects.toEqual(apiError(400, 'logins_disabled'))
    // …and an update of an account that has a login, a rename included, is refused as well:
    // such an account cannot be used without the key.
    const login = await add(alice, basic({ url: 'https://dav.example.net/' }))
    await expect(
      changeAccount(deps({ sealer: null }), alice, login.account.id, { name: 'x' }),
    ).rejects.toEqual(apiError(400, 'logins_disabled'))
    // Leaving the login behind is possible without the key.
    await expect(
      changeAccount(deps({ sealer: null }), alice, login.account.id, { authMode: 'none' }),
    ).resolves.toMatchObject({ account: { authMode: 'none' } })
  })

  it('moves updated_at forward', async () => {
    const created = await add(alice, none())
    db.prepare("UPDATE external_accounts SET updated_at = '2020-01-01T00:00:00.000Z'").run()
    const result = await changeAccount(deps(), alice, created.account.id, { name: 'Later' })
    expect(result.account.updatedAt > '2020-01-01T00:00:00.000Z').toBe(true)
  })
})

describe('a new seal for an existing account', () => {
  it('seals the stored user name and origin with the new password, without any network', async () => {
    const created = await add(alice, basic())
    resolve.mockClear()
    const result = resealAccount(deps(), alice, created.account.id, { password: 'on-a-new-device' })
    expect(result.account).toEqual(created.account)
    expect(opens(result, alice, 'https://cal.example.org')).toEqual({
      username: 'alice',
      password: 'on-a-new-device',
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(result.sealed).not.toBe(created.sealed)
  })

  it('does not change the stored account', async () => {
    const created = await add(alice, basic())
    resealAccount(deps(), alice, created.account.id, { password: 'x' })
    expect(findExternalAccount(db, alice.id, created.account.id)?.account).toEqual(created.account)
  })

  it('is refused for an account without a login', async () => {
    const created = await add(alice, none())
    expect(() => resealAccount(deps(), alice, created.account.id, { password: 'x' })).toThrow(
      apiError(400),
    )
  })

  it('is refused without the seal key: logins_disabled', async () => {
    const created = await add(alice, basic())
    expect(() =>
      resealAccount(deps({ sealer: null }), alice, created.account.id, { password: 'x' }),
    ).toThrow(apiError(400, 'logins_disabled'))
  })

  it.each([
    ['missing', {}],
    ['null', { password: null }],
    ['empty', { password: '' }],
    ['a number', { password: 1 }],
    ['too long', { password: 'p'.repeat(EXTERNAL_PASSWORD_MAX_LENGTH + 1) }],
    ['not an object', 'password'],
  ])('is refused when the password is %s', async (_name, body) => {
    const created = await add(alice, basic())
    expect(() => resealAccount(deps(), alice, created.account.id, body)).toThrow(apiError(400))
  })
})

describe('removing an account', () => {
  it('deletes it', async () => {
    const created = await add(alice, none())
    removeAccount(db, alice.id, created.account.id)
    expect(findExternalAccount(db, alice.id, created.account.id)).toBeNull()
  })
})

describe('the table’s own checks', () => {
  const insert = (values: Record<string, unknown>) =>
    db
      .prepare(
        `INSERT INTO external_accounts (user_id, name, url, origin, auth_mode, username)
         VALUES (@user_id, @name, @url, @origin, @auth_mode, @username)`,
      )
      .run({
        user_id: alice.id,
        name: 'X',
        url: 'https://cal.example.org/',
        origin: 'https://cal.example.org',
        auth_mode: 'none',
        username: null,
        ...values,
      })

  it('takes a plain row', () => {
    expect(() => insert({})).not.toThrow()
  })

  it.each([
    ['an unknown login mode', { auth_mode: 'digest' }],
    ['a login without a user name', { auth_mode: 'basic', username: null }],
    ['a login with an empty user name', { auth_mode: 'basic', username: '' }],
    ['a user name without a login', { username: 'alice' }],
    ['an upper-case origin', { origin: 'https://Cal.example.org' }],
    ['an origin with another scheme', { origin: 'ftp://cal.example.org' }],
    ['an empty origin', { origin: '' }],
    ['an origin that is only a scheme', { origin: 'https://' }],
    ['an empty name', { name: '' }],
    ['an empty address', { url: '' }],
    ['no user', { user_id: null }],
    ['a user that does not exist', { user_id: 9999 }],
  ])('refuses %s', (_name, values) => {
    expect(() => insert(values)).toThrow()
  })

  it('refuses the same address twice for one user', () => {
    insert({})
    expect(() => insert({})).toThrow(/UNIQUE/)
  })

  it('creates the account through the module with the limit applied inside a transaction', () => {
    for (let i = 0; i < MAX_EXTERNAL_ACCOUNTS; i++) {
      createExternalAccount(db, alice.id, { ...findFieldsFor(i) })
    }
    expect(() => createExternalAccount(db, alice.id, findFieldsFor(99))).toThrow(
      expect.objectContaining({ name: 'ExternalAccountError', code: 'limit_reached' }),
    )
  })

  function findFieldsFor(index: number) {
    return {
      name: `A${index}`,
      url: `https://cal.example.org/${index}/`,
      origin: 'https://cal.example.org',
      authMode: 'none' as const,
      username: null,
      color: null,
    }
  }
})
