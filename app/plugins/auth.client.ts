// Starts the browser login (FR-12): looks for a session once the settings from `/api/config` are
// known, so the route guard (middleware/auth.global.ts) can decide at the first navigation. It
// never redirects itself: the guard does, and the callback page must stay quiet.
import { useAuth } from '~/composables/useAuth'

export default defineNuxtPlugin({
  name: 'auth',
  dependsOn: ['server-config'],
  async setup() {
    const auth = useAuth()
    await auth.initialize()

    // A page restored from the back/forward cache (the user pressed Back on the provider's login
    // page) is a frozen app that never finished starting: load it again.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && auth.status.value !== 'authenticated') window.location.reload()
    })
  },
})
