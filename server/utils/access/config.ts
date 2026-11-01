// The settings the access administration needs, in one place so tests can replace them.
import { kanidmOrigin } from '../group-sync/kanidm'

export interface AccessConfig {
  /** Origin of Kanidm and the group-sync API token; null when groups cannot be looked up. */
  kanidm: { origin: string; token: string } | null
}

export function accessConfig(): AccessConfig {
  const config = useRuntimeConfig()
  const token = String(config.groupSync?.token ?? '').trim()
  const origin = kanidmOrigin(String(config.oidc?.issuer ?? ''))
  return { kanidm: token && origin ? { origin, token } : null }
}
