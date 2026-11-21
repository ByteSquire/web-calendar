/**
 * The items the signed-in user has hidden from the sidebar (FR-21): calendars, resources, views,
 * categories and filters. Hiding one switches it off and moves it into the "Hidden" section; the
 * open eye there shows it in its section again, still off. The list is stored per user on the
 * server, like the order of the sections (useSidebarOrder.ts): `/api/me` brings it (the live loader
 * hands it over) and every change saves it. Demo mode has no account, so there a change stays in
 * the page.
 */
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { N_ } from '~/utils/i18n'
import { isLiveConfig } from '~/utils/live/seed'
import { describeError } from '~/utils/settings/api-errors'
import { readSidebarHidden, type SidebarHiddenKind } from '../../shared/utils/sidebar-hidden'

/** True once the person hid or showed an item in this page (it lasts until the page is loaded again). */
function useHiddenChangedHere() {
  return useState<boolean>('sidebar-hidden-changed-here', () => false)
}

/**
 * Takes the list `/api/me` brought (the live loader calls it), unless the person changed it in this
 * page: the loader asks `/api/me` again when the calendars change, and that answer can be older
 * than a change whose save is still on its way.
 */
export function useSavedSidebarHidden(): (saved: unknown) => void {
  const { applySidebarHidden } = useCalendarState()
  const changedHere = useHiddenChangedHere()
  return (saved) => {
    if (changedHere.value) return
    applySidebarHidden(readSidebarHidden(saved))
  }
}

// Saves go one after the other, so that the last change is the one the server keeps.
let saving: Promise<void> = Promise.resolve()

export function useSidebarHidden() {
  const state = useCalendarState()
  const changedHere = useHiddenChangedHere()
  const live = isLiveConfig(useServerConfigState().value)
  const api = live ? useAuthFetch() : null
  const toast = useToast()

  function save() {
    changedHere.value = true
    if (!api) return
    const hidden = [...state.sidebarHidden.value]
    saving = saving.then(async () => {
      try {
        await api('/api/me/sidebar-hidden', { method: 'PUT', body: { hidden } })
      } catch (error) {
        // The sidebar stays as it is now; it is the saving that failed, and the toast says so.
        toast.add({
          title: describeError(error, N_('save the hidden items')),
          color: 'error',
          icon: 'i-lucide-x',
        })
      }
    })
  }

  /** Hides an item and switches it off. */
  function hide(kind: SidebarHiddenKind, id: string) {
    state.hideSidebarItem(kind, id)
    save()
  }

  /** Shows a hidden item in its section again, switched off. */
  function show(kind: SidebarHiddenKind, id: string) {
    state.showSidebarItem(kind, id)
    save()
  }

  return { hidden: state.sidebarHidden, isHidden: state.isSidebarHidden, hide, show }
}
