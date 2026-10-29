import { Temporal } from 'temporal-polyfill'
import { createMockData } from '~/data/mock'

/** Mock data around the current week. Phase 2 replaces this with API calls. */
export function useMockData() {
  return createMockData(Temporal.Now.plainDateISO())
}
