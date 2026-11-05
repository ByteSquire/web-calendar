// Live data for the calendar (FR-8, FR-10, FR-3..FR-5): `useLiveCalendar()` is called once, by the
// default layout, and keeps the calendar state filled from the API and CalDAV. `useLiveStatus()`
// is what the rest of the UI reads (progress, problems) and calls (refresh, retry).
// The logic is in utils/live/loader.ts; this binds it to Nuxt. Both are no-ops in demo mode.
import { useAuth } from '~/composables/useAuth'
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useCalDav } from '~/composables/useCalDav'
import { useCalendarState } from '~/composables/useCalendarState'
import { useExternalAccess } from '~/composables/useExternalAccess'
import { useResourceUpdates } from '~/composables/useResourceUpdates'
import { useSidebarOrderState } from '~/composables/useSidebarOrder'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { t } from '~/utils/i18n'
import { fetchIcsText } from '~/utils/live/ics'
import { createLiveLoader, type LiveLoader } from '~/utils/live/loader'
import { isLiveConfig } from '~/utils/live/seed'
import { createLiveStatusState } from '~/utils/live/status'
import type { ResourceRight } from '~/utils/resources/types'
import { completeSidebarOrder } from '../../shared/utils/sidebar-sections'

// One loader per app: the layout creates it, `useLiveStatus` reaches it from anywhere.
const loaders = new WeakMap<object, LiveLoader>()

/** The shared state the settings screen bumps when sources change (subscriptions, calendars). */
export function useCalendarSourcesVersion() {
  return useState<number>('calendar-sources-version', () => 0)
}

export function useLiveStatus() {
  const nuxtApp = useNuxtApp()
  const { loading, errors, skipped, lastLoadedAt, externalAccounts, passwordFor } =
    createLiveStatusState(useState)
  return {
    /** A load is running. */
    loading: readonly(loading),
    /** What could not be loaded: calendar id (or `source:...`) -> short message. */
    errors: readonly(errors),
    /** Calendar id -> how many entries of it could not be read. */
    skipped: readonly(skipped),
    /** The external accounts as the loader last read them. */
    externalAccounts: readonly(externalAccounts),
    /** The problems a new password cures: key of `errors` -> the external account's id. */
    passwordFor: readonly(passwordFor),
    /** Epoch milliseconds of the last finished load of events. */
    lastLoadedAt: readonly(lastLoadedAt),
    /**
     * Reload the calendars and events, bypassing the short-lived cache (FR-10); `external: false`
     * leaves the external accounts out.
     */
    refresh: (options?: { external?: boolean }): Promise<void> =>
      loaders.get(nuxtApp)?.refresh(options) ?? Promise.resolve(),
    /** Load one failed calendar (or source) again. */
    retry: (key: string): Promise<void> => loaders.get(nuxtApp)?.retry(key) ?? Promise.resolve(),
  }
}

export function useLiveCalendar(): void {
  if (!import.meta.client) return
  const config = useServerConfigState()
  if (!isLiveConfig(config.value)) return

  const nuxtApp = useNuxtApp()
  const auth = useAuth()
  const caldav = useCalDav()
  if (!caldav) return
  const state = useCalendarState()
  const api = useAuthFetch()
  const displayTimeZone = useDisplayTimeZone()
  const orgTimeZone = useOrgTimeZone()
  const userTimeZone = useUserTimeZone()
  const sidebarOrder = useSidebarOrderState()
  const toast = useToast()
  const updates = useResourceUpdates()
  const rights = useState<Record<string, ResourceRight>>('resource-rights', () => ({}))

  const loader = createLiveLoader({
    store: state,
    status: createLiveStatusState(useState),
    client: caldav.client,
    reader: caldav.reader,
    api: <T>(path: string) => api<T>(path) as Promise<T>,
    fetchIcs: (id) => fetchIcsText(auth.authFetch, id),
    external: useExternalAccess().source,
    resources: {
      onList: (list) => {
        rights.value = Object.fromEntries(
          list.map((resource) => [String(resource.id), resource.right]),
        )
      },
    },
    displayTimeZone: () => displayTimeZone.value,
    orgTimeZone: () => orgTimeZone.value,
    setUserTimeZone: (zone) => {
      userTimeZone.value = zone
    },
    setSidebarOrder: (order) => {
      sidebarOrder.value = completeSidebarOrder(order)
    },
    sourcesVersion: useCalendarSourcesVersion(),
    notifyProblems: (keys) => {
      // The problems list lives in the sidebar, which is closed on small screens: say so.
      if (state.sidebarOpen.value) return
      toast.add({
        title:
          keys.length === 1
            ? t('Something could not be loaded')
            : t('Some things could not be loaded'),
        description: t('Open the sidebar to see what and to try again.'),
        icon: 'i-lucide-triangle-alert',
        color: 'warning',
      })
    },
  })
  loaders.set(nuxtApp, loader)

  // The route guard keeps the layout from rendering before the login; this is the second lock.
  const stop = watch(
    auth.status,
    (status) => {
      if (status === 'authenticated') {
        void loader.start()
        void updates.announce()
      }
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    stop()
    loader.dispose()
    if (loaders.get(nuxtApp) === loader) loaders.delete(nuxtApp)
  })
}
