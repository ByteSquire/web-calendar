// @vitest-environment node
import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { validateEnv } from '../../server/validate-config.mjs'
import {
  createSealer,
  MAX_SEALED_LENGTH,
  parseSealKey,
  SealKeyError,
  sealedFromHeader,
  type SealContext,
} from '../../server/utils/external/seal'

// The sealed credential (FR-8): AES-256-GCM over `username:password`, bound to the user, the
// account and the origin. What matters: it round-trips, it opens for nothing else, nothing about a
// failure tells the cause, and a bad key never reaches a message.

const KEY = Buffer.alloc(32, 7)
const sealer = createSealer(KEY)
const context: SealContext = {
  sub: 'a1b2c3d4-0000-4000-8000-000000000001',
  accountId: 7,
  origin: 'https://cal.example.org',
}
const login = { username: 'alice', password: 'correct horse: battery staple' }

describe('seal and open', () => {
  it('round-trips a login, a colon in the password and non-ASCII text included', () => {
    for (const sample of [
      login,
      { username: 'bob@example.org', password: 'p' },
      { username: 'ünïcode', password: 'pässwörd ✓ 日本語' },
      { username: 'u'.repeat(256), password: 'x'.repeat(1024) },
      { username: 'a', password: ':::' },
    ]) {
      expect(sealer.open(sealer.seal(sample, context), context)).toEqual(sample)
    }
  })

  it('writes base64url text that is different every time (a fresh nonce)', () => {
    const first = sealer.seal(login, context)
    const second = sealer.seal(login, context)
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(first).not.toBe(second)
    expect(sealer.open(second, context)).toEqual(login)
  })

  it('starts with the version byte, then a 12-byte nonce, ends with a 16-byte tag', () => {
    const bytes = Buffer.from(sealer.seal({ username: 'a', password: 'b' }, context), 'base64url')
    expect(bytes[0]).toBe(1)
    expect(bytes.length).toBe(1 + 12 + 'a:b'.length + 16)
  })

  it('does not contain the user name or the password in clear', () => {
    const sealed = sealer.seal({ username: 'alice-user', password: 'hunter2-secret' }, context)
    const bytes = Buffer.from(sealed, 'base64url').toString('latin1')
    expect(sealed).not.toContain('alice')
    expect(bytes).not.toContain('alice-user')
    expect(bytes).not.toContain('hunter2')
  })

  it.each([
    [{ username: '', password: 'x' }],
    [{ username: 'a:b', password: 'x' }],
    [{ username: 'a', password: '' }],
  ])('refuses to seal %j', (sample) => {
    expect(() => sealer.seal(sample, context)).toThrow(TypeError)
  })
})

describe('what a seal opens for', () => {
  const sealed = sealer.seal(login, context)

  it.each([
    ['another user', { ...context, sub: 'a1b2c3d4-0000-4000-8000-000000000002' }],
    ['another account', { ...context, accountId: 8 }],
    ['another origin', { ...context, origin: 'https://evil.example.org' }],
    ['another port', { ...context, origin: 'https://cal.example.org:8443' }],
    ['another scheme', { ...context, origin: 'http://cal.example.org' }],
    ['a differently spelt origin', { ...context, origin: 'https://CAL.example.org' }],
  ])('does not open for %s', (_name, other) => {
    expect(sealer.open(sealed, other)).toBeNull()
  })

  it('cannot be re-cut by moving the separator between the user and the account', () => {
    // `|` may appear in a sub; the account id is digits and the origin has none.
    const a = sealer.seal(login, { ...context, sub: 'x|1', accountId: 2 })
    expect(sealer.open(a, { ...context, sub: 'x', accountId: 2 })).toBeNull()
    expect(sealer.open(a, { ...context, sub: 'x|1', accountId: 2 })).toEqual(login)
  })

  it('does not open with another key', () => {
    expect(createSealer(Buffer.alloc(32, 8)).open(sealed, context)).toBeNull()
  })

  it('does not open after a rotation to a new key, and opens again when it is sealed anew', () => {
    const rotated = createSealer(randomBytes(32))
    expect(rotated.open(sealed, context)).toBeNull()
    expect(rotated.open(rotated.seal(login, context), context)).toEqual(login)
  })
})

