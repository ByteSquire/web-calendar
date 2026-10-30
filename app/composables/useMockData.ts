import { Temporal } from 'temporal-polyfill'
import { createMockData } from '~/data/mock'
import { convertEventTimes } from '~/utils/time-zone'

/**
 * Mock data around the current week. The mock times are organization time; they are moved into the
 * viewer's display zone like real events will be, so mock mode exercises the conversion.
 * Phase 2 replaces this.
 */
export function useMockData() {
  const orgTimeZone = useOrgTimeZone().value
  const displayTimeZone = useDisplayTimeZone().value
  const data = createMockData(Temporal.Now.plainDateISO(orgTimeZone))
  return {
    ...data,
    events: data.events.map((event) => convertEventTimes(event, orgTimeZone, displayTimeZone)),
  }
}
