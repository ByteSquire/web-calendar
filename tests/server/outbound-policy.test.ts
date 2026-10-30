// @vitest-environment node
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { upsertUser } from '../../server/db/users'
import { createIcalProxy } from '../../server/utils/ical-proxy/cache'
import { IcalFetchError } from '../../server/utils/ical-proxy/errors'
import { fetchIcal } from '../../server/utils/ical-proxy/fetcher'
import { parseHostList } from '../../server/utils/ical-proxy/host-list'
import {
  createAddressPolicy,
  createGuardedLookup,
  hostRefusal,
  isBlockedForListedHost,
  isBlockedHost,
  resolveAllowed,
  type AddressPolicy,
  type Resolver,
} from '../../server/utils/ical-proxy/ssrf'
import { addSubscription, changeSubscription } from '../../server/utils/ical-proxy/subscriptions'

// The host policy (NUXT_OUTBOUND_ALLOWED_HOSTS) inside the SSRF guard. With a list: a host that is
// not on it is refused; a listed host may live in a private range, but never in loopback,
// link-local, unspecified or multicast space; the CalDAV store's host is refused even if listed;
// all of it is decided again when the socket connects. Without a list nothing changes.

const migrationsDir = fileURLToPath(new URL('../../server/db/migrations', import.meta.url))
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'

function hosts(text: string) {
  const { list, problems } = parseHostList(text)
  expect(problems).toEqual([])
  return list
}

const ZONE: Record<string, string[]> = {
  'cal.example.org': ['93.184.216.34'],
  'public.example.net': ['93.184.216.35'],
  'intranet.corp.example': ['10.0.0.5'],
  'lan.corp.example': ['192.168.1.20', '172.16.4.4'],
  'ula.corp.example': ['fd12:3456::1'],
  'loop.corp.example': ['127.0.0.1'],
  'meta.corp.example': ['169.254.169.254'],
  'mapped.corp.example': ['::ffff:169.254.169.254'],
  'mapped-private.corp.example': ['::ffff:10.0.0.5'],
  'nat64.corp.example': ['64:ff9b::a9fe:a9fe'],
  'compat.corp.example': ['::7f00:1'],
  'linklocal6.corp.example': ['fe80::1'],
  'multicast.corp.example': ['224.0.0.1'],
  'unspecified.corp.example': ['0.0.0.0'],
  'mixed.corp.example': ['10.0.0.5', '127.0.0.1'],
  'radicale.corp.example': ['10.0.0.9'],
  'store.example.org': ['10.1.2.3'],
  radicale: ['172.18.0.3'],
}

const resolve = vi.fn<Resolver>(async (hostname) => {
  const addresses = ZONE[hostname]
  if (!addresses) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
})

beforeEach(() => {
  resolve.mockClear()
})

function policyWith(
  list: string,
  extra: { allowPrivate?: boolean; refusedHosts?: string[] } = {},
): AddressPolicy {
  return createAddressPolicy({
    allowPrivate: extra.allowPrivate ?? false,
    resolve,
    allowedHosts: hosts(list),
    refusedHosts: extra.refusedHosts,
  })
}

async function outcome(host: string, policy: AddressPolicy): Promise<string> {
  try {
    await resolveAllowed(host, policy)
    return 'allowed'
  } catch (error) {
    if (!(error instanceof IcalFetchError)) throw error
    return error.notListed ? 'not-listed' : error.reason
  }
}

describe('the address check for a listed host', () => {
  it.each([
    '10.0.0.5',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '198.18.0.1',
    '8.8.8.8',
    'fd12:3456::1',
    'fc00::1',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2606:4700:4700::1111',
  ])('allows %s (private ranges are where internal servers live)', (address) => {
    expect(isBlockedForListedHost(address)).toBe(false)
  })

  it.each([
    // unspecified
    '0.0.0.0',
    '0.1.2.3',
    '::',
    // loopback
    '127.0.0.1',
    '127.255.255.254',
    '::1',
    '0:0:0:0:0:0:0:1',
    // link-local, the cloud metadata address
    '169.254.169.254',
    '169.254.0.1',
    '169.254.255.255',
    // other clouds' metadata addresses, which the private ranges would otherwise let through
    '100.100.100.200',
    'fd00:ec2::254',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    // multicast, reserved, broadcast
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    'ff02::1',
    'ff0e::1',
    // every way of writing an IPv4 address inside an IPv6 one
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::ffff:10.0.0.5',
    '::127.0.0.1',
    '::7f00:1',
    '::a9fe:a9fe',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::1',
    // site-local, documentation, unparsable
    'fec0::1',
    '2001:db8::1',
    '1::1',
    'not an address',
    '',
    '1.2.3',
    '1.2.3.4.5',
  ])('blocks %j', (address) => {
    expect(isBlockedForListedHost(address)).toBe(true)
  })
})

