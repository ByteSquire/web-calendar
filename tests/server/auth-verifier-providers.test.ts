// @vitest-environment node
import { SignJWT, base64url, exportJWK, generateKeyPair, type JWK } from 'jose'
import { createHmac } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AllowedClient } from '../../server/utils/auth/clients'
import { AuthError, type AuthFailureReason } from '../../server/utils/auth/errors'
import {
  createTokenVerifier,
  type KeyResolver,
  type TokenVerifier,
} from '../../server/utils/auth/jwt'
import {
  CLIENT,
  NOW,
  NOW_MS,
  makeKey,
  mintAccessToken,
  type MintOptions,
  type TestKey,
} from './auth-fixtures'

// The verifier is not Kanidm's alone: it takes the access tokens of the providers listed in the OIDC
// plan (section 8.3) and refuses what is not one. The token shapes below follow those findings;
// none was produced by a live provider except Kanidm's (auth-jwt.test.ts).

const ALGS = [
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
]

function verifierFor(
  keys: readonly (TestKey | JWK)[],
  extra: { clients?: AllowedClient[]; audiences?: string[]; resolver?: KeyResolver } = {},
): TokenVerifier {
  return createTokenVerifier({
    clients: extra.clients ?? [CLIENT],
    audiences: extra.audiences,
    requiredScope: 'caldav',
    keyResolver:
      extra.resolver ?? (async () => keys.map((k) => ('privateKey' in k ? (k as TestKey).jwk : k))),
    now: () => NOW_MS,
  })
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

let key: TestKey
beforeAll(async () => {
  key = await makeKey('k1')
})

describe('every accepted signature algorithm', () => {
  it.each(ALGS)('verifies %s, with the key published without an alg', async (alg) => {
    const signer = await makeKey(`k-${alg}`, alg, false)
    const verifier = verifierFor([signer])
    await expect(verifier.verify(await mintAccessToken(signer))).resolves.toMatchObject({
      clientId: 'web-calendar',
    })
  })

  it.each(ALGS)('verifies %s, with the key published labelled with it', async (alg) => {
    const signer = await makeKey(`k-${alg}`, alg, true)
    const verifier = verifierFor([signer])
    await expect(verifier.verify(await mintAccessToken(signer))).resolves.toBeDefined()
  })

  it('lets one unlabelled RSA key verify both RS and PS, and a labelled one only its own', async () => {
    const rs = await makeKey('rsa', 'RS256', false)
    const verifier = verifierFor([rs])
    // Same key material, signed as PS256 with a key made for it.
    const ps = await generateKeyPair('PS256', { extractable: true })
    const published = { ...(await exportJWK(ps.publicKey)), kid: 'rsa-ps' }
    const psToken = await mintAccessToken({
      kid: 'rsa-ps',
      privateKey: ps.privateKey,
      jwk: {},
      alg: 'PS256',
    })
    expect(await reasonOf(verifier, psToken)).toBe('unknown-kid')
    await expect(verifierFor([published]).verify(psToken)).resolves.toBeDefined()
    // Labelled RS256: a PS256 token under the same kid is refused before the signature is read.
    const labelled = { ...published, alg: 'RS256' }
    expect(await reasonOf(verifierFor([labelled]), psToken)).toBe('wrong-alg')
  })

  it('verifies a token of every key family out of one key set', async () => {
    // A provider with several signing algorithms publishes their keys side by side.
    const signers = await Promise.all([
      makeKey('ec256', 'ES256'),
      makeKey('ec512', 'ES512'),
      makeKey('ed', 'EdDSA'),
      makeKey('rs', 'RS256', false),
      makeKey('ps', 'PS384', true),
    ])
    const verifier = verifierFor(signers)
    for (const signer of signers) {
      await expect(
        verifier.verify(await mintAccessToken(signer)),
        signer.kid,
      ).resolves.toMatchObject({ clientId: 'web-calendar' })
    }
  })

  it('uses the first of two keys that share a kid, and refuses a token of the other', async () => {
    // Providers should not do this; what happens is pinned here so that nobody is surprised.
    const first = await makeKey('same', 'RS256', false)
    const second = await makeKey('same', 'ES256')
    const verifier = verifierFor([first, second])
    await expect(verifier.verify(await mintAccessToken(first))).resolves.toBeDefined()
    expect(await reasonOf(verifier, await mintAccessToken(second))).toBe('wrong-alg')
  })
})

describe('the key type limits the algorithm (algorithm confusion)', () => {
  async function signedAs(alg: string, kid: string): Promise<string> {
    return mintAccessToken(await makeKey(kid, alg))
  }

  it('refuses another family under the kid of a published key', async () => {
    const rsa = await makeKey('rsa', 'RS256', false)
    const ec = await makeKey('ec', 'ES256')
    const okp = await makeKey('okp', 'EdDSA')
    const verifier = verifierFor([rsa, ec, okp])
    // The attacker signs with a key of his own and names the kid of ours: the algorithm gives it away.
    expect(await reasonOf(verifier, await signedAs('ES256', 'rsa'))).toBe('wrong-alg')
    expect(await reasonOf(verifier, await signedAs('EdDSA', 'rsa'))).toBe('wrong-alg')
    expect(await reasonOf(verifier, await signedAs('RS256', 'ec'))).toBe('wrong-alg')
    expect(await reasonOf(verifier, await signedAs('ES384', 'ec'))).toBe('wrong-alg')
    expect(await reasonOf(verifier, await signedAs('ES512', 'ec'))).toBe('wrong-alg')
    expect(await reasonOf(verifier, await signedAs('RS256', 'okp'))).toBe('wrong-alg')
    expect(await reasonOf(verifier, await signedAs('ES256', 'okp'))).toBe('wrong-alg')
  })

  it('refuses HS256 keyed with the public RSA key, and alg none, without asking for keys', async () => {
    const rsa = await makeKey('rsa', 'RS256', false)
    const resolver = vi.fn<KeyResolver>(async () => [rsa.jwk])
    const verifier = verifierFor([], { resolver })
    const claims = {
      iss: CLIENT.issuer,
      sub: 'x',
      aud: 'web-calendar',
      exp: NOW + 900,
      scope: 'caldav',
    }
    const secret = new TextEncoder().encode(JSON.stringify(rsa.jwk))
    const hs256 = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', kid: 'rsa' })
      .sign(secret)
    expect(await reasonOf(verifier, hs256)).toBe('wrong-alg')
    const header = base64url.encode(JSON.stringify({ alg: 'HS512', kid: 'rsa' }))
    const payload = base64url.encode(JSON.stringify(claims))
    const mac = createHmac('sha512', JSON.stringify(rsa.jwk))
      .update(`${header}.${payload}`)
      .digest()
    expect(await reasonOf(verifier, `${header}.${payload}.${base64url.encode(mac)}`)).toBe(
      'wrong-alg',
    )
    const none = `${base64url.encode(JSON.stringify({ alg: 'none', kid: 'rsa' }))}.${payload}.`
    expect(await reasonOf(verifier, none)).toBe('wrong-alg')
    expect(resolver).not.toHaveBeenCalled()
  })
})

describe('which published keys are used', () => {
  // WebCrypto directly: the signing library refuses to generate a key as weak as 1024 bits.
  async function rsaKey(kid: string, modulusLength: number): Promise<TestKey> {
    const pair = await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    return {
      kid,
      alg: 'RS256',
      privateKey: pair.privateKey,
      jwk: {
        ...(await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey)),
        kid,
        use: 'sig',
      },
    }
  }

  it('takes an RSA key of 2048 bits and refuses one of 1024', async () => {
    const strong = await rsaKey('strong', 2048)
    const weak = await rsaKey('weak', 1024)
    const verifier = verifierFor([key, strong, weak])
    await expect(verifier.verify(await mintAccessToken(strong))).resolves.toBeDefined()
    // Signed by hand: the signing library refuses a key this weak. The signature is valid; the key is not used.
    const encode = (value: unknown) => base64url.encode(JSON.stringify(value))
    const signingInput = `${encode({ alg: 'RS256', kid: 'weak', typ: 'at+jwt' })}.${encode({
      iss: CLIENT.issuer,
      sub: 'x',
      aud: 'web-calendar',
      client_id: 'web-calendar',
      exp: NOW + 900,
      scope: 'caldav',
    })}`
    const signature = await globalThis.crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      weak.privateKey,
      new TextEncoder().encode(signingInput),
    )
    const token = `${signingInput}.${base64url.encode(new Uint8Array(signature))}`
    expect(await reasonOf(verifier, token)).toBe('unknown-kid')
  })

  it('skips private keys, encryption keys, keys for another algorithm and keys of other types', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    // A curve we do not accept; the key is refused by its curve, before any import.
    const ed448: JWK = { kty: 'OKP', crv: 'Ed448', x: base64url.encode(new Uint8Array(57)) }
    const rsa = await generateKeyPair('RS256', { extractable: true })
    const jwks: JWK[] = [
      { ...(await exportJWK(pair.privateKey)), kid: 'private', use: 'sig' },
      { ...key.jwk, kid: 'encryption', use: 'enc' },
      { ...(await exportJWK(rsa.publicKey)), kid: 'oaep', alg: 'RSA-OAEP' },
      { ...(await exportJWK(rsa.publicKey)), kid: 'labelled-hs', alg: 'HS256' },
      { ...ed448, kid: 'ed448' },
      { kty: 'oct', kid: 'secret', k: base64url.encode('s3cret') },
      { ...(await exportJWK(rsa.publicKey)), kid: '' },
      { ...(await exportJWK(rsa.publicKey)) },
      key.jwk,
    ]
    const verifier = verifierFor(jwks)
    for (const kid of ['private', 'encryption', 'oaep', 'labelled-hs', 'ed448', 'secret']) {
      expect(await reasonOf(verifier, await mintAccessToken({ ...key, kid })), kid).toBe(
        'unknown-kid',
      )
    }
    await expect(verifier.verify(await mintAccessToken(key))).resolves.toBeDefined()
  })

  it('refuses a key set with no usable key as a broken answer (a 503, not a 401)', async () => {
    const verifier = verifierFor([{ kty: 'oct', kid: 'secret', k: 'abc' }])
    expect(await reasonOf(verifier, await mintAccessToken(key))).toBe('keys-unavailable')
  })
})

