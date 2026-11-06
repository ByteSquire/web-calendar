// A person's default calendar: the one Radicale makes in every new home (`predefined_collections`
// of deploy/radicale/config), `/<sub>/def-calendar/`. The app keeps it: it can be renamed and
// recoloured but not deleted, by its owner or an admin (design §8), so everybody has a calendar to
// write to. A CalDAV app can still delete it in Radicale; the next load then makes a new first one.

export const DEFAULT_CALENDAR_SEGMENT = 'def-calendar'

/** Whether a collection path or URL (`/<sub>/def-calendar/`, `/caldav/<sub>/def-calendar/`) is one. */
export function isDefaultCalendarPath(path: string): boolean {
  const last = path.split(/[?#]/, 1)[0]!.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(last) === DEFAULT_CALENDAR_SEGMENT
  } catch {
    return false
  }
}
