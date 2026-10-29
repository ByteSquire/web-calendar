import { AuthError, type AuthFailureReason } from './errors'
import { isValidSubject } from './subject'
import type { TokenVerifier } from './jwt'

export const AUTH_REALM = 'Web Calendar'

const BASIC_CHALLENGE = `Basic realm="${AUTH_REALM}", charset="UTF-8"`
const BEARER_CHALLENGE = `Bearer realm="${AUTH_REALM}"`
const MAX_HEADER_LENGTH = 8192

export interface AuthDeps {
  verifier: Pick<TokenVerifier, 'verify'>
  /**
   * The owner of an app token, or null when the user name or token is wrong, expired or revoked.
   * Leave it out where only bearer tokens are accepted (`/api/**`); Basic is then refused and not
   * offered in the challenge.
   */
  verifyAppToken?(
    username: string,
    token: string,
  ): { sub: string } | null | Promise<{ sub: string } | null>
}

export interface Identity {
  sub: string
  via: 'bearer' | 'app-token'
}

function fail(
  deps: AuthDeps,
  reason: AuthFailureReason,
  options: { invalidToken?: boolean; message?: string; cause?: unknown } = {},
): AuthError {
  const bearer = options.invalidToken
    ? `${BEARER_CHALLENGE}, error="invalid_token"`
    : BEARER_CHALLENGE
  return new AuthError(reason, {
    message: options.message,
    cause: options.cause,
    challenges: deps.verifyAppToken ? [BASIC_CHALLENGE, bearer] : [bearer],
  })
}

function parseBasic(credentials: string): { username: string; token: string } | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(credentials)) return null
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(credentials, 'base64'))
  } catch {
    return null
  }
  const colon = decoded.indexOf(':')
  if (colon < 1 || colon === decoded.length - 1) return null
  return { username: decoded.slice(0, colon), token: decoded.slice(colon + 1) }
}

/**
 * Resolves the caller of a request (design §6): `Authorization: Bearer` is an OIDC access token
 * verified locally, `Authorization: Basic` is a user name with an app token. Anything else, and every
 * failure, is an `AuthError` that carries the `WWW-Authenticate` challenges for a 401.
 */
export async function authenticateRequest(headers: Headers, deps: AuthDeps): Promise<Identity> {
  const header = headers.get('authorization')
  if (header === null || header.trim() === '') throw fail(deps, 'no-credentials')
  if (header.length > MAX_HEADER_LENGTH) throw fail(deps, 'malformed')
  const match = /^(\S+)\s+(\S+)\s*$/.exec(header)
  if (!match) throw fail(deps, 'malformed')
  const [, scheme, credentials] = match

  switch (scheme!.toLowerCase()) {
    case 'bearer': {
      let verified
      try {
        verified = await deps.verifier.verify(credentials!)
      } catch (error) {
        // Not an AuthError: a bug, not a bad token. A 503 (keys unavailable) has no challenge.
        if (!(error instanceof AuthError) || error.status === 503) throw error
        throw fail(deps, error.reason, {
          invalidToken: true,
          message: error.message,
          cause: error.cause,
        })
      }
      if (!isValidSubject(verified.sub)) throw fail(deps, 'invalid-sub', { invalidToken: true })
      return { sub: verified.sub, via: 'bearer' }
    }
    case 'basic': {
      if (!deps.verifyAppToken) throw fail(deps, 'unsupported-scheme')
      const parsed = parseBasic(credentials!)
      if (!parsed) throw fail(deps, 'malformed')
      const owner = await deps.verifyAppToken(parsed.username, parsed.token)
      if (!owner) throw fail(deps, 'invalid-app-token')
      if (!isValidSubject(owner.sub)) throw fail(deps, 'invalid-sub')
      return { sub: owner.sub, via: 'app-token' }
    }
    default:
      throw fail(deps, 'unsupported-scheme')
  }
}
