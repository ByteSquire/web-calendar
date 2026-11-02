// One toast on load for what happened to the viewer's own bookings since they last looked
// (FR-19). The time of the last look is kept in localStorage per user. Live mode only.
import type { BookingUpdatesResponse } from '../../shared/types/resources-api'
import { t } from '~/utils/i18n'
import { useAuth } from '~/composables/useAuth'
import { useAuthFetch } from '~/composables/useAuthFetch'
import {
  firstSinceIso,
  lastSeenKey,
  newestDecision,
  readLastSeen,
  updatesToastText,
  writeLastSeen,
  type KeyValueStore,
} from '~/utils/resources/updates'

function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function useResourceUpdates() {
  const api = useAuthFetch()
  const auth = useAuth()
  const toast = useToast()
  const router = useRouter()
  let asked = false

  /** Asks once per page load; a failure is silent (the toast is a convenience). */
  async function announce(): Promise<void> {
    if (asked) return
    asked = true
    const store = browserStore()
    const key = lastSeenKey(auth.user.value?.sub ?? 'unknown')
    const stored = readLastSeen(store, key)
    const since = stored ?? firstSinceIso(new Date())
    try {
      const answer = await api<BookingUpdatesResponse>('/api/resources/updates', {
        query: { since },
      })
      const text = updatesToastText(answer.updates)
      const newest = newestDecision(answer.updates)
      // Without news the stored time stays (the browser clock may differ from the server's).
      if (newest) writeLastSeen(store, key, newest)
      else if (!stored) writeLastSeen(store, key, new Date().toISOString())
      if (text) {
        toast.add({
          title: text,
          icon: 'i-lucide-info',
          actions: [{ label: t('View'), onClick: () => void router.push('/resources/requests') }],
        })
      }
    } catch {
      asked = false
    }
  }

  return { announce }
}
