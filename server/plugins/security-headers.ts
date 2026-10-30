import { installSecurityHeaders } from '../utils/security/install'
import { originOf } from '../utils/security/headers'

// Content-Security-Policy and the other security headers on every response (review M2).
export default defineNitroPlugin((nitroApp) => {
  const issuerOrigin = originOf(useRuntimeConfig().oidc.issuer)
  installSecurityHeaders(nitroApp.hooks, {
    connectOrigins: issuerOrigin ? [issuerOrigin] : [],
    enforcePolicy: !import.meta.dev,
  })
})
