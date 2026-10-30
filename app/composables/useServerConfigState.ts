import type { ServerConfig } from '~/plugins/server-config'

/** The shared holder of the settings the plugin in plugins/server-config.ts loads at startup. */
export function useServerConfigState() {
  return useState<ServerConfig | null>('server-config', () => null)
}
