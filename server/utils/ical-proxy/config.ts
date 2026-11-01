// The runtime config `icalProxy` as numbers. Nuxt applies environment overrides through a
// parser, so a value may arrive as a string, a number or a boolean; everything goes through
// `String()` / `Number()` here.

export interface IcalProxyConfig {
  /** Seconds a fetched file is served without asking the source again. */
  cacheTtlSec: number
  /** Largest file accepted, in bytes (also for a streamed body without Content-Length). */
  maxBytes: number
  /** Milliseconds for one fetch including its redirects. */
  timeoutMs: number
  /** Lets subscriptions point at private addresses. Tests and local development only. */
  allowPrivate: boolean
}

export interface RawIcalProxyConfig {
  cacheTtlSec: unknown
  maxBytes: unknown
  timeoutMs: unknown
  allowPrivate: unknown
}

function integer(name: string, envName: string, value: unknown, min: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(
      `NUXT_ICAL_PROXY_${envName} must be an integer of at least ${min}, got "${String(value)}" (${name})`,
    )
  }
  return parsed
}

/** The name of the second switch that production needs before `allowPrivate` is honoured. */
export const ALLOW_PRIVATE_ACK_VARIABLE = 'NUXT_ICAL_PROXY_ALLOW_PRIVATE_I_UNDERSTAND_THE_RISK'

/**
 * Why the server must not start with the outbound settings as they are, or null (security review
 * 2026-11-01, finding 1). No host list means every public host may be contacted for the users. In
 * production that is an open channel to a host anyone who can sign in may choose, so it has to be
 * switched on knowingly with `allowAnyHost` (NUXT_OUTBOUND_ALLOW_ANY_HOST=true).
 */
export function outboundScopeError(options: {
  production: boolean
  /** Entries in NUXT_OUTBOUND_ALLOWED_HOSTS. */
  hostCount: number
  allowAnyHost: boolean
}): string | null {
  if (!options.production || options.hostCount > 0 || options.allowAnyHost) return null
  return (
    'NUXT_OUTBOUND_ALLOWED_HOSTS is empty, which lets the server contact every public host for ' +
    'its users (iCal subscriptions, external CalDAV accounts). In production, list the hosts ' +
    'users may use (cal.example.org, *.example.org), or knowingly set ' +
    'NUXT_OUTBOUND_ALLOW_ANY_HOST=true.'
  )
}

export interface IcalProxyEnvironment {
  /** `NODE_ENV=production`. */
  production: boolean
  /** The variable named by `ALLOW_PRIVATE_ACK_VARIABLE` is `true`. */
  allowPrivateAcknowledged: boolean
}

/**
 * `allowPrivate` switches the whole SSRF guard off (L3), which a test stack needs and a
 * deployment must not have by accident: in production it needs a second, deliberately long
 * variable, otherwise parsing fails and the server does not start.
 */
export function parseIcalProxyConfig(
  raw: RawIcalProxyConfig,
  environment: IcalProxyEnvironment = { production: false, allowPrivateAcknowledged: false },
): IcalProxyConfig {
  const allowPrivate = String(raw.allowPrivate) === 'true'
  if (allowPrivate && environment.production && !environment.allowPrivateAcknowledged) {
    throw new Error(
      'NUXT_ICAL_PROXY_ALLOW_PRIVATE=true turns off the SSRF guard of the iCal proxy (every ' +
        'subscription could reach internal addresses). It is for tests only and is refused when ' +
        `NODE_ENV=production. Remove it, or knowingly set ${ALLOW_PRIVATE_ACK_VARIABLE}=true.`,
    )
  }
  return {
    cacheTtlSec: integer('cacheTtlSec', 'CACHE_TTL_SEC', raw.cacheTtlSec, 0),
    maxBytes: integer('maxBytes', 'MAX_BYTES', raw.maxBytes, 1),
    timeoutMs: integer('timeoutMs', 'TIMEOUT_MS', raw.timeoutMs, 1),
    // Anything but an explicit "true" keeps the guard on.
    allowPrivate,
  }
}
