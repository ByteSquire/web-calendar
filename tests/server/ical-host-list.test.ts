// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { validateEnv } from '../../server/validate-config.mjs'
import { MAX_HOST_LIST_ENTRIES, parseHostList } from '../../server/utils/ical-proxy/host-list'

// NUXT_OUTBOUND_ALLOWED_HOSTS: the grammar, the matching, and that server/validate-config.mjs (plain
// JS, runs before the server) accepts and refuses exactly the same lists.

const list = (text: string) => {
  const parsed = parseHostList(text)
  expect(parsed.problems).toEqual([])
  return parsed.list
}

describe('matching', () => {
  it('an empty or missing setting is no list at all', () => {
    for (const text of ['', '   ', '\n']) {
      const parsed = parseHostList(text)
      expect(parsed.problems).toEqual([])
      expect(parsed.list.size).toBe(0)
    }
    expect(parseHostList(undefined).list.size).toBe(0)
    expect(parseHostList(null).list.size).toBe(0)
  })

  it('an exact entry matches that host and nothing around it', () => {
    const hosts = list('cal.example.org')
    expect(hosts.size).toBe(1)
    expect(hosts.matches('cal.example.org')).toBe(true)
    for (const other of [
      'example.org',
      'evil.cal.example.org',
      'cal.example.org.evil.com',
      'xcal.example.org',
      'cal.example.com',
      'cal-example.org',
      '',
    ]) {
      expect(hosts.matches(other), other).toBe(false)
    }
  })

  it('`*.suffix` matches every host below the domain at any depth, but not the domain itself', () => {
    const hosts = list('*.example.org')
    expect(hosts.matches('cal.example.org')).toBe(true)
    expect(hosts.matches('a.b.c.example.org')).toBe(true)
    expect(hosts.matches('example.org')).toBe(false)
    for (const other of ['evil-example.org', 'example.org.evil.com', 'notexample.org', 'org', '']) {
      expect(hosts.matches(other), other).toBe(false)
    }
    // Listing both is how one allows the domain and everything below it.
    const both = list('example.org, *.example.org')
    expect(both.matches('example.org')).toBe(true)
    expect(both.matches('x.example.org')).toBe(true)
  })

  it('is case-insensitive for the entries (hosts arrive lower-cased from the URL parser)', () => {
    const hosts = list('Cal.Example.ORG, *.Intra.Example.org')
    expect(hosts.matches('cal.example.org')).toBe(true)
    expect(hosts.matches('x.intra.example.org')).toBe(true)
  })

  it('takes blanks around entries and several entries, in any order', () => {
    const hosts = list('  a.example.org ,*.b.example.org,  c.example.org  ')
    expect(hosts.size).toBe(3)
    for (const host of ['a.example.org', 'x.b.example.org', 'c.example.org']) {
      expect(hosts.matches(host), host).toBe(true)
    }
    expect(hosts.matches('b.example.org')).toBe(false)
  })

  it('a dotted IPv4 address is an exact entry; it never matches by suffix or as a name', () => {
    const hosts = list('192.168.1.5, *.example.org')
    expect(hosts.matches('192.168.1.5')).toBe(true)
    expect(hosts.matches('192.168.1.50')).toBe(false)
    expect(hosts.matches('8.8.8.8')).toBe(false)
  })

  it('an international name is written as xn--', () => {
    expect(list('xn--bcher-kva.example').matches('xn--bcher-kva.example')).toBe(true)
  })

  it('a single-label domain is allowed (internal names)', () => {
    const hosts = list('*.lan, nas')
    expect(hosts.matches('printer.lan')).toBe(true)
    expect(hosts.matches('nas')).toBe(true)
    expect(hosts.matches('lan')).toBe(false)
  })
})

