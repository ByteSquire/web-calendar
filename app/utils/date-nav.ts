import type { RangeKind } from './calendar-state'
import { N_, tv } from './i18n'

const LABELS = {
  previous: {
    day: N_('Previous day'),
    '5day': N_('Previous 5 days'),
    week: N_('Previous week'),
    month: N_('Previous month'),
    year: N_('Previous year'),
  },
  next: {
    day: N_('Next day'),
    '5day': N_('Next 5 days'),
    week: N_('Next week'),
    month: N_('Next month'),
    year: N_('Next year'),
  },
} satisfies Record<'previous' | 'next', Record<RangeKind, string>>

/** Accessible name of the previous / next button, for example `Previous week`. */
export function dateStepLabel(direction: 'previous' | 'next', kind: RangeKind): string {
  return tv(LABELS[direction][kind])
}
