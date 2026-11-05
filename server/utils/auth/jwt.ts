import {
  decodeJwt,
  decodeProtectedHeader,
  errors,
  importJWK,
  jwtVerify,
  type CryptoKey,
  type JWK,
} from 'jose'
import { claimEntries, claimIsOverage } from '../groups/claim'
import { AuthError } from './errors'
import type { AllowedClient } from './clients'
import { createDiscoveryStore, type DiscoveryStore } from './discovery'

/** What a verified access token tells the gateway. */
export interface VerifiedToken {
  sub: string
  clientId: string
  scopes: string[]
  /** Expiry, seconds since the epoch. */
  exp: number
  /**
   * The entries of the groups claim of this token (signature checked), or undefined when it has
   * none. Kanidm keeps its groups out of access tokens; Entra, Keycloak and others put them in.
   */
  groups: string[] | undefined
  /** The token says its groups were left out because there are too many (Entra). */
  groupsOverage: boolean
}

/** Returns the signing keys of an issuer (the JWKS `keys` array). `client` is one the issuer serves. */
export type KeyResolver = (client: AllowedClient) => Promise<readonly JWK[]>

export interface TokenVerifierOptions {
  /** The allow-list: a token of any other client is rejected, however valid it is. */
  clients: readonly AllowedClient[]
  /** Scope every token must carry. */
  requiredScope: string
  /** The claim the groups are read from (`NUXT_OIDC_GROUPS_CLAIM`); `groups` when not given. */
  groupsClaim?: string
  /**
   * Further `aud` values that make a token ours, for providers whose access tokens are issued for
   * an API identifier and not for the client (Auth0, Entra). A token that names none of these and
   * none of the allowed clients is refused.
   */
  audiences?: readonly string[]
  /** Clock tolerance for `exp` and `nbf`, in seconds. */
  toleranceSec?: number
  /**
   * Where keys come from; the default reads the `jwks_uri` of the issuer's discovery document and
   * fetches the keys from there (`createJwksFetcher`).
   */
  keyResolver?: KeyResolver
  /**
   * Minimum time between two key fetches per issuer, in seconds (a failed fetch is retried after at
   * most 5 s). A token with an unknown `kid` cannot make us fetch more often than this.
   */
  keyCooldownSec?: number
  /**
   * Longest time the cached keys of an issuer are used before they are fetched again, in seconds
   * (default 3600). A key the provider has removed stops being trusted once a fetch no longer lists
   * it. The fetch runs in the background: the request that finds the cache stale is still verified
   * with the cached keys, and a failed fetch keeps them.
   */
  keyMaxAgeSec?: number
  /** Reports a failed key fetch, once per run of failures. Never receives a token or a key. */
  log?: (message: string) => void
  /** Milliseconds since the epoch. */
  now?: () => number
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>
}

/**
 * The signature algorithms accepted: asymmetric ones only. `none` and the `HS*` family are never
 * accepted (a shared secret cannot come from a published key set), and a key only verifies the
 * algorithms its own type allows (see `admitKey`), so an RSA key never checks an `ES*` token.
 */
const RSA_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512'] as const
const ALLOWED_ALGS: ReadonlySet<string> = new Set([...RSA_ALGS, 'ES256', 'ES384', 'ES512', 'EdDSA'])
const EC_ALG_OF_CURVE: Record<string, string> = {
  'P-256': 'ES256',
  'P-384': 'ES384',
  'P-521': 'ES512',
}
const MIN_RSA_BITS = 2048

/**
 * Header `typ` values of an access token. Providers differ: RFC 9068 says `at+jwt`, Kanidm sends it,
 * Keycloak, Okta, Entra and Cognito send `JWT` or nothing. The header cannot tell an access token
 * from an ID token then; the payload rules in `verify` and the required scope do.
 */
const ACCEPTED_TYP: ReadonlySet<string> = new Set(['at+jwt', 'jwt'])
/** Claims that name the client a token was issued to, by provider: Kanidm and Cognito, Keycloak, Okta, Entra v1. */
const CLIENT_CLAIMS = ['client_id', 'azp', 'cid', 'appid'] as const

