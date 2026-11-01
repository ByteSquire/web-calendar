#!/usr/bin/env node
// Startup config validation (design §12). The container runs this script before the server and
// stops with a readable message instead of failing on the first request. The checks are in the pure
// validateEnv(), which tests/validate-config.test.ts covers.
import { isIP } from 'node:net'
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
 * The problems with the app token hash keys: NUXT_TOKEN_HASH_KEY (key version 1) and the optional
 * NUXT_TOKEN_HASH_KEYS (`version:key` entries separated by commas, the current key first). The same
 * rules as `parseTokenKeyring` in server/utils/auth/token-keys.ts (this script is plain JS and runs
 * before the server; tests/server/auth-token-keys.test.ts keeps the two equal). Key values are
 * never echoed.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function tokenHashKeyErrors(env) {
  const single = env.NUXT_TOKEN_HASH_KEY ?? ''
  const list = (env.NUXT_TOKEN_HASH_KEYS ?? '').trim()
  /** @type {{ version: number, key: string }[]} */
  const keys = []
  if (list !== '') {
    const entries = list.split(',').map((entry) => entry.trim())
    if (entries.length > MAX_TOKEN_HASH_KEYS) {
      return [`NUXT_TOKEN_HASH_KEYS lists more than ${MAX_TOKEN_HASH_KEYS} keys`]
    }
    for (const [index, entry] of entries.entries()) {
      const colon = entry.indexOf(':')
      const version = colon === -1 ? '' : entry.slice(0, colon).trim()
      if (!/^[1-9][0-9]{0,8}$/.test(version)) {
        return [
          `NUXT_TOKEN_HASH_KEYS entry ${index + 1} must look like <version>:<key>, with a whole number from 1 as the version`,
        ]
      }
      if (keys.some((known) => known.version === Number(version))) {
        return [`NUXT_TOKEN_HASH_KEYS lists version ${version} twice`]
      }
      keys.push({ version: Number(version), key: entry.slice(colon + 1).trim() })
    }
  }

  if (single.trim() !== '') {
    const listed = keys.find((known) => known.version === 1)
    if (listed && listed.key !== single) {
      return [
        'NUXT_TOKEN_HASH_KEY is key version 1, but NUXT_TOKEN_HASH_KEYS lists another key for version 1',
      ]
    }
    if (!listed) keys.push({ version: 1, key: single })
  }

  if (keys.length === 0) return ['NUXT_TOKEN_HASH_KEY is required']
  return keys.flatMap(({ version, key }) =>
    key.trim().length >= MIN_TOKEN_HASH_KEY_LENGTH
      ? []
      : [
          version === 1 && key === single
            ? `NUXT_TOKEN_HASH_KEY must have at least ${MIN_TOKEN_HASH_KEY_LENGTH} characters`
            : `NUXT_TOKEN_HASH_KEYS: the key of version ${version} must have at least ${MIN_TOKEN_HASH_KEY_LENGTH} characters`,
        ],
  )
}

const MAX_HOST_LIST_ENTRIES = 200

/**
 * The problems with a host name or the domain after `*.` in NUXT_OUTBOUND_ALLOWED_HOSTS, or null.
 * The same grammar as `nameProblem` in server/utils/ical-proxy/host-list.ts (this script is plain
 * JS and runs before the server; tests/server/ical-host-list.test.ts feeds one table to both).
 * @param {string} name already trimmed and lower-cased
 * @returns {string | null}
 */
