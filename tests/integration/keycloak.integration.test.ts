// @vitest-environment node
//
// The token verifier against a real Keycloak (OIDC plan, WP6): real discovery, real RS256 keys, the
// real header and payload of its access, ID and refresh tokens, its group mapper in the token and in
// userinfo. The test makes two realms of its own in the throwaway Keycloak of dev/keycloak over the
// admin API (so nothing is imported or left behind: each run deletes and recreates them), signs in
// with the password grant, and checks what the production code (`fetchDiscovery`,
// `createTokenVerifier` with the real key fetcher, `authenticateRequest`, `fetchUserinfo`) does with
// the tokens. Skipped unless KEYCLOAK_URL is set:
//
//   docker compose -f dev/keycloak/compose.yml up -d
//   docker network connect webcal-keycloak-test <the dev container>
//   KEYCLOAK_URL=http://keycloak:8080 npx vitest run tests/integration/keycloak.integration.test.ts
//
// The realm is called `calendar`, not like the client: an issuer that ends with the client id looks
// like Kanidm's layout (one issuer per client) to `buildAllowedClients`.
import { decodeJwt, decodeProtectedHeader } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { authenticateRequest } from '../../server/utils/auth/authenticate'
import { buildAllowedClients } from '../../server/utils/auth/clients'
import { fetchDiscovery } from '../../server/utils/auth/discovery'
import { AuthError } from '../../server/utils/auth/errors'
import { createTokenVerifier, type TokenVerifier } from '../../server/utils/auth/jwt'
import { fetchUserinfo } from '../../server/utils/api/userinfo'

const BASE = (process.env.KEYCLOAK_URL ?? '').replace(/\/+$/, '')
const REALM = 'calendar'
const OTHER_REALM = 'elsewhere'
const ISSUER = `${BASE}/realms/${REALM}`
const OTHER_ISSUER = `${BASE}/realms/${OTHER_REALM}`
const OIDC = 'protocol/openid-connect'
const PASSWORD = 'correct horse battery staple'

interface Tokens {
  access_token: string
  id_token: string
  refresh_token: string
}

let adminToken = ''

/** The admin REST API; `path` is below /admin/realms. Returns the response (the id is in Location). */
async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${BASE}/admin/realms${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
    throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`)
  }
  return response
}

const idOf = (response: Response) => response.headers.get('location')!.split('/').at(-1)!

/** A realm with the scopes, the group mapper, two public clients, users and groups of the test. */
async function makeRealm(realm: string, groups: boolean): Promise<void> {
  await admin('DELETE', `/${realm}`)
  await admin('POST', '', { realm, enabled: true, sslRequired: 'none' })

  // `caldav` is what every access token must carry; `groups` holds the Group Membership mapper. Its
  // "Add to ..." switches are set explicitly; what a new mapper has by default was not checked.
  const caldav = idOf(
    await admin('POST', `/${realm}/client-scopes`, {
      name: 'caldav',
      protocol: 'openid-connect',
      attributes: { 'include.in.token.scope': 'true', 'display.on.consent.screen': 'false' },
    }),
  )
  const groupsScope = idOf(
    await admin('POST', `/${realm}/client-scopes`, {
      name: 'groups',
      protocol: 'openid-connect',
      attributes: { 'include.in.token.scope': 'true', 'display.on.consent.screen': 'false' },
    }),
  )
  await admin('POST', `/${realm}/client-scopes/${groupsScope}/protocol-mappers/models`, {
    name: 'groups',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-group-membership-mapper',
    config: {
      'claim.name': 'groups',
      'full.path': 'true',
      'id.token.claim': 'true',
      'access.token.claim': 'true',
      'userinfo.token.claim': 'true',
    },
  })

  for (const clientId of ['web-calendar', 'other-app']) {
    const client = idOf(
      await admin('POST', `/${realm}/clients`, {
        clientId,
        publicClient: true,
        standardFlowEnabled: true,
        // The test signs in with the password grant: a real login needs no browser this way.
        directAccessGrantsEnabled: true,
        redirectUris: ['http://localhost/*'],
        attributes: { 'pkce.code.challenge.method': 'S256' },
      }),
    )
    for (const scope of [caldav, groupsScope]) {
      await admin('PUT', `/${realm}/clients/${client}/default-client-scopes/${scope}`)
    }
  }

  if (groups) {
    const team = idOf(await admin('POST', `/${realm}/groups`, { name: 'team' }))
    const ops = idOf(await admin('POST', `/${realm}/groups/${team}/children`, { name: 'ops' }))
    const extra = idOf(await admin('POST', `/${realm}/groups`, { name: 'everyone-extra' }))
    for (const [username, group] of [
      ['alice', ops],
      ['bob', extra],
    ] as const) {
      const user = idOf(
        await admin('POST', `/${realm}/users`, {
          username,
          enabled: true,
          email: `${username}@example.test`,
          emailVerified: true,
          firstName: username,
          lastName: 'Example',
          credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
        }),
      )
      await admin('PUT', `/${realm}/users/${user}/groups/${group}`)
    }
  } else {
    await admin('POST', `/${realm}/users`, {
      username: 'alice',
      enabled: true,
      email: 'alice@elsewhere.test',
      emailVerified: true,
      firstName: 'Alice',
      lastName: 'Elsewhere',
      credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
    })
  }
}

async function signIn(realm: string, clientId: string, username: string): Promise<Tokens> {
  const response = await fetch(`${BASE}/realms/${realm}/${OIDC}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: clientId,
      username,
      password: PASSWORD,
      scope: 'openid',
    }),
  })
  if (!response.ok) throw new Error(`sign in answered ${response.status}: ${await response.text()}`)
  return (await response.json()) as Tokens
}

