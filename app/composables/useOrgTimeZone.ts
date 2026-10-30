import { computed } from 'vue'
import { DEFAULT_TIME_ZONE } from '../../shared/utils/time-zone'

/**
 * The organization time zone (FR-29): an IANA name from the server's `TZ` setting, `Europe/Berlin`
 * by default. Floating times are read in it, it is the fallback display zone and the reference
 * label. For what the UI shows, use `useDisplayTimeZone()`.
 */
export function useOrgTimeZone() {
  const config = useServerConfigState()
  return computed(() => config.value?.timezone ?? DEFAULT_TIME_ZONE)
}
