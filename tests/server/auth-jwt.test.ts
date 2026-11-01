// @vitest-environment node
import { SignJWT, base64url, exportJWK, generateKeyPair } from 'jose'
import { createHmac } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildAllowedClients, deriveClientIssuer } from '../../server/utils/auth/clients'
import { AuthError, type AuthFailureReason } from '../../server/utils/auth/errors'
import {
  createTokenVerifier,
  type KeyResolver,
  type TokenVerifier,
} from '../../server/utils/auth/jwt'
import kanidm from './auth-kanidm-fixture.json'
import {
  CLIENT,
  ISSUER_BASE,
  NOW,
  NOW_MS,
  makeKey,
  mintAccessToken,
  unsignedToken,
  type TestKey,
} from './auth-fixtures'

const OTHER = { clientId: 'other-app', issuer: `${ISSUER_BASE}/other-app` }

let key: TestKey
let key2: TestKey
let otherKey: TestKey

beforeAll(async () => {
  key = await makeKey('k1')
  key2 = await makeKey('k2')
  otherKey = await makeKey('o1')
})

/** A verifier whose resolver serves the keys per client (null: the provider is down). */
function setup(
  serve: Record<string, () => TestKey[] | null> = { 'web-calendar': () => [key] },
  extra: { clients?: (typeof CLIENT)[]; keyCooldownSec?: number } = {},
) {
  const clock = { ms: NOW_MS }
  const resolver = vi.fn<KeyResolver>(async (client) => {
    const keys = serve[client.clientId]?.() ?? null
    if (!keys) throw new Error('provider unreachable')
    return keys.map((k) => k.jwk)
  })
  const verifier = createTokenVerifier({
    clients: extra.clients ?? [CLIENT],
    requiredScope: 'caldav',
    keyResolver: resolver,
    keyCooldownSec: extra.keyCooldownSec,
    now: () => clock.ms,
  })
  return { verifier, resolver, clock }
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

describe('createTokenVerifier: the good token', () => {
  it('accepts a token shaped like Kanidm’s and returns its identity', async () => {
    const { verifier } = setup()
    const result = await verifier.verify(await mintAccessToken(key))
    expect(result).toEqual({
      sub: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
      clientId: 'web-calendar',
      scopes: ['caldav', 'email', 'groups', 'openid', 'profile'],
      exp: NOW + 900,
    })
  })

  it('accepts typ application/at+jwt and an aud array that contains the client', async () => {
    const { verifier } = setup()
    const token = await mintAccessToken(key, {
      header: { typ: 'application/at+jwt' },
      claims: { aud: ['web-calendar', 'someone-else'] },
    })
    await expect(verifier.verify(token)).resolves.toMatchObject({ clientId: 'web-calendar' })
  })

  it('verifies a real token and rejects the real ID token (captured from Kanidm 1.11.2)', async () => {
    const clock = { ms: (kanidm.iat + 60) * 1000 }
    const verifier = createTokenVerifier({
      clients: [{ clientId: kanidm.clientId, issuer: kanidm.issuer }],
      requiredScope: 'caldav',
      keyResolver: async () => kanidm.jwks.keys,
      now: () => clock.ms,
    })
    await expect(verifier.verify(kanidm.accessToken)).resolves.toMatchObject({
      clientId: 'web-calendar',
      scopes: expect.arrayContaining(['caldav']),
    })
    // Same issuer, audience, signing key and scopes: only the missing `typ` tells it apart.
    expect(await reasonOf(verifier, kanidm.idToken)).toBe('wrong-typ')
    clock.ms = (kanidm.iat + 900 + 61) * 1000
    expect(await reasonOf(verifier, kanidm.accessToken)).toBe('expired')
  })
})

describe('createTokenVerifier: algorithm and type', () => {
  it('rejects HS256, even keyed with the public key (algorithm confusion)', async () => {
    const { verifier, resolver } = setup()
    const claims = {
      iss: CLIENT.issuer,
      sub: 'x',
      aud: 'web-calendar',
      exp: NOW + 900,
      scope: 'caldav',
    }
    const secret = new TextEncoder().encode(JSON.stringify(key.jwk))
    const hs256 = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: 'k1' })
      .sign(secret)
    expect(await reasonOf(verifier, hs256)).toBe('wrong-alg')
    // Built by hand as well, so the check does not rest on the library's signing rules.
    const header = base64url.encode(JSON.stringify({ alg: 'HS256', typ: 'at+jwt', kid: 'k1' }))
    const payload = base64url.encode(JSON.stringify(claims))
    const mac = createHmac('sha256', JSON.stringify(key.jwk))
      .update(`${header}.${payload}`)
      .digest()
    expect(await reasonOf(verifier, `${header}.${payload}.${base64url.encode(mac)}`)).toBe(
      'wrong-alg',
    )
    expect(resolver).not.toHaveBeenCalled()
  })

  it('rejects alg none', async () => {
    const { verifier } = setup()
    const token = unsignedToken({
      iss: CLIENT.issuer,
      sub: 'x',
      aud: 'web-calendar',
      exp: NOW + 900,
    })
    expect(await reasonOf(verifier, token)).toBe('wrong-alg')
  })

  it('rejects RS256 and ES384', async () => {
    const { verifier } = setup()
    const claims = {
      iss: CLIENT.issuer,
      sub: 'x',
      aud: 'web-calendar',
      exp: NOW + 900,
      scope: 'caldav',
    }
    const rsa = await generateKeyPair('RS256')
    const rs256 = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'k1' })
      .sign(rsa.privateKey)
    expect(await reasonOf(verifier, rs256)).toBe('wrong-alg')
    const ec = await generateKeyPair('ES384')
    const es384 = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES384', typ: 'at+jwt', kid: 'k1' })
      .sign(ec.privateKey)
    expect(await reasonOf(verifier, es384)).toBe('wrong-alg')
  })

  it('rejects a wrong or missing typ (an ID token used as access token)', async () => {
    const { verifier } = setup()
    expect(await reasonOf(verifier, await mintAccessToken(key, { header: { typ: 'JWT' } }))).toBe(
      'wrong-typ',
    )
    expect(
      await reasonOf(verifier, await mintAccessToken(key, { header: { typ: undefined } })),
    ).toBe('wrong-typ')
    expect(
      await reasonOf(verifier, await mintAccessToken(key, { header: { typ: 'id_token+jwt' } })),
    ).toBe('wrong-typ')
  })

  it.each(['', 'garbage', 'a.b.c', 'a.b', '....'])(
    'rejects the malformed token %j',
    async (token) => {
      const { verifier } = setup()
      expect(await reasonOf(verifier, token)).toBe('malformed')
    },
  )

  it('rejects a token without kid', async () => {
    const { verifier } = setup()
    expect(
      await reasonOf(verifier, await mintAccessToken(key, { header: { kid: undefined } })),
    ).toBe('malformed')
  })
})