/** Header and claims as a provider writes them, over the Kanidm-shaped defaults of the fixtures. */
const SHAPES: Record<string, MintOptions> = {
  // Realm issuer; `aud` is `account`; the client is `azp`; payload typ Bearer; header JWT.
  keycloak: {
    header: { typ: 'JWT' },
    claims: { aud: 'account', client_id: undefined, azp: 'web-calendar', typ: 'Bearer' },
  },
  keycloakArray: {
    header: { typ: 'JWT' },
    claims: { aud: ['account', 'other'], client_id: undefined, azp: 'web-calendar', typ: 'bearer' },
  },
  // Custom authorization server: `cid`, `aud` is the server's audience, `scp` is an array.
  okta: {
    header: { typ: undefined },
    claims: {
      aud: 'api://default',
      client_id: undefined,
      cid: 'web-calendar',
      scope: undefined,
      scp: ['openid', 'caldav'],
    },
  },
  // v2.0: `azp` is the client, `aud` the API's client id, `scp` a space-separated string.
  entraV2: {
    header: { typ: 'JWT' },
    claims: {
      aud: '6f1c2b0e-4d51-4c7e-9a52-0b6f3c1d2e77',
      client_id: undefined,
      azp: 'web-calendar',
      scope: undefined,
      scp: 'caldav access_as_user',
      ver: '2.0',
    },
  },
  entraV1: {
    header: { typ: 'JWT' },
    claims: {
      aud: 'api://6f1c2b0e',
      client_id: undefined,
      appid: 'web-calendar',
      scope: undefined,
      scp: 'caldav',
      ver: '1.0',
    },
  },
  // Always a JWT, `client_id` and `token_use`, no `aud` without a resource binding.
  cognito: {
    header: { typ: undefined },
    claims: {
      aud: undefined,
      client_id: 'web-calendar',
      token_use: 'access',
      scope: 'openid caldav',
    },
  },
  // RFC 9068 profile: `client_id`, no default audience, `scp` array.
  authelia: {
    header: { typ: 'at+jwt' },
    claims: {
      aud: undefined,
      client_id: 'web-calendar',
      scope: undefined,
      scp: ['caldav', 'openid'],
    },
  },
  authentik: {
    header: { typ: 'JWT' },
    claims: {
      aud: 'web-calendar',
      client_id: undefined,
      azp: 'web-calendar',
      scope: 'openid caldav',
    },
  },
  auth0: {
    header: { typ: 'JWT' },
    claims: {
      aud: ['https://calendar.example/api', 'https://tenant.auth0.example/userinfo'],
      client_id: undefined,
      azp: 'web-calendar',
      scope: 'openid caldav',
    },
  },
}

