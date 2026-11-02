// Who may write what (FR-9), as pure functions: the calendars an event can be created in and
// whether an existing event can be edited or deleted. Whether the app runs on live data at all is
// `isLiveConfig` (app/utils/live/seed.ts).
//
// The CalDAV client only talks to the built-in service (it refuses any other origin), so
// "writable" means a `dav:` calendar of type caldav that the server did not mark read-only.
// External accounts (`ext:`) and subscriptions (`ics:`) are read-only here.
import type { Calendar, CalendarEvent } from '../../../shared/types/calendar'
import { t } from '../i18n'
import type { EventTarget } from './types'

/** A calendar events can be created in. */
export function isWritableCalendar(calendar: Calendar): boolean {
  return (
    calendar.type === 'caldav' &&
    calendar.readOnly !== true &&
    calendar.id.startsWith('dav:') &&
    typeof calendar.href === 'string' &&
    calendar.href !== ''
  )
}

export function writableCalendars(calendars: readonly Calendar[]): Calendar[] {
  return calendars.filter(isWritableCalendar)
}

export type EventAccess = { allowed: true } | { allowed: false; reason: string }

/** Whether the viewer can edit or delete the event; the reason is shown next to the buttons. */
export function eventWriteAccess(
  event: Pick<CalendarEvent, 'calendarId' | 'href' | 'isBlocked'>,
  calendarById: ReadonlyMap<string, Calendar>,
): EventAccess {
  if (event.isBlocked) {
    return {
      allowed: false,
      reason: t('You can only see that you are busy, not the event itself.'),
    }
  }
  const calendar = calendarById.get(event.calendarId)
  if (!calendar) return { allowed: false, reason: t("This event's calendar is not available.") }
  if (calendar.type === 'ical') {
    return { allowed: false, reason: t('This calendar is a subscription and is read-only.') }
  }
  if (calendar.readOnly === true) {
    return { allowed: false, reason: t('This calendar is read-only for you.') }
  }
  if (!isWritableCalendar(calendar)) {
    return { allowed: false, reason: t("Events in this calendar can't be changed here.") }
  }
  if (!event.href) return { allowed: false, reason: t("This event can't be changed here.") }
  return { allowed: true }
}

/** Where to find an editable event, or null when `eventWriteAccess` does not allow it. */
export function eventTargetOf(
  event: Pick<CalendarEvent, 'calendarId' | 'href' | 'isBlocked' | 'recurring' | 'recurrenceId'>,
  calendarById: ReadonlyMap<string, Calendar>,
): EventTarget | null {
  if (!eventWriteAccess(event, calendarById).allowed) return null
  const calendar = calendarById.get(event.calendarId)
  if (!calendar?.href || !event.href) return null
  return {
    href: event.href,
    calendarHref: calendar.href,
    recurring: event.recurring === true,
    ...(event.recurrenceId === undefined ? {} : { recurrenceId: event.recurrenceId }),
  }
}
