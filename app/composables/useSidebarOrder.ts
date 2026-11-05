/**
 * The order the signed-in user keeps the sidebar's sections in (FR-21). It is stored per user on
 * the server, so it is the same in every browser and after signing in again: `/api/me` brings it
 * (the live loader fills the state, utils/live/loader.ts) and `move` saves a change. Demo mode has
 * no account, so there a change stays in the page.
 */
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { N_ } from '~/utils/i18n'
import { sameOrder } from '~/utils/sidebar-drag'
import { isLiveConfig } from '~/utils/live/seed'
import { describeError } from '~/utils/settings/api-errors'
import {
  completeSidebarOrder,
  moveSidebarSection,
  type SidebarSectionId,
} from '../../shared/utils/sidebar-sections'

/** The shared holder of the order; the default order until `/api/me` has answered. */
export function useSidebarOrderState() {
  return useState<SidebarSectionId[]>('sidebar-order', () => completeSidebarOrder(null))
}

// Saves go one after the other, so that the last move is the one the server keeps. One chain for
// the whole page: the sections, the list of arrows and the dragging each use `useSidebarOrder()`.
let saving: Promise<void> = Promise.resolve()

export function useSidebarOrder() {
  const order = useSidebarOrderState()
  const live = isLiveConfig(useServerConfigState().value)
  const api = live ? useAuthFetch() : null
  const toast = useToast()
  /** Moves a section one place up (-1) or down (1); false when it is at that end already. */
  function move(id: SidebarSectionId, delta: -1 | 1): boolean {
    const next = moveSidebarSection(order.value, id, delta)
    if (sameOrder(next, order.value)) return false
    commit(next)
    return true
  }

  /** Takes `next` as the order and saves it. */
  function commit(next: SidebarSectionId[]) {
    order.value = next
    if (api) {
      saving = saving.then(async () => {
        try {
          await api('/api/me/sidebar-order', { method: 'PUT', body: { order: next } })
        } catch (error) {
          // The new order stays on the screen; it is the saving that failed, and the toast says so.
          toast.add({
            title: describeError(error, N_('save the order of the sections')),
            color: 'error',
            icon: 'i-lucide-x',
          })
        }
      })
    }
  }

  return { order, move, commit }
}