/** Fetches the key set at the `jwks_uri` of the issuer's discovery document. */
export function createJwksFetcher(
  options: {
    fetch?: typeof globalThis.fetch
    timeoutMs?: number
    discovery?: DiscoveryStore
    /** Hosts besides the issuer's own that the keys may come from (`NUXT_OIDC_JWKS_HOSTS`). */
    jwksHosts?: readonly string[]
  } = {},
): KeyResolver {
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 5000
  const discovery = options.discovery ?? createDiscoveryStore({ fetch: doFetch, timeoutMs })
  return async (client) => {
    const { jwksUri } = await discovery.refresh(client.issuer, { jwksHosts: options.jwksHosts })
    const response = await doFetch(jwksUri, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`key fetch for ${client.issuer} failed: ${response.status}`)
    const body: unknown = await response.json()
    const keys = (body as { keys?: unknown } | null)?.keys
    if (!Array.isArray(keys)) throw new Error(`key fetch for ${client.issuer}: no "keys" array`)
    return keys as JWK[]
  }
}

/** A signing key we trust, with the algorithms it may verify. */
interface KeyEntry {
  algs: readonly string[]
  /** The key for `alg` (an RSA key is imported per algorithm: its hash and padding are part of it). */
  forAlg(alg: string): Promise<CryptoKey>
}

interface KeyState {
  keys: Map<string, KeyEntry>
  /** When the key set was last fetched successfully; null while the cache has never been filled. */
  fetchedAt: number | null
  /** When the last fetch, successful or not, finished. */
  lastAttempt: number | null
  /** How many fetches failed in a row (0 after a success). */
  failures: number
  pending: Promise<void> | null
}

/** First delay before a scheduled refresh is retried; it doubles with every failure. */
const REFRESH_BACKOFF_START_MS = 30_000

function normalizeTyp(value: string): string {
  const lower = value.toLowerCase()
  return lower.startsWith('application/') ? lower.slice('application/'.length) : lower
}

/** The bit length of an RSA modulus given as base64url; 0 when it is not one. */
function modulusBits(n: unknown): number {
  if (typeof n !== 'string') return 0
  const bytes = Buffer.from(n, 'base64url')
  let first = 0
  while (first < bytes.length && bytes[first] === 0) first += 1
  if (first === bytes.length) return 0
  return (bytes.length - first - 1) * 8 + (32 - Math.clz32(bytes[first]!))
}

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const

/**
 * The algorithms a published key may verify, or null when it is not a key we use: not a public
 * signing key, a curve or size we do not accept, or labelled for another algorithm. The key type
 * decides, never the token: P-256 means ES256 only, an RSA key means the RS and PS families, Ed25519
 * means EdDSA. A key that names its own `alg` is limited to it.
 */
function admitKey(jwk: JWK): readonly string[] | null {
  if (typeof jwk.kid !== 'string' || jwk.kid === '') return null
  // A private key in a public key set is a mistake we do not want to touch.
  if (PRIVATE_MEMBERS.some((member) => member in jwk)) return null
  if (jwk.use !== undefined && jwk.use !== 'sig') return null
  let algs: readonly string[]
  switch (jwk.kty) {
    case 'EC': {
      const alg = EC_ALG_OF_CURVE[String(jwk.crv)]
      if (!alg) return null
      algs = [alg]
      break
    }
    case 'RSA':
      if (modulusBits(jwk.n) < MIN_RSA_BITS) return null
      algs = RSA_ALGS
      break
    case 'OKP':
      if (jwk.crv !== 'Ed25519') return null
      algs = ['EdDSA']
      break
    default:
      return null
  }
  if (jwk.alg !== undefined) {
    if (!algs.includes(jwk.alg)) return null
    algs = [jwk.alg]
  }
  return algs
}

