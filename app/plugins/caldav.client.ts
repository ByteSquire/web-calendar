// The CalDAV transport for the signed-in user (FR-8): a client for the gateway at `/caldav` and a
// reader with the 30 s cache (design §7). Not created in demo mode, which shows the mock data.
import { useAuth } from '~/composables/useAuth'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { createCalDavClient } from '~/utils/caldav/client'
import { createCalendarReader } from '~/utils/caldav/reader'
import { davFetchFrom } from '~/utils/live/dav-fetch'
import { isLiveConfig } from '~/utils/live/seed'
import type { CalDav } from '~/composables/useCalDav'

export default defineNuxtPlugin({
  name: 'caldav',
  dependsOn: ['auth'],
  setup() {
    if (!isLiveConfig(useServerConfigState().value)) return
    const auth = useAuth()
    const client = createCalDavClient({
      baseUrl: `${window.location.origin}/caldav`,
      // A failed token renewal becomes `unauthorized`, which the sidebar words as "Sign-in expired".
      fetch: davFetchFrom(auth.authFetch),
    })
    // Radicale matches floating and all-day events as if they were UTC: the reader pads by a day.
    const reader = createCalendarReader(client, { ttlMs: 30_000, concurrency: 6, padDays: 1 })
    const caldav: CalDav = { client, reader }
    return { provide: { caldav } }
  },
})
