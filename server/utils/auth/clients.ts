/** An OAuth2 client whose access tokens the gateway accepts, with the issuer its tokens carry. */
export interface AllowedClient {
  clientId: string
  issuer: string
}

const CLIENT_ID = /^[A-Za-z0-9._~-]+$/

/**
 * The issuer of the tokens of `clientId`. Most providers have one issuer for all clients, and that
 * is then the configured one. Kanidm scopes issuer and signing keys per client
 * (`https://<kanidm>/oauth2/openid/<client>`): when the configured issuer ends in the app's own
 * client id, another client's issuer is that with the last path segment replaced. The text is kept
 * as configured otherwise, a trailing slash included, because `iss` must match what the provider
 * writes character by character.
 */
export function deriveClientIssuer(issuer: string, ownClientId: string, clientId: string): string {
  if (!CLIENT_ID.test(clientId))
    throw new Error(`invalid OIDC client id: ${JSON.stringify(clientId)}`)
  try {
    new URL(issuer)
  } catch {
    throw new Error(`invalid OIDC issuer URL: ${JSON.stringify(issuer)}`)
  }
  const perClient = `/${ownClientId}`
  if (!issuer.endsWith(perClient)) return issuer
  return issuer.slice(0, issuer.length - ownClientId.length) + clientId
}

/** The allow-list from `runtimeConfig.oidc`: `allowedClients` (comma-separated), else `clientId`. */
export function buildAllowedClients(config: {
  issuer: string
  clientId: string
  allowedClients: string
}): AllowedClient[] {
  const listed = config.allowedClients
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  const ids = [...new Set(listed.length > 0 ? listed : [config.clientId])]
  return ids.map((clientId) => ({
    clientId,
    issuer: deriveClientIssuer(config.issuer, config.clientId, clientId),
  }))
}
