// @vitest-environment node
import type { LookupAddress } from 'node:dns'
import { describe, expect, it, vi } from 'vitest'
import { IcalFetchError } from '../../server/utils/ical-proxy/errors'
import { parseSourceUrl } from '../../server/utils/ical-proxy/source-url'
import {
  createAddressPolicy,
  createGuardedLookup,
  hostnameOf,
  isBlockedAddress,
  isBlockedHost,
  isBlockedHostname,
  resolveAllowed,
  type Resolver,
} from '../../server/utils/ical-proxy/ssrf'

// The SSRF guard is table-driven: every blocked range gets an address on both edges, every public
// neighbour of a range is checked to stay allowed, and odd spellings go through the URL parser.

const BLOCKED_IPV4 = [
  // 0.0.0.0/8
  '0.0.0.0',
  '0.1.2.3',
  '0.255.255.255',
  // RFC 1918
  '10.0.0.0',
  '10.0.0.1',
  '10.255.255.255',
  '172.16.0.0',
  '172.20.1.1',
  '172.31.255.255',
  '192.168.0.0',
  '192.168.1.1',
  '192.168.255.255',
  // carrier-grade NAT 100.64.0.0/10
  '100.64.0.0',
  '100.100.100.100',
  '100.127.255.255',
  // loopback
  '127.0.0.0',
  '127.0.0.1',
  '127.255.255.254',
  // link-local, cloud metadata
  '169.254.0.0',
  '169.254.169.254',
  '169.254.255.255',
  // IETF protocol assignments, documentation, 6to4 relay, benchmarking
  '192.0.0.1',
  '192.0.0.255',
  '192.0.2.5',
  '192.88.99.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.7',
  '203.0.113.9',
  // multicast, reserved, broadcast
  '224.0.0.1',
  '232.1.2.3',
  '239.255.255.255',
  '240.0.0.1',
  '250.250.250.250',
  '255.255.255.254',
  '255.255.255.255',
]

const PUBLIC_IPV4 = [
  '1.1.1.1',
  '8.8.8.8',
  '9.255.255.255',
  '11.0.0.0',
  '100.63.255.255',
  '100.128.0.0',
  '126.255.255.255',
  '128.0.0.1',
  '169.253.255.255',
  '169.255.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '192.0.1.1',
  '192.167.255.255',
  '192.169.0.0',
  '198.17.255.255',
  '198.20.0.0',
  '203.0.112.255',
  '203.0.114.0',
  '223.255.255.255',
]

const BLOCKED_IPV6 = [
  '::',
  '::1',
  '0:0:0:0:0:0:0:1',
  // IPv4-mapped and IPv4-compatible, in every spelling
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '0:0:0:0:0:ffff:7f00:1',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  '::ffff:8.8.8.8',
  '::127.0.0.1',
  '::7f00:1',
  '::10.0.0.1',
  // NAT64
  '64:ff9b::7f00:1',
  '64:ff9b::169.254.169.254',
  '64:ff9b:1::1',
  // unique local, link-local (with and without a scope id), site-local, multicast
  'fc00::1',
  'fd12:3456:789a::1',
  'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  'fe80::1',
  'fe80::1%eth0',
  'febf:ffff::1',
  'fec0::1',
  'ff00::',
  'ff02::1',
  'ff0e::1',
  // discard-only and everything else outside global unicast
  '100::1',
  '1::1',
  '4000::1',
  'e000::1',
  // protocol assignments incl. Teredo, documentation, 6to4
  '2001::1',
  '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  '2001:1ff:ffff::1',
  '2001:db8::1',
  '2002:7f00:1::1',
  '2002:808:808::1',
  '3fff::1',
  '3fff:fff:ffff::1',
]

const PUBLIC_IPV6 = [
  '2001:4860:4860::8888',
  '2606:4700:4700::1111',
  '2a00:1450:4001:81b::200e',
  '2001:200::1',
  '2001:db9::1',
  '2003::1',
  '3fff:1000::1',
]

const UNPARSABLE = [
  '',
  'not-an-ip',
  'example.com',
  '127.1',
  '2130706433',
  '0x7f.0.0.1',
  '1.2.3',
  '1.2.3.4.5',
  '256.1.1.1',
  '::g',
  '1:2:3:4:5:6:7:8:9',
  '[::1]',
]

