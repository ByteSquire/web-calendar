import { resolveTimeZone } from '../../shared/utils/time-zone'

// The public values the SPA needs before it can log in. No secrets.
export default defineEventHandler((event) => {
  const { oidc } = useRuntimeConfig(event)
  return {
    oidc: { issuer: oidc.issuer, clientId: oidc.clientId, scope: oidc.scope },
    // The organization time zone (FR-29): `TZ`, validated at startup by server/validate-config.mjs.
    timezone: resolveTimeZone(process.env.TZ),
  }
})
