import type { RangeKind } from './calendar-state'
import { N_, tc, tv } from './i18n'

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
} satisfies Record<'previous' | 'next', Record<Exclude<RangeKind, 'custom'>, string>>

/**
 * Accessible name of the previous / next button, for example `Previous week`. A custom range steps
 * by its own length (`customDays`): `Previous 10 days`.
 */
export function dateStepLabel(
  direction: 'previous' | 'next',
  kind: RangeKind,
  customDays = 7,
): string {
  if (kind !== 'custom') return tv(LABELS[direction][kind])
  return direction === 'previous'
    ? tc('Previous day | Previous {count} days', customDays)
    : tc('Next day | Next {count} days', customDays)
}