describe('isBlockedAddress', () => {
  it.each(BLOCKED_IPV4)('blocks the IPv4 address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true)
  })

  it.each(PUBLIC_IPV4)('allows the public IPv4 address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false)
  })

  it.each(BLOCKED_IPV6)('blocks the IPv6 address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true)
  })

  it.each(PUBLIC_IPV6)('allows the public IPv6 address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false)
  })

  it.each(UNPARSABLE)('treats the unparsable input "%s" as blocked', (address) => {
    expect(isBlockedAddress(address)).toBe(true)
  })
})

describe('isBlockedHostname', () => {
  it.each(['localhost', 'foo.localhost', 'a.b.localhost'])('blocks %s', (name) => {
    expect(isBlockedHostname(name)).toBe(true)
  })

  it.each(['example.com', 'localhost.example.com', 'mylocalhost', 'notlocalhost.org'])(
    'leaves %s to the address check',
    (name) => {
      expect(isBlockedHostname(name)).toBe(false)
    },
  )
})

// What the fetcher sees: the URL parser normalises the odd spellings of IP literals first.
describe('the host of a parsed URL', () => {
  const strict = createAddressPolicy({ allowPrivate: false })

  function hostOf(raw: string): string {
    const parsed = parseSourceUrl(raw)
    if (!parsed.ok) throw new Error(`${raw}: ${parsed.error}`)
    return hostnameOf(parsed.url)
  }

  const BLOCKED_URLS: [string, string][] = [
    ['http://127.0.0.1/', '127.0.0.1'],
    ['http://127.0.0.1:8080/x.ics', '127.0.0.1'],
    ['http://127.0.0.1./', '127.0.0.1'],
    ['http://2130706433/', '127.0.0.1'],
    ['http://0x7f000001/', '127.0.0.1'],
    ['http://0x7f.0x0.0x0.0x1/', '127.0.0.1'],
    ['http://017700000001/', '127.0.0.1'],
    ['http://0177.0.0.1/', '127.0.0.1'],
    ['http://127.1/', '127.0.0.1'],
    ['http://127.0.1/', '127.0.0.1'],
    ['http://0/', '0.0.0.0'],
    ['http://0.0.0.0/', '0.0.0.0'],
    ['http://3232235777/', '192.168.1.1'],
    ['http://0xc0a80101/', '192.168.1.1'],
    ['http://0251.0376.0251.0376/', '169.254.169.254'],
    ['http://2852039166/', '169.254.169.254'],
    ['http://169.254.169.254/latest/meta-data/', '169.254.169.254'],
    ['http://10.1.2.3/', '10.1.2.3'],
    ['http://[::1]/', '::1'],
    ['http://[0:0:0:0:0:0:0:1]/', '::1'],
    ['http://[::]/', '::'],
    ['http://[::ffff:127.0.0.1]/', '::ffff:7f00:1'],
    ['http://[0:0:0:0:0:ffff:127.0.0.1]/', '::ffff:7f00:1'],
    ['http://[::ffff:7f00:1]/', '::ffff:7f00:1'],
    ['http://[::ffff:169.254.169.254]/', '::ffff:a9fe:a9fe'],
    ['http://[::127.0.0.1]/', '::7f00:1'],
    ['http://[fe80::1]/', 'fe80::1'],
    ['http://[fd00::1]:8080/', 'fd00::1'],
    ['http://localhost/', 'localhost'],
    ['http://LOCALHOST/', 'localhost'],
    ['http://localhost./', 'localhost'],
    ['http://foo.localhost:3000/', 'foo.localhost'],
    // webcal is not a special scheme; the scheme is swapped before parsing so these normalise too
    ['webcal://2130706433/cal.ics', '127.0.0.1'],
    ['webcal://0x7f.1/cal.ics', '127.0.0.1'],
    ['WEBCAL://[::1]/cal.ics', '::1'],
    ['webcal://localhost/cal.ics', 'localhost'],
  ]

  it.each(BLOCKED_URLS)('%s is blocked (host %s)', (raw, host) => {
    expect(hostOf(raw)).toBe(host)
    expect(isBlockedHost(host, strict)).toBe(true)
  })

  it.each([
    ['http://93.184.216.34/', '93.184.216.34'],
    ['https://[2606:4700:4700::1111]/', '2606:4700:4700::1111'],
    ['webcal://8.8.8.8/cal.ics', '8.8.8.8'],
    ['https://Example.COM/cal.ics', 'example.com'],
  ])('%s is left to the resolver or allowed (host %s)', (raw, host) => {
    expect(hostOf(raw)).toBe(host)
    expect(isBlockedHost(host, strict)).toBe(false)
  })

  it('does not block literals when private addresses are allowed', () => {
    const lax = createAddressPolicy({ allowPrivate: true })
    expect(isBlockedHost('127.0.0.1', lax)).toBe(false)
    expect(isBlockedHost('::1', lax)).toBe(false)
    expect(isBlockedHost('localhost', lax)).toBe(false)
  })
})

