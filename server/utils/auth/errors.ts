export type AuthFailureReason =
  // credentials missing or not usable at all
  | 'no-credentials'
  | 'unsupported-scheme'
  | 'malformed'
  // the access token itself
  | 'wrong-alg'
  | 'wrong-typ'
  | 'client-not-allowed'
  | 'unknown-kid'
  | 'bad-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired'
  | 'not-yet-valid'
  | 'invalid-claims'
  | 'missing-scope'
  // app tokens
  | 'invalid-app-token'
  | 'invalid-sub'
  // the signing keys cannot be fetched (cold cache and the identity provider is down)
  | 'keys-unavailable'
  // too many failed Basic logins from this client address (a 429, answered before any lookup)
  | 'throttled'

/**
 * A request that cannot be authenticated. `status` is 401, except when the signing keys cannot be
 * fetched (the token may be fine, so the caller gets a 503 and must not discard its credentials)
 * and when the client has failed too many Basic logins (a 429 with `retryAfterSec`).
 * The reason is for logs; it is never put into a response.
 */
export class AuthError extends Error {
  readonly reason: AuthFailureReason
  readonly status: 401 | 429 | 503
  /** `WWW-Authenticate` values for the response (401 only). */
  readonly challenges: readonly string[]
  /** Whole seconds for the `Retry-After` header (429 only, at least 1); null otherwise. */
  readonly retryAfterSec: number | null

  constructor(
    reason: AuthFailureReason,
    options: {
      message?: string
      cause?: unknown
      challenges?: readonly string[]
      retryAfterSec?: number
    } = {},
  ) {
    super(options.message ?? reason, { cause: options.cause })
    this.name = 'AuthError'
    this.reason = reason
    this.status = reason === 'keys-unavailable' ? 503 : reason === 'throttled' ? 429 : 401
    this.challenges = options.challenges ?? []
    this.retryAfterSec =
      reason === 'throttled' ? Math.max(1, Math.ceil(options.retryAfterSec ?? 1)) : null
  }
}
