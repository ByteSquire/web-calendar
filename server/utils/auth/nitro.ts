import type { H3Event } from 'h3'
import { verifyAppToken } from '../../db/app-tokens'
import { getDb } from '../db'
import { authenticateRequest, type Identity } from './authenticate'
import { buildAllowedClients } from './clients'
import { AuthError } from './errors'
import { createTokenVerifier, type TokenVerifier } from './jwt'

// Nitro glue: reads the runtime config and wires the database. The logic is in the plain modules.

let verifier: TokenVerifier | undefined

function getVerifier(): TokenVerifier {
  if (!verifier) {
    const { oidc } = useRuntimeConfig()
    if (!oidc.issuer) throw new Error('NUXT_OIDC_ISSUER is not set; no token can be verified')
    verifier = createTokenVerifier({
      clients: buildAllowedClients(oidc),
      requiredScope: oidc.requiredScope,
    })
  }
  return verifier
}

/** Bearer token or app token (Basic): the CalDAV gateway. Throws `AuthError`. */
export function authenticateCalDav(headers: Headers): Promise<Identity> {
  return authenticateRequest(headers, {
    verifier: getVerifier(),
    verifyAppToken: (username, token) =>
      verifyAppToken(getDb(), useRuntimeConfig().tokenHashKey, username, token),
  })
}

/**
 * The caller of an `/api/**` request: a bearer token only (design §6, app tokens are for CalDAV
 * clients). Throws an HTTP 401, or 503 while the signing keys cannot be fetched.
 */
export async function requireUser(event: H3Event): Promise<Identity> {
  try {
    return await authenticateRequest(event.headers, { verifier: getVerifier() })
  } catch (error) {
    if (!(error instanceof AuthError)) throw error
    console.warn(`[auth] ${event.path}: ${error.reason}`)
    for (const challenge of error.challenges) {
      appendResponseHeader(event, 'www-authenticate', challenge)
    }
    throw createError({
      statusCode: error.status,
      statusMessage: error.status === 401 ? 'Unauthorized' : 'Service Unavailable',
    })
  }
}
