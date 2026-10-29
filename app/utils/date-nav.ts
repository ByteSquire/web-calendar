import type { RangeKind } from './calendar-state'

const PERIODS = {
  day: 'day',
  '5day': '5 days',
  week: 'week',
  month: 'month',
  year: 'year',
} satisfies Record<RangeKind, string>

/** Accessible name of the previous / next button, for example `Previous week`. */
export function dateStepLabel(direction: 'previous' | 'next', kind: RangeKind): string {
  return `${direction === 'previous' ? 'Previous' : 'Next'} ${PERIODS[kind]}`
}