describe('createTokenVerifier: signature and claims', () => {
  it('rejects a changed payload', async () => {
    const { verifier } = setup()
    const [header, , signature] = (await mintAccessToken(key)).split('.')
    const payload = base64url.encode(
      JSON.stringify({
        iss: CLIENT.issuer,
        sub: 'someone-else',
        aud: 'web-calendar',
        client_id: 'web-calendar',
        exp: NOW + 900,
        scope: 'caldav',
      }),
    )
    expect(await reasonOf(verifier, `${header}.${payload}.${signature}`)).toBe('bad-signature')
  })

  it('rejects a token signed with another key that claims the known kid', async () => {
    const { verifier } = setup()
    const forged = { ...key2, kid: 'k1' }
    expect(await reasonOf(verifier, await mintAccessToken(forged))).toBe('bad-signature')
  })

  it('rejects an issuer that is not on the allow-list', async () => {
    const { verifier, resolver } = setup()
    const token = await mintAccessToken(key, {
      claims: { iss: 'https://evil.example/oauth2/openid/web-calendar' },
    })
    expect(await reasonOf(verifier, token)).toBe('client-not-allowed')
    expect(resolver).not.toHaveBeenCalled()
  })

  it('rejects the allowed issuer when another client’s key signed it', async () => {
    const { verifier } = setup()
    expect(
      await reasonOf(verifier, await mintAccessToken(otherKey, { header: { kid: 'k1' } })),
    ).toBe('bad-signature')
  })

  it('rejects a wrong or missing audience, and a client_id that differs', async () => {
    const { verifier } = setup()
    expect(
      await reasonOf(verifier, await mintAccessToken(key, { claims: { aud: 'other-app' } })),
    ).toBe('wrong-audience')
    expect(
      await reasonOf(verifier, await mintAccessToken(key, { claims: { aud: ['a', 'b'] } })),
    ).toBe('wrong-audience')
    expect(
      await reasonOf(verifier, await mintAccessToken(key, { claims: { aud: undefined } })),
    ).toBe('wrong-audience')
    expect(
      await reasonOf(verifier, await mintAccessToken(key, { claims: { client_id: 'other-app' } })),
    ).toBe('wrong-audience')
  })

  it('requires a client_id (security review 2026-11-01): a token without one is refused', async () => {
    const { verifier } = setup()
    const withoutClientId = await mintAccessToken(key, { claims: { client_id: undefined } })
    expect(await reasonOf(verifier, withoutClientId)).toBe('wrong-audience')
    // The same token with the claim set to the right client passes, so only the claim differs.
    await expect(verifier.verify(await mintAccessToken(key))).resolves.toBeDefined()
  })

  it('applies exp with a 60 s tolerance', async () => {
    const { verifier } = setup()
    const expiredAt = (seconds: number) => mintAccessToken(key, { claims: { exp: NOW - seconds } })
    await expect(verifier.verify(await expiredAt(59))).resolves.toBeDefined()
    expect(await reasonOf(verifier, await expiredAt(60))).toBe('expired')
    expect(await reasonOf(verifier, await expiredAt(3600))).toBe('expired')
  })

  it('applies nbf with a 60 s tolerance', async () => {
    const { verifier } = setup()
    const validFrom = (seconds: number) => mintAccessToken(key, { claims: { nbf: NOW + seconds } })
    await expect(verifier.verify(await validFrom(60))).resolves.toBeDefined()
    expect(await reasonOf(verifier, await validFrom(61))).toBe('not-yet-valid')
  })

  it('honours the configured tolerance', async () => {
    const strict = createTokenVerifier({
      clients: [CLIENT],
      requiredScope: 'caldav',
      toleranceSec: 0,
      keyResolver: async () => [key.jwk],
      now: () => NOW_MS,
    })
    expect(await reasonOf(strict, await mintAccessToken(key, { claims: { exp: NOW - 1 } }))).toBe(
      'expired',
    )
  })

  it('requires exp and sub', async () => {
    const { verifier } = setup()
    expect(
      await reasonOf(verifier, await mintAccessToken(key, { claims: { exp: undefined } })),
    ).toBe('invalid-claims')
    expect(
      await reasonOf(verifier, await mintAccessToken(key, { claims: { sub: undefined } })),
    ).toBe('invalid-claims')
    expect(await reasonOf(verifier, await mintAccessToken(key, { claims: { sub: '' } }))).toBe(
      'invalid-claims',
    )
  })

  it('requires the scope as a whole word', async () => {
    const { verifier } = setup()
    const withScope = (scope: unknown) => mintAccessToken(key, { claims: { scope } })
    await expect(verifier.verify(await withScope('openid caldav'))).resolves.toBeDefined()
    expect(await reasonOf(verifier, await withScope('openid email'))).toBe('missing-scope')
    expect(await reasonOf(verifier, await withScope('caldavx xcaldav'))).toBe('missing-scope')
    expect(await reasonOf(verifier, await withScope(''))).toBe('missing-scope')
    expect(await reasonOf(verifier, await withScope(undefined))).toBe('missing-scope')
    expect(await reasonOf(verifier, await withScope(['caldav']))).toBe('missing-scope')
  })

  it('refuses to start without a required scope or a client', () => {
    expect(() =>
      createTokenVerifier({ clients: [CLIENT], requiredScope: '', keyResolver: async () => [] }),
    ).toThrow(TypeError)
    expect(() =>
      createTokenVerifier({ clients: [], requiredScope: 'caldav', keyResolver: async () => [] }),
    ).toThrow(TypeError)
  })
})

