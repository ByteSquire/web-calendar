import {
  decodeJwt,
  decodeProtectedHeader,
  errors,
  importJWK,
  jwtVerify,
  type CryptoKey,
  type JWK,
} from 'jose'
import { AuthError } from './errors'
import type { AllowedClient } from './clients'

/** What a verified access token tells the gateway. */
export interface VerifiedToken {
  sub: string
  clientId: string
  scopes: string[]
  /** Expiry, seconds since the epoch. */
  exp: number
}

/** Returns the client's current public signing keys (the JWKS `keys` array). */
export type KeyResolver = (client: AllowedClient) => Promise<readonly JWK[]>

export interface TokenVerifierOptions {
  /** The allow-list: a token of any other client is rejected, however valid it is. */
  clients: readonly AllowedClient[]
  /** Scope every token must carry. */
  requiredScope: string
  /** Clock tolerance for `exp` and `nbf`, in seconds. */
  toleranceSec?: number
  /** Where keys come from; the default fetches `<issuer>/public_key.jwk`. */
  keyResolver?: KeyResolver
  /**
   * Minimum time between two key fetches per client, in seconds (a failed fetch is retried after at
   * most 5 s). A token with an unknown `kid` cannot make us fetch more often than this.
   */
  keyCooldownSec?: number
  /** Milliseconds since the epoch. */
  now?: () => number
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>
}

const ACCESS_TOKEN_TYP = 'at+jwt'
// Kanidm signs access tokens with ES256 only (RFC 9068 requires an asymmetric algorithm).
const ALG = 'ES256'

/** Fetches `<issuer>/public_key.jwk`, the JWKS Kanidm publishes per client. */
export function createJwksFetcher(
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): KeyResolver {
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 5000
  return async (client) => {
    const response = await doFetch(`${client.issuer}/public_key.jwk`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`key fetch for ${client.clientId} failed: ${response.status}`)
    const body: unknown = await response.json()
    const keys = (body as { keys?: unknown } | null)?.keys
    if (!Array.isArray(keys)) throw new Error(`key fetch for ${client.clientId}: no "keys" array`)
    return keys as JWK[]
  }
}

interface KeyState {
  keys: Map<string, CryptoKey>
  lastAttempt: number | null
  lastFailed: boolean
  pending: Promise<void> | null
}

function normalizeTyp(value: string): string {
  const lower = value.toLowerCase()
  return lower.startsWith('application/') ? lower.slice('application/'.length) : lower
}

async function importKeys(jwks: readonly JWK[]): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>()
  for (const jwk of jwks) {
    // Only public ES256 signing keys with an id. A private key in a public key set is a mistake we
    // do not want to touch.
    if (typeof jwk.kid !== 'string' || keys.has(jwk.kid)) continue
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || 'd' in jwk) continue
    if (
      (jwk.use !== undefined && jwk.use !== 'sig') ||
      (jwk.alg !== undefined && jwk.alg !== ALG)
    ) {
      continue
    }
    try {
      keys.set(jwk.kid, (await importJWK(jwk, ALG)) as CryptoKey)
    } catch {
      // A key we cannot import is as good as absent.
    }
  }
  return keys
}

function claimFailure(error: unknown): AuthError {
  if (error instanceof errors.JWTExpired) return new AuthError('expired', { cause: error })
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case 'nbf':
        return new AuthError('not-yet-valid', { cause: error })
      case 'iss':
        return new AuthError('wrong-issuer', { cause: error })
      case 'aud':
        return new AuthError('wrong-audience', { cause: error })
      case 'typ':
        return new AuthError('wrong-typ', { cause: error })
      default:
        return new AuthError('invalid-claims', { message: error.message, cause: error })
    }
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return new AuthError('wrong-alg', { cause: error })
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return new AuthError('bad-signature', { cause: error })
  }
  return new AuthError('malformed', { cause: error })
}