async function importKeys(jwks: readonly JWK[]): Promise<Map<string, KeyEntry>> {
  const keys = new Map<string, KeyEntry>()
  for (const jwk of jwks) {
    const algs = admitKey(jwk)
    if (!algs || keys.has(jwk.kid!)) continue
    const imported = new Map<string, Promise<CryptoKey>>()
    const forAlg = (alg: string): Promise<CryptoKey> => {
      let key = imported.get(alg)
      if (!key) {
        key = importJWK(jwk, alg) as Promise<CryptoKey>
        imported.set(alg, key)
      }
      return key
    }
    try {
      // Import once now, so that a key we cannot use is as good as absent.
      await forAlg(algs[0]!)
    } catch {
      continue
    }
    keys.set(jwk.kid!, { algs, forAlg })
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

/** The scopes of a token: `scope` (a space-separated string), else `scp` (a string or an array). */
function readScopes(payload: Record<string, unknown>): string[] | null {
  const split = (text: string) => text.split(/\s+/).filter(Boolean)
  if (typeof payload.scope === 'string') return split(payload.scope)
  if (payload.scope !== undefined) return null
  const scp = payload.scp
  if (typeof scp === 'string') return split(scp)
  if (Array.isArray(scp) && scp.every((item) => typeof item === 'string')) {
    return (scp as string[]).flatMap(split)
  }
  return null
}

/**
 * Verifies access tokens locally (design §6): no introspection, no call to the provider per
 * request. Whatever the provider, a token is accepted when
 *
 * - its signature checks out against a key the issuer published, with an algorithm that key's type
 *   allows, and its `iss` is an allowed client's issuer exactly;
 * - it is an access token: header `typ` absent, `at+jwt` or `jwt`; payload `typ` absent or `Bearer`
 *   (Keycloak tags ID, refresh, offline and logout tokens differently); `token_use` absent or
 *   `access` (Cognito);
 * - it names an allowed client in `client_id`, `azp`, `cid` or `appid`, or has an `aud` that holds
 *   an allowed client or one of the configured audiences;
 * - it carries the required scope, in `scope` or `scp`. An ID token has none, which is what keeps
 *   it out where no marker tells it apart.
 *
 * Keys are cached per issuer and fetched again in two cases: when a token names a `kid` we do not
 * have (at most once per cooldown), and when the cache is older than `keyMaxAgeSec` (in the
 * background, with a growing delay between failed tries). Either way a successful fetch replaces
 * the whole set and a failed one changes nothing.
 */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const { clients, requiredScope } = options
  if (!requiredScope) throw new TypeError('requiredScope must not be empty')
  if (clients.length === 0) throw new TypeError('at least one allowed client is required')
  const audiences = new Set(options.audiences ?? [])
  const groupsClaim = options.groupsClaim ?? 'groups'
  const toleranceSec = options.toleranceSec ?? 60
  const cooldownMs = (options.keyCooldownSec ?? 30) * 1000
  // After a failed fetch the provider may be back within seconds, so try again sooner.
  const failureCooldownMs = Math.min(cooldownMs, 5000)
  const maxAgeSec = options.keyMaxAgeSec ?? 3600
  if (!Number.isFinite(maxAgeSec) || maxAgeSec <= 0) {
    throw new TypeError('keyMaxAgeSec must be a positive number')
  }
  const maxAgeMs = maxAgeSec * 1000
  const now = options.now ?? Date.now
  const log = (message: string) => {
    try {
      options.log?.(message)
    } catch {
      // A broken logger must not break a fetch that nobody awaits.
    }
  }
  const resolveKeys = options.keyResolver ?? createJwksFetcher()
  // Clients that share an issuer share its keys; the token's own claims then pick the client.
  const byIssuer = new Map<string, AllowedClient[]>()
  for (const client of clients) {
    byIssuer.set(client.issuer, [...(byIssuer.get(client.issuer) ?? []), client])
  }
  const states = new Map<string, KeyState>()

  // One fetch at a time per issuer; concurrent requests wait for it. It never rejects.
  function refresh(issuer: string, client: AllowedClient, state: KeyState): Promise<void> {
    const attempt = async () => {
      try {
        const keys = await importKeys(await resolveKeys(client))
        // A key set without one usable key is a broken answer, not the provider's decision to trust
        // nothing; taking it over would turn every bearer request into a 401.
        if (keys.size === 0) throw new Error('the key set holds no usable signing key')
        state.keys = keys
        state.fetchedAt = now()
        state.failures = 0
      } catch (error) {
        // Keep the keys we have: an outage must not take down tokens we can already verify.
        if (state.failures === 0) {
          const reason = error instanceof Error ? error.message : String(error)
          log(
            `fetching the signing keys of "${issuer}" failed (${reason}); ` +
              `${state.keys.size > 0 ? `keeping the ${state.keys.size} cached` : 'none cached'}, will retry`,
          )
        }
        state.failures += 1
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

  // 30 s after the first failure, then 60 s, 120 s, ... but never longer than the max age itself.
  function backoffMs(failures: number): number {
    return Math.min(REFRESH_BACKOFF_START_MS * 2 ** Math.min(failures - 1, 30), maxAgeMs)
  }

  // Stale-while-revalidate: the request that notices an old cache starts the fetch and does not wait
  // for it. Without a timer the schedule is only checked when a request arrives, which is enough:
  // with no requests there is nothing to verify.
  function refreshIfStale(issuer: string, client: AllowedClient, state: KeyState): void {
    if (state.pending || state.fetchedAt === null) return
    const current = now()
    if (current - state.fetchedAt < maxAgeMs) return
    if (state.failures > 0 && current - (state.lastAttempt ?? 0) < backoffMs(state.failures)) return
    void refresh(issuer, client, state)
  }

  async function keyFor(issuer: string, client: AllowedClient, kid: string): Promise<KeyEntry> {
    let state = states.get(issuer)
    if (!state) {
      state = { keys: new Map(), fetchedAt: null, lastAttempt: null, failures: 0, pending: null }
      states.set(issuer, state)
    }
    const cached = state.keys.get(kid)
    refreshIfStale(issuer, client, state)
    if (cached) return cached
    // The kid is unknown: that may be a rotation, or a forged header. Fetch (rate limited), or wait
    // for the fetch that is already running.
    if (state.pending) {
      await state.pending
    } else if (
      state.lastAttempt === null ||
      now() - state.lastAttempt >= (state.failures > 0 ? failureCooldownMs : cooldownMs)
    ) {
      await refresh(issuer, client, state)
    }
    const key = state.keys.get(kid)
    if (key) return key
    // After a failed fetch we cannot tell a rotated key from a forged `kid`; ask the caller to retry.
    throw new AuthError(state.failures > 0 ? 'keys-unavailable' : 'unknown-kid')
  }

  /** The allowed client a verified token was issued to or for, or undefined. */
  function clientOf(
    candidates: readonly AllowedClient[],
    payload: Record<string, unknown>,
  ): AllowedClient | undefined {
    const direct = candidates.find((client) =>
      CLIENT_CLAIMS.some((claim) => payload[claim] === client.clientId),
    )
    if (direct) return direct
    const aud = typeof payload.aud === 'string' ? [payload.aud] : payload.aud
    const names = Array.isArray(aud) ? aud.filter((item) => typeof item === 'string') : []
    const byAudience = candidates.find((client) => names.includes(client.clientId))
    if (byAudience) return byAudience
    // An API identifier says the token is for us, not which client asked: the first one stands in.
    return names.some((name) => audiences.has(name)) ? candidates[0] : undefined
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
      const alg = header.alg
      if (typeof alg !== 'string' || !ALLOWED_ALGS.has(alg)) throw new AuthError('wrong-alg')
      if (
        header.typ !== undefined &&
        (typeof header.typ !== 'string' || !ACCEPTED_TYP.has(normalizeTyp(header.typ)))
      ) {
        throw new AuthError('wrong-typ')
      }
      if (typeof header.kid !== 'string' || header.kid === '') throw new AuthError('malformed')
      // The issuer picks the keys that are tried; the signature then proves the claim.
      const issuer = unverified.iss
      const candidates = typeof issuer === 'string' ? byIssuer.get(issuer) : undefined
      if (!candidates) throw new AuthError('client-not-allowed')

      const entry = await keyFor(issuer as string, candidates[0]!, header.kid)
      // The algorithm-confusion defence: the key's own type limits what it may verify.
      if (!entry.algs.includes(alg)) throw new AuthError('wrong-alg')
      let payload
      try {
        ;({ payload } = await jwtVerify(token, await entry.forAlg(alg), {
          algorithms: [alg],
          issuer: issuer as string,
          requiredClaims: ['exp', 'sub'],
          clockTolerance: toleranceSec,
          currentDate: new Date(now()),
        }))
      } catch (error) {
        throw claimFailure(error)
      }

      if (typeof payload.sub !== 'string' || payload.sub === '') {
        throw new AuthError('invalid-claims', { message: 'sub must be a non-empty string' })
      }
      // Only access tokens. Keycloak signs ID, refresh, offline and logout tokens with the same keys
      // and says which in `typ`; a refresh token names our client and carries a scope, so it would
      // pass everything below. Cognito says `token_use`.
      if (
        payload.typ !== undefined &&
        (typeof payload.typ !== 'string' || payload.typ.toLowerCase() !== 'bearer')
      ) {
        throw new AuthError('wrong-typ', { message: 'the payload typ is not Bearer' })
      }
      if (payload.token_use !== undefined && payload.token_use !== 'access') {
        throw new AuthError('wrong-typ', { message: 'token_use is not access' })
      }
      const client = clientOf(candidates, payload)
      if (!client) {
        throw new AuthError('wrong-audience', { message: 'the token names none of our clients' })
      }
      const scopes = readScopes(payload)
      if (!scopes?.includes(requiredScope)) throw new AuthError('missing-scope')

      return {
        sub: payload.sub,
        clientId: client.clientId,
        scopes,
        exp: payload.exp as number,
        groups: claimEntries(
          Object.hasOwn(payload, groupsClaim) ? payload[groupsClaim] : undefined,
        ),
        groupsOverage: claimIsOverage(payload, groupsClaim),
      }
    },
  }
}
