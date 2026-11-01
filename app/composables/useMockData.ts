import { Temporal } from 'temporal-polyfill'
import { createMockData } from '~/data/mock'
import { BUSY_QUERY, BUSY_VALUE, addBusyCalendars } from '~/data/mock-busy'
import { convertEventTimes } from '~/utils/time-zone'

/**
 * Mock data around the current week. The mock times are organization time; they are moved into the
 * viewer's display zone like real events will be, so mock mode exercises the conversion.
 * Phase 2 replaces this.
 */
export function useMockData() {
  const orgTimeZone = useOrgTimeZone().value
  const displayTimeZone = useDisplayTimeZone().value
  const today = Temporal.Now.plainDateISO(orgTimeZone)
  const plain = createMockData(today)
  // `?demo-load=busy` adds 8 calendars and a busy day (NFR-1) to the mock data; see mock-busy.ts.
  const data =
    useRoute().query[BUSY_QUERY] === BUSY_VALUE
      ? addBusyCalendars(plain, today.add({ days: 3 - (today.dayOfWeek - 1) }))
      : plain
  return {
    ...data,
    events: data.events.map((event) => convertEventTimes(event, orgTimeZone, displayTimeZone)),
  }
}