/**
 * Verifies Kanidm access tokens locally (design §6): no introspection, no call to the provider per
 * request. Keys are cached per client and fetched again, at most once per cooldown, when a token
 * names a `kid` we do not have.
 */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const { clients, requiredScope } = options
  if (!requiredScope) throw new TypeError('requiredScope must not be empty')
  if (clients.length === 0) throw new TypeError('at least one allowed client is required')
  const toleranceSec = options.toleranceSec ?? 60
  const cooldownMs = (options.keyCooldownSec ?? 30) * 1000
  // After a failed fetch the provider may be back within seconds, so try again sooner.
  const failureCooldownMs = Math.min(cooldownMs, 5000)
  const now = options.now ?? Date.now
  const resolveKeys = options.keyResolver ?? createJwksFetcher()
  const byIssuer = new Map(clients.map((client) => [client.issuer, client]))
  const states = new Map<string, KeyState>()

  // One fetch at a time per client; concurrent requests wait for it.
  function refresh(client: AllowedClient, state: KeyState): Promise<void> {
    const attempt = async () => {
      try {
        state.keys = await importKeys(await resolveKeys(client))
        state.lastFailed = false
      } catch {
        // Keep the keys we have: an outage must not take down tokens we can already verify.
        state.lastFailed = true
      } finally {
        state.lastAttempt = now()
      }
    }
    const pending = attempt().finally(() => {
      state.pending = null
    })
    state.pending = pending
    return pending
  }

  async function keyFor(client: AllowedClient, kid: string): Promise<CryptoKey> {
    let state = states.get(client.clientId)
    if (!state) {
      state = { keys: new Map(), lastAttempt: null, lastFailed: false, pending: null }
      states.set(client.clientId, state)
    }
    const cached = state.keys.get(kid)
    if (cached) return cached
    if (state.pending) {
      await state.pending
    } else if (
      state.lastAttempt === null ||
      now() - state.lastAttempt >= (state.lastFailed ? failureCooldownMs : cooldownMs)
    ) {
      await refresh(client, state)
    }
    const key = state.keys.get(kid)
    if (key) return key
    // After a failed fetch we cannot tell a rotated key from a forged `kid`; ask the caller to retry.
    throw new AuthError(state.lastFailed ? 'keys-unavailable' : 'unknown-kid')
  }

  return {
    async verify(token) {
      let header
      let unverified
      try {
        header = decodeProtectedHeader(token)
        unverified = decodeJwt(token)
      } catch (error) {
        throw new AuthError('malformed', { cause: error })
      }
      if (header.alg !== ALG) throw new AuthError('wrong-alg')
      if (typeof header.typ !== 'string' || normalizeTyp(header.typ) !== ACCESS_TOKEN_TYP) {
        throw new AuthError('wrong-typ')
      }
      if (typeof header.kid !== 'string' || header.kid === '') throw new AuthError('malformed')
      // The issuer picks the client whose keys are tried; the signature then proves the claim.
      const client = typeof unverified.iss === 'string' ? byIssuer.get(unverified.iss) : undefined
      if (!client) throw new AuthError('client-not-allowed')

      const key = await keyFor(client, header.kid)
      let payload
      try {
        ;({ payload } = await jwtVerify(token, key, {
          algorithms: [ALG],
          typ: ACCESS_TOKEN_TYP,
          issuer: client.issuer,
          audience: client.clientId,
          requiredClaims: ['exp', 'sub'],
          clockTolerance: toleranceSec,
          currentDate: new Date(now()),
        }))
      } catch (error) {
        throw claimFailure(error)
      }

      if (payload.client_id !== undefined && payload.client_id !== client.clientId) {
        throw new AuthError('wrong-audience', { message: 'client_id does not match' })
      }
      if (typeof payload.sub !== 'string' || payload.sub === '') {
        throw new AuthError('invalid-claims', { message: 'sub must be a non-empty string' })
      }
      if (typeof payload.scope !== 'string') throw new AuthError('missing-scope')
      const scopes = payload.scope.split(/\s+/).filter(Boolean)
      if (!scopes.includes(requiredScope)) throw new AuthError('missing-scope')

      return { sub: payload.sub, clientId: client.clientId, scopes, exp: payload.exp as number }
    },
  }
}
