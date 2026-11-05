import { resolveTimeZone } from '../../shared/utils/time-zone'
import { parseSigninWindowDays } from '../utils/auth/window'

// The public values the SPA needs before it can log in. No secrets.
export default defineEventHandler((event) => {
  const { oidc, demo, signinWindowDays } = useRuntimeConfig(event)
  return {
    oidc: { issuer: oidc.issuer, clientId: oidc.clientId, scope: oidc.scope },
    // Demo mode: no login, mock data (NUXT_DEMO).
    demo: demo === true || String(demo) === 'true',
    // The organization time zone (FR-29): `TZ`, validated at startup by server/validate-config.mjs.
    timezone: resolveTimeZone(process.env.TZ),
    // Days after the last sign-in that an app token works (NUXT_SIGNIN_WINDOW_DAYS); the Settings
    // page says so next to the tokens.
    signinWindowDays: parseSigninWindowDays(signinWindowDays),
  }
})
