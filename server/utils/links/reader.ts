// Reads the calendar of a link, read-only, as the principal the link reads as (its maker, or the
// collection's owner for a link an admin made). It sends exactly three kinds of request: a depth-0
// PROPFIND for the calendar's name and colour, a calendar-query REPORT with a time range and
// server-side expansion of series (level `read`), and a free-busy-query REPORT (level
// `free_busy`). Nothing that writes, and no other path than the one given. A 403 or 404 means the
// principal cannot read the calendar (any more): a share or a membership that ended ends the link.
import {
  createStoreSend,
  escapeXml,
  responses,
  tagText,
  type EventReaderOptions,
} from '../resources/reconcile-reader'

export type CalendarProbe =
  | { kind: 'ok'; name: string; color: string | null; isCalendar: boolean }
  | { kind: 'forbidden' }
  | { kind: 'no_collection' }
  | { kind: 'error' }

export type CalendarRead =
  | { kind: 'ok'; objects: string[] }
  | { kind: 'forbidden' }
  | { kind: 'no_collection' }
  | { kind: 'error' }

export type CalendarFreeBusy =
  | { kind: 'ok'; text: string }
  | { kind: 'forbidden' }
  | { kind: 'no_collection' }
  | { kind: 'error' }

export interface LinkReader {
  /** The name and colour of the calendar, as `principal` sees it. */
  probe(principal: string, path: string): Promise<CalendarProbe>
  /** The calendar objects with events in `[start, end)`, as stored (the page expands series). */
  read(principal: string, path: string, start: Date, end: Date): Promise<CalendarRead>
  /**
   * The busy times in `[start, end)`: Radicale's `VFREEBUSY` (a free-busy-query), which is all a
   * free/busy share gets, without titles or anything else of the events.
   */
  freeBusy(principal: string, path: string, start: Date, end: Date): Promise<CalendarFreeBusy>
}

/** `20261105T000000Z`: the UTC form CalDAV time ranges take. */
export function caldavUtc(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

const COLOR = /^#[0-9a-fA-F]{6}/

export function createLinkReader(options: EventReaderOptions): LinkReader {
  const send = createStoreSend(options)

  const status = (code: number) =>
    code === 403 ? 'forbidden' : code === 404 ? 'no_collection' : 'error'

  return {
    async probe(principal, path) {
      const answer = await send(
        principal,
        'PROPFIND',
        path,
        '0',
        '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:ICAL="http://apple.com/ns/ical/"><D:prop><D:displayname/><D:resourcetype/><ICAL:calendar-color/></D:prop></D:propfind>',
      )
      if (!answer) return { kind: 'error' }
      if (answer.status !== 207) return { kind: status(answer.status) } as CalendarProbe
      const block = responses(answer.text)[0] ?? ''
      const colour = COLOR.exec(tagText(block, 'calendar-color') ?? '')?.[0] ?? null
      return {
        kind: 'ok',
        name: tagText(block, 'displayname') ?? '',
        color: colour ? colour.toLowerCase() : null,
        isCalendar: /<(?:[\w-]+:)?calendar\s*\/>/i.test(block),
      }
    },

    async read(principal, path, start, end) {
      const from = escapeXml(caldavUtc(start))
      const to = escapeXml(caldavUtc(end))
      const answer = await send(
        principal,
        'REPORT',
        path,
        '1',
        '<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
          // As stored: the page expands the series, as the app does (Radicale's own expansion is
          // slow on a busy calendar and refused past 10000 occurrences).
          '<D:prop><C:calendar-data/></D:prop>' +
          '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
          `<C:time-range start="${from}" end="${to}"/>` +
          '</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>',
      )
      if (!answer) return { kind: 'error' }
      if (answer.status !== 207) return { kind: status(answer.status) } as CalendarRead
      const objects: string[] = []
      for (const block of responses(answer.text)) {
        const data = tagText(block, 'calendar-data')
        if (data) objects.push(data)
      }
      return { kind: 'ok', objects }
    },

    async freeBusy(principal, path, start, end) {
      const answer = await send(
        principal,
        'REPORT',
        path,
        '1',
        '<?xml version="1.0"?><C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav">' +
          `<C:time-range start="${escapeXml(caldavUtc(start))}" end="${escapeXml(caldavUtc(end))}"/>` +
          '</C:free-busy-query>',
      )
      if (!answer) return { kind: 'error' }
      // The answer is the calendar text itself (200), not a multistatus.
      if (answer.status !== 200) return { kind: status(answer.status) } as CalendarFreeBusy
      if (!/BEGIN:VFREEBUSY/i.test(answer.text)) return { kind: 'error' }
      return { kind: 'ok', text: answer.text }
    },
  }
}