function resolverFor(table: Record<string, string[]>): Resolver {
  return async (hostname) => {
    const addresses = table[hostname]
    if (!addresses) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    }
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
}

const ZONE: Record<string, string[]> = {
  'public.test': ['93.184.216.34'],
  'public6.test': ['2606:4700:4700::1111'],
  'dual.test': ['93.184.216.34', '2606:4700:4700::1111'],
  'private.test': ['10.0.0.5'],
  'loopback.test': ['127.0.0.1'],
  'loopback6.test': ['::1'],
  'metadata.test': ['169.254.169.254'],
  'mapped.test': ['::ffff:127.0.0.1'],
  'mixed.test': ['93.184.216.34', '10.0.0.5'],
  'mixed-last.test': ['93.184.216.34', '2606:4700:4700::1111', '192.168.0.1'],
  'mixed6.test': ['2606:4700:4700::1111', 'fd00::1'],
  'empty.test': [],
  localhost: ['127.0.0.1', '::1'],
}

async function outcome(host: string, allowPrivate = false): Promise<string> {
  const policy = createAddressPolicy({ allowPrivate, resolve: resolverFor(ZONE) })
  try {
    await resolveAllowed(host, policy)
    return 'allowed'
  } catch (error) {
    if (error instanceof IcalFetchError) return error.reason
    throw error
  }
}

describe('resolveAllowed', () => {
  it.each([
    ['public.test', 'allowed'],
    ['public6.test', 'allowed'],
    ['dual.test', 'allowed'],
    ['93.184.216.34', 'allowed'],
    ['2606:4700:4700::1111', 'allowed'],
    ['private.test', 'blocked'],
    ['loopback.test', 'blocked'],
    ['loopback6.test', 'blocked'],
    ['metadata.test', 'blocked'],
    ['mapped.test', 'blocked'],
    // one blocked address in the set blocks the whole name, wherever it sits
    ['mixed.test', 'blocked'],
    ['mixed-last.test', 'blocked'],
    ['mixed6.test', 'blocked'],
    ['localhost', 'blocked'],
    ['api.localhost', 'blocked'],
    ['127.0.0.1', 'blocked'],
    ['::1', 'blocked'],
    ['169.254.169.254', 'blocked'],
    ['unknown.test', 'unreachable'],
    ['empty.test', 'unreachable'],
  ])('%s -> %s', async (host, expected) => {
    expect(await outcome(host)).toBe(expected)
  })

  it('allows private addresses and localhost when they are allowed', async () => {
    for (const host of ['private.test', 'loopback.test', 'mixed.test', 'localhost', '127.0.0.1']) {
      expect(await outcome(host, true), host).toBe('allowed')
    }
  })

  it('does not ask the resolver about IP literals', async () => {
    const resolve = vi.fn<Resolver>()
    await resolveAllowed('8.8.8.8', createAddressPolicy({ allowPrivate: false, resolve }))
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not ask the resolver about localhost', async () => {
    const resolve = vi.fn<Resolver>()
    await expect(
      resolveAllowed('localhost', createAddressPolicy({ allowPrivate: false, resolve })),
    ).rejects.toMatchObject({ reason: 'blocked' })
    expect(resolve).not.toHaveBeenCalled()
  })
})

type LookupReply = { error: NodeJS.ErrnoException | null; address: unknown; family?: number }

function callLookup(
  lookup: ReturnType<typeof createGuardedLookup>,
  hostname: string,
  options: { all?: boolean; family?: number } = {},
): Promise<LookupReply> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => resolve({ error, address, family }))
  })
}

