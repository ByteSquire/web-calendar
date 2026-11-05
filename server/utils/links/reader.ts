// Reads the calendar of a link as the person who made it, read-only. It sends exactly two kinds of
// request: a depth-0 PROPFIND for the calendar's name and colour, and a calendar-query REPORT with
// a time range and server-side expansion of series. Nothing that writes, and no other path than the
// one given. A 403 or 404 means the maker cannot read the calendar (any more): a share or a
// membership that ended ends the link with it.
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

export interface LinkReader {
  /** The name and colour of the calendar, as `principal` sees it. */
  probe(principal: string, path: string): Promise<CalendarProbe>
  /** The calendar objects with events in `[start, end)`, series expanded by Radicale. */
  read(principal: string, path: string, start: Date, end: Date): Promise<CalendarRead>
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
          `<D:prop><C:calendar-data><C:expand start="${from}" end="${to}"/></C:calendar-data></D:prop>` +
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
  }
}