describe('tampering and malformed input', () => {
  const sealed = sealer.seal(login, context)
  const bytes = Buffer.from(sealed, 'base64url')

  it('rejects a flipped bit in every byte (version, nonce, ciphertext, tag)', () => {
    for (let index = 0; index < bytes.length; index++) {
      const copy = Buffer.from(bytes)
      copy[index] = copy[index]! ^ 0x01
      expect(sealer.open(copy.toString('base64url'), context), `byte ${index}`).toBeNull()
    }
  })

  it.each([0, 2, 255])('rejects version %i', (version) => {
    const copy = Buffer.from(bytes)
    copy[0] = version
    expect(sealer.open(copy.toString('base64url'), context)).toBeNull()
  })

  it('rejects every truncation and an appended byte', () => {
    for (let length = 0; length < bytes.length; length++) {
      expect(sealer.open(bytes.subarray(0, length).toString('base64url'), context)).toBeNull()
    }
    expect(
      sealer.open(Buffer.concat([bytes, Buffer.of(0)]).toString('base64url'), context),
    ).toBeNull()
  })

  it('rejects another spelling of the same bytes (padding, standard base64, stray bits)', () => {
    expect(sealer.open(`${sealed}=`, context)).toBeNull()
    const standard = bytes.toString('base64')
    if (standard !== sealed) expect(sealer.open(standard, context)).toBeNull()
    // The last character carries unused bits for most lengths; the bytes are the same, the text not.
    const last = sealed.slice(-1)
    const variants = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_']
    const accepted = variants.filter(
      (char) => char !== last && sealer.open(sealed.slice(0, -1) + char, context) !== null,
    )
    expect(accepted).toEqual([])
  })

  it.each([
    ['an empty string', ''],
    ['text that is not base64url', 'not base64 at all!'],
    ['whitespace around a seal', ` ${sealed} `],
    ['a line break', `${sealed}\n`],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { sealed }],
    ['an array', [sealed]],
    ['an over-long text', 'A'.repeat(MAX_SEALED_LENGTH + 1)],
  ])('answers null for %s', (_name, value) => {
    expect(sealer.open(value, context)).toBeNull()
  })

  it('opens nothing when the plaintext has the wrong shape (a seal of another format)', () => {
    // Made with the right key and context but without a ':' (or an empty part): not ours to open.
    for (const plain of ['nocolon', ':nouser', 'nopassword:', '']) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', KEY, nonce)
      cipher.setAAD(Buffer.from(`v1|${context.sub}|${context.accountId}|${context.origin}`))
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      const forged = Buffer.concat([Buffer.of(1), nonce, body, cipher.getAuthTag()])
      expect(sealer.open(forged.toString('base64url'), context), JSON.stringify(plain)).toBeNull()
    }
  })

  it('returns the same null for every cause, and never throws', () => {
    const outcomes = [
      sealer.open('', context),
      sealer.open('AAAA', context),
      sealer.open(sealed, { ...context, accountId: 99 }),
      sealer.open(
        `${sealed.slice(0, 20)}${sealed[20] === 'A' ? 'B' : 'A'}${sealed.slice(21)}`,
        context,
      ),
      sealer.open(7, context),
    ]
    expect(outcomes).toEqual([null, null, null, null, null])
  })
})

