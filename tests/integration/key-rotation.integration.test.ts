// @vitest-environment node
//
// A real rotation of an OAuth2 client's signing key in Kanidm, and what the token verifier of the
// gateway does with it (design §6; security review test gap 12, until now unit-tested only): a key
// Kanidm adds is picked up from the unknown `kid` of the first token that uses it, a key it REVOKES
// is trusted until the cached keys are fetched again (`oidc.keyMaxAgeSec`,
// NUXT_OIDC_KEY_MAX_AGE_SEC) and not after, and a token signed by the retired key is then refused
// with a 401. The verifier is the production one (`createTokenVerifier` with the real key fetcher
// and `authenticateRequest`), with the age set to seconds instead of an hour. Skipped unless
// KEY_ROTATION_IT=1.
//
// Kanidm can rotate keys in two ways: `rotate-cryptographic-keys` adds a key and leaves the old one
// published ("past signatures will continue to operate"), `revoke-cryptographic-key <kid>` removes
// one at once. Only a revocation produces a retired key, so the test does both.
//
// Do NOT run this against the `web-calendar` client: revoking its key signs out every user of the
// stack, the live browser tests included. It uses a throwaway client of its own, created once:
//
//   cd dev/spike-s1
//   ./spike.sh kanidm system oauth2 create-public wcal-keytest 'Key rotation test' http://localhost:3999
//   ./spike.sh kanidm system oauth2 add-redirect-url wcal-keytest http://localhost:3999/callback
//   ./spike.sh kanidm system oauth2 enable-localhost-redirects wcal-keytest
//   ./spike.sh kanidm system oauth2 update-scope-map wcal-keytest web_calendar_users openid profile email caldav
//   ./spike.sh kanidm system oauth2 prefer-short-username wcal-keytest
//
// Run it in the dev container (it has no docker, so the test talks to Kanidm's REST API itself: the
// admin session is the one `idm_admin` password of dev/spike-s1/.local/secrets.env, and the tokens
// come from dev/spike-s1/tools/spike_client.py, which needs python3):
//
//   NODE_EXTRA_CA_CERTS=$PWD/dev/spike-s1/.local/certs/ca.crt KEY_ROTATION_IT=1 \
//     npx vitest run tests/integration/key-rotation.integration.test.ts
//
// Optional: KEY_ROTATION_CLIENT (default wcal-keytest), KEY_ROTATION_MAX_AGE_SEC (default 15, the
// time the test waits for the refresh; it is the test's `keyMaxAgeSec`). Takes about 20 seconds.
// Every run rotates and revokes the client's keys once more.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { decodeProtectedHeader } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { AuthError } from '../../server/utils/auth/errors'
import { authenticateRequest } from '../../server/utils/auth/authenticate'
import { createTokenVerifier, type TokenVerifier } from '../../server/utils/auth/jwt'

const enabled = process.env.KEY_ROTATION_IT === '1'
const IDM = 'https://idm.localhost:8443'
const CLIENT = process.env.KEY_ROTATION_CLIENT ?? 'wcal-keytest'
const REDIRECT = 'http://localhost:3999/callback'
const KEY_MAX_AGE_SEC = Number(process.env.KEY_ROTATION_MAX_AGE_SEC ?? 15)
const KEY_COOLDOWN_SEC = 1
const stack = resolve('dev/spike-s1')

/** A value of the test stack's secrets file (shell syntax, read the way spike.sh reads it). */
function secret(name: string): string {
  const value = execFileSync('sh', ['-c', `. "$SECRETS_FILE" && printf %s "\${${name}:-}"`], {
    env: { PATH: process.env.PATH ?? '', SECRETS_FILE: `${stack}/.local/secrets.env` },
    encoding: 'utf8',
  })
  if (!value) throw new Error(`${name} is not set in dev/spike-s1/.local/secrets.env`)
  return value
}

/** An access token of alice for the throwaway client, through the browserless login flow. */
function loginAlice(): string {
  const response = execFileSync(
    'python3',
    [
      `${stack}/tools/spike_client.py`,
      'token',
      ...['--idm', IDM, '--ca', `${stack}/.local/certs/ca.crt`, '--client', CLIENT],
      ...['--redirect', REDIRECT, '--scope', 'openid caldav', '--user', 'alice'],
      ...['--password', secret('ALICE_PASSWORD')],
    ],
    { encoding: 'utf8' },
  )
  return (JSON.parse(response) as { access_token: string }).access_token
}

