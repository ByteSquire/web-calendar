// The runtime config the API routes need, in one place so the routes stay free of Nitro globals
// and tests can replace it. Reads the config on each call; Nitro keeps it cached.
import type { TokenHashKeys } from '../../db/app-tokens'
import { getTokenKeyring } from '../auth/nitro'

export interface ApiConfig {
  /** Keys for hashing app tokens (NUXT_TOKEN_HASH_KEY, NUXT_TOKEN_HASH_KEYS); see token-keys.ts. */
  tokenHashKey: TokenHashKeys
  /** OIDC issuer (NUXT_OIDC_ISSUER); userinfo is `<issuer>/userinfo`. */
  oidcIssuer: string
  /** Kanidm group whose members are admins (NUXT_OIDC_ADMIN_GROUP). */
  adminGroup: string
  /** A manager of a resource may cancel the bookings of others (NUXT_RESOURCES_MANAGER_CANCEL). */
  managerCancel: boolean
}

export function apiConfig(): ApiConfig {
  const { oidc, resources } = useRuntimeConfig()
  return {
    tokenHashKey: getTokenKeyring(),
    oidcIssuer: oidc.issuer,
    adminGroup: oidc.adminGroup,
    managerCancel: String(resources.managerCancel) !== 'false',
  }
}
