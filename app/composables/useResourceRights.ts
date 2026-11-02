// What the viewer may do with resources: the rights come with the list of resources (live mode,
// filled by the loader) or are everything (demo mode, the mock data). Display only; the resource
// routes check the right themselves.
import { useServerConfigState } from '~/composables/useServerConfigState'
import { isLiveConfig } from '~/utils/live/seed'
import type { BookableResource, ResourceRight } from '~/utils/resources/types'

const RANK: Record<ResourceRight, number> = { read: 1, book: 2, manage: 3 }

export function useResourceRights() {
  const live = isLiveConfig(useServerConfigState().value)
  /** Resource id (as in the calendar state) -> the viewer's right on it. Live mode only. */
  const rights = useState<Record<string, ResourceRight>>('resource-rights', () => ({}))
  const { resources } = useCalendarState()

  function rightOn(id: string): ResourceRight | null {
    return live ? (rights.value[id] ?? null) : 'manage'
  }

  const bookable = computed<BookableResource[]>(() =>
    resources.value
      .filter((resource) => {
        const right = rightOn(resource.id)
        return right !== null && RANK[right] >= RANK.book
      })
      .map((resource) => ({ id: resource.id, name: resource.name })),
  )

  return { live, rights, bookable, rightOn }
}
