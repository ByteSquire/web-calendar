#!/usr/bin/env node
// Startup config validation (design §12). The container runs this script before the server and
// stops with a readable message instead of failing on the first request. The checks are in the pure
// validateEnv(), which tests/validate-config.test.ts covers.
import { pathToFileURL } from 'node:url'

// Same default as runtimeConfig.oidc.clientId in nuxt.config.ts.
const DEFAULT_CLIENT_ID = 'web-calendar'
const MIN_TOKEN_HASH_KEY_LENGTH = 32
const MAX_TOKEN_HASH_KEYS = 10
// Mirrors ALLOW_PRIVATE_ACK_VARIABLE in utils/ical-proxy/config.ts (this script is plain JS and
// runs before the server; a test keeps the two equal).
const ALLOW_PRIVATE_ACK = 'NUXT_ICAL_PROXY_ALLOW_PRIVATE_I_UNDERSTAND_THE_RISK'

/** @param {string} value */
function parseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** @param {string} zone */
function isTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** A value for an error message: short, on one line. */
function show(/** @type {string} */ value) {
  const text = value.length > 40 ? `${value.slice(0, 40)}...` : value
  return JSON.stringify(text)
}

/**
 * Checks the NUXT_* variables the server cannot run without, `TZ`, and every optional variable the
 * server reads at startup or per request (the server stops at start on a bad one, see
 * server/plugins/startup.ts; checking here gives the message before it starts). Secret values are
 * never echoed.
 * @param {Record<string, string | undefined>} env
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateEnv(env) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  const get = (/** @type {string} */ name) => (env[name] ?? '').trim()

  // An unset variable keeps its default. One that is set must be valid, an empty value included:
  // the server would take the empty text and fail (or switch a guard off) on it.
  /** @param {string} name @param {number} min */
  const checkInteger = (name, min) => {
    const raw = env[name]
    if (raw === undefined) return
    const value = /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN
    if (!Number.isSafeInteger(value) || value < min) {
      errors.push(`${name} must be a whole number of at least ${min}, not ${show(raw)}`)
    }
  }
  /** @param {string} name */
  const checkBoolean = (name) => {
    const raw = env[name]
    if (raw === undefined) return
    if (raw !== 'true' && raw !== 'false') {
      errors.push(`${name} must be exactly "true" or "false", not ${show(raw)}`)
    }
  }

  const clientId = get('NUXT_OIDC_CLIENT_ID') || DEFAULT_CLIENT_ID
  const issuer = get('NUXT_OIDC_ISSUER')
  if (!issuer) {
    errors.push(
      'NUXT_OIDC_ISSUER is required, for example https://idm.example.org/oauth2/openid/web-calendar',
    )
  } else {
    const url = parseUrl(issuer)
    if (!url) {
      errors.push('NUXT_OIDC_ISSUER is not a valid URL')
    } else if (url.protocol !== 'https:') {
      errors.push('NUXT_OIDC_ISSUER must be an https URL')
    } else if (issuer.endsWith('/')) {
      errors.push('NUXT_OIDC_ISSUER must not end with a slash')
    } else {
      const lastSegment = url.pathname.split('/').filter(Boolean).at(-1)
      if (!lastSegment) {
        errors.push(`NUXT_OIDC_ISSUER must end with the client id "${clientId}"`)
      } else if (lastSegment !== clientId) {
        errors.push(
          `NUXT_OIDC_ISSUER ends with "${lastSegment}", but NUXT_OIDC_CLIENT_ID is "${clientId}"`,
        )
      }
    }
  }

  const tokenHashKey = get('NUXT_TOKEN_HASH_KEY')
  if (!tokenHashKey) {
    errors.push('NUXT_TOKEN_HASH_KEY is required')
  } else if (tokenHashKey.length < MIN_TOKEN_HASH_KEY_LENGTH) {
    errors.push(`NUXT_TOKEN_HASH_KEY must have at least ${MIN_TOKEN_HASH_KEY_LENGTH} characters`)
  }

  const radicaleUrl = get('NUXT_RADICALE_URL')
  if (!radicaleUrl) {
    errors.push('NUXT_RADICALE_URL is required, for example http://radicale:5232')
  } else {
    const url = parseUrl(radicaleUrl)
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      errors.push('NUXT_RADICALE_URL must be an http or https URL')
    }
  }

  // Optional knobs with defaults in nuxt.config.ts; the names are the runtimeConfig keys in env form.
  checkInteger('NUXT_OIDC_KEY_MAX_AGE_SEC', 1)
  checkInteger('NUXT_GATEWAY_MAX_BODY_BYTES', 1)
  checkBoolean('NUXT_GATEWAY_TRUST_FORWARDED_FOR')
  checkInteger('NUXT_ICAL_PROXY_CACHE_TTL_SEC', 0)
  checkInteger('NUXT_ICAL_PROXY_MAX_BYTES', 1)
  checkInteger('NUXT_ICAL_PROXY_TIMEOUT_MS', 1)
  checkBoolean('NUXT_ICAL_PROXY_ALLOW_PRIVATE')
  checkBoolean('NUXT_DEMO')

  const adminGroup = env.NUXT_OIDC_ADMIN_GROUP
  if (adminGroup !== undefined && (adminGroup.trim() === '' || adminGroup !== adminGroup.trim())) {
    errors.push(
      'NUXT_OIDC_ADMIN_GROUP must be the name of the Kanidm admin group, without blanks around ' +
        `it (it is empty or padded: ${show(adminGroup)}); nobody could be an admin with it`,
    )
  }

  // L3: the SSRF guard of the iCal proxy is off with this one; only tests want that.
  if (env.NUXT_ICAL_PROXY_ALLOW_PRIVATE === 'true') {
    if (env.NODE_ENV !== 'production') {
      warnings.push(
        'NUXT_ICAL_PROXY_ALLOW_PRIVATE=true: the SSRF guard of the iCal proxy is OFF, so ' +
          'subscriptions can reach internal addresses. For tests only.',
      )
    } else if (env[ALLOW_PRIVATE_ACK] === 'true') {
      warnings.push(
        'NUXT_ICAL_PROXY_ALLOW_PRIVATE=true IN PRODUCTION (acknowledged): the SSRF guard is OFF ' +
          'and any signed-in user can make this server fetch internal addresses.',
      )
    } else {
      errors.push(
        'NUXT_ICAL_PROXY_ALLOW_PRIVATE=true turns the SSRF guard of the iCal proxy off. It is for ' +
          'tests only and the server refuses to start with it when NODE_ENV=production. Remove it, ' +
          `or knowingly set ${ALLOW_PRIVATE_ACK}=true.`,
      )
    }
  }

  if (env.NUXT_DEMO === 'true') {
    warnings.push(
      'NUXT_DEMO=true: DEMO MODE. The SPA skips the login and shows mock data. For previews and ' +
        'browser tests only; do not use it for a real deployment.',
    )
  }

  // The organization time zone (FR-29); unset means Europe/Berlin (shared/utils/time-zone.ts).
  const timeZone = get('TZ')
  if (timeZone && !isTimeZone(timeZone)) {
    errors.push(`TZ must be an IANA time zone such as Europe/Berlin, not "${timeZone}"`)
  }

  if (!get('NUXT_GROUP_SYNC_TOKEN')) {
    warnings.push(
      "NUXT_GROUP_SYNC_TOKEN is not set: Radicale's group file is not filled from Kanidm " +
        '(group sync arrives in Phase 3)',
    )
  }

  return { errors, warnings }
}

function main() {
  const { errors, warnings } = validateEnv(process.env)
  for (const warning of warnings) {
    console.warn(`[config] Warning: ${warning}`)
  }
  if (errors.length > 0) {
    console.error('[config] Invalid runtime config:')
    for (const error of errors) {
      console.error(`  - ${error}`)
    }
    console.error('[config] Set the NUXT_* environment variables (see .env.example).')
    process.exit(1)
  }
  console.log('[config] Validation passed')
}

// Run as a script (the Dockerfile CMD); importing the module has no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