async function reasonOf(verifier: TokenVerifier, token: string): Promise<string> {
  try {
    await verifier.verify(token)
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError)
    return (error as AuthError).reason
  }
  throw new Error('token was accepted')
}

describe.skipIf(!BASE)('the token verifier against Keycloak', () => {
  let alice: Tokens
  let bob: Tokens
  let aliceOther: Tokens
  let aliceOtherRealm: Tokens
  let verifier: TokenVerifier

  beforeAll(async () => {
    const response = await fetch(`${BASE}/realms/master/${OIDC}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'admin',
        password: 'admin',
      }),
    })
    adminToken = ((await response.json()) as { access_token: string }).access_token
    await makeRealm(REALM, true)
    await makeRealm(OTHER_REALM, false)
    alice = await signIn(REALM, 'web-calendar', 'alice')
    bob = await signIn(REALM, 'web-calendar', 'bob')
    aliceOther = await signIn(REALM, 'other-app', 'alice')
    aliceOtherRealm = await signIn(OTHER_REALM, 'web-calendar', 'alice')
    verifier = createTokenVerifier({
      clients: buildAllowedClients({
        issuer: ISSUER,
        clientId: 'web-calendar',
        allowedClients: '',
      }),
      requiredScope: 'caldav',
    })
  }, 120_000)

  it('publishes a discovery document the app accepts, with RSA signing keys', async () => {
    await expect(fetchDiscovery(ISSUER)).resolves.toEqual({
      issuer: ISSUER,
      jwksUri: `${ISSUER}/${OIDC}/certs`,
      userinfoEndpoint: `${ISSUER}/${OIDC}/userinfo`,
    })
    const keys = (
      (await (await fetch(`${ISSUER}/${OIDC}/certs`)).json()) as {
        keys: { alg?: string; use?: string; kty: string }[]
      }
    ).keys
    expect(keys.some((key) => key.kty === 'RSA' && key.use === 'sig' && key.alg === 'RS256')).toBe(
      true,
    )
  })

  it('writes the access token the way the plan says', () => {
    const header = decodeProtectedHeader(alice.access_token)
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' })
    expect(typeof header.kid).toBe('string')
    const payload = decodeJwt(alice.access_token) as Record<string, unknown>
    expect(payload).toMatchObject({ iss: ISSUER, typ: 'Bearer', azp: 'web-calendar' })
    expect(String(payload.scope).split(' ')).toEqual(expect.arrayContaining(['openid', 'caldav']))
    // No `client_id` in a user's token, and `aud` is not the client: the client is bound by `azp`.
    expect(payload.client_id).toBeUndefined()
    expect([payload.aud].flat()).not.toContain('web-calendar')
    expect(payload.groups).toEqual(['/team/ops'])
  })

  it('tags the other tokens it signs with the same keys', () => {
    expect(decodeProtectedHeader(alice.id_token)).toMatchObject({ alg: 'RS256', typ: 'JWT' })
    expect(decodeJwt(alice.id_token)).toMatchObject({ typ: 'ID', azp: 'web-calendar' })
    // The refresh token carries the client and the scope too, but Keycloak signs it with the realm's
    // secret (HS512), which no published key can check: it never gets as far as its payload.
    expect(decodeJwt(alice.refresh_token)).toMatchObject({ typ: 'Refresh', azp: 'web-calendar' })
    expect(decodeProtectedHeader(alice.refresh_token).alg).toBe('HS512')
  })

  it('accepts the access token and says who and which client it is', async () => {
    const verified = await verifier.verify(alice.access_token)
    expect(verified).toMatchObject({
      sub: decodeJwt(alice.access_token).sub,
      clientId: 'web-calendar',
    })
    expect(verified.scopes).toContain('caldav')
    const bearer = { authorization: `Bearer ${alice.access_token}` }
    await expect(authenticateRequest(new Headers(bearer), { verifier })).resolves.toEqual({
      sub: verified.sub,
      via: 'bearer',
    })
  })

  it('refuses its ID token, its refresh token and a changed token', async () => {
    expect(await reasonOf(verifier, alice.id_token)).toBe('wrong-typ')
    expect(await reasonOf(verifier, alice.refresh_token)).toBe('wrong-alg')
    const [header, payload, signature] = alice.access_token.split('.')
    const forged = Buffer.from(
      JSON.stringify({ ...decodeJwt(alice.access_token), sub: 'someone-else' }),
    ).toString('base64url')
    expect(await reasonOf(verifier, `${header}.${forged}.${signature}`)).toBe('bad-signature')
    expect(payload).not.toBe(forged)
    await expect(
      authenticateRequest(new Headers({ authorization: `Bearer ${alice.id_token}` }), { verifier }),
    ).rejects.toMatchObject({ reason: 'wrong-typ', status: 401 })
  })

  it('refuses the token of another client in the same realm, until that client is allowed', async () => {
    expect(await reasonOf(verifier, aliceOther.access_token)).toBe('wrong-audience')
    // Both clients share the realm's issuer; the claims tell them apart and not their identity.
    const both = createTokenVerifier({
      clients: buildAllowedClients({
        issuer: ISSUER,
        clientId: 'web-calendar',
        allowedClients: 'web-calendar,other-app',
      }),
      requiredScope: 'caldav',
    })
    await expect(both.verify(aliceOther.access_token)).resolves.toMatchObject({
      clientId: 'other-app',
    })
    await expect(both.verify(alice.access_token)).resolves.toMatchObject({
      clientId: 'web-calendar',
    })
    expect((await both.verify(aliceOther.access_token)).sub).toBe(
      (await both.verify(alice.access_token)).sub,
    )
  })

  it('refuses the token of another realm', async () => {
    expect(decodeJwt(aliceOtherRealm.access_token).iss).toBe(OTHER_ISSUER)
    expect(await reasonOf(verifier, aliceOtherRealm.access_token)).toBe('client-not-allowed')
  })

  it('answers userinfo at the endpoint of the discovery document, with the groups as paths', async () => {
    const { userinfoEndpoint } = await fetchDiscovery(ISSUER)
    const sub = decodeJwt(alice.access_token).sub!
    const result = await fetchUserinfo({
      endpoint: userinfoEndpoint,
      accessToken: alice.access_token,
      expectedSub: sub,
      fetch,
    })
    expect(result).toMatchObject({
      ok: true,
      profile: { sub, username: 'alice', groups: ['/team/ops'] },
    })
    // Bob is in another group; the userinfo of the token's own subject only.
    const other = await fetchUserinfo({
      endpoint: userinfoEndpoint,
      accessToken: bob.access_token,
      expectedSub: sub,
      fetch,
    })
    expect(other).toEqual({ ok: false, reason: 'sub-mismatch' })
  })
})
