import { AuthError } from '../auth/errors'
import { authenticateCalDav } from '../auth/nitro'
import { parseSigninWindowDays } from '../auth/window'
import { handleGatewayRequest } from '../gateway/nitro'
import { getIcalProxy } from '../ical-proxy/nitro'
import { createSelfTestEvent, runStartupChecks } from './startup-checks'

// Builds the security-relevant parts now (L2). Their glue modules read the runtime config on the
// first request, so a typo in NUXT_OIDC_KEY_MAX_AGE_SEC or NUXT_GATEWAY_MAX_BODY_BYTES would show
// up as a 500 on every request of a container that looks healthy. Same pattern as plugins/db.ts:
// on a failure the process exits with a readable message, and requests wait for the checks.

/** The part of Nitro's hooks this module uses. */
export interface RequestHooks {
  hook(name: 'request', handler: () => Promise<void>): unknown
}

export function installStartupChecks(
  hooks: RequestHooks,
  options: { demo: unknown; signinWindowDays?: unknown },
): void {
  if (options.demo === true || String(options.demo) === 'true') {
    console.warn(
      '[config] WARNING: DEMO MODE (NUXT_DEMO=true). The SPA skips the login and shows mock data. ' +
        'For previews and browser tests only, not for a real deployment.',
    )
  }

  async function start(): Promise<void> {
    const failures = await runStartupChecks([
      {
        // Builds the token verifier. Without credentials the answer must be "no credentials".
        name: 'OIDC token verifier (NUXT_OIDC_*)',
        run: async () => {
          try {
            await authenticateCalDav(new Headers())
          } catch (error) {
            if (error instanceof AuthError && error.reason === 'no-credentials') return
            throw error
          }
          throw new Error('a request without credentials was accepted')
        },
      },
      {
        // Builds the gateway; goes through the verifier like a real request and must be refused.
        name: 'CalDAV gateway (NUXT_GATEWAY_*, NUXT_RADICALE_URL)',
        run: async () => {
          const response = await handleGatewayRequest(createSelfTestEvent('GET', '/caldav/'))
          if (response.status !== 401) {
            throw new Error(`GET /caldav/ without credentials answered ${response.status}, not 401`)
          }
        },
      },
      { name: 'iCal proxy (NUXT_ICAL_PROXY_*)', run: () => getIcalProxy() },
      // A number of days from 1 to 365; the window bounds the app tokens and the group of everyone.
      {
        name: 'Sign-in window (NUXT_SIGNIN_WINDOW_DAYS)',
        run: () => parseSigninWindowDays(options.signinWindowDays),
      },
    ])
    if (failures.length > 0) {
      throw new Error(failures.map((failure) => `\n  - ${failure}`).join(''))
    }
  }

  const ready = start().catch((error: unknown) => {
    console.error(
      `[startup] The server cannot start with this configuration:${error instanceof Error ? error.message : String(error)}\n` +
        '[startup] Fix the NUXT_* environment variables (see .env.example) and start again.',
    )
    process.exit(1)
  })
  hooks.hook('request', () => ready)
}
