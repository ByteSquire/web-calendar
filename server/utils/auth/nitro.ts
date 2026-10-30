import type { H3Event } from 'h3'
import { verifyAppToken } from '../../db/app-tokens'
import { getDb } from '../db'
import { authenticateRequest, type Identity } from './authenticate'
import { buildAllowedClients } from './clients'
import { AuthError } from './errors'
import { createTokenVerifier, type TokenVerifier } from './jwt'
import { createBasicThrottle, describeBlock, type BasicThrottle } from './throttle'

// Nitro glue: reads the runtime config and wires the database. The logic is in the plain modules.

let verifier: TokenVerifier | undefined
let basicThrottle: BasicThrottle | undefined

function getVerifier(): TokenVerifier {
  if (!verifier) {
    const { oidc } = useRuntimeConfig()
    if (!oidc.issuer) throw new Error('NUXT_OIDC_ISSUER is not set; no token can be verified')
    // Environment overrides arrive as numbers (or strings); anything but a positive integer is a typo.
    const keyMaxAgeSec = Number(oidc.keyMaxAgeSec)
    if (!Number.isSafeInteger(keyMaxAgeSec) || keyMaxAgeSec <= 0) {
      throw new Error(
        `NUXT_OIDC_KEY_MAX_AGE_SEC must be a positive integer, got "${String(oidc.keyMaxAgeSec)}"`,
      )
    }
    verifier = createTokenVerifier({
      clients: buildAllowedClients(oidc),
      requiredScope: oidc.requiredScope,
      keyMaxAgeSec,
      log: (message) => console.warn(`[auth] ${message}`),
    })
  }
  return verifier
}

// One throttle per process, shared by every request: its counters are the whole point.
function getBasicThrottle(): BasicThrottle {
  basicThrottle ??= createBasicThrottle({
    onBlock: (block) => console.warn(`[auth] ${describeBlock(block)}`),
  })
  return basicThrottle
}

/**
 * Bearer token or app token (Basic): the CalDAV gateway. Throws `AuthError`, a 429 for a client that
 * has failed too many Basic logins.
 */
export function authenticateCalDav(
  headers: Headers,
  context: { clientAddress: string | null } = { clientAddress: null },
): Promise<Identity> {
  return authenticateRequest(headers, {
    verifier: getVerifier(),
    verifyAppToken: (username, token) =>
      verifyAppToken(getDb(), useRuntimeConfig().tokenHashKey, username, token),
    basicThrottle: getBasicThrottle(),
    clientAddress: context.clientAddress,
  })
}

const STATUS_TEXT = { 401: 'Unauthorized', 429: 'Too Many Requests', 503: 'Service Unavailable' }

/**
 * The caller of an `/api/**` request: a bearer token only (design §6, app tokens are for CalDAV
 * clients). Throws an HTTP 401, or 503 while the signing keys cannot be fetched. (A 429 with
 * `Retry-After` is mapped too, but only the Basic throttle raises one, so nothing here does yet.)
 */
export async function requireUser(event: H3Event): Promise<Identity> {
  try {
    return await authenticateRequest(event.headers, { verifier: getVerifier() })
  } catch (error) {
    if (!(error instanceof AuthError)) throw error
    // A throttled client would log on every request; the throttle reports when it starts blocking.
    if (error.reason !== 'throttled') console.warn(`[auth] ${event.path}: ${error.reason}`)
    for (const challenge of error.challenges) {
      appendResponseHeader(event, 'www-authenticate', challenge)
    }
    if (error.retryAfterSec !== null) setResponseHeader(event, 'retry-after', error.retryAfterSec)
    throw createError({ statusCode: error.status, statusMessage: STATUS_TEXT[error.status] })
  }
}
