// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  UNKNOWN_ADDRESS,
  clientGroupKey,
  lastForwardedHop,
  looksLikeProxyAddress,
  normalizeClientAddress,
  sharedAddressWarning,
} from '../../server/utils/auth/client-address'

describe('normalizeClientAddress', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['  203.0.113.9 ', '203.0.113.9'],
    ['2001:db8::1', '2001:db8::1'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['::1', '::1'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['::FFFF:203.0.113.9', '203.0.113.9'],
    ['::ffff:cb00:7109', '203.0.113.9'],
    ['0:0:0:0:0:ffff:cb00:7109', '203.0.113.9'],
    ['fe80::1%eth0', 'fe80::1'],
    // Not mapped IPv4: the 64:ff9b::/96 prefix is a translation prefix, a different address.
    ['64:ff9b::cb00:7109', '64:ff9b::cb00:7109'],
  ])('writes %j as %j', (raw, expected) => {
    expect(normalizeClientAddress(raw)).toBe(expected)
  })

  it.each([
    null,
    undefined,
    '',
    '   ',
    'localhost',
    '203.0.113.9:8080',
    '[2001:db8::1]:443',
    '203.0.113',
    '203.0.113.256',
    '2001:db8::1::2',
    '203.0.113.9, 198.51.100.7',
    'unknown',
  ])('maps the unusable %j to the shared unknown address', (raw) => {
    expect(normalizeClientAddress(raw)).toBe(UNKNOWN_ADDRESS)
  })
})

describe('clientGroupKey', () => {
  it.each([
    // IPv4 stays as it is.
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['::FFFF:cb00:7109', '203.0.113.9'],
    // Every address of a /64 maps to its prefix, one spelling for it.
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2:0:0:0:1', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:db8:1:3::1', '2001:db8:1:3::/64'],
    // The prefix is compressed like an address: zero groups inside it go, the first four only
    // count.
    ['2001:db8::1', '2001:db8::/64'],
    ['2001:db8:0:0:1::1', '2001:db8::/64'],
    ['2001:db8:0:1:0:0:0:1', '2001:db8:0:1::/64'],
    ['1::1', '1::/64'],
    ['1:2:3:4::', '1:2:3:4::/64'],
    // Loopback, unspecified and link-local get no special treatment.
    ['::1', '::/64'],
    ['::', '::/64'],
    ['fe80::1%eth0', 'fe80::/64'],
    ['fe80::a:b:c:d%eth0', 'fe80::/64'],
    // 64:ff9b::/96 is not IPv4-mapped; it is an ordinary prefix here.
    ['64:ff9b::cb00:7109', '64:ff9b::/64'],
  ])('writes %j as %j', (raw, expected) => {
    expect(clientGroupKey(raw)).toBe(expected)
  })

  it('keeps addresses of different /64 prefixes apart, down to the last bit of the prefix', () => {
    const keys = new Set(
      [
        '2001:db8:1:2::1',
        '2001:db8:1:3::1',
        '2001:db8:1:12::1',
        '2001:db8:1:2:8000::1',
        '2001:db9:1:2::1',
      ].map(clientGroupKey),
    )
    // The fourth is in the same /64 as the first (the low 64 bits are free), so four keys remain.
    expect(keys.size).toBe(4)
  })

  it.each([null, undefined, '', 'localhost', '203.0.113.9:80', '2001:db8::1::2'])(
    'maps the unusable %j to the shared unknown address',
    (raw) => {
      expect(clientGroupKey(raw)).toBe(UNKNOWN_ADDRESS)
    },
  )

  it('leaves normalizeClientAddress alone: proxy detection needs the real address', () => {
    expect(normalizeClientAddress('2001:db8:1:2::1')).toBe('2001:db8:1:2::1')
    expect(looksLikeProxyAddress('::1')).toBe(true)
    expect(looksLikeProxyAddress('fd00:1:2:3::4')).toBe(true)
  })
})

describe('lastForwardedHop', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['198.51.100.7, 203.0.113.9', '203.0.113.9'],
    ['198.51.100.7,203.0.113.9', '203.0.113.9'],
    ['  198.51.100.7 ,  203.0.113.9  ', '203.0.113.9'],
    ['2001:db8::1', '2001:db8::1'],
    ['198.51.100.7, 2001:db8::1', '2001:db8::1'],
    // The client chose the first entries; only the last one is the proxy's.
    ['10.0.0.1, 10.0.0.2, 10.0.0.3, 203.0.113.9', '203.0.113.9'],
    ['evil, 203.0.113.9', '203.0.113.9'],
  ])('takes the last entry of %j: %j', (header, expected) => {
    expect(lastForwardedHop(header)).toBe(expected)
  })

  it.each([
    null,
    undefined,
    '',
    ' ',
    ',',
    // The proxy's entry is missing or malformed: the caller falls back to the socket address.
    '203.0.113.9, ',
    '203.0.113.9, evil',
    '203.0.113.9, 198.51.100.7:4711',
    '203.0.113.9, [2001:db8::1]',
    '203.0.113.9, unknown',
    '203.0.113.9, 999.1.1.1',
  ])('gives up on %j', (header) => {
    expect(lastForwardedHop(header)).toBeNull()
  })

  it('reads the repeated header lines as Headers joins them', () => {
    const headers = new Headers()
    headers.append('x-forwarded-for', '1.1.1.1')
    headers.append('x-forwarded-for', '203.0.113.9')
    expect(lastForwardedHop(headers.get('x-forwarded-for'))).toBe('203.0.113.9')
  })
})

describe('looksLikeProxyAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '::1',
    '::ffff:127.0.0.1',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.17.0.2',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.1.1',
    '100.64.0.1',
    '100.127.255.255',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    '::ffff:10.1.2.3',
  ])('takes %s for a reverse proxy', (address) => {
    expect(looksLikeProxyAddress(address)).toBe(true)
  })

  it.each([
    '203.0.113.9',
    '8.8.8.8',
    '126.255.255.255',
    '128.0.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.167.255.255',
    '192.169.0.1',
    '169.253.255.255',
    '100.63.255.255',
    '100.128.0.1',
    '2001:db8::1',
    '2a00:1450::1',
    'fec0::1',
    'fe00::1',
    'fb00::1',
    '::ffff:203.0.113.9',
    '::',
  ])('does not take the public address %s for one', (address) => {
    expect(looksLikeProxyAddress(address)).toBe(false)
  })

  it.each([null, undefined, '', 'localhost', 'unknown', '10.0.0'])(
    'says no for the unusable %j',
    (address) => {
      expect(looksLikeProxyAddress(address)).toBe(false)
    },
  )
})

describe('sharedAddressWarning', () => {
  it.each(['127.0.0.1', '::1', '::ffff:10.1.2.3', '172.18.0.1', '192.168.1.5', 'fd00::2'])(
    'warns, naming the setting, when requests come from %s',
    (peer) => {
      const warning = sharedAddressWarning(peer, false)
      expect(warning).toContain(normalizeClientAddress(peer))
      expect(warning).toContain('NUXT_GATEWAY_TRUST_FORWARDED_FOR=true')
      expect(warning).toContain('share this one address')
    },
  )

  it.each(['203.0.113.9', '2001:db8::1', null, undefined, 'not an address'])(
    'says nothing for the public or unknown address %j',
    (peer) => {
      expect(sharedAddressWarning(peer, false)).toBeNull()
    },
  )

  it('says nothing once the forwarded address is trusted', () => {
    expect(sharedAddressWarning('127.0.0.1', true)).toBeNull()
  })
})