describe('createTokenVerifier: allow-list of clients', () => {
  it('rejects a perfectly valid token of a client that is not listed, without fetching keys', async () => {
    const { verifier, resolver } = setup({
      'web-calendar': () => [key],
      'other-app': () => [otherKey],
    })
    const token = await mintAccessToken(otherKey, { client: OTHER })
    expect(await reasonOf(verifier, token)).toBe('client-not-allowed')
    expect(resolver).not.toHaveBeenCalled()
  })

  it('accepts it once the client is listed, with its own keys', async () => {
    const { verifier, resolver } = setup(
      { 'web-calendar': () => [key], 'other-app': () => [otherKey] },
      { clients: [CLIENT, OTHER] },
    )
    await expect(
      verifier.verify(await mintAccessToken(otherKey, { client: OTHER })),
    ).resolves.toMatchObject({ clientId: 'other-app' })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver.mock.calls[0]![0]).toEqual(OTHER)
    // Keys are per client: the other client's key is not consulted for the first client's issuer.
    const swapped = await mintAccessToken(otherKey, {
      client: OTHER,
      claims: { iss: CLIENT.issuer },
    })
    expect(await reasonOf(verifier, swapped)).toBe('unknown-kid')
  })
})

describe('createTokenVerifier: key cache and rotation', () => {
  it('fetches keys on first use and then serves from the cache', async () => {
    const { verifier, resolver } = setup()
    await verifier.verify(await mintAccessToken(key))
    await verifier.verify(await mintAccessToken(key))
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('shares one fetch between concurrent requests on a cold cache', async () => {
    const { verifier, resolver } = setup()
    const token = await mintAccessToken(key)
    await Promise.all([verifier.verify(token), verifier.verify(token), verifier.verify(token)])
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('refetches for an unknown kid, at most once per cooldown, and then accepts the rotated key', async () => {
    let published = [key]
    const { verifier, resolver, clock } = setup({ 'web-calendar': () => published })
    await verifier.verify(await mintAccessToken(key))
    expect(resolver).toHaveBeenCalledTimes(1)

    const rotated = await mintAccessToken(key2)
    // The provider has not published k2 yet: unknown, and the next attempt waits for the cooldown.
    clock.ms += 31_000
    expect(await reasonOf(verifier, rotated)).toBe('unknown-kid')
    expect(resolver).toHaveBeenCalledTimes(2)
    clock.ms += 10_000
    expect(await reasonOf(verifier, rotated)).toBe('unknown-kid')
    expect(resolver).toHaveBeenCalledTimes(2)

    published = [key, key2]
    clock.ms += 25_000
    await expect(verifier.verify(rotated)).resolves.toMatchObject({ clientId: 'web-calendar' })
    expect(resolver).toHaveBeenCalledTimes(3)
    // The old key is still published and still works.
    await expect(verifier.verify(await mintAccessToken(key))).resolves.toBeDefined()
    expect(resolver).toHaveBeenCalledTimes(3)
  })

  it('cannot be made to flood the provider with random kids', async () => {
    const { verifier, resolver } = setup()
    await verifier.verify(await mintAccessToken(key))
    for (let i = 0; i < 20; i++) {
      const forged = { ...key2, kid: `junk-${i}` }
      expect(await reasonOf(verifier, await mintAccessToken(forged))).toBe('unknown-kid')
    }
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('forgets a key the provider no longer publishes after the next refresh', async () => {
    let published = [key, key2]
    const { verifier, clock } = setup({ 'web-calendar': () => published })
    await verifier.verify(await mintAccessToken(key))
    published = [key2]
    clock.ms += 31_000
    expect(await reasonOf(verifier, await mintAccessToken(key2, { header: { kid: 'new' } }))).toBe(
      'unknown-kid',
    )
    expect(await reasonOf(verifier, await mintAccessToken(key))).toBe('unknown-kid')
  })

  it('ignores private keys and keys that are not ES256 signing keys in the key set', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    const privateJwk = {
      ...(await exportJWK(pair.privateKey)),
      kid: 'priv',
      alg: 'ES256',
      use: 'sig',
    }
    const encryption = { ...key2.jwk, kid: 'enc', use: 'enc' }
    const rsa = await generateKeyPair('RS256', { extractable: true })
    const rsaJwk = { ...(await exportJWK(rsa.publicKey)), kid: 'rsa', alg: 'RS256' }
    const verifier = createTokenVerifier({
      clients: [CLIENT],
      requiredScope: 'caldav',
      keyResolver: async () => [
        privateJwk,
        encryption,
        rsaJwk,
        { kty: 'EC', kid: 'broken' },
        key.jwk,
      ],
      now: () => NOW_MS,
    })
    const signedBy = async (pairKey: typeof pair.privateKey, kid: string) =>
      mintAccessToken({ kid, privateKey: pairKey, jwk: {} }, {})
    expect(await reasonOf(verifier, await signedBy(pair.privateKey, 'priv'))).toBe('unknown-kid')
    expect(await reasonOf(verifier, await mintAccessToken({ ...key2, kid: 'enc' }))).toBe(
      'unknown-kid',
    )
    await expect(verifier.verify(await mintAccessToken(key))).resolves.toBeDefined()
  })
})

describe('createTokenVerifier: provider unreachable', () => {
  it('answers keys-unavailable (a 503, not a 401) on a cold cache', async () => {
    const { verifier, resolver } = setup({})
    const token = await mintAccessToken(key)
    const error = await verifier.verify(token).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthError)
    expect((error as AuthError).reason).toBe('keys-unavailable')
    expect((error as AuthError).status).toBe(503)
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('retries after a few seconds, not on every request, and recovers', async () => {
    let up = false
    const { verifier, resolver, clock } = setup({ 'web-calendar': () => (up ? [key] : null) })
    const token = await mintAccessToken(key)
    expect(await reasonOf(verifier, token)).toBe('keys-unavailable')
    clock.ms += 1000
    expect(await reasonOf(verifier, token)).toBe('keys-unavailable')
    expect(resolver).toHaveBeenCalledTimes(1)
    up = true
    clock.ms += 5000
    await expect(verifier.verify(token)).resolves.toBeDefined()
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('keeps verifying with cached keys through an outage', async () => {
    let up = true
    const { verifier, resolver, clock } = setup({ 'web-calendar': () => (up ? [key] : null) })
    await verifier.verify(await mintAccessToken(key))
    up = false
    // An hour later the cache is stale: one background fetch fails, and the request is unaffected.
    clock.ms += 3_600_000
    await expect(
      verifier.verify(await mintAccessToken(key, { claims: { exp: NOW + 7200 } })),
    ).resolves.toBeDefined()
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2))
    // An unknown kid during the outage is a 503 and the cached keys stay in place.
    expect(await reasonOf(verifier, await mintAccessToken(key2))).toBe('keys-unavailable')
    await expect(
      verifier.verify(await mintAccessToken(key, { claims: { exp: NOW + 7200 } })),
    ).resolves.toBeDefined()
  })
})

describe('allowed clients from the configuration', () => {
  const issuer = 'https://idm.example.org/oauth2/openid/web-calendar'

  it('derives the issuer of another client by replacing the last path segment', () => {
    expect(deriveClientIssuer(issuer, 'other-app')).toBe(
      'https://idm.example.org/oauth2/openid/other-app',
    )
    expect(deriveClientIssuer(`${issuer}/`, 'other-app')).toBe(
      'https://idm.example.org/oauth2/openid/other-app',
    )
  })

  it('refuses issuers without a client segment and client ids that could escape the path', () => {
    expect(() => deriveClientIssuer('https://idm.example.org', 'x')).toThrow()
    expect(() => deriveClientIssuer('https://idm.example.org/', 'x')).toThrow()
    expect(() => deriveClientIssuer('not a url', 'x')).toThrow()
    expect(() => deriveClientIssuer(issuer, '../evil')).toThrow()
    expect(() => deriveClientIssuer(issuer, 'a/b')).toThrow()
    expect(() => deriveClientIssuer(issuer, '')).toThrow()
  })

  it('defaults to the app’s own client and lists the configured ones otherwise', () => {
    expect(buildAllowedClients({ issuer, clientId: 'web-calendar', allowedClients: '' })).toEqual([
      { clientId: 'web-calendar', issuer },
    ])
    expect(
      buildAllowedClients({
        issuer,
        clientId: 'web-calendar',
        allowedClients: ' web-calendar, other-app ,,web-calendar',
      }),
    ).toEqual([
      { clientId: 'web-calendar', issuer },
      { clientId: 'other-app', issuer: 'https://idm.example.org/oauth2/openid/other-app' },
    ])
  })
})
