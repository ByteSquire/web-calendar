/** An OAuth2 client whose access tokens the gateway accepts, with the issuer Kanidm gives it. */
export interface AllowedClient {
  clientId: string
  issuer: string
}

const CLIENT_ID = /^[A-Za-z0-9._~-]+$/

/**
 * Kanidm scopes issuer and signing keys per client: `https://<kanidm>/oauth2/openid/<client>`.
 * The issuer of another client is the configured one with its last path segment replaced. The text
 * is kept as configured otherwise, because `iss` must match what the provider writes character by
 * character.
 */
export function deriveClientIssuer(issuer: string, clientId: string): string {
  if (!CLIENT_ID.test(clientId))
    throw new Error(`invalid OIDC client id: ${JSON.stringify(clientId)}`)
  const trimmed = issuer.replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`invalid OIDC issuer URL: ${JSON.stringify(issuer)}`)
  }
  if (url.pathname === '/' || url.search || url.hash) {
    throw new Error(`OIDC issuer must end in the client id, got ${JSON.stringify(issuer)}`)
  }
  return trimmed.slice(0, trimmed.lastIndexOf('/') + 1) + clientId
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
  return ids.map((clientId) => ({ clientId, issuer: deriveClientIssuer(config.issuer, clientId) }))
}