// The `lookup` option of the connection: the socket connects to what this hands back.
describe('createGuardedLookup', () => {
  const policy = createAddressPolicy({ allowPrivate: false, resolve: resolverFor(ZONE) })

  it('returns the checked addresses as a list for `all: true`', async () => {
    const reply = await callLookup(createGuardedLookup(policy), 'dual.test', { all: true })
    expect(reply.error).toBeNull()
    expect(reply.address).toEqual<LookupAddress[]>([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ])
  })

  it('returns the first address and its family for `all: false`', async () => {
    const reply = await callLookup(createGuardedLookup(policy), 'dual.test')
    expect(reply.error).toBeNull()
    expect(reply.address).toBe('93.184.216.34')
    expect(reply.family).toBe(4)
  })

  it.each([
    [4, '93.184.216.34'],
    [6, '2606:4700:4700::1111'],
  ])('honours family %i', async (family, expected) => {
    const reply = await callLookup(createGuardedLookup(policy), 'dual.test', { all: true, family })
    expect(reply.address).toEqual([{ address: expected, family }])
  })

  it('fails with ENOTFOUND when the family asked for does not exist', async () => {
    const reply = await callLookup(createGuardedLookup(policy), 'public.test', {
      all: true,
      family: 6,
    })
    expect(reply.error?.code).toBe('ENOTFOUND')
  })

  it.each([
    'private.test',
    'loopback.test',
    'loopback6.test',
    'metadata.test',
    'mapped.test',
    'mixed.test',
    'mixed-last.test',
    'mixed6.test',
    'localhost',
  ])('refuses %s with a blocked error for both call styles', async (host) => {
    for (const all of [true, false]) {
      const rejected: IcalFetchError[] = []
      const lookup = createGuardedLookup(policy, (error) => rejected.push(error))
      const reply = await callLookup(lookup, host, { all })
      expect(reply.error).toBeInstanceOf(IcalFetchError)
      expect(reply.error).toMatchObject({ reason: 'blocked', code: 'ERR_ICAL_PROXY' })
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.reason).toBe('blocked')
    }
  })

  it('reports an unresolvable name as unreachable, not blocked', async () => {
    const rejected: IcalFetchError[] = []
    const reply = await callLookup(
      createGuardedLookup(policy, (error) => rejected.push(error)),
      'unknown.test',
      { all: true },
    )
    expect(reply.error).toMatchObject({ reason: 'unreachable' })
    expect(rejected[0]!.reason).toBe('unreachable')
  })

  it('wraps a resolver failure that is not ours as unreachable', async () => {
    const failing = createAddressPolicy({
      allowPrivate: false,
      resolve: () => Promise.reject(new Error('socket hang up')),
    })
    const reply = await callLookup(createGuardedLookup(failing), 'any.test', { all: true })
    expect(reply.error).toMatchObject({ reason: 'unreachable' })
  })

  it('validates its own resolution, so DNS rebinding after an earlier check cannot help', async () => {
    // The first answer is public (the check when the subscription is created), the second one,
    // at connect time, is the cloud metadata address.
    const answers = [['93.184.216.34'], ['169.254.169.254']]
    const resolve: Resolver = async () =>
      answers.shift()!.map((address) => ({ address, family: 4 }))
    const rebinding = createAddressPolicy({ allowPrivate: false, resolve })

    await expect(resolveAllowed('rebind.test', rebinding)).resolves.toHaveLength(1)
    const reply = await callLookup(createGuardedLookup(rebinding), 'rebind.test', { all: true })
    expect(reply.error).toMatchObject({ reason: 'blocked' })
  })

  it('hands back only what it validated, with one resolution per call', async () => {
    const resolve = vi.fn<Resolver>(async () => [{ address: '93.184.216.34', family: 4 }])
    const counted = createAddressPolicy({ allowPrivate: false, resolve })
    const reply = await callLookup(createGuardedLookup(counted), 'public.test', { all: true })
    expect(reply.address).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('lets private addresses through when they are allowed', async () => {
    const lax = createAddressPolicy({ allowPrivate: true, resolve: resolverFor(ZONE) })
    const reply = await callLookup(createGuardedLookup(lax), 'loopback.test', { all: true })
    expect(reply.address).toEqual([{ address: '127.0.0.1', family: 4 }])
  })
})
