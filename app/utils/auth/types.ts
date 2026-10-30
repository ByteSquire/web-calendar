// Shared types of the browser login (FR-12): the signed-in user, the state the UI reads and the
// shape of the client the composables use. Kept apart so the pure modules do not import each other.

/** The signed-in user, from the ID token claims. */
export interface AuthUserInfo {
  sub: string
  /** What to show: the `name` claim, else the user name, e-mail or `sub`. */
  name: string
  email: string | null
  /** The `preferred_username` claim. */
  username: string | null
}

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error'

export interface TokenOptions {
  /**
   * The access token a server just refused (401). If it is still the current one it is renewed even
   * though it has not expired; if another request already replaced it, the current one is returned.
   */
  rejectedToken?: string
}

/** Where `createAuthFetch` and the composables get the bearer token from. */
export type TokenProvider = (options?: TokenOptions) => Promise<string>

export interface AuthClient {
  /** Loads the user the manager already holds (none after a page reload: tokens live in memory). */
  init(): Promise<AuthUserInfo | null>
  /** Redirects to the provider. `returnTo` is where the app continues afterwards. */
  login(returnTo?: string): Promise<void>
  /** Finishes the login on the callback page; resolves to the (safe) `returnTo`. */
  completeLogin(url: string): Promise<string>
  /** An access token that stays valid for at least a minute, renewed on demand. */
  getAccessToken: TokenProvider
  logout(): Promise<void>
  /** The user as of the last init, login, renewal or logout. */
  readonly user: AuthUserInfo | null
}
