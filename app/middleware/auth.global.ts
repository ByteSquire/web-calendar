// The route guard of the login (FR-12): every page except the login's own needs a session. Without
// one the browser goes to the identity provider, which logs the user in silently when its own
// session exists, and comes back to the page that was asked for.
import { useAuth } from '~/composables/useAuth'
import { routeGuardAction } from '~/utils/auth/state'

export default defineNuxtRouteMiddleware(async (to, from) => {
  if (import.meta.server) return
  const auth = useAuth()

  // The plugin has finished before the first navigation; this only matters if it is slow.
  if (auth.status.value === 'loading') {
    await new Promise<void>((resolve) => {
      const stop = watch(
        auth.status,
        (status) => {
          if (status !== 'loading') {
            stop()
            resolve()
          }
        },
        { immediate: true },
      )
    })
  }

  const action = routeGuardAction({
    demo: auth.isDemo.value,
    status: auth.status.value,
    path: to.path,
    from: from.path,
  })
  if (action === 'pass') return

  try {
    await auth.login(to.fullPath)
  } catch (cause) {
    // The provider cannot be reached or sign-in is not configured: say so instead of a blank page.
    return createError({
      statusCode: 503,
      statusMessage: 'Sign-in is not available',
      message: auth.error.value ?? 'Sign-in is not available',
      cause,
      fatal: true,
    })
  }
  // The browser is on its way to the provider; the redirect settles only if the page stays (a
  // restore from the back/forward cache, handled by the plugin). Until it leaves, the navigation
  // stays open, so the layout and the pages (and the data they would load) never start. Returning
  // `false` would not do: on the first navigation Nuxt turns it into a 404 page.
  return new Promise<never>(() => {})
})