describe('access tokens of other providers', () => {
  it.each(Object.keys(SHAPES))('takes the %s shape', async (name) => {
    const verifier = verifierFor([key])
    const result = await verifier.verify(await mintAccessToken(key, SHAPES[name]))
    expect(result).toMatchObject({ clientId: 'web-calendar' })
    expect(result.scopes).toContain('caldav')
  })

  it('refuses the Keycloak token of another client in the same realm', async () => {
    const verifier = verifierFor([key])
    const other = mintAccessToken(key, {
      header: { typ: 'JWT' },
      claims: { aud: 'account', client_id: undefined, azp: 'other-app', typ: 'Bearer' },
    })
    expect(await reasonOf(verifier, await other)).toBe('wrong-audience')
  })

  it('takes a token made for the API only when the API identifier is configured', async () => {
    const forApi = await mintAccessToken(key, {
      claims: { aud: 'https://calendar.example/api', client_id: undefined },
    })
    expect(await reasonOf(verifierFor([key]), forApi)).toBe('wrong-audience')
    const configured = verifierFor([key], { audiences: ['https://calendar.example/api'] })
    await expect(configured.verify(forApi)).resolves.toMatchObject({ clientId: 'web-calendar' })
    // Another identifier is no help, and an audience does not make a token without a scope pass.
    expect(
      await reasonOf(
        configured,
        await mintAccessToken(key, {
          claims: { aud: 'https://other.example', client_id: undefined },
        }),
      ),
    ).toBe('wrong-audience')
    expect(
      await reasonOf(
        configured,
        await mintAccessToken(key, {
          claims: { aud: 'https://calendar.example/api', client_id: undefined, scope: 'openid' },
        }),
      ),
    ).toBe('missing-scope')
  })
})