describe('a policy with a list', () => {
  const policy = policyWith('*.corp.example, cal.example.org, 192.168.7.7, 127.0.0.1')

  it('refuses an unlisted host, public or not, with the not-listed flag', async () => {
    expect(await outcome('public.example.net', policy)).toBe('not-listed')
    expect(await outcome('example.org', policy)).toBe('not-listed')
    expect(await outcome('corp.example', policy)).toBe('not-listed') // the domain itself is not `*.corp.example`
    expect(await outcome('evilcorp.example', policy)).toBe('not-listed')
    expect(await outcome('8.8.8.8', policy)).toBe('not-listed')
    expect(await outcome('10.0.0.5', policy)).toBe('not-listed')
    // The list is checked before DNS: nothing is resolved for a host that cannot be used.
    expect(resolve).not.toHaveBeenCalled()
  })

  it('allows a listed public host', async () => {
    expect(await outcome('cal.example.org', policy)).toBe('allowed')
  })

  it('is case-insensitive through the guarded lookup, which lower-cases the name', async () => {
    const lookup = createGuardedLookup(policy)
    const reply = await new Promise<{ error: unknown; address: unknown }>((done) =>
      lookup('CAL.Example.ORG.', { all: true }, (error, address) => done({ error, address })),
    )
    expect(reply.error).toBeNull()
    expect(reply.address).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('allows a listed host in a private range, however many private addresses it has', async () => {
    expect(await outcome('intranet.corp.example', policy)).toBe('allowed')
    expect(await outcome('lan.corp.example', policy)).toBe('allowed')
    expect(await outcome('ula.corp.example', policy)).toBe('allowed')
  })

  it('allows a listed IP literal in a private range, and refuses a listed loopback literal', async () => {
    expect(await outcome('192.168.7.7', policy)).toBe('allowed')
    expect(await outcome('127.0.0.1', policy)).toBe('blocked')
    expect(isBlockedHost('192.168.7.7', policy)).toBe(false)
    expect(isBlockedHost('127.0.0.1', policy)).toBe(true)
  })

  it.each([
    'loop.corp.example',
    'meta.corp.example',
    'mapped.corp.example',
    'mapped-private.corp.example',
    'nat64.corp.example',
    'compat.corp.example',
    'linklocal6.corp.example',
    'multicast.corp.example',
    'unspecified.corp.example',
    'mixed.corp.example',
  ])(
    'refuses %s even though it is listed: loopback and its relatives stay blocked',
    async (host) => {
      expect(await outcome(host, policy)).toBe('blocked')
    },
  )

  it('refuses localhost names even if they are listed', async () => {
    const withLocalhost = policyWith('localhost, *.localhost')
    expect(await outcome('localhost', withLocalhost)).toBe('blocked')
    expect(await outcome('app.localhost', withLocalhost)).toBe('blocked')
  })

  it('reports a name that does not resolve as unreachable, not as a policy refusal', async () => {
    expect(await outcome('nothing.corp.example', policy)).toBe('unreachable')
  })

  it('hostRefusal tells the two refusals apart without any DNS', () => {
    expect(hostRefusal('public.example.net', policy)).toMatchObject({
      reason: 'blocked',
      notListed: true,
    })
    expect(hostRefusal('127.0.0.1', policy)).toMatchObject({ reason: 'blocked', notListed: false })
    expect(hostRefusal('cal.example.org', policy)).toBeNull()
    expect(hostRefusal('anything.corp.example', policy)).toBeNull()
  })
})

describe('without a list (today’s behaviour)', () => {
  it.each([undefined, null, hosts(''), hosts('  ')])(
    'policy %#: public yes, private no',
    async (list) => {
      const policy = createAddressPolicy({ allowPrivate: false, resolve, allowedHosts: list })
      expect(policy.isUnlistedHostname).toBeUndefined()
      expect(await outcome('cal.example.org', policy)).toBe('allowed')
      expect(await outcome('public.example.net', policy)).toBe('allowed')
      expect(await outcome('intranet.corp.example', policy)).toBe('blocked')
      expect(await outcome('lan.corp.example', policy)).toBe('blocked')
      expect(await outcome('ula.corp.example', policy)).toBe('blocked')
      expect(await outcome('loop.corp.example', policy)).toBe('blocked')
      expect(await outcome('localhost', policy)).toBe('blocked')
      expect(await outcome('10.0.0.5', policy)).toBe('blocked')
      expect(await outcome('8.8.8.8', policy)).toBe('allowed')
    },
  )

  it('a hand-made policy of the old three members still works', async () => {
    const legacy: AddressPolicy = {
      resolve,
      isBlockedAddress: (address) => address.startsWith('10.'),
      isBlockedHostname: () => false,
    }
    expect(await outcome('cal.example.org', legacy)).toBe('allowed')
    expect(await outcome('intranet.corp.example', legacy)).toBe('blocked')
  })
})

describe('the CalDAV store’s host', () => {
  it('is refused by name even when the list names it', async () => {
    const policy = policyWith('radicale, *.corp.example', { refusedHosts: ['radicale'] })
    expect(await outcome('radicale', policy)).toBe('blocked')
    expect(await outcome('intranet.corp.example', policy)).toBe('allowed')
  })

  it('is refused when it is a name below a listed domain', async () => {
    const policy = policyWith('*.corp.example', { refusedHosts: ['radicale.corp.example'] })
    expect(await outcome('radicale.corp.example', policy)).toBe('blocked')
    expect(await outcome('intranet.corp.example', policy)).toBe('allowed')
  })

  it('is refused without a list as well, whatever its case or trailing dot', async () => {
    const policy = createAddressPolicy({
      allowPrivate: false,
      resolve,
      refusedHosts: ['Radicale.'],
    })
    expect(await outcome('radicale', policy)).toBe('blocked')
  })

  it('is refused by address when it is an IP literal: as a literal and behind a listed name', async () => {
    const policy = policyWith('*.example.org, 10.1.2.3, 10.1.2.4', {
      refusedHosts: ['10.1.2.3'],
    })
    expect(await outcome('10.1.2.3', policy)).toBe('blocked')
    expect(await outcome('10.1.2.4', policy)).toBe('allowed')
    expect(await outcome('store.example.org', policy)).toBe('blocked')
    expect(await outcome('cal.example.org', policy)).toBe('allowed')
  })

  it('is refused by an IPv6 address in any spelling', async () => {
    const policy = createAddressPolicy({
      allowPrivate: false,
      resolve: async () => [{ address: '0:0:0:0:0:0:0:1', family: 6 }],
      allowedHosts: hosts('v6.example.org'),
      refusedHosts: ['[fd00::1]', 'fd00:0:0:0:0:0:0:2'],
    })
    expect(policy.isBlockedAddress('fd00::1', 'v6.example.org')).toBe(true)
    expect(policy.isBlockedAddress('FD00:0:0:0:0:0:0:1', 'v6.example.org')).toBe(true)
    expect(policy.isBlockedAddress('fd00::2', 'v6.example.org')).toBe(true)
    expect(policy.isBlockedAddress('fd00::3', 'v6.example.org')).toBe(false)
  })

  it('is no longer refused when the switch for tests is on', async () => {
    const policy = policyWith('radicale', { allowPrivate: true, refusedHosts: ['radicale'] })
    expect(await outcome('radicale', policy)).toBe('allowed')
  })
})

describe('the switch for tests (allowPrivate) with a list', () => {
  const policy = policyWith('cal.example.org, loop.corp.example, 127.0.0.1', { allowPrivate: true })

  it('turns the address rules off but keeps the administrator’s list', async () => {
    expect(await outcome('loop.corp.example', policy)).toBe('allowed')
    expect(await outcome('127.0.0.1', policy)).toBe('allowed')
    expect(await outcome('public.example.net', policy)).toBe('not-listed')
    expect(await outcome('10.0.0.5', policy)).toBe('not-listed')
  })
})

describe('DNS rebinding with a list: the decision is made again when the socket connects', () => {
  it('a listed name that answered with a private address and later answers with loopback is refused', async () => {
    let answer = '10.0.0.5'
    const flipping: Resolver = async () => [{ address: answer, family: 4 }]
    const policy = createAddressPolicy({
      allowPrivate: false,
      resolve: flipping,
      allowedHosts: hosts('rebind.corp.example'),
    })
    await expect(resolveAllowed('rebind.corp.example', policy)).resolves.toEqual([
      { address: '10.0.0.5', family: 4 },
    ])

    answer = '127.0.0.1'
    const rejected: IcalFetchError[] = []
    const lookup = createGuardedLookup(policy, (error) => rejected.push(error))
    const reply = await new Promise<{ error: unknown }>((done) =>
      lookup('rebind.corp.example', { all: true }, (error) => done({ error })),
    )
    expect(reply.error).toBeInstanceOf(IcalFetchError)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ reason: 'blocked', notListed: false })
  })

  it('the lookup refuses an unlisted name before it resolves anything', async () => {
    const policy = policyWith('cal.example.org')
    const rejected: IcalFetchError[] = []
    const lookup = createGuardedLookup(policy, (error) => rejected.push(error))
    const reply = await new Promise<{ error: unknown }>((done) =>
      lookup('public.example.net', { all: true }, (error) => done({ error })),
    )
    expect(reply.error).toBeInstanceOf(IcalFetchError)
    expect(rejected[0]).toMatchObject({ reason: 'blocked', notListed: true })
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('iCal subscriptions with a list', () => {
  let db: Database
  let alice: number

  beforeEach(() => {
    db = openDatabase(':memory:')
    runMigrations(db, loadMigrationsFromDir(migrationsDir))
    alice = upsertUser(db, { sub: 'sub-alice', username: 'alice' }).id
  })
  afterEach(() => db.close())

  const body = (url: string) => ({ name: 'Feed', url })
  const rejection = (message: string) =>
    expect.objectContaining({
      statusCode: 400,
      data: { fields: [{ field: 'url', message }] },
    })

  it('refuses to subscribe to a host that is not listed, and says why', async () => {
    const policy = policyWith('cal.example.org, *.corp.example')
    await expect(
      addSubscription(db, policy, alice, body('https://public.example.net/a.ics')),
    ).rejects.toEqual(rejection('must name a host that the administrator allows'))
    await expect(addSubscription(db, policy, alice, body('https://8.8.8.8/a.ics'))).rejects.toEqual(
      rejection('must name a host that the administrator allows'),
    )
    expect(resolve).not.toHaveBeenCalled()
  })

  it('subscribes to a listed host, a listed internal one included', async () => {
    const policy = policyWith('cal.example.org, *.corp.example')
    await expect(
      addSubscription(db, policy, alice, body('https://cal.example.org/a.ics')),
    ).resolves.toMatchObject({ url: 'https://cal.example.org/a.ics' })
    await expect(
      addSubscription(db, policy, alice, body('https://intranet.corp.example/team.ics')),
    ).resolves.toMatchObject({ url: 'https://intranet.corp.example/team.ics' })
  })

  it('still refuses a listed host that resolves to loopback or the metadata address', async () => {
    const policy = policyWith('*.corp.example')
    for (const host of ['loop.corp.example', 'meta.corp.example', 'mapped.corp.example']) {
      await expect(
        addSubscription(db, policy, alice, body(`https://${host}/a.ics`)),
      ).rejects.toEqual(rejection('must not point to a private or reserved network'))
    }
  })

  it('checks a changed address against the list too', async () => {
    const policy = policyWith('cal.example.org')
    const created = await addSubscription(db, policy, alice, body('https://cal.example.org/a.ics'))
    await expect(
      changeSubscription(db, policy, alice, created.id, body('https://public.example.net/a.ics')),
    ).rejects.toEqual(rejection('must name a host that the administrator allows'))
    await expect(
      changeSubscription(db, policy, alice, created.id, body('https://cal.example.org/b.ics')),
    ).resolves.toMatchObject({ url: 'https://cal.example.org/b.ics' })
  })

  it('without a list it behaves as before', async () => {
    const policy = createAddressPolicy({ allowPrivate: false, resolve })
    await expect(
      addSubscription(db, policy, alice, body('https://public.example.net/a.ics')),
    ).resolves.toBeDefined()
    await expect(
      addSubscription(db, policy, alice, body('https://intranet.corp.example/a.ics')),
    ).rejects.toEqual(rejection('must not point to a private or reserved network'))
  })
})

describe('fetching with a list (real sockets on loopback)', () => {
  interface Hit {
    host: string | undefined
    path: string | undefined
  }
  let feed: Server
  let other: Server
  let feedPort = 0
  let otherPort = 0
  const feedHits: Hit[] = []
  const otherHits: Hit[] = []

  async function listen(server: Server, host: string): Promise<number> {
    await new Promise<void>((done) => server.listen(0, host, done))
    return (server.address() as AddressInfo).port
  }

  beforeAll(async () => {
    feed = createServer((request, response) => {
      feedHits.push({ host: request.headers.host, path: request.url })
      if (request.url === '/to-other') {
        response.writeHead(302, { location: `http://other.test:${otherPort}/a.ics` })
        return response.end()
      }
      response.writeHead(200, { 'content-type': 'text/calendar' })
      response.end(ICS)
    })
    other = createServer((request, response) => {
      otherHits.push({ host: request.headers.host, path: request.url })
      response.writeHead(200, { 'content-type': 'text/calendar' })
      response.end(ICS)
    })
    feedPort = await listen(feed, '127.0.0.1')
    otherPort = await listen(other, '127.0.0.2')
  })
  afterAll(async () => {
    for (const server of [feed, other]) {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }
  })
  beforeEach(() => {
    feedHits.length = 0
    otherHits.length = 0
  })

  // The names point at the two loopback servers; the switch for tests lets the connection reach
  // them, the list stays in force.
  const table: Record<string, string> = { 'feed.test': '127.0.0.1', 'other.test': '127.0.0.2' }
  const toLoopback: Resolver = async (hostname) => {
    const address = table[hostname]
    if (!address) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    return [{ address, family: 4 }]
  }
  const options = (list: string) => ({
    policy: createAddressPolicy({
      allowPrivate: true,
      resolve: toLoopback,
      allowedHosts: hosts(list),
    }),
    maxBytes: 100_000,
    timeoutMs: 2000,
  })

  async function failure(promise: Promise<unknown>): Promise<IcalFetchError> {
    try {
      await promise
    } catch (error) {
      expect(error).toBeInstanceOf(IcalFetchError)
      return error as IcalFetchError
    }
    throw new Error('expected the fetch to fail')
  }

  it('fetches from a listed host', async () => {
    const result = await fetchIcal(`http://feed.test:${feedPort}/a.ics`, options('feed.test'))
    expect(result.kind).toBe('ok')
    expect(feedHits).toHaveLength(1)
  })

  it('refuses a host that is not listed before any connection is made', async () => {
    const error = await failure(
      fetchIcal(`http://feed.test:${feedPort}/a.ics`, options('other.test')),
    )
    expect(error).toMatchObject({ reason: 'blocked', notListed: true })
    expect(feedHits).toHaveLength(0)
  })

  it('refuses an IP literal that is not listed, and fetches one that is', async () => {
    const error = await failure(
      fetchIcal(`http://127.0.0.1:${feedPort}/a.ics`, options('feed.test')),
    )
    expect(error).toMatchObject({ reason: 'blocked', notListed: true })
    expect(feedHits).toHaveLength(0)
    const result = await fetchIcal(`http://127.0.0.1:${feedPort}/a.ics`, options('127.0.0.1'))
    expect(result.kind).toBe('ok')
  })

  it('checks every redirect hop: a redirect to an unlisted host is refused and never requested', async () => {
    const error = await failure(
      fetchIcal(`http://feed.test:${feedPort}/to-other`, options('feed.test')),
    )
    expect(error).toMatchObject({ reason: 'blocked', notListed: true })
    expect(feedHits).toHaveLength(1)
    expect(otherHits).toHaveLength(0)
  })

  it('follows a redirect to another listed host', async () => {
    const result = await fetchIcal(
      `http://feed.test:${feedPort}/to-other`,
      options('feed.test, other.test'),
    )
    expect(result.kind).toBe('ok')
    expect(otherHits).toHaveLength(1)
  })

  it('every fetch asks the policy: a host that is no longer listed stops working', async () => {
    const config = { cacheTtlSec: 0, maxBytes: 100_000, timeoutMs: 2000, allowPrivate: true }
    let current = options('feed.test').policy
    const policy: AddressPolicy = {
      resolve: (host) => current.resolve(host),
      isBlockedAddress: (address, host) => current.isBlockedAddress(address, host),
      isBlockedHostname: (host) => current.isBlockedHostname(host),
      isUnlistedHostname: (host) => current.isUnlistedHostname?.(host) ?? false,
    }
    const proxy = createIcalProxy({ config, policy, log: () => {} })
    const url = `http://feed.test:${feedPort}/a.ics`
    await expect(proxy.get(url, { userId: 1, subscriptionId: 1 })).resolves.toBeDefined()

    current = options('other.test').policy
    await expect(proxy.get(url, { userId: 1, subscriptionId: 1 })).rejects.toMatchObject({
      reason: 'blocked',
      notListed: true,
    })
    // …and one that was added later works.
    current = options('feed.test, other.test').policy
    await expect(proxy.get(url, { userId: 1, subscriptionId: 1 })).resolves.toBeDefined()
  })
})
