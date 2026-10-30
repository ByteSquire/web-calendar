// The browser login (FR-12, design §6): authorization code flow with PKCE against the identity
// provider, tokens in memory. This is a thin wrapper around oidc-client-ts' `UserManager` that
// owns the rules of this app. The manager is injected (`createUserManager`), so tests use a fake
// and this file does not import the library at runtime; the real factory is in user-manager.ts.
import { AuthRequiredError } from './errors'
import { safeReturnTo } from './return-to'
import { SIGNED_OUT_PATH } from './state'
import type { AuthClient, AuthUserInfo, TokenOptions } from './types'

/** The part of oidc-client-ts' `User` this client reads. */
export interface OidcUserLike {
  access_token: string
  /** Seconds since the epoch. */
  expires_at?: number
  refresh_token?: string
  profile: { sub: string; name?: string; email?: string; preferred_username?: string }
  /** What `login` passed as `state`. */
  state?: unknown
}

/** The part of oidc-client-ts' `UserManager` this client calls; the real class fits as it is. */
export interface OidcManagerLike {
  getUser(): Promise<OidcUserLike | null>
  removeUser(): Promise<void>
  signinRedirect(args?: { state?: unknown }): Promise<void>
  signinRedirectCallback(url?: string): Promise<OidcUserLike>
  /** With a refresh token this is the refresh grant. */
  signinSilent(): Promise<OidcUserLike | null>
  signoutRedirect(): Promise<void>
  /** RFC 7009: asks the provider to invalidate the stored user's token(s) of these types. */
  revokeTokens(types: Array<'access_token' | 'refresh_token'>): Promise<void>
  metadataService: {
    getEndSessionEndpoint(): Promise<string | undefined>
    getRevocationEndpoint(): Promise<string | undefined>
  }
}

/** The settings the client decides; user-manager.ts adds the two storages. */
export interface OidcSettings {
  authority: string
  client_id: string
  redirect_uri: string
  post_logout_redirect_uri: string
  response_type: 'code'
  scope: string
  automaticSilentRenew: false
  loadUserInfo: false
  revokeTokenAdditionalContentTypes: string[]
}

export interface AuthClientOptions {
  /** The provider's per-client issuer, e.g. `https://idm.example.org/oauth2/openid/web-calendar`. */
  issuer: string
  clientId: string
  scope: string
  /** The origin the app is served from, e.g. `https://calendar.example.org`. */
  origin: string
  createUserManager: (settings: OidcSettings) => OidcManagerLike
  /** Leaves the page for a URL of this origin; the real one is `location.assign`. */
  navigate?: (url: string) => void
  /** Milliseconds since the epoch; for tests. */
  now?: () => number
  /** Where logout goes when the provider has no end-session endpoint. */
  signedOutPath?: string
  /** The longest logout waits for the provider (revoking the tokens); default 3000 ms. */
  providerTimeoutMs?: number
}

/** A token must stay valid for this long after it is handed out (design §6: 15 minute tokens). */
export const MIN_TOKEN_VALIDITY_SEC = 60

/** Signing out never waits longer than this for the provider. */
export const PROVIDER_TIMEOUT_MS = 3000

export function buildOidcSettings(
  options: Pick<AuthClientOptions, 'issuer' | 'clientId' | 'scope' | 'origin'>,
): OidcSettings {
  const origin = options.origin.replace(/\/+$/, '')
  return {
    authority: options.issuer,
    client_id: options.clientId,
    redirect_uri: `${origin}/auth/callback`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: 'code',
    scope: options.scope,
    // Renewal happens on demand in getAccessToken; a timer would also renew in idle background tabs.
    automaticSilentRenew: false,
    // The ID token has what the UI shows; groups are checked on the server.
    loadUserInfo: false,
    // Kanidm answers a revocation with "200 text/plain" (RFC 7009 has no body); the library
    // refuses any content type it does not know and would report a successful revocation as failed.
    revokeTokenAdditionalContentTypes: ['text/plain'],
  }
}