describe('tokens that are not access tokens', () => {
  const idToken = (claims: Record<string, unknown>) => ({
    header: { typ: undefined },
    claims: { client_id: undefined, scope: undefined, ...claims },
  })

  it.each([
    ['a Keycloak ID token', { aud: 'web-calendar', azp: 'web-calendar', typ: 'ID' }, 'wrong-typ'],
    [
      'a Keycloak refresh token',
      { aud: 'web-calendar', azp: 'web-calendar', typ: 'Refresh', scope: 'caldav' },
      'wrong-typ',
    ],
    [
      'a Keycloak offline token',
      { azp: 'web-calendar', typ: 'Offline', scope: 'caldav' },
      'wrong-typ',
    ],
    [
      'a Keycloak logout token',
      { azp: 'web-calendar', typ: 'Logout', scope: 'caldav' },
      'wrong-typ',
    ],
    [
      'a typ that is not a string',
      { azp: 'web-calendar', typ: ['Bearer'], scope: 'caldav' },
      'wrong-typ',
    ],
    ['a Cognito ID token', { aud: 'web-calendar', token_use: 'id' }, 'wrong-typ'],
    [
      'a Cognito token of an unknown use',
      { client_id: 'web-calendar', token_use: 'refresh', scope: 'caldav' },
      'wrong-typ',
    ],
    // No marker at all: the scope is what is missing. Kanidm's ID token has `scopes`, not `scope`.
    [
      'an ID token with aud and azp of the client',
      { aud: 'web-calendar', azp: 'web-calendar', scopes: ['caldav'] },
      'missing-scope',
    ],
    [
      'a Dex-style token (nonce, at_hash)',
      { aud: 'web-calendar', nonce: 'n', at_hash: 'h', email: 'a@b.test' },
      'missing-scope',
    ],
  ])('refuses %s', async (_name, claims, reason) => {
    const verifier = verifierFor([key])
    const token = await mintAccessToken(key, idToken(claims as Record<string, unknown>))
    expect(await reasonOf(verifier, token)).toBe(reason)
  })
})

