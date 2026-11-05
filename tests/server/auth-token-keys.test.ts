// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateEnv } from '../../server/validate-config.mjs'
import {
  MAX_TOKEN_HASH_KEYS,
  MIN_TOKEN_HASH_KEY_LENGTH,
  describeTokenKeyring,
  parseTokenKeyring,
} from '../../server/utils/auth/token-keys'

const OLD = 'old-key-'.repeat(5)
const NEW = 'new-key-'.repeat(5)
const NEWER = 'newer-key-'.repeat(4)

describe('parseTokenKeyring', () => {
  it('keeps a deployment with only NUXT_TOKEN_HASH_KEY as it was: key version 1, current', () => {
    expect(parseTokenKeyring({ key: OLD })).toEqual({
      current: { version: 1, key: OLD },
      keys: [{ version: 1, key: OLD }],
    })
  })

  it('treats the empty values Compose passes for unset variables as unset', () => {
    expect(parseTokenKeyring({ key: OLD, keys: '' }).keys).toEqual([{ version: 1, key: OLD }])
    expect(parseTokenKeyring({ key: OLD, keys: '  ' }).keys).toEqual([{ version: 1, key: OLD }])
    expect(parseTokenKeyring({ key: '', keys: `2:${NEW}` }).keys).toEqual([
      { version: 2, key: NEW },
    ])
  })

  it('takes the first listed key as the current one and keeps NUXT_TOKEN_HASH_KEY as version 1', () => {
    expect(parseTokenKeyring({ key: OLD, keys: `2:${NEW}` })).toEqual({
      current: { version: 2, key: NEW },
      keys: [
        { version: 2, key: NEW },
        { version: 1, key: OLD },
      ],
    })
  })

  it('lists the keys in the order written, so the current one can be moved back', () => {
    const forward = parseTokenKeyring({ key: OLD, keys: `3:${NEWER}, 2:${NEW}` })
    expect(forward.current.version).toBe(3)
    expect(forward.keys.map((k) => k.version)).toEqual([3, 2, 1])
    const back = parseTokenKeyring({ key: OLD, keys: `1:${OLD},2:${NEW}` })
    expect(back.current).toEqual({ version: 1, key: OLD })
    expect(back.keys.map((k) => k.version)).toEqual([1, 2])
  })

  it('works without NUXT_TOKEN_HASH_KEY once the old key is retired', () => {
    expect(parseTokenKeyring({ keys: `3:${NEWER},2:${NEW}` }).keys.map((k) => k.version)).toEqual([
      3, 2,
    ])
  })

  it('uses NUXT_TOKEN_HASH_KEY exactly as given: it hashed the tokens that exist', () => {
    const padded = `${OLD}\n`
    expect(parseTokenKeyring({ key: padded }).current.key).toBe(padded)
  })

  it('allows a colon in a key, and blanks around entries and versions', () => {
    const key = `a:b:c-${NEW}`
    expect(parseTokenKeyring({ keys: ` 2 : ${key} , 1:${OLD} ` }).keys).toEqual([
      { version: 2, key },
      { version: 1, key: OLD },
    ])
  })

  it('accepts a listed version 1 only when it is the same key', () => {
    expect(parseTokenKeyring({ key: OLD, keys: `2:${NEW},1:${OLD}` }).keys).toHaveLength(2)
    expect(() => parseTokenKeyring({ key: OLD, keys: `2:${NEW},1:${NEWER}` })).toThrow(
      'another key for version 1',
    )
  })

  it.each([
    ['no colon', `2${NEW}`, 'entry 1'],
    ['no version', `:${NEW}`, 'entry 1'],
    ['version 0', `0:${NEW}`, 'entry 1'],
    ['negative version', `-1:${NEW}`, 'entry 1'],
    ['fractional version', `1.5:${NEW}`, 'entry 1'],
    ['version with a prefix', `v2:${NEW}`, 'entry 1'],
    ['version too large', `1234567890:${NEW}`, 'entry 1'],
    ['an empty entry', `2:${NEW},,1:${OLD}`, 'entry 2'],
    ['a trailing comma', `2:${NEW},`, 'entry 2'],
    ['a version twice', `2:${NEW},2:${NEWER}`, 'version 2 twice'],
  ])('refuses %s', (_name, keys, message) => {
    expect(() => parseTokenKeyring({ key: OLD, keys })).toThrow(message)
  })

  it('refuses a key shorter than the minimum, in either variable', () => {
    const short = 'k'.repeat(MIN_TOKEN_HASH_KEY_LENGTH - 1)
    expect(() => parseTokenKeyring({ key: short })).toThrow(
      'NUXT_TOKEN_HASH_KEY must have at least 32 characters',
    )
    expect(() => parseTokenKeyring({ key: OLD, keys: `2:${short}` })).toThrow(
      'NUXT_TOKEN_HASH_KEYS: the key of version 2 must have at least 32 characters',
    )
    expect(parseTokenKeyring({ key: 'k'.repeat(MIN_TOKEN_HASH_KEY_LENGTH) }).keys).toHaveLength(1)
  })

  it('refuses a configuration without any key', () => {
    expect(() => parseTokenKeyring({})).toThrow('NUXT_TOKEN_HASH_KEY is not set')
    expect(() => parseTokenKeyring({ key: '  ', keys: '' })).toThrow('NUXT_TOKEN_HASH_KEY')
  })

  it('refuses more keys than it will hash a token with', () => {
    const keys = (count: number) =>
      Array.from({ length: count }, (_, i) => `${i + 2}:${NEW}`).join(',')
    expect(parseTokenKeyring({ keys: keys(MAX_TOKEN_HASH_KEYS) }).keys).toHaveLength(
      MAX_TOKEN_HASH_KEYS,
    )
    expect(() => parseTokenKeyring({ keys: keys(MAX_TOKEN_HASH_KEYS + 1) })).toThrow('more than')
  })

  it('refuses a key that Nitro read as something other than text', () => {
    expect(() => parseTokenKeyring({ key: Number('12345678901234567890123456789012') })).toThrow(
      'must be text',
    )
  })

  it('never puts a key into an error message', () => {
    const attempts = [
      { key: 'x'.repeat(10) },
      { key: OLD, keys: `2:${NEW},1:${NEWER}` },
      { key: OLD, keys: `2:${NEW},2:${NEWER}` },
      { key: OLD, keys: `x${NEW}` },
      { key: OLD, keys: `2:short-secret` },
    ]
    for (const settings of attempts) {
      try {
        parseTokenKeyring(settings)
        expect.unreachable()
      } catch (error) {
        const message = (error as Error).message
        for (const secret of [OLD, NEW, NEWER, 'short-secret', 'xxxxxxxxxx']) {
          expect(message).not.toContain(secret)
        }
      }
    }
  })
})