function toUserInfo(profile: OidcUserLike['profile']): AuthUserInfo {
  const username = profile.preferred_username || null
  const email = profile.email || null
  return {
    sub: profile.sub,
    name: profile.name || username || email || profile.sub,
    email,
    username,
  }
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const manager = options.createUserManager(buildOidcSettings(options))
  const now = options.now ?? Date.now
  const navigate = options.navigate ?? ((url: string) => globalThis.location.assign(url))
  const signedOutPath = options.signedOutPath ?? SIGNED_OUT_PATH
  const providerTimeoutMs = options.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS

  let user: AuthUserInfo | null = null
  // ONE renewal at a time. Kanidm rotates the refresh token on every use and treats a second use of
  // an old one as theft: it revokes the whole session. Two renewals in parallel would log the user out.
  let renewing: Promise<OidcUserLike> | null = null
  let redirecting: Promise<void> | null = null
  // Set when logout starts, cleared by the next login. A renewal that was under way must not bring
  // the session back, and nothing may hand out a token after the user asked to sign out.
  let signedOut = false
  // The callback must run once: the stored login state is gone after the first run, so a second
  // run (a remount, hot reload) would fail with a confusing "no matching state".
  const completions = new Map<string, Promise<string>>()

  function remember(value: OidcUserLike | null): void {
    user = value ? toUserInfo(value.profile) : null
  }

  function expiresSoon(value: OidcUserLike): boolean {
    if (value.expires_at === undefined) return false
    return value.expires_at - now() / 1000 < MIN_TOKEN_VALIDITY_SEC
  }

  function renew(): Promise<OidcUserLike> {
    renewing ??= (async () => {
      try {
        const renewed = await manager.signinSilent()
        if (!renewed) throw new Error('The provider returned no user')
        // Logout started meanwhile: the library has stored the renewed user, but logout owns the
        // local state now. It revokes this newest refresh token and removes the user.
        if (signedOut) throw new AuthRequiredError('signed-out')
        remember(renewed)
        return renewed
      } catch (cause) {
        if (signedOut) {
          throw cause instanceof AuthRequiredError ? cause : new AuthRequiredError('signed-out')
        }
        // The refresh token is spent or revoked, or the provider cannot be reached: there is no
        // session to go on with. Do not try again with the old token (that would be a replay).
        user = null
        await manager.removeUser().catch(() => undefined)
        throw new AuthRequiredError('renewal-failed', { cause })
      }
    })().finally(() => {
      renewing = null
    })
    return renewing
  }

  /**
   * Before the local sign-out: invalidates the session's tokens at the provider (RFC 7009), so a
   * token copied from this browser is worth nothing. Best effort: it resolves with the provider's
   * end-session endpoint (if it has one) and never rejects. Errors are dropped on purpose: the
   * library's errors carry the request body, which holds the token.
   */
  async function signOutAtProvider(): Promise<string | undefined> {
    try {
      // A renewal under way replaces the refresh token: wait for it, so the newest one is revoked.
      await renewing?.catch(() => undefined)
      const metadata = manager.metadataService
      const [endSession, revocation] = await Promise.all([
        metadata.getEndSessionEndpoint().catch(() => undefined),
        metadata.getRevocationEndpoint().catch(() => undefined),
      ])
      if (revocation) {
        const current = await manager.getUser()
        if (current) {
          // Kanidm ends the whole login session (access token too) when either token is revoked.
          await manager
            .revokeTokens([current.refresh_token ? 'refresh_token' : 'access_token'])
            .catch(() => undefined)
        }
      }
      return endSession
    } catch {
      return undefined
    }
  }

  /** `work`'s result, or `undefined` once `ms` have passed; the work itself keeps going. */
  function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms)
    })
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
  }

  return {
    get user() {
      return user
    },

    async init() {
      remember(await manager.getUser())
      return user
    },

    login(returnTo = '/') {
      signedOut = false
      // A second call (several failed requests at once) joins the redirect that is under way.
      // The promise only settles if the page does not go away (back/forward cache) or fails.
      redirecting ??= manager
        .signinRedirect({ state: { returnTo: safeReturnTo(returnTo) } })
        .finally(() => {
          redirecting = null
        })
      return redirecting
    },

    completeLogin(url) {
      signedOut = false
      let done = completions.get(url)
      if (!done) {
        done = manager.signinRedirectCallback(url).then((signedIn) => {
          remember(signedIn)
          const state = signedIn.state
          const stored = typeof state === 'object' && state !== null ? state : {}
          return safeReturnTo((stored as { returnTo?: unknown }).returnTo)
        })
        completions.set(url, done)
      }
      return done
    },

    async getAccessToken(tokenOptions: TokenOptions = {}) {
      if (signedOut) throw new AuthRequiredError('signed-out')
      const current = await manager.getUser()
      if (!current) {
        user = null
        throw new AuthRequiredError('signed-out')
      }
      remember(current)
      const rejected = tokenOptions.rejectedToken === current.access_token
      if (!rejected && !expiresSoon(current)) return current.access_token
      return (await renew()).access_token
    },

    async logout() {
      // From here on no token is handed out and a renewal under way is ignored.
      signedOut = true
      user = null
      // The provider part is best effort and capped: signing out here never waits longer for it.
      let finished = false
      const atProvider = signOutAtProvider().finally(() => {
        finished = true
      })
      const endSession = await within(atProvider, providerTimeoutMs)
      if (endSession) {
        try {
          // Removes the local user itself and leaves the page for the provider.
          await manager.signoutRedirect()
          return
        } catch {
          // Fall through: the local state goes in any case.
        }
      }
      await manager.removeUser()
      // If the provider part is still running (it timed out), the library may store the user again
      // when it ends: remove it once more then.
      if (!finished) void atProvider.then(() => manager.removeUser()).catch(() => undefined)
      // The provider cannot end its own session (Kanidm has no end-session endpoint), so going
      // straight back into the app would sign the user in again at once.
      navigate(signedOutPath)
    },
  }
}
