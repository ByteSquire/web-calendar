// @vitest-environment node
// The parts of calendar links without HTTP: the sealed copy of the address and password, the
// password hash, the session token and the path rule.
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword, passwordProblem } from '../../server/utils/links/password'
import { openLinkSecret, sealLinkSecret } from '../../server/utils/links/secret'
import {
  SESSION_LIFETIME_MS,
  createLinkSession,
  readLinkSession,
} from '../../server/utils/links/session'
import { ownCalendarPath, parseRange, slugHashOf } from '../../server/utils/links/service'

const SUB = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'

describe('the kept address and password of a link', () => {
  const keyring = {
    current: { version: 2, key: 'new-key' },
    keys: [
      { version: 2, key: 'new-key' },
      { version: 1, key: 'old-key' },
    ],
  }
  const secret = { slug: 'Xq3-slug-of-the-link', password: 'correct horse' }
  const hash = slugHashOf(secret.slug)

  it('opens again for its own link, and is sealed anew each time', () => {
    const sealed = sealLinkSecret(keyring, hash, secret)
    expect(sealed).toMatch(/^s1\.2\./)
    expect(sealed).not.toContain('correct')
    expect(openLinkSecret(keyring, hash, sealed)).toEqual(secret)
    expect(sealLinkSecret(keyring, hash, secret)).not.toBe(sealed)
  })

  it('does not open for another link, changed, damaged or missing', () => {
    const sealed = sealLinkSecret(keyring, hash, secret)
    expect(openLinkSecret(keyring, slugHashOf('another'), sealed)).toBeNull()
    const body = sealed.split('.')[2]!
    const flipped = body.slice(0, 20) + (body[20] === 'A' ? 'B' : 'A') + body.slice(21)
    expect(openLinkSecret(keyring, hash, `s1.2.${flipped}`)).toBeNull()
    expect(openLinkSecret(keyring, hash, sealed.replace('s1.2.', 's1.1.'))).toBeNull()
    expect(openLinkSecret(keyring, hash, 'garbage')).toBeNull()
    expect(openLinkSecret(keyring, hash, null)).toBeNull()
  })

  it('sealed with a key that is still listed opens after a rotation, not once it is dropped', () => {
    const old = sealLinkSecret('old-key', hash, secret)
    expect(openLinkSecret(keyring, hash, old)).toEqual(secret)
    expect(
      openLinkSecret(
        { current: { version: 2, key: 'new-key' }, keys: [{ version: 2, key: 'new-key' }] },
        hash,
        old,
      ),
    ).toBeNull()
  })
})

describe('the password of a link', () => {
  it('needs 8 to 200 characters', () => {
    expect(passwordProblem('short')).toMatch(/at least 8/)
    expect(passwordProblem('x'.repeat(201))).toMatch(/at most 200/)
    expect(passwordProblem(42)).toMatch(/string/)
    expect(passwordProblem('correct horse')).toBeNull()
  })

  it('is stored as a salted scrypt hash and checked against it', async () => {
    const stored = await hashPassword('correct horse')
    expect(stored).toMatch(/^scrypt\$15\$8\$1\$/)
    expect(stored).not.toContain('correct horse')
    expect(await hashPassword('correct horse')).not.toBe(stored)
    expect(await verifyPassword('correct horse', stored)).toBe(true)
    expect(await verifyPassword('correct horsf', stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
  })

  it('never matches a damaged hash, and refuses one that would ask for huge memory', async () => {
    const stored = await hashPassword('correct horse')
    expect(await verifyPassword('correct horse', stored.replace(/.$/, 'A'))).toBe(false)
    expect(await verifyPassword('correct horse', stored.replace('scrypt$15$', 'scrypt$30$'))).toBe(
      false,
    )
    expect(await verifyPassword('correct horse', 'plain')).toBe(false)
  })
})

describe('the session of a link page', () => {
  const now = new Date('2026-11-05T10:00:00Z')
  const keyring = {
    current: { version: 2, key: 'new-key' },
    keys: [
      { version: 2, key: 'new-key' },
      { version: 1, key: 'old-key' },
    ],
  }

  it('names its link and works until it ends', () => {
    const { token, expiresAt } = createLinkSession(keyring, 7, now)
    expect(readLinkSession(keyring, token, now)).toBe(7)
    expect(Date.parse(expiresAt) - now.getTime()).toBe(SESSION_LIFETIME_MS)
    expect(
      readLinkSession(keyring, token, new Date(now.getTime() + SESSION_LIFETIME_MS)),
    ).toBeNull()
  })

  it('cannot be changed to another link or a later end, or made with another key', () => {
    const { token } = createLinkSession(keyring, 7, now)
    const parts = token.split('.')
    expect(
      readLinkSession(keyring, [parts[0], parts[1], '8', parts[3], parts[4]].join('.'), now),
    ).toBeNull()
    expect(
      readLinkSession(
        keyring,
        [parts[0], parts[1], parts[2], String(Number(parts[3]) + 1), parts[4]].join('.'),
        now,
      ),
    ).toBeNull()
    const other = createLinkSession({ current: { version: 2, key: 'other' }, keys: [] }, 7, now)
    expect(readLinkSession(keyring, other.token, now)).toBeNull()
    expect(readLinkSession(keyring, undefined, now)).toBeNull()
    expect(readLinkSession(keyring, 'garbage', now)).toBeNull()
  })

  it('made with a key that is still listed works after a rotation', () => {
    const old = createLinkSession('old-key', 7, now)
    expect(readLinkSession(keyring, old.token, now)).toBe(7)
    expect(
      readLinkSession(
        { current: { version: 2, key: 'new-key' }, keys: [{ version: 2, key: 'new-key' }] },
        old.token,
        now,
      ),
    ).toBeNull()
  })
})

describe('which calendar a link may name', () => {
  it('is one calendar in the caller’s own home, as the app addresses it', () => {
    expect(ownCalendarPath(`/caldav/${SUB}/work/`, SUB)).toBe(`/${SUB}/work/`)
    expect(ownCalendarPath(`/caldav/${SUB}/Team%20plan/`, SUB)).toBe(`/${SUB}/Team plan/`)
  })

  it('is not another person’s home, a home, an event or a path that tries to leave', () => {
    for (const href of [
      `/caldav/other/work/`,
      `/caldav/${SUB}/`,
      `/caldav/${SUB}/work/event.ics`,
      `/caldav/${SUB}/work`,
      `/caldav/${SUB}/../other/work/`,
      `/caldav/${SUB}/%2e%2e/work/`,
      `/${SUB}/work/`,
      `/caldav/.sharing/x/`,
      `/caldav/${SUB}/work/?a=1`,
      'https://evil.example/caldav/x/y/',
    ]) {
      expect(ownCalendarPath(href, SUB), href).toBeNull()
    }
  })
})

describe('the time range of a read', () => {
  it('takes date-times up to 400 days apart, end after start', () => {
    expect(parseRange('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z').ok).toBe(true)
    expect(parseRange('2026-01-01T00:00:00Z', '2027-02-04T00:00:00Z').ok).toBe(true)
    for (const [from, to] of [
      ['2026-12-01T00:00:00Z', '2026-11-01T00:00:00Z'],
      ['2026-01-01T00:00:00Z', '2027-03-01T00:00:00Z'],
      ['nope', '2026-11-01T00:00:00Z'],
      [undefined, '2026-11-01T00:00:00Z'],
      ['x'.repeat(50), 'y'],
    ]) {
      expect(parseRange(from, to).ok, `${from} ${to}`).toBe(false)
    }
  })
})
