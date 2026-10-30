// Keeps the calendar state in step with the viewer's display zone (FR-32) when that zone changes
// without a reload: the user picks another zone in the settings, or the saved choice arrives with
// `/api/me` after the calendar is up. Called once, by the default layout.
import { Temporal } from 'temporal-polyfill'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { isLiveConfig } from '~/utils/live/seed'
import { convertEventTimes } from '~/utils/time-zone'

export function useDisplayZoneFollow(): void {
  const zone = useDisplayTimeZone()
  const { anchorDate, events } = useCalendarState()
  const live = isLiveConfig(useServerConfigState().value)

  watch(zone, (next, previous) => {
    // Someone looking at today keeps looking at today, which may be another date in the new zone.
    if (anchorDate.value.equals(Temporal.Now.plainDateISO(previous))) {
      anchorDate.value = Temporal.Now.plainDateISO(next)
    }
    // Live events are loaded again in the new zone by the loader (utils/live/loader.ts). The demo's
    // are in the state only: move them, an event keeps its instant.
    if (!live) events.value = events.value.map((event) => convertEventTimes(event, previous, next))
  })
}
