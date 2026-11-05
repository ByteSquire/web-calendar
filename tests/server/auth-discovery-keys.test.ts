// @vitest-environment node
import type { JWK } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { AuthError } from '../../server/utils/auth/errors'
import { createDiscoveryStore, discoveryUrl } from '../../server/utils/auth/discovery'
import { createJwksFetcher, createTokenVerifier } from '../../server/utils/auth/jwt'
import { CLIENT, NOW, NOW_MS, makeKey, mintAccessToken, type TestKey } from './auth-fixtures'

// The default key source reads the discovery document first and fetches the keys from the
// `jwks_uri` in it, on the verifier's own schedule: first use, an unknown `kid` (at most once per
// cooldown) and the maximum age.

// On the issuer's host (CLIENT.issuer is on idm.example.test), but not at the old fixed path.
const JWKS_URI = 'https://idm.example.test/keys/web-calendar/certs.json'
const DOCUMENT = {
  issuer: CLIENT.issuer,
  jwks_uri: JWKS_URI,
  userinfo_endpoint: `${CLIENT.issuer}/userinfo`,
}

let key: TestKey
let key2: TestKey

beforeAll(async () => {
  key = await makeKey('k1')
  key2 = await makeKey('k2')
})

const mint = (signer: TestKey) => mintAccessToken(signer, { claims: { exp: NOW + 30 * 86_400 } })

const OTHER_HOST_JWKS_URI = 'https://keys.example.test/certs.json'

function world(jwksHosts?: string[]) {
  const clock = { ms: NOW_MS }
  const state = {
    down: false,
    document: DOCUMENT as Record<string, unknown>,
    keys: [key.jwk] as JWK[],
  }
  const requests: string[] = []
  const fetch = vi.fn(async (url: string) => {
    requests.push(url)
    if (state.down) throw new TypeError('connect ECONNREFUSED')
    if (url === discoveryUrl(CLIENT.issuer)) return new Response(JSON.stringify(state.document))
    if (url === JWKS_URI || url === OTHER_HOST_JWKS_URI) {
      return new Response(JSON.stringify({ keys: state.keys }))
    }
    return new Response('', { status: 404 })
  }) as unknown as typeof globalThis.fetch
  const discovery = createDiscoveryStore({ fetch })
  const log = vi.fn<(message: string) => void>()
  const verifier = createTokenVerifier({
    clients: [CLIENT],
    requiredScope: 'caldav',
    keyResolver: createJwksFetcher({ fetch, discovery, jwksHosts }),
    now: () => clock.ms,
    log,
  })
  return {
    verifier,
    state,
    requests,
    log,
    discovery,
    advance: (seconds: number) => {
      clock.ms += seconds * 1000
    },
  }
}

const reasonOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof AuthError ? error.reason : String(error)),
  )

