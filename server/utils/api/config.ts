// The runtime config the API routes need, in one place so the routes stay free of Nitro globals
// and tests can replace it. Reads the config on each call; Nitro keeps it cached.

export interface ApiConfig {
  /** Key for hashing app tokens (NUXT_TOKEN_HASH_KEY). */
  tokenHashKey: string
  /** OIDC issuer (NUXT_OIDC_ISSUER); userinfo is `<issuer>/userinfo`. */
  oidcIssuer: string
  /** Kanidm group whose members are admins (NUXT_OIDC_ADMIN_GROUP). */
  adminGroup: string
}

export function apiConfig(): ApiConfig {
  const { oidc, tokenHashKey } = useRuntimeConfig()
  return { tokenHashKey, oidcIssuer: oidc.issuer, adminGroup: oidc.adminGroup }
}