function hostNameProblem(name) {
  if (name === '') return 'is empty'
  if (name.length > 253) return 'is too long for a host name'
  if (/[^\x20-\x7e]/.test(name))
    return 'must be ASCII (write an international name in its xn-- form)'
  if (/\s/.test(name)) return 'must not contain blanks'
  if (name.includes('://')) return 'must be a host name, not a URL'
  if (/[:/?#@[\]\\]/.test(name)) return 'must be a bare host name (no port, path or user name)'
  if (name.includes('*')) return 'may use * only as the first label, written *.example.org'
  const labels = name.split('.')
  for (const label of labels) {
    if (label === '') return 'must not have an empty label (a leading, trailing or double dot)'
    if (label.length > 63) return 'has a label longer than 63 characters'
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      return 'has a label with characters other than letters, digits and -'
    }
  }
  // The URL parser reads a host that ends in a number as an IPv4 address (`1.2.3` is 1.2.0.3).
  const last = labels[labels.length - 1] ?? ''
  if (/^(?:\d+|0x[0-9a-f]*)$/.test(last)) {
    const quad =
      labels.length === 4 && isIP(name) === 4 && labels.every((l) => String(Number(l)) === l)
    if (!quad) return 'looks like an IP address but is not a dotted IPv4 address'
  }
  return null
}

/**
 * @param {string} entry already trimmed and lower-cased
 * @returns {string | null}
 */
function hostEntryProblem(entry) {
  if (entry === '*') {
    return 'must not be a bare * (leave the list empty to allow every public host)'
  }
  if (!entry.startsWith('*.')) return hostNameProblem(entry)
  const name = entry.slice(2)
  const problem = hostNameProblem(name)
  return problem === null && isIP(name) !== 0 ? 'must not put * in front of an IP address' : problem
}

/**
 * The problems with NUXT_OUTBOUND_ALLOWED_HOSTS, one sentence each. Empty means no list.
 * @param {string} text
 * @returns {string[]}
 */
function hostListProblems(text) {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const entries = trimmed.split(',').map((entry) => entry.trim().toLowerCase())
  /** @type {string[]} */
  const problems = []
  if (entries.length > MAX_HOST_LIST_ENTRIES) {
    problems.push(`has more than ${MAX_HOST_LIST_ENTRIES} entries`)
  }
  for (const entry of entries.slice(0, MAX_HOST_LIST_ENTRIES)) {
    const problem = hostEntryProblem(entry)
    if (problem !== null) {
      const shown = entry.length > 40 ? `${entry.slice(0, 40)}...` : entry
      problems.push(`the entry ${JSON.stringify(shown)} ${problem}`)
    }
  }
  return problems
}

/**
 * Whether NUXT_EXTERNAL_SEAL_KEY is 32 random bytes as 64 hex characters or as base64: the rules of
 * `parseSealKey` in server/utils/external/seal.ts (tests/server/external-seal.test.ts keeps the
 * two equal). The value is never echoed.
 * @param {string} text
 */
function isSealKey(text) {
  const value = text.trim()
  /** @type {Buffer | null} */
  let key = null
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, 'hex')
  else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(value)) key = Buffer.from(value, 'base64')
  if (key === null || key.length !== 32) return false
  return !key.every((byte) => byte === key[0])
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

  errors.push(...tokenHashKeyErrors(env))

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

  // Empty means unset for both: Compose passes them on even when .env leaves them empty.
  const hostProblems = hostListProblems(env.NUXT_OUTBOUND_ALLOWED_HOSTS ?? '')
  if (hostProblems.length > 0) {
    errors.push(
      `NUXT_OUTBOUND_ALLOWED_HOSTS cannot be used (comma-separated host names such as ` +
        `cal.example.org or *.example.org): ${hostProblems.join('; ')}`,
    )
  }
  const sealKey = get('NUXT_EXTERNAL_SEAL_KEY')
  if (sealKey !== '' && !isSealKey(sealKey)) {
    errors.push(
      'NUXT_EXTERNAL_SEAL_KEY must be 32 random bytes written as 64 hex characters or as base64 ' +
        '(generate one with: openssl rand -base64 32)',
    )
  }

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
      "NUXT_GROUP_SYNC_TOKEN is not set: Radicale's group file is not filled from Kanidm, so " +
        'group changes never reach it',
    )
  }
  // The interval is a security setting: a removed member keeps access for up to this long.
  checkInteger('NUXT_GROUP_SYNC_INTERVAL_SEC', 1)
  const syncInterval = env.NUXT_GROUP_SYNC_INTERVAL_SEC
  if (syncInterval !== undefined && /^\d{1,15}$/.test(syncInterval) && Number(syncInterval) > 300) {
    errors.push(
      `NUXT_GROUP_SYNC_INTERVAL_SEC must be at most 300 (a removed member keeps access that long), not ${show(syncInterval)}`,
    )
  }
  if (env.NUXT_GROUP_SYNC_FILE !== undefined && !get('NUXT_GROUP_SYNC_FILE')) {
    errors.push('NUXT_GROUP_SYNC_FILE must be a file path; leave it unset for the default')
  }

  // The sharing writer: a longer reconcile interval would leave a share change unapplied for longer.
  checkInteger('NUXT_SHARING_RECONCILE_INTERVAL_SEC', 1)
  const reconcileInterval = env.NUXT_SHARING_RECONCILE_INTERVAL_SEC
  if (
    reconcileInterval !== undefined &&
    /^\d{1,15}$/.test(reconcileInterval) &&
    Number(reconcileInterval) > 900
  ) {
    errors.push(
      `NUXT_SHARING_RECONCILE_INTERVAL_SEC must be at most 900, not ${show(reconcileInterval)}`,
    )
  }
  checkInteger('NUXT_SHARING_AUDIT_INTERVAL_HOURS', 1)
  const auditHours = env.NUXT_SHARING_AUDIT_INTERVAL_HOURS
  if (auditHours !== undefined && /^\d{1,15}$/.test(auditHours) && Number(auditHours) > 168) {
    errors.push(`NUXT_SHARING_AUDIT_INTERVAL_HOURS must be at most 168, not ${show(auditHours)}`)
  }
  // The booking reconcile: a longer interval would leave a moved or deleted event unnoticed longer.
  checkInteger('NUXT_RESOURCES_RECONCILE_INTERVAL_SEC', 1)
  const bookingInterval = env.NUXT_RESOURCES_RECONCILE_INTERVAL_SEC
  if (
    bookingInterval !== undefined &&
    /^\d{1,15}$/.test(bookingInterval) &&
    Number(bookingInterval) > 900
  ) {
    errors.push(
      `NUXT_RESOURCES_RECONCILE_INTERVAL_SEC must be at most 900, not ${show(bookingInterval)}`,
    )
  }
  checkBoolean('NUXT_RESOURCES_MANAGER_CANCEL')
  for (const owner of get('NUXT_SHARING_SHARED_OWNERS')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')) {
    if (!/^_[A-Za-z0-9_.-]{1,63}$/.test(owner) || owner === '_resources') {
      errors.push(
        `NUXT_SHARING_SHARED_OWNERS: ${show(owner)} must be a service principal that starts with _ (and is not _resources)`,
      )
    }
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