/** A privileged idm_admin session over Kanidm's REST API, and what the test does with it. */
async function adminSession() {
  const post = async (body: unknown, session?: string) => {
    const response = await fetch(`${IDM}/v1/auth`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(session ? { 'x-kanidm-auth-session-id': session } : {}),
      },
      body: JSON.stringify(body),
    })
    return {
      session: response.headers.get('x-kanidm-auth-session-id') ?? undefined,
      body: (await response.json().catch(() => null)) as { state?: { success?: string } } | null,
    }
  }
  const init = await post({
    step: { init2: { username: 'idm_admin', issue: 'token', privileged: true } },
  })
  await post({ step: { begin: 'password' } }, init.session)
  const done = await post(
    { step: { cred: { password: secret('KANIDM_IDM_ADMIN_PASSWORD') } } },
    init.session,
  )
  const token = done.body?.state?.success
  if (!token) throw new Error('the idm_admin login did not succeed')

  /** Sets attributes of the throwaway client; a key action is an attribute with a value. */
  return async (attrs: Record<string, string[]>) => {
    const response = await fetch(`${IDM}/v1/oauth2/${CLIENT}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ attrs }),
    })
    if (!response.ok) throw new Error(`PATCH ${CLIENT} answered ${response.status}`)
  }
}

/** The key ids the client publishes now. */
async function publishedKids(): Promise<string[]> {
  const response = await fetch(`${IDM}/oauth2/openid/${CLIENT}/public_key.jwk`)
  return ((await response.json()) as { keys: { kid: string }[] }).keys.map((key) => key.kid)
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const kidOf = (token: string) => decodeProtectedHeader(token).kid!

describe.skipIf(!enabled)('key rotation against Kanidm', () => {
  let verifier: TokenVerifier
  let patchClient: Awaited<ReturnType<typeof adminSession>>
  let oldToken = ''
  let oldKid = ''
  let newToken = ''
  /** When the verifier last fetched the keys successfully, as far as the test can tell. */
  let fetchedAt = 0

  beforeAll(async () => {
    // Without the test CA the key fetch fails with a TLS error that does not say why.
    await publishedKids().catch((error) => {
      throw new Error(
        `cannot reach ${IDM} (set NODE_EXTRA_CA_CERTS to dev/spike-s1/.local/certs/ca.crt): ${error}`,
      )
    })
    patchClient = await adminSession()
    verifier = createTokenVerifier({
      clients: [{ clientId: CLIENT, issuer: `${IDM}/oauth2/openid/${CLIENT}` }],
      requiredScope: 'caldav',
      keyMaxAgeSec: KEY_MAX_AGE_SEC,
      keyCooldownSec: KEY_COOLDOWN_SEC,
      log: (message) => console.warn(`[auth] ${message}`),
    })
  })

  const reasonOf = async (token: string) => {
    try {
      await verifier.verify(token)
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError)
      return (error as AuthError).reason
    }
    return 'accepted'
  }

  it('accepts a token of the key it has fetched', async () => {
    oldToken = loginAlice()
    oldKid = kidOf(oldToken)
    expect(await publishedKids()).toContain(oldKid)
    expect(await verifier.verify(oldToken)).toMatchObject({ clientId: CLIENT })
    fetchedAt = Date.now()
  })

  it('picks up a key Kanidm adds from the unknown kid of the first token that uses it', async () => {
    await patchClient({ key_action_rotate: [new Date().toISOString()] })
    // A new token is signed by the new key once Kanidm has switched; before that by the old one.
    await vi.waitFor(
      () => {
        newToken = loginAlice()
        expect(kidOf(newToken)).not.toBe(oldKid)
      },
      { timeout: 30_000, interval: 500 },
    )
    expect(await publishedKids()).toEqual(expect.arrayContaining([oldKid, kidOf(newToken)]))

    // The cache holds only the old key. The unknown kid makes the verifier fetch, at most once per
    // cooldown, so wait that out.
    await sleep(KEY_COOLDOWN_SEC * 1000 + 200)
    expect(await verifier.verify(newToken)).toMatchObject({ clientId: CLIENT })
    fetchedAt = Date.now()
    // A rotation keeps the old key published: its tokens still work.
    expect(await reasonOf(oldToken)).toBe('accepted')
  }, 60_000)

  it('trusts a revoked key until the cached keys are too old, and not after', async () => {
    await patchClient({ key_action_revoke: [oldKid] })
    await vi.waitFor(async () => expect(await publishedKids()).not.toContain(oldKid), {
      timeout: 15_000,
      interval: 300,
    })

    // Kanidm no longer vouches for the key, but the verifier has not asked again: this is the
    // window `keyMaxAgeSec` bounds, and it must not be longer than that.
    const age = (Date.now() - fetchedAt) / 1000
    expect(age).toBeLessThan(KEY_MAX_AGE_SEC)
    expect(await reasonOf(oldToken)).toBe('accepted')

    // Once the cache is old enough, the next request starts the refresh in the background (the
    // request itself is still verified with the cached keys) and the key is gone after it.
    await sleep(Math.max(0, KEY_MAX_AGE_SEC * 1000 - (Date.now() - fetchedAt)) + 500)
    expect(await verifier.verify(newToken)).toMatchObject({ clientId: CLIENT })
    await vi.waitFor(async () => expect(await reasonOf(oldToken)).toBe('unknown-kid'), {
      timeout: 15_000,
      interval: 300,
    })

    // The gateway turns that into a 401 with an invalid_token challenge.
    const refused = await authenticateRequest(
      new Headers({ authorization: `Bearer ${oldToken}` }),
      {
        verifier,
      },
    ).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(AuthError)
    expect((refused as AuthError).status).toBe(401)
    expect((refused as AuthError).challenges.join(' ')).toContain('error="invalid_token"')

    // The token of the key that is still published keeps working.
    expect(await reasonOf(newToken)).toBe('accepted')
  }, 90_000)
})