describe('scope forms', () => {
  const withScope = (claims: Record<string, unknown>) =>
    mintAccessToken(key, { claims: { scope: undefined, ...claims } })

  it('reads a string in scope, and a string or an array in scp', async () => {
    const verifier = verifierFor([key])
    for (const claims of [
      { scope: 'openid caldav' },
      { scp: 'openid caldav' },
      { scp: ['openid', 'caldav'] },
      { scp: ['openid caldav'] },
    ]) {
      await expect(
        verifier.verify(await withScope(claims)),
        JSON.stringify(claims),
      ).resolves.toBeDefined()
    }
  })

  it('refuses everything else', async () => {
    const verifier = verifierFor([key])
    for (const claims of [
      {},
      { scope: ['caldav'] },
      { scp: [1, 'caldav'] },
      { scp: { caldav: true } },
      { scp: 'caldavx' },
      // `scope` wins when it is there: a token cannot add the scope through the other claim.
      { scope: 'openid', scp: ['caldav'] },
    ]) {
      expect(await reasonOf(verifier, await withScope(claims)), JSON.stringify(claims)).toBe(
        'missing-scope',
      )
    }
  })
})

describe('issuers that clients share, and issuers with a trailing slash', () => {
  const SHARED = 'https://keycloak.example.test/realms/team'
  const A: AllowedClient = { clientId: 'app-a', issuer: SHARED }
  const B: AllowedClient = { clientId: 'app-b', issuer: SHARED }

  it('fetches the keys once for all clients of an issuer and tells the clients apart by claim', async () => {
    const resolver = vi.fn<KeyResolver>(async () => [key.jwk])
    const verifier = verifierFor([], { clients: [A, B], resolver })
    const token = (claims: Record<string, unknown>) =>
      mintAccessToken(key, {
        client: A,
        claims: { aud: 'account', client_id: undefined, sub: 'someone', ...claims },
      })
    const a = await verifier.verify(await token({ azp: 'app-a' }))
    const b = await verifier.verify(await token({ azp: 'app-b' }))
    expect([a.clientId, b.clientId, a.sub, b.sub]).toEqual(['app-a', 'app-b', 'someone', 'someone'])
    // A token of a third client of the realm is refused, and a claim naming both picks the first.
    expect(await reasonOf(verifier, await token({ azp: 'app-c' }))).toBe('wrong-audience')
    expect((await verifier.verify(await token({ azp: 'app-b', aud: ['app-a'] }))).clientId).toBe(
      'app-b',
    )
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('keeps one cache per issuer: a key of one realm does not verify a token of another', async () => {
    const other = await makeKey('o1')
    const C: AllowedClient = {
      clientId: 'app-c',
      issuer: 'https://keycloak.example.test/realms/other',
    }
    const verifier = verifierFor([], {
      clients: [A, C],
      resolver: async (client) => [(client.issuer === SHARED ? key : other).jwk],
    })
    await expect(verifier.verify(await mintAccessToken(key, { client: A }))).resolves.toBeDefined()
    await expect(
      verifier.verify(await mintAccessToken(other, { client: C })),
    ).resolves.toBeDefined()
    // Realm "other" signed it, but it claims the issuer of realm "team".
    expect(
      await reasonOf(verifier, await mintAccessToken(other, { client: A, header: { kid: 'o1' } })),
    ).toBe('unknown-kid')
  })

  it('compares the issuer character by character, a trailing slash included', async () => {
    const auth0: AllowedClient = {
      clientId: 'web-calendar',
      issuer: 'https://tenant.auth0.example/',
    }
    const verifier = verifierFor([key], { clients: [auth0] })
    await expect(
      verifier.verify(await mintAccessToken(key, { client: auth0 })),
    ).resolves.toBeDefined()
    const noSlash = await mintAccessToken(key, {
      client: auth0,
      claims: { iss: 'https://tenant.auth0.example' },
    })
    expect(await reasonOf(verifier, noSlash)).toBe('client-not-allowed')
  })
})
