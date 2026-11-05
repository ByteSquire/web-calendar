// A stand-in for Kanidm's OAuth2 client endpoints, for the gateway tests against the production
// build (scripts/test-gateway-prod.mjs): the discovery document, the signing keys at
// `<issuer>/public_key.jwk`, `userinfo`, and access tokens it signs itself. The keys are generated
// per run, so a token only works for the run that made it. Plain HTTP on the loopback interface: the
// server under test requires https only of an https issuer.
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

/**
 * @typedef {{ sub: string, username: string, name: string, email: string, groups: string[] }}
 *   FakeUser
 */

/**
 * @param {{ clientId?: string, users?: string[] }} [options] `users` are the short names to make
 *   users of, each with a random `sub`
 */
export async function startFakeIdp(options = {}) {
  const clientId = options.clientId ?? 'web-calendar'
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  // Same shape and field order as Kanidm's JWKS (tests/server/auth-kanidm-fixture.json).
  const kid = randomBytes(6).toString('hex')
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid }

  /** @type {Record<string, FakeUser>} */
  const users = {}
  for (const username of options.users ?? ['alice', 'bob']) {
    users[username] = {
      sub: randomUUID(),
      username,
      name: `${username[0]?.toUpperCase()}${username.slice(1)} Example`,
      email: `${username}@example.test`,
      groups: ['web_calendar_users'],
    }
  }
  const bySub = new Map(Object.values(users).map((user) => [user.sub, user]))

  const base = `/oauth2/openid/${clientId}`
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]
    if (request.method === 'GET' && path === `${base}/.well-known/openid-configuration`) {
      // What Kanidm publishes per client (checked against a real one): the issuer is the client's.
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/public_key.jwk`,
          userinfo_endpoint: `${issuer}/userinfo`,
        }),
      )
      return
    }
    if (request.method === 'GET' && path === `${base}/public_key.jwk`) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ keys: [jwk] }))
      return
    }
    if (request.method === 'GET' && path === `${base}/userinfo`) {
      // Only a token this IdP signed gets an answer, and only about its own subject.
      const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
      let sub = ''
      try {
        sub = String(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).sub)
      } catch {
        // Not a JWT: no answer below.
      }
      const user = bySub.get(sub)
      if (!user) {
        response.writeHead(401).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          sub: user.sub,
          preferred_username: user.username,
          name: user.name,
          email: user.email,
          groups: user.groups,
        }),
      )
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  const issuer = `http://127.0.0.1:${address.port}${base}`

  /**
   * A token shaped like the ones Kanidm issues (tests/server/auth-fixtures.ts, checked against a
   * real one): `at+jwt`, `aud` and `client_id` the client, 900 s, scope `caldav` among others.
   * @param {FakeUser} user
   * @param {{ idToken?: boolean }} [tokenOptions] an ID token is shaped like Kanidm's (checked
   *   against a real one): no `typ`, `azp` instead of `client_id`, and `scopes` instead of `scope`
   */
  async function mint(user, tokenOptions = {}) {
    const now = Math.floor(Date.now() / 1000)
    const common = {
      iss: issuer,
      sub: user.sub,
      aud: clientId,
      exp: now + 900,
      nbf: now,
      iat: now,
      jti: randomUUID(),
      auth_time: now,
    }
    const scopes = ['caldav', 'email', 'groups', 'openid', 'profile']
    if (tokenOptions.idToken) {
      return new SignJWT({ ...common, azp: clientId, scopes, email: user.email })
        .setProtectedHeader({ alg: 'ES256', kid })
        .sign(privateKey)
    }
    return new SignJWT({ ...common, client_id: clientId, scope: scopes.join(' ') })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
      .sign(privateKey)
  }

  return {
    issuer,
    clientId,
    kid,
    users,
    mint,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}
