// @vitest-environment node
import type { JWK } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { AuthError, type AuthFailureReason } from '../../server/utils/auth/errors'
import {
  createTokenVerifier,
  type KeyResolver,
  type TokenVerifier,
} from '../../server/utils/auth/jwt'
import {
  CLIENT,
  ISSUER_BASE,
  NOW,
  NOW_MS,
  makeKey,
  mintAccessToken,
  type TestKey,
} from './auth-fixtures'

// The cached signing keys are fetched again on a schedule, not only for an unknown `kid`: a key the
// provider removed must stop being trusted, and an outage must not touch tokens we can verify.

const HOUR = 3600
const OTHER = { clientId: 'other-app', issuer: `${ISSUER_BASE}/other-app` }

let key: TestKey
let key2: TestKey
let otherKey: TestKey

beforeAll(async () => {
  key = await makeKey('k1')
  key2 = await makeKey('k2')
  otherKey = await makeKey('o1')
})

/** Long-lived, so that the fake clock can run for days without the tokens expiring. */
const mint = (signer: TestKey, options: Parameters<typeof mintAccessToken>[1] = {}) =>
  mintAccessToken(signer, {
    ...options,
    claims: { exp: NOW + 30 * 86_400, ...options.claims },
  })

/** Lets the callbacks of a fetch that fails (no crypto involved) run to the end. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Waits for the fetch that was just started to finish. A token with an unknown kid waits for the
 * fetch that is running and starts none of its own while the last attempt is fresh; call it right
 * after the request that started the fetch, not later.
 */
async function fetchFinished(verifier: TokenVerifier): Promise<void> {
  const unknown = await mint({ ...key2, kid: 'barrier' })
  await verifier.verify(unknown).catch(() => undefined)
}

const publicJwk = (k: TestKey | JWK): JWK => ('privateKey' in k ? (k as TestKey).jwk : (k as JWK))

function setup(
  options: { keyMaxAgeSec?: number; keyCooldownSec?: number; clients?: (typeof CLIENT)[] } = {},
) {
  const clock = { ms: NOW_MS }
  /** What the provider publishes per client id; null: the provider is down. */
  const served: Record<string, JWK[] | null> = {
    'web-calendar': [key.jwk],
    'other-app': [otherKey.jwk],
  }
  let held: (() => void)[] | null = null
  const resolver = vi.fn<KeyResolver>(async (client) => {
    // While the provider is "slow" a fetch stays open until `release()`.
    if (held) await new Promise<void>((resolve) => held!.push(resolve))
    const keys = served[client.clientId] ?? null
    if (keys === null) throw new Error('provider unreachable')
    return keys
  })
  const log = vi.fn<(message: string) => void>()
  const verifier = createTokenVerifier({
    clients: options.clients ?? [CLIENT],
    requiredScope: 'caldav',
    keyResolver: resolver,
    keyMaxAgeSec: options.keyMaxAgeSec,
    keyCooldownSec: options.keyCooldownSec,
    log,
    now: () => clock.ms,
  })
  return {
    verifier,
    resolver,
    log,
    clock,
    serve: (id: string, keys: (TestKey | JWK)[] | null) => {
      served[id] = keys && keys.map(publicJwk)
    },
    advance: (seconds: number) => {
      clock.ms += seconds * 1000
    },
    slow: () => {
      held = []
    },
    release: () => {
      const waiting = held ?? []
      held = null
      for (const resume of waiting) resume()
    },
  }
}

async function reasonOf(verifier: TokenVerifier, token: string): Promise<AuthFailureReason> {
  try {
    await verifier.verify(token)
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError)
    return (error as AuthError).reason
  }
  throw new Error('token was accepted')
}

/** Waits until the refresh that replaces the key set has finished: `signer` no longer verifies. */
const untilRejected = (verifier: TokenVerifier, signer: TestKey) =>
  vi.waitFor(async () => expect(await reasonOf(verifier, await mint(signer))).toBe('unknown-kid'))

