// The CalDAV client and the event reader of the signed-in session, created by plugins/caldav.client.ts.
// `null` in demo mode and wherever the plugin does not run (there is nothing to talk to).
import type { CalDavClient } from '~/utils/caldav/client'
import type { CalendarReader } from '~/utils/caldav/reader'

export interface CalDav {
  client: CalDavClient
  reader: CalendarReader
}

export function useCalDav(): CalDav | null {
  // Typed through a cast: the plugin's `provide` is only known to `.nuxt` after `nuxt prepare`.
  return (useNuxtApp() as unknown as { $caldav?: CalDav }).$caldav ?? null
}
