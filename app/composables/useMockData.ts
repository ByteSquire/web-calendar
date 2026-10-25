import { Temporal } from 'temporal-polyfill'
import { createMockData } from '~/data/mock'

/** Anchor mock data once per request so SSR and hydration agree. */
export function useMockData() {
  const anchor = useState('mock-anchor', () => Temporal.Now.plainDateISO().toString())
  return createMockData(Temporal.PlainDate.from(anchor.value))
}
