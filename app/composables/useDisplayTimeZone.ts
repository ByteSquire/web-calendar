import { computed } from 'vue'
import { resolveDisplayTimeZone } from '../../shared/utils/time-zone'

/**
 * The zone this viewer sees times in (FR-29, FR-32): the one chosen in the settings, else the
 * browser's own, else the organization zone when the browser reports none. Event times in the
 * shared state, "today", the calendar and quick-add are wall-clock times in it. It follows the
 * setting: the live loader loads the events again when it changes (utils/live/loader.ts).
 */
export function useDisplayTimeZone() {
  const orgTimeZone = useOrgTimeZone()
  const userTimeZone = useUserTimeZone()
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return computed(() => resolveDisplayTimeZone(browserZone, orgTimeZone.value, userTimeZone.value))
}