describe('keys through discovery', () => {
  it('reads the document, then the keys from its jwks_uri, once for many tokens', async () => {
    const { verifier, requests, discovery } = world()
    const token = await mint(key)
    expect(await reasonOf(verifier.verify(token))).toBe('ok')
    expect(await reasonOf(verifier.verify(token))).toBe('ok')
    expect(requests).toEqual([discoveryUrl(CLIENT.issuer), JWKS_URI])
    // The store holds what the userinfo code will need.
    expect(discovery.current(CLIENT.issuer)).toEqual({
      issuer: CLIENT.issuer,
      jwksUri: JWKS_URI,
      userinfoEndpoint: `${CLIENT.issuer}/userinfo`,
    })
  })

  it('fetches both again for an unknown kid, at most once per cooldown, and takes the new key', async () => {
    const { verifier, state, requests, advance } = world()
    expect(await reasonOf(verifier.verify(await mint(key)))).toBe('ok')
    const rotated = await mint({ ...key2, kid: 'k-new' })

    // The keys were fetched a moment ago, so an unknown kid asks nobody: not even for the document.
    expect(await reasonOf(verifier.verify(rotated))).toBe('unknown-kid')
    expect(requests).toHaveLength(2)

    // After the cooldown one unknown kid fetches both, once; the provider has not rotated yet.
    advance(31)
    expect(await reasonOf(verifier.verify(rotated))).toBe('unknown-kid')
    expect(requests).toHaveLength(4)
    expect(await reasonOf(verifier.verify(rotated))).toBe('unknown-kid')
    expect(requests).toHaveLength(4)

    state.keys = [key.jwk, { ...key2.jwk, kid: 'k-new' }]
    advance(31)
    expect(await reasonOf(verifier.verify(rotated))).toBe('ok')
    expect(requests).toHaveLength(6)
  })

  it('treats a document for another issuer as a key outage: 401 never, 503 and no key fetch', async () => {
    const { verifier, state, requests, log } = world()
    state.document = { ...DOCUMENT, issuer: `${CLIENT.issuer}-other`, jwks_uri: 'https://x.test/k' }
    const token = await mint(key)
    const error = await verifier.verify(token).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthError)
    expect(error).toMatchObject({ reason: 'keys-unavailable', status: 503 })
    expect(requests).toEqual([discoveryUrl(CLIENT.issuer)])
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toMatch(/discovery: the document is for the issuer/)
    expect(log.mock.calls[0]![0]).not.toContain(token)
  })

  it('answers 503 while the provider is down at the start, and recovers without a restart', async () => {
    const { verifier, state, advance } = world()
    state.down = true
    const token = await mint(key)
    expect(await reasonOf(verifier.verify(token))).toBe('keys-unavailable')
    state.down = false
    // A failed fetch is tried again after at most 5 seconds.
    advance(6)
    expect(await reasonOf(verifier.verify(token))).toBe('ok')
  })

  it('refuses a document with an http key set for an https issuer, before any key is trusted', async () => {
    const { verifier, state, requests } = world()
    state.document = { ...DOCUMENT, jwks_uri: 'http://idm.example.test/certs.json' }
    expect(await reasonOf(verifier.verify(await mint(key)))).toBe('keys-unavailable')
    expect(requests).toEqual([discoveryUrl(CLIENT.issuer)])
  })

  it('fetches keys from another host once the operator names it (Google, Entra v1)', async () => {
    const { verifier, state, requests } = world(['keys.example.test'])
    state.document = { ...DOCUMENT, jwks_uri: OTHER_HOST_JWKS_URI }
    expect(await reasonOf(verifier.verify(await mint(key)))).toBe('ok')
    expect(requests).toEqual([discoveryUrl(CLIENT.issuer), OTHER_HOST_JWKS_URI])
    // A host that is not on the list stays refused, and nothing is fetched from it.
    const strict = world(['somewhere-else.example.test'])
    strict.state.document = { ...DOCUMENT, jwks_uri: OTHER_HOST_JWKS_URI }
    expect(await reasonOf(strict.verifier.verify(await mint(key)))).toBe('keys-unavailable')
    expect(strict.requests).toEqual([discoveryUrl(CLIENT.issuer)])
  })

  it('does not fetch keys from another host than the issuer’s: a key outage, nothing is trusted', async () => {
    const { verifier, state, requests, log } = world()
    state.document = { ...DOCUMENT, jwks_uri: 'https://keys.example.test/certs.json' }
    expect(await reasonOf(verifier.verify(await mint(key)))).toBe('keys-unavailable')
    expect(requests).toEqual([discoveryUrl(CLIENT.issuer)])
    expect(log.mock.calls[0]![0]).toMatch(/jwks_uri is on another host than the issuer/)
  })

  it('keeps verifying with the cached keys when the later refresh cannot reach the provider', async () => {
    const { verifier, state, requests, advance } = world()
    const token = await mint(key)
    expect(await reasonOf(verifier.verify(token))).toBe('ok')
    state.down = true
    advance(3601)
    expect(await reasonOf(verifier.verify(token))).toBe('ok')
    // The background refresh asked once and failed; the cache is untouched.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toHaveLength(3)
    expect(await reasonOf(verifier.verify(token))).toBe('ok')
  })

  it('stops trusting a key the provider removed, once the document and keys are read again', async () => {
    const { verifier, state, advance } = world()
    const token = await mint(key)
    expect(await reasonOf(verifier.verify(token))).toBe('ok')
    state.keys = [key2.jwk]
    advance(3601)
    // The request that finds the cache stale still uses it; the refresh runs in the background.
    expect(await reasonOf(verifier.verify(token))).toBe('ok')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await reasonOf(verifier.verify(token))).toBe('unknown-kid')
  })
})
