// Names of the weekdays and months in the language in use, short ("Thu", "Oct") and long
// ("October"). Dates read differently in German ("Do, 29. Okt 2026"), so the callers put them
// together with a text of their own (`t('{weekday}, {day} {month} {year}', ...)`).
import { N_, tv } from '~/utils/i18n'

const WEEKDAYS_SHORT = [N_('Mon'), N_('Tue'), N_('Wed'), N_('Thu'), N_('Fri'), N_('Sat'), N_('Sun')]
const MONTHS_SHORT = [
  N_('Jan'),
  N_('Feb'),
  N_('Mar'),
  N_('Apr'),
  N_('May'),
  N_('Jun'),
  N_('Jul'),
  N_('Aug'),
  N_('Sep'),
  N_('Oct'),
  N_('Nov'),
  N_('Dec'),
]
const MONTHS_LONG = [
  N_('January'),
  N_('February'),
  N_('March'),
  N_('April'),
  N_('May'),
  N_('June'),
  N_('July'),
  N_('August'),
  N_('September'),
  N_('October'),
  N_('November'),
  N_('December'),
]

/** `Thu` for a day of the week from 1 (Monday) to 7 (Sunday), as Temporal counts them. */
export const weekdayShort = (dayOfWeek: number): string => tv(WEEKDAYS_SHORT[dayOfWeek - 1]!)
/** `Oct` for a month from 1 to 12. */
export const monthShort = (month: number): string => tv(MONTHS_SHORT[month - 1]!)
/** `October` for a month from 1 to 12. */
export const monthLong = (month: number): string => tv(MONTHS_LONG[month - 1]!)
