#!/usr/bin/env node
// Startup config validation (design §12). The container runs this script before the server and
// stops with a readable message instead of failing on the first request. The checks are in the pure
// validateEnv(), which tests/validate-config.test.ts covers.
import { pathToFileURL } from 'node:url'

// Same default as runtimeConfig.oidc.clientId in nuxt.config.ts.
const DEFAULT_CLIENT_ID = 'web-calendar'
const MIN_TOKEN_HASH_KEY_LENGTH = 32

/** @param {string} value */
function parseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * Checks the NUXT_* variables the server cannot run without. Secret values are never echoed.
 * @param {Record<string, string | undefined>} env
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateEnv(env) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  const get = (/** @type {string} */ name) => (env[name] ?? '').trim()

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
