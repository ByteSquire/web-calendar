// The browser login as the rest of the app sees it (FR-12): who is signed in, a bearer token for
// the API and a `fetch` that adds it. The logic is in utils/auth/controller.ts; this wires it to
// the shared state and to the settings from `/api/config`. In demo mode (no login, mock data)
// every function is a no-op and the user is the mock user.
import { createAuthClient } from '~/utils/auth/client'
import { createAuthController, type AuthController } from '~/utils/auth/controller'
import { isDemoConfig } from '~/utils/auth/state'
import type { AuthStatus, AuthUserInfo } from '~/utils/auth/types'
import { createOidcUserManager } from '~/utils/auth/user-manager'
import { useServerConfigState } from '~/composables/useServerConfigState'
import type { ServerConfig } from '~/plugins/server-config'

// One controller per app and per set of settings: the client holds the tokens in memory and the
// single renewal in flight. The settings are loaded once at startup; this only reacts to a test
// (or a future reload) replacing them.
const controllers = new WeakMap<
  object,
  { config: ServerConfig | null; controller: AuthController }
>()

export function useAuth() {
  const nuxtApp = useNuxtApp()
  const status = useState<AuthStatus>('auth-status', () => 'loading')
  const user = useState<AuthUserInfo | null>('auth-user', () => null)
  const error = useState<string | null>('auth-error', () => null)
  const config = useServerConfigState()

  let cached = controllers.get(nuxtApp)
  if (!cached || cached.config !== config.value) {
    const oidc = config.value?.oidc
    const controller = createAuthController({
      // An empty issuer means `/api/config` failed or the server has no sign-in set up. Demo mode
      // never signs in, so it gets no client (and does not touch the browser storage).
      client:
        !isDemoConfig(config.value) && oidc?.issuer && oidc.clientId
          ? createAuthClient({
              issuer: oidc.issuer,
              clientId: oidc.clientId,
              scope: oidc.scope,
              origin: window.location.origin,
              createUserManager: createOidcUserManager,
            })
          : null,
      demo: isDemoConfig(config.value),
      setState(patch) {
        if (patch.status !== undefined) status.value = patch.status
        if (patch.user !== undefined) user.value = patch.user
        if (patch.error !== undefined) error.value = patch.error
      },
    })
    cached = { config: config.value, controller }
    controllers.set(nuxtApp, cached)
  }
  const auth = cached.controller

  return {
    /** `loading` until the plugin has looked for a session. */
    status: readonly(status),
    user: readonly(user),
    /** Why the status is `error`, worded for people. */
    error: readonly(error),
    isDemo: computed(() => isDemoConfig(config.value)),
    /** For the auth plugin only. */
    initialize: auth.initialize,
    login: auth.login,
    completeLogin: auth.completeLogin,
    logout: auth.logout,
    getAccessToken: auth.getAccessToken,
    authFetch: auth.authFetch,
  }
}