describe('key refresh on a schedule: when it happens', () => {
  it('fetches once, and not again before the cache is as old as the max age', async () => {
    const { verifier, resolver, advance } = setup()
    await verifier.verify(await mint(key))
    advance(HOUR - 1)
    await verifier.verify(await mint(key))
    await settle()
    expect(resolver).toHaveBeenCalledTimes(1)
    advance(1)
    await verifier.verify(await mint(key))
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('counts the age from the last successful fetch, not from the first one', async () => {
    const { verifier, resolver, advance } = setup()
    await verifier.verify(await mint(key))
    advance(HOUR)
    await verifier.verify(await mint(key))
    expect(resolver).toHaveBeenCalledTimes(2)
    await fetchFinished(verifier)
    advance(HOUR - 1)
    await verifier.verify(await mint(key))
    await settle()
    expect(resolver).toHaveBeenCalledTimes(2)
    advance(1)
    await verifier.verify(await mint(key))
    expect(resolver).toHaveBeenCalledTimes(3)
  })

  it.each([
    [60, 59, 60],
    [120, 119, 120],
    [86_400, 3600, 86_400],
  ])('honours keyMaxAgeSec = %i', async (maxAge, before, at) => {
    const { verifier, resolver, advance } = setup({ keyMaxAgeSec: maxAge })
    await verifier.verify(await mint(key))
    advance(before)
    await verifier.verify(await mint(key))
    await settle()
    expect(resolver).toHaveBeenCalledTimes(1)
    advance(at - before)
    await verifier.verify(await mint(key))
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('does not fetch at all while no request comes in', async () => {
    const { verifier, resolver, advance } = setup()
    await verifier.verify(await mint(key))
    advance(10 * HOUR)
    await settle()
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('keeps the age of each client apart', async () => {
    const { verifier, resolver, advance } = setup({ clients: [CLIENT, OTHER] })
    await verifier.verify(await mint(key))
    await verifier.verify(await mint(otherKey, { client: OTHER }))
    advance(HOUR / 2)
    await verifier.verify(await mint(otherKey, { client: OTHER }))
    advance(HOUR / 2)
    // Only the first client's cache is an hour old; the second one was used, not refreshed, since.
    await verifier.verify(await mint(key))
    expect(resolver.mock.calls.map(([client]) => client.clientId)).toEqual([
      'web-calendar',
      'other-app',
      'web-calendar',
    ])
  })

  it('refuses a max age that is not a positive number', () => {
    for (const keyMaxAgeSec of [0, -1, Number.NaN, Infinity]) {
      expect(() =>
        createTokenVerifier({
          clients: [CLIENT],
          requiredScope: 'caldav',
          keyResolver: async () => [],
          keyMaxAgeSec,
        }),
      ).toThrow(TypeError)
    }
  })
})

describe('key refresh on a schedule: stale-while-revalidate', () => {
  it('verifies the request that finds the cache stale with the cached keys, without waiting', async () => {
    const { verifier, resolver, advance, slow, release } = setup()
    await verifier.verify(await mint(key))
    slow()
    advance(HOUR)
    // The fetch is open and stays open; the request is answered anyway.
    await expect(verifier.verify(await mint(key))).resolves.toMatchObject({
      clientId: 'web-calendar',
    })
    expect(resolver).toHaveBeenCalledTimes(2)
    // And so is the next one, with the fetch still open.
    await expect(verifier.verify(await mint(key))).resolves.toBeDefined()
    expect(resolver).toHaveBeenCalledTimes(2)
    release()
  })

  it('shares one fetch between concurrent requests that find the cache stale', async () => {
    const { verifier, resolver, advance, slow, release } = setup()
    await verifier.verify(await mint(key))
    slow()
    advance(HOUR)
    const token = await mint(key)
    await Promise.all(Array.from({ length: 20 }, () => verifier.verify(token)))
    expect(resolver).toHaveBeenCalledTimes(2)
    release()
    await settle()
    await verifier.verify(token)
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('lets an unknown kid wait for the fetch that is already running, instead of starting another', async () => {
    const { verifier, resolver, advance, slow, release, serve } = setup()
    await verifier.verify(await mint(key))
    serve('web-calendar', [key, key2])
    slow()
    advance(HOUR)
    const rotated = verifier.verify(await mint(key2))
    const known = verifier.verify(await mint(key))
    await expect(known).resolves.toBeDefined()
    release()
    await expect(rotated).resolves.toMatchObject({ clientId: 'web-calendar' })
    expect(resolver).toHaveBeenCalledTimes(2)
  })
})

describe('key refresh on a schedule: a successful refresh replaces the key set', () => {
  it('stops trusting a key the provider removed', async () => {
    const { verifier, advance, serve } = setup()
    serve('web-calendar', [key, key2])
    await verifier.verify(await mint(key))
    await verifier.verify(await mint(key2))
    serve('web-calendar', [key2])
    advance(HOUR)
    // The request that starts the refresh still passes, that is the point of revalidating in the background.
    await expect(verifier.verify(await mint(key))).resolves.toBeDefined()
    await untilRejected(verifier, key)
    // The key that is still published is still trusted.
    await expect(verifier.verify(await mint(key2))).resolves.toBeDefined()
  })

  it('picks up a key that was added, without an unknown kid having to ask for it', async () => {
    const { verifier, resolver, advance, serve } = setup()
    await verifier.verify(await mint(key))
    serve('web-calendar', [key, key2])
    advance(HOUR)
    await verifier.verify(await mint(key))
    await vi.waitFor(async () => expect(await verifier.verify(await mint(key2))).toBeDefined())
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('replaces the whole set when the provider switches to different keys', async () => {
    const { verifier, advance, serve } = setup()
    serve('web-calendar', [key, key2])
    await verifier.verify(await mint(key))
    const key3 = await makeKey('k3')
    serve('web-calendar', [key3])
    advance(HOUR)
    await verifier.verify(await mint(key))
    await untilRejected(verifier, key)
    expect(await reasonOf(verifier, await mint(key2))).toBe('unknown-kid')
    await expect(verifier.verify(await mint(key3))).resolves.toBeDefined()
  })
})

describe('key refresh on a schedule: a failed refresh', () => {
  it('keeps the cached keys, however long the outage lasts', async () => {
    const { verifier, resolver, advance, serve } = setup()
    await verifier.verify(await mint(key))
    serve('web-calendar', null)
    for (let hour = 0; hour < 30; hour++) {
      advance(HOUR)
      await expect(verifier.verify(await mint(key))).resolves.toMatchObject({
        clientId: 'web-calendar',
      })
      await settle()
    }
    expect(resolver.mock.calls.length).toBeGreaterThan(1)
  })

  it.each([
    ['answers with an empty key set', [] as JWK[]],
    [
      'answers with keys we cannot use',
      [
        { kty: 'EC', kid: 'broken' },
        { kty: 'RSA', kid: 'rsa' },
      ],
    ],
  ])('keeps the cached keys when the provider %s', async (_name, answer) => {
    const { verifier, advance, serve, log } = setup()
    await verifier.verify(await mint(key))
    serve('web-calendar', answer)
    advance(HOUR)
    await verifier.verify(await mint(key))
    await settle()
    await expect(verifier.verify(await mint(key))).resolves.toBeDefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain('no usable signing key')
  })

  it('tries again after 30 s, then 60 s, then twice as long each time, up to the max age', async () => {
    const { verifier, resolver, advance, serve } = setup({ keyMaxAgeSec: 1000 })
    await verifier.verify(await mint(key))
    serve('web-calendar', null)
    advance(1000)
    let calls = 1
    // Seconds to wait after the 1st, 2nd, ... failure; the cap is the max age.
    for (const wait of [30, 60, 120, 240, 480, 960, 1000, 1000, 1000]) {
      await verifier.verify(await mint(key))
      await settle()
      expect(resolver).toHaveBeenCalledTimes(++calls)
      advance(wait - 1)
      await verifier.verify(await mint(key))
      await settle()
      expect(resolver).toHaveBeenCalledTimes(calls)
      advance(1)
    }
    await verifier.verify(await mint(key))
    expect(resolver).toHaveBeenCalledTimes(calls + 1)
  })

  it('caps the delay at a max age that is shorter than the first step', async () => {
    const { verifier, resolver, advance, serve } = setup({ keyMaxAgeSec: 10 })
    await verifier.verify(await mint(key))
    serve('web-calendar', null)
    advance(10)
    await verifier.verify(await mint(key))
    await settle()
    advance(9)
    await verifier.verify(await mint(key))
    await settle()
    expect(resolver).toHaveBeenCalledTimes(2)
    advance(1)
    await verifier.verify(await mint(key))
    expect(resolver).toHaveBeenCalledTimes(3)
  })

  it('does not try on every request while it backs off', async () => {
    const { verifier, resolver, advance, serve } = setup()
    await verifier.verify(await mint(key))
    serve('web-calendar', null)
    advance(HOUR)
    for (let i = 0; i < 50; i++) {
      await verifier.verify(await mint(key))
      await settle()
    }
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('starts over with a short delay once the provider is back and failed again later', async () => {
    const { verifier, resolver, advance, serve } = setup({ keyMaxAgeSec: 1000 })
    await verifier.verify(await mint(key))
    serve('web-calendar', null)
    advance(1000)
    await verifier.verify(await mint(key))
    await settle()
    advance(30)
    await verifier.verify(await mint(key))
    await settle()
    advance(60)
    serve('web-calendar', [key, key2])
    await verifier.verify(await mint(key))
    // The unknown kid waits for the fetch that has just started, so it has finished afterwards.
    await expect(verifier.verify(await mint(key2))).resolves.toBeDefined()
    expect(resolver).toHaveBeenCalledTimes(4)
    // Fresh again: no fetch for another max age, then a failure restarts the backoff at 30 s.
    serve('web-calendar', null)
    advance(1000)
    await verifier.verify(await mint(key))
    await settle()
    expect(resolver).toHaveBeenCalledTimes(5)
    advance(30)
    await verifier.verify(await mint(key))
    expect(resolver).toHaveBeenCalledTimes(6)
  })

  it('logs once per run of failures, then again after a recovery', async () => {
    const { verifier, advance, serve, log } = setup({ keyMaxAgeSec: 1000 })
    await verifier.verify(await mint(key))
    serve('web-calendar', null)
    advance(1000)
    for (const wait of [30, 60, 120, 240]) {
      await verifier.verify(await mint(key))
      await settle()
      advance(wait)
    }
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain('web-calendar')
    expect(log.mock.calls[0]![0]).toContain('provider unreachable')
    expect(log.mock.calls[0]![0]).toContain('keeping the 1 cached')

    // The provider is back: the next try (the delay has passed) succeeds and ends the run.
    serve('web-calendar', [key, key2])
    await verifier.verify(await mint(key))
    await expect(verifier.verify(await mint(key2))).resolves.toBeDefined()
    expect(log).toHaveBeenCalledTimes(1)
    // A new failure is a new run, and it is reported.
    serve('web-calendar', null)
    advance(1000)
    await verifier.verify(await mint(key))
    await settle()
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('never puts a token into the log', async () => {
    const { verifier, advance, serve, log } = setup()
    const token = await mint(key)
    await verifier.verify(token)
    serve('web-calendar', null)
    advance(HOUR)
    await verifier.verify(token)
    await settle()
    expect(log).toHaveBeenCalled()
    for (const [message] of log.mock.calls) expect(message).not.toContain(token.split('.')[1]!)
  })

  it('survives a logger that throws', async () => {
    const { verifier, advance, serve, log } = setup()
    log.mockImplementation(() => {
      throw new Error('stderr closed')
    })
    await verifier.verify(await mint(key))
    serve('web-calendar', null)
    advance(HOUR)
    await expect(verifier.verify(await mint(key))).resolves.toBeDefined()
    await settle()
    await expect(verifier.verify(await mint(key))).resolves.toBeDefined()
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('key refresh on a schedule: next to the unknown-kid path', () => {
  it('still refetches for an unknown kid, within its own rate limit', async () => {
    const { verifier, resolver, advance, serve } = setup()
    await verifier.verify(await mint(key))
    serve('web-calendar', [key, key2])
    advance(31)
    await expect(verifier.verify(await mint(key2))).resolves.toBeDefined()
    expect(resolver).toHaveBeenCalledTimes(2)
    // Junk kids right after cannot make us fetch again.
    for (let i = 0; i < 20; i++) {
      const forged = { ...key2, kid: `junk-${i}` }
      expect(await reasonOf(verifier, await mint(forged))).toBe('unknown-kid')
    }
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('does not let junk kids on a stale cache cause more than the one scheduled fetch', async () => {
    const { verifier, resolver, advance } = setup()
    await verifier.verify(await mint(key))
    advance(HOUR)
    for (let i = 0; i < 30; i++) {
      const forged = { ...key2, kid: `junk-${i}` }
      expect(await reasonOf(verifier, await mint(forged))).toBe('unknown-kid')
    }
    expect(resolver).toHaveBeenCalledTimes(2)
    // The cache is fresh again: the next scheduled fetch is an hour away, not one request away.
    advance(HOUR - 1)
    await verifier.verify(await mint(key))
    await settle()
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('counts a fetch for an unknown kid as a refresh: the schedule starts over', async () => {
    const { verifier, resolver, advance, serve } = setup()
    await verifier.verify(await mint(key))
    advance(HOUR - 10)
    serve('web-calendar', [key, key2])
    await verifier.verify(await mint(key2))
    expect(resolver).toHaveBeenCalledTimes(2)
    advance(20)
    await verifier.verify(await mint(key))
    await settle()
    expect(resolver).toHaveBeenCalledTimes(2)
    advance(HOUR - 20)
    await verifier.verify(await mint(key))
    expect(resolver).toHaveBeenCalledTimes(3)
  })

  it('keeps the 5 s retry for an unknown kid during an outage', async () => {
    const { verifier, resolver, advance, serve } = setup()
    await verifier.verify(await mint(key))
    serve('web-calendar', null)
    advance(HOUR)
    await verifier.verify(await mint(key))
    await settle()
    expect(resolver).toHaveBeenCalledTimes(2)
    // Unknown kid: a 503 (we cannot tell a rotation from a forgery), and the cached keys stay.
    expect(await reasonOf(verifier, await mint(key2))).toBe('keys-unavailable')
    expect(resolver).toHaveBeenCalledTimes(2)
    advance(5)
    expect(await reasonOf(verifier, await mint(key2))).toBe('keys-unavailable')
    expect(resolver).toHaveBeenCalledTimes(3)
    await expect(verifier.verify(await mint(key))).resolves.toBeDefined()
  })
})

describe('key refresh on a schedule: a cold cache', () => {
  it('answers 503 while the provider is down, however much time has passed', async () => {
    const { verifier, resolver, advance, serve } = setup()
    serve('web-calendar', null)
    const error = await verifier.verify(await mint(key)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthError)
    expect((error as AuthError).status).toBe(503)
    expect(resolver).toHaveBeenCalledTimes(1)
    advance(10 * HOUR)
    expect(await reasonOf(verifier, await mint(key))).toBe('keys-unavailable')
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('does not hammer the provider when many requests arrive during the outage', async () => {
    const { verifier, resolver, serve } = setup()
    serve('web-calendar', null)
    const token = await mint(key)
    await Promise.all(Array.from({ length: 50 }, () => verifier.verify(token).catch(() => 0)))
    for (let i = 0; i < 50; i++) await verifier.verify(token).catch(() => 0)
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('answers 503, not 401, when the provider only has keys we cannot use', async () => {
    const { verifier, serve } = setup()
    serve('web-calendar', [])
    expect(await reasonOf(verifier, await mint(key))).toBe('keys-unavailable')
  })

  it('recovers when the provider comes back, and then follows the schedule', async () => {
    const { verifier, resolver, advance, serve } = setup()
    serve('web-calendar', null)
    expect(await reasonOf(verifier, await mint(key))).toBe('keys-unavailable')
    serve('web-calendar', [key])
    advance(5)
    await expect(verifier.verify(await mint(key))).resolves.toBeDefined()
    expect(resolver).toHaveBeenCalledTimes(2)
    advance(HOUR)
    await verifier.verify(await mint(key))
    expect(resolver).toHaveBeenCalledTimes(3)
  })
})