/** Entries the setting must refuse, with the sentence the administrator reads. */
const INVALID: [entry: string, problem: string][] = [
  ['*', 'bare *'],
  ['*.', 'is empty'],
  ['**.example.org', 'only as the first label'],
  ['a.*.example.org', 'only as the first label'],
  ['*example.org', 'only as the first label'],
  ['cal*.example.org', 'only as the first label'],
  ['*.*.example.org', 'only as the first label'],
  ['https://cal.example.org', 'not a URL'],
  ['http://cal.example.org/', 'not a URL'],
  ['//cal.example.org', 'no port, path or user name'],
  ['cal.example.org:8443', 'no port, path or user name'],
  ['cal.example.org/dav', 'no port, path or user name'],
  ['cal.example.org?x=1', 'no port, path or user name'],
  ['cal.example.org#x', 'no port, path or user name'],
  ['user@cal.example.org', 'no port, path or user name'],
  ['[::1]', 'no port, path or user name'],
  ['::1', 'no port, path or user name'],
  ['cal.example.org\\x', 'no port, path or user name'],
  ['cal example.org', 'blanks'],
  ['cal\texample.org', 'ASCII'],
  ['cal.example.org.', 'empty label'],
  ['.example.org', 'empty label'],
  ['cal..example.org', 'empty label'],
  ['-cal.example.org', 'characters other than letters, digits and -'],
  ['cal-.example.org', 'characters other than letters, digits and -'],
  ['cal_host.example.org', 'characters other than letters, digits and -'],
  ['bücher.example', 'ASCII'],
  ['café.example.org', 'ASCII'],
  [`${'a'.repeat(64)}.example.org`, 'longer than 63'],
  [`${'a.'.repeat(130)}org`, 'too long'],
  // Hosts that end in a number are read as IPv4 addresses by the URL parser and could never match.
  ['1.2.3', 'IP address'],
  ['1.2.3.4.5', 'IP address'],
  ['example.123', 'IP address'],
  ['0x7f.1', 'IP address'],
  ['0x7f.0.0.1', 'IP address'],
  ['256.1.1.1', 'IP address'],
  ['01.2.3.4', 'IP address'],
  ['*.1.2.3.4', 'in front of an IP address'],
  ['*.example.123', 'IP address'],
]

describe('malformed entries', () => {
  it.each(INVALID)('refuses %j', (entry, problem) => {
    const parsed = parseHostList(entry)
    expect(parsed.problems).toHaveLength(1)
    expect(parsed.problems[0]).toContain(problem)
    expect(parsed.problems[0]).toContain('the entry')
  })

  it('refuses empty entries between commas (a typo is not a permission)', () => {
    for (const text of ['a.example.org,,b.example.org', 'a.example.org,', ',a.example.org', ',']) {
      expect(parseHostList(text).problems.length, text).toBeGreaterThan(0)
    }
  })

  it('reports every bad entry, and a list with a problem has to be refused as a whole', () => {
    const parsed = parseHostList('ok.example.org, *, https://x, also.ok')
    expect(parsed.problems).toHaveLength(2)
  })

  it('cuts a long entry out of the message', () => {
    const [problem] = parseHostList(`${'x'.repeat(200)}://`).problems
    expect(problem!.length).toBeLessThan(200)
  })

  it('refuses a list of more than the maximum number of entries', () => {
    const many = Array.from({ length: MAX_HOST_LIST_ENTRIES + 1 }, (_, i) => `h${i}.example.org`)
    expect(parseHostList(many.join(',')).problems.join()).toContain('more than')
    expect(parseHostList(many.slice(0, MAX_HOST_LIST_ENTRIES).join(',')).problems).toEqual([])
  })
})

describe('server/validate-config.mjs agrees with the server on the same table', () => {
  const valid = {
    NUXT_OIDC_ISSUER: 'https://idm.example.org/oauth2/openid/web-calendar',
    NUXT_TOKEN_HASH_KEY: 'k'.repeat(32),
    NUXT_RADICALE_URL: 'http://radicale:5232',
    NUXT_GROUP_SYNC_TOKEN: 'sync-token',
  }
  const check = (text: string) =>
    validateEnv({ ...valid, NUXT_OUTBOUND_ALLOWED_HOSTS: text }).errors

  const ACCEPTED = [
    '',
    '  ',
    'cal.example.org',
    '*.example.org',
    'Cal.Example.ORG , *.intra.example.org',
    '192.168.1.5',
    '*.lan',
    'nas',
    'xn--bcher-kva.example',
    'a-b.c-d.example.org',
    'example.org, *.example.org',
  ]

  it.each(ACCEPTED)('accepts %j', (text) => {
    expect(parseHostList(text).problems).toEqual([])
    expect(check(text)).toEqual([])
  })

  it.each([...INVALID.map(([entry]) => entry), 'a,,b', 'a.example.org,', ','])(
    'refuses %j and names the variable, not the other entries',
    (text) => {
      const server = parseHostList(text).problems
      const script = check(text)
      expect(server.length).toBeGreaterThan(0)
      expect(script).toHaveLength(1)
      expect(script[0]).toContain('NUXT_OUTBOUND_ALLOWED_HOSTS')
      // The same sentences, in the same order.
      for (const problem of server) expect(script[0]).toContain(problem)
    },
  )

  it('refuses too many entries the same way', () => {
    const many = Array.from({ length: MAX_HOST_LIST_ENTRIES + 1 }, (_, i) => `h${i}.example.org`)
    expect(check(many.join(',')).join()).toContain('more than')
  })

  it('treats an empty value as unset (Compose passes it on)', () => {
    expect(validateEnv({ ...valid, NUXT_OUTBOUND_ALLOWED_HOSTS: '' }).errors).toEqual([])
    expect(validateEnv({ ...valid }).errors).toEqual([])
  })
})
