#!/usr/bin/env node
// Standalone config validation script for container startup.
// Exits with code 1 if required NUXT_* environment variables are missing.

const required = {
  oidc: ['issuer', 'clientId', 'clientSecret', 'redirectUri'],
  caldav: ['baseUrl'],
  sync: ['intervalMin'],
}

function validate(config, path = '') {
  const missing = []
  for (const [key, value] of Object.entries(config)) {
    const fullPath = path ? `${path}.${key}` : key
    if (value && typeof value === 'object') {
      missing.push(...validate(value, fullPath))
    } else if (required[path]?.includes(key) && (!value || value === '')) {
      missing.push(fullPath)
    }
  }
  return missing
}

const runtimeConfig = {
  oidc: {
    issuer: process.env.NUXT_OIDC_ISSUER || '',
    clientId: process.env.NUXT_OIDC_CLIENT_ID || '',
    clientSecret: process.env.NUXT_OIDC_CLIENT_SECRET || '',
    redirectUri: process.env.NUXT_OIDC_REDIRECT_URI || '',
  },
  caldav: {
    baseUrl: process.env.NUXT_CALDAV_BASE_URL || '',
  },
  sync: {
    intervalMin: process.env.NUXT_SYNC_INTERVAL_MIN || '5',
  },
}

const missing = validate(runtimeConfig)

if (missing.length > 0) {
  console.error('[config] Missing required runtime config:')
  for (const key of missing) {
    console.error(`  - ${key}`)
  }
  console.error('[config] Set corresponding NUXT_* environment variables.')
  process.exit(1)
}

console.log('[config] Validation passed')
