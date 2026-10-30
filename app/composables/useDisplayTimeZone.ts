import { computed } from 'vue'
import { resolveDisplayTimeZone } from '../../shared/utils/time-zone'

/**
 * The zone this viewer sees times in (FR-29): the browser's own, or the organization zone when the
 * browser reports none. Event times in the shared state, "today", the calendar and quick-add are
 * wall-clock times in it. A per-user setting that overrides the browser zone is planned for the
 * settings screen.
 */
export function useDisplayTimeZone() {
  const orgTimeZone = useOrgTimeZone()
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return computed(() => resolveDisplayTimeZone(browserZone, orgTimeZone.value))
}
