// What `useAuth()` does, without Nuxt: it drives the client, reports the state through `setState`
// and, in demo mode, does nothing at all. The composable only wires it to `useState`, so the
// decisions can be tested in plain Vitest (tests/auth-controller.test.ts).
import { AuthConfigError, AuthRequiredError, describeAuthError } from './errors'
import { createAuthFetch } from './fetch'
import { DEMO_USER } from './state'
import type { AuthClient, AuthStatus, AuthUserInfo, TokenOptions } from './types'

export interface AuthStatePatch {
  status?: AuthStatus
  user?: AuthUserInfo | null
  error?: string | null
}

export interface AuthControllerOptions {
  /** Null when the server gave no sign-in settings. Not used in demo mode. */
  client: AuthClient | null
  demo: boolean
  setState: (patch: AuthStatePatch) => void
  baseFetch?: typeof fetch
  /** The app's origin for `createAuthFetch`; default: the page's. */
  origin?: string
}

export interface AuthController {
  /** Reads the session the client already has and sets the state. Never throws. */
  initialize(): Promise<void>
  /** Redirects to the provider. Resolves only if the page does not go away. */
  login(returnTo?: string): Promise<void>
  /** Finishes the login on the callback page; resolves to where to go next. */
  completeLogin(url: string): Promise<string>
  logout(): Promise<void>
  getAccessToken(options?: TokenOptions): Promise<string>
  /** `fetch` with the bearer token and one renew-and-retry on 401. */
  authFetch: typeof fetch
}

export function createAuthController(options: AuthControllerOptions): AuthController {
  const { client, demo, setState } = options
  const baseFetch = options.baseFetch ?? ((input, init) => globalThis.fetch(input, init))

  function requireClient(): AuthClient {
    if (!client) throw new AuthConfigError()
    return client
  }

  async function login(returnTo = '/'): Promise<void> {
    if (demo) return
    try {
      await requireClient().login(returnTo)
    } catch (error) {
      setState({ status: 'error', error: describeAuthError(error).message })
      throw error
    }
  }

  async function getAccessToken(tokenOptions?: TokenOptions): Promise<string> {
    if (demo) return ''
    try {
      return await requireClient().getAccessToken(tokenOptions)
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        // The session is gone and there is nothing to retry with. No redirect from here: it would
        // throw away what the user has not saved yet (design §6), and an offline renewal failure
        // would send the browser to an unreachable page. The status tells the UI to ask; the route
        // guard signs in at the next navigation.
        setState({ status: 'unauthenticated', user: null })
      }
      throw error
    }
  }

  return {
    async initialize() {
      if (demo) {
        setState({ status: 'authenticated', user: DEMO_USER, error: null })
        return
      }
      if (!client) {
        setState({
          status: 'error',
          user: null,
          error: describeAuthError(new AuthConfigError()).message,
        })
        return
      }
      try {
        const user = await client.init()
        setState({ status: user ? 'authenticated' : 'unauthenticated', user, error: null })
      } catch (error) {
        setState({ status: 'error', user: null, error: describeAuthError(error).message })
      }
    },

    login,

    async completeLogin(url) {
      if (demo) return '/'
      const authClient = requireClient()
      try {
        const returnTo = await authClient.completeLogin(url)
        // The state is set before the caller navigates: the route guard of the target page reads it.
        setState({ status: 'authenticated', user: authClient.user, error: null })
        return returnTo
      } catch (error) {
        setState({ status: 'error', user: null, error: describeAuthError(error).message })
        throw error
      }
    },

    async logout() {
      if (demo) return
      const authClient = requireClient()
      setState({ status: 'unauthenticated', user: null })
      await authClient.logout()
    },

    getAccessToken,

    authFetch: demo
      ? (input, init) => baseFetch(input, init)
      : createAuthFetch(getAccessToken, baseFetch, { origin: options.origin }),
  }
}