describe('describeTokenKeyring', () => {
  it('says nothing for a single key', () => {
    expect(describeTokenKeyring(parseTokenKeyring({ key: OLD }))).toBeNull()
  })

  it('names the current version and the ones that only verify, and no key', () => {
    const note = describeTokenKeyring(parseTokenKeyring({ key: OLD, keys: `2:${NEW}` }))
    expect(note).toBe(
      'app token hash keys: version 2 hashes new tokens; version 1 only verifies earlier tokens, ' +
        'which move to the current key when used',
    )
    const more = describeTokenKeyring(parseTokenKeyring({ key: OLD, keys: `3:${NEWER},2:${NEW}` }))
    expect(more).toContain('version 3 hashes new tokens; versions 2, 1 only verify')
    for (const secret of [OLD, NEW, NEWER]) expect(`${note}${more}`).not.toContain(secret)
  })
})

describe('validate-config.mjs and parseTokenKeyring agree (the script cannot import the TS module)', () => {
  const required = {
    NUXT_OIDC_ISSUER: 'https://idm.example.org/oauth2/openid/web-calendar',
    NUXT_RADICALE_URL: 'http://radicale:5232',
  }
  const entries = (count: number) =>
    Array.from({ length: count }, (_, i) => `${i + 2}:${NEW}`).join(',')
  const cases: [name: string, key: string | undefined, keys: string | undefined][] = [
    ['only the single key', OLD, undefined],
    ['the single key and an empty list', OLD, ''],
    ['a blank single key', '   ', undefined],
    ['nothing', undefined, undefined],
    ['nothing but an empty list', '', ''],
    ['a list without the single key', undefined, `2:${NEW},1:${OLD}`],
    ['the single key and a new current key', OLD, `2:${NEW}`],
    ['a rotation, two generations', OLD, `3:${NEWER},2:${NEW}`],
    ['version 1 listed first, same key', OLD, `1:${OLD},2:${NEW}`],
    ['version 1 listed with another key', OLD, `2:${NEW},1:${NEWER}`],
    ['a short single key', 'k'.repeat(31), undefined],
    ['a single key of exactly the minimum', 'k'.repeat(32), undefined],
    ['a short listed key', OLD, `2:${'k'.repeat(31)}`],
    ['a listed key of exactly the minimum', OLD, `2:${'k'.repeat(32)}`],
    ['a key with a colon', OLD, `2:a:b:${NEW}`],
    ['blanks around entries', OLD, ` 2 : ${NEW} , 3 : ${NEWER} `],
    ['no colon', OLD, NEW],
    ['version zero', OLD, `0:${NEW}`],
    ['a prefixed version', OLD, `v2:${NEW}`],
    ['a too large version', OLD, `1234567890:${NEW}`],
    ['a repeated version', OLD, `2:${NEW},2:${NEWER}`],
    ['an empty entry', OLD, `2:${NEW},,3:${NEWER}`],
    ['a trailing comma', OLD, `2:${NEW},`],
    ['exactly the most keys', undefined, entries(MAX_TOKEN_HASH_KEYS)],
    ['one key too many', undefined, entries(MAX_TOKEN_HASH_KEYS + 1)],
  ]

  it.each(cases)('%s', (_name, key, keys) => {
    const env = {
      ...required,
      ...(key === undefined ? {} : { NUXT_TOKEN_HASH_KEY: key }),
      ...(keys === undefined ? {} : { NUXT_TOKEN_HASH_KEYS: keys }),
    }
    let parses = true
    try {
      parseTokenKeyring({ key, keys })
    } catch {
      parses = false
    }
    expect(validateEnv(env).errors.length === 0).toBe(parses)
  })
})

describe('the examples list the rotation setting', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

  it('.env.example has NUXT_TOKEN_HASH_KEYS as a commented-out variable of its own', () => {
    expect(read('../../.env.example')).toMatch(/^# NUXT_TOKEN_HASH_KEYS=$/m)
  })

  it('docker-compose.yml passes it on, empty by default (empty counts as unset)', () => {
    expect(read('../../docker-compose.yml')).toContain(
      "NUXT_TOKEN_HASH_KEYS: '${NUXT_TOKEN_HASH_KEYS:-}'",
    )
  })

  it('nuxt.config.ts declares the runtime config key that the environment variable maps to', () => {
    expect(read('../../nuxt.config.ts')).toMatch(/^\s+tokenHashKeys: '',$/m)
  })
})