describe('parseSealKey', () => {
  const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))

  it('reads 64 hex characters, either case', () => {
    expect(parseSealKey(bytes.toString('hex'))).toEqual(bytes)
    expect(parseSealKey(bytes.toString('hex').toUpperCase())).toEqual(bytes)
  })

  it('reads base64, with or without padding, and base64url', () => {
    expect(parseSealKey(bytes.toString('base64'))).toEqual(bytes)
    expect(parseSealKey(bytes.toString('base64').replace(/=+$/, ''))).toEqual(bytes)
    expect(parseSealKey(bytes.toString('base64url'))).toEqual(bytes)
    const random = randomBytes(32)
    expect(parseSealKey(random.toString('base64'))).toEqual(random)
  })

  it('ignores blanks around the value', () => {
    expect(parseSealKey(`  ${bytes.toString('hex')}\n`)).toEqual(bytes)
  })

  it('tries hex first: 64 hex characters are never read as 48 base64 bytes', () => {
    expect(parseSealKey(bytes.toString('hex'))).toHaveLength(32)
  })

  it.each([
    ['empty', ''],
    ['31 bytes as hex', 'ab'.repeat(31)],
    ['33 bytes as hex', 'ab'.repeat(33)],
    ['a short word', 'secret'],
    ['16 bytes as base64', randomBytes(16).toString('base64')],
    ['48 bytes as base64', randomBytes(48).toString('base64')],
    ['hex with a stray character', `${'ab'.repeat(31)}zz`],
    ['base64 with a stray character', `${randomBytes(32).toString('base64').slice(0, 40)}!!!`],
    ['one repeated byte in hex', '00'.repeat(32)],
    ['one repeated byte in base64', Buffer.alloc(32, 9).toString('base64')],
  ])('refuses %s', (_name, text) => {
    expect(() => parseSealKey(text)).toThrow(SealKeyError)
  })

  it('never puts the key into the message', () => {
    const secret = `${'cd'.repeat(31)}zz`
    try {
      parseSealKey(secret)
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain('cdcd')
      expect((error as Error).message).toContain('NUXT_EXTERNAL_SEAL_KEY')
    }
    expect(() => createSealer(Buffer.alloc(16))).toThrow(SealKeyError)
  })

  it('agrees with server/validate-config.mjs, which runs before the server', () => {
    const valid = {
      NUXT_OIDC_ISSUER: 'https://idm.example.org/oauth2/openid/web-calendar',
      NUXT_TOKEN_HASH_KEY: 'k'.repeat(32),
      NUXT_RADICALE_URL: 'http://radicale:5232',
    }
    const cases = [
      bytes.toString('hex'),
      bytes.toString('base64'),
      bytes.toString('base64url'),
      randomBytes(32).toString('base64'),
      '',
      'secret',
      'ab'.repeat(31),
      '00'.repeat(32),
      Buffer.alloc(32, 9).toString('base64'),
      randomBytes(48).toString('base64'),
      `${'ab'.repeat(31)}zz`,
    ]
    for (const text of cases) {
      let accepted = true
      if (text.trim() !== '') {
        try {
          parseSealKey(text)
        } catch {
          accepted = false
        }
      }
      const errors = validateEnv({ ...valid, NUXT_EXTERNAL_SEAL_KEY: text }).errors
      expect([text.slice(0, 12), errors.length === 0]).toEqual([text.slice(0, 12), accepted])
    }
  })
})

describe('sealedFromHeader', () => {
  const sealed = sealer.seal(login, context)

  it('reads `Sealed <text>`, in any case', () => {
    expect(sealedFromHeader(`Sealed ${sealed}`)).toBe(sealed)
    expect(sealedFromHeader(`sealed ${sealed}`)).toBe(sealed)
    expect(sealedFromHeader(`SEALED ${sealed} `)).toBe(sealed)
  })

  it.each([
    ['no header', null],
    ['an empty header', ''],
    ['another scheme', 'Basic YWxpY2U6c2VjcmV0'],
    ['no text', 'Sealed '],
    ['two parts', 'Sealed abc def'],
    ['a bad character', 'Sealed abc+def'],
    ['the text alone', 'abc'],
    ['an over-long text', `Sealed ${'A'.repeat(MAX_SEALED_LENGTH + 1)}`],
  ])('answers null for %s', (_name, value) => {
    expect(sealedFromHeader(value)).toBeNull()
  })
})
