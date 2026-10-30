// @vitest-environment node
// FR-7, importing a file: a resource is named after a hash of its UID, never after the UID, which
// comes from an untrusted file.
import { describe, expect, it } from 'vitest'
import { resourceHref, resourceName, sha256Hex } from '../app/utils/import/naming'

const NAME = /^[0-9a-f]{32}\.ics$/

const hostileUids = [
  '../../etc/passwd',
  'a/b/c',
  '..',
  '.',
  '%2e%2e%2fother-user%2fcalendar',
  'https://evil.example/..;x=1?y=2#z',
  'ünïcode-ñ-日本語',
  'con.ics',
  'with space',
  'new\nline',
  'nul' + String.fromCharCode(0) + 'byte',
  'lone' + String.fromCharCode(0xd800) + 'surrogate',
  '',
  'x'.repeat(10_000),
]

describe('sha256Hex', () => {
  it('is SHA-256 of the UTF-8 text in lower-case hex', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    // UTF-8 bytes, not UTF-16 code units.
    expect(await sha256Hex('ä')).toBe(
      '33e6d73fee82904c8d7afb78de1154d1e8dc2a0edb08120e63df5b9385c2d9cc',
    )
  })
})

describe('the name of a resource', () => {
  it('is 128 bits of the UID’s hash and .ics', async () => {
    expect(await resourceName('abc')).toBe('ba7816bf8f01cfea414140de5dae2223.ics')
  })

  it.each(hostileUids.map((uid) => [uid.slice(0, 30), uid] as const))(
    'is plain hex whatever the UID holds: %j',
    async (_label, uid) => {
      expect(await resourceName(uid)).toMatch(NAME)
    },
  )

  it('is the same for the same UID and differs for any other, case included', async () => {
    expect(await resourceName('event-1@example.com')).toBe(
      await resourceName('event-1@example.com'),
    )
    const names = await Promise.all(
      [
        'event-1@example.com',
        'event-2@example.com',
        'EVENT-1@example.com',
        'event-1@example.com ',
      ].map(resourceName),
    )
    expect(new Set(names).size).toBe(4)
  })

  it('does not repeat across many UIDs', async () => {
    const names = await Promise.all(
      Array.from({ length: 5000 }, (_, i) => resourceName(`uid-${i}`)),
    )
    expect(new Set(names).size).toBe(5000)
  })
})

describe('the address of a resource', () => {
  it('is the collection’s address plus the name, with or without the trailing slash', async () => {
    const name = await resourceName('a')
    expect(resourceHref('/caldav/alice/cal/', name)).toBe(`/caldav/alice/cal/${name}`)
    expect(resourceHref('/caldav/alice/cal', name)).toBe(`/caldav/alice/cal/${name}`)
    expect(resourceHref('http://localhost:3000/caldav/alice/cal/', name)).toBe(
      `http://localhost:3000/caldav/alice/cal/${name}`,
    )
  })

  it.each(hostileUids.map((uid) => [uid.slice(0, 30), uid] as const))(
    'stays one level below the collection whatever the UID holds: %j',
    async (_label, uid) => {
      const href = resourceHref('/caldav/alice/cal/', await resourceName(uid))
      const url = new URL(href, 'http://localhost:3000')
      expect(url.pathname.split('/')).toHaveLength(5)
      expect(url.pathname.startsWith('/caldav/alice/cal/')).toBe(true)
      expect(url.search).toBe('')
      expect(url.hash).toBe('')
    },
  )
})
