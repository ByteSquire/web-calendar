// Loads the public server settings (`/api/config`) before the app mounts, so the organization time
// zone (FR-29) and, later, the login settings are known to every component. If the request fails
// the defaults apply and the failure is logged.
import { DEFAULT_TIME_ZONE } from '../../shared/utils/time-zone'

export interface ServerConfig {
  oidc: { issuer: string; clientId: string; scope: string }
  /** The organization time zone, an IANA name. */
  timezone: string
  /** Demo mode: no login, mock data. */
  demo: boolean
  /** Days after a person's last sign-in that their app tokens still work. */
  signinWindowDays: number
}

// Named so that plugins that need the settings (the login) can depend on it.
export default defineNuxtPlugin({
  name: 'server-config',
  async setup() {
    const config = useServerConfigState()
    try {
      config.value = await $fetch<ServerConfig>('/api/config')
    } catch (error) {
      console.error('Could not load /api/config; using defaults', error)
      config.value = {
        oidc: { issuer: '', clientId: '', scope: '' },
        timezone: DEFAULT_TIME_ZONE,
        demo: false,
        signinWindowDays: 30,
      }
    }
  },
})
