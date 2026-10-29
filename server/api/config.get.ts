// The public values the SPA needs before it can log in. No secrets.
export default defineEventHandler((event) => {
  const { oidc } = useRuntimeConfig(event)
  return {
    oidc: { issuer: oidc.issuer, clientId: oidc.clientId, scope: oidc.scope },
    timezone: process.env.TZ || 'Europe/Berlin',
  }
})
