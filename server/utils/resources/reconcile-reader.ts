import { isActingPrincipal } from '../sharing/radicale-client'

// Reads the booker's calendar as the booker (internal Radicale client identity, never reachable
// from the browser). The sharing client has no ctag or REPORT call, so this is a small separate
// reader that refuses the same principals. Paths are the decoded form of the requester's view
// (`/<sub>/<name>/`, a share included). Only a successful query without the UID says the event is
// absent; a 403 or a 404 on the collection says the requester cannot read it, which for a share
// is the same as it being revoked or hidden. Anything else it cannot read is `error`.

export type CalendarStamp =
  | { kind: 'ok'; stamp: string }
  | { kind: 'forbidden' }
  | { kind: 'no_collection' }
  | { kind: 'error' }

export type EventLookup =
  | { kind: 'found'; objects: string[] }
  | { kind: 'absent' }
  | { kind: 'forbidden' }
  | { kind: 'no_collection' }
  | { kind: 'error' }

export type CalendarList = { kind: 'ok'; paths: string[] } | { kind: 'error' }

export interface BookingEventReader {
  /** ctag and sync-token of a calendar, joined; '' when the server shows neither. */
  stamp(principal: string, path: string): Promise<CalendarStamp>
  /** The objects of the calendar whose VEVENT has this UID. */
  findEvent(principal: string, path: string, uid: string): Promise<EventLookup>
  /** The calendar collections in the principal's home (shared ones appear there too). */
  listCalendars(principal: string): Promise<CalendarList>
}

export interface EventReaderOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxResponseBytes?: number
}

const NAME = '(?:[\\w-]+:)?'
const COLLECTION = /^\/[^/]+\/[^/]+\/$/

function isStorePath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('//') || path.includes('?') || path.includes('#')) {
    return false
  }
  return path.split('/').every((segment) => segment !== '.' && segment !== '..')
}

function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function decodedHref(href: string): string | null {
  try {
    return decodeURIComponent(href)
  } catch {
    return null
  }
}

function unescapeXml(text: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text)
  if (cdata) return cdata[1] ?? ''
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#13;|&#xD;/gi, '\r')
    .replace(/&amp;/g, '&')
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function tagText(block: string, tag: string): string | null {
  const match = new RegExp(`<${NAME}${tag}[^>]*>([\\s\\S]*?)</${NAME}${tag}>`, 'i').exec(block)
  return match ? unescapeXml(match[1] ?? '').trim() : null
}

function responses(xml: string): string[] {
  return [
    ...xml.matchAll(new RegExp(`<${NAME}response[ >][\\s\\S]*?</${NAME}response>`, 'gi')),
  ].map((match) => match[0])
}

export function createBookingEventReader(options: EventReaderOptions): BookingEventReader {
  const base = new URL(options.baseUrl).href.replace(/\/+$/, '')
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024

  async function send(
    principal: string,
    method: string,
    path: string,
    depth: '0' | '1',
    body: string,
  ): Promise<{ status: number; text: string } | null> {
    if (!isActingPrincipal(principal) || !isStorePath(path)) return null
    try {
      const response = await doFetch(base + encodedPath(path), {
        method,
        headers: { 'x-remote-user': principal, depth, 'content-type': 'application/xml' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      const text = await response.text()
      if (text.length > maxBytes) return null
      return { status: response.status, text }
    } catch {
      return null
    }
  }

  return {
    async stamp(principal, path) {
      const answer = await send(
        principal,
        'PROPFIND',
        path,
        '0',
        '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/"><D:prop><CS:getctag/><D:sync-token/></D:prop></D:propfind>',
      )
      if (!answer) return { kind: 'error' }
      if (answer.status === 403) return { kind: 'forbidden' }
      if (answer.status === 404) return { kind: 'no_collection' }
      if (answer.status !== 207) return { kind: 'error' }
      const ctag = tagText(answer.text, 'getctag') ?? ''
      const token = tagText(answer.text, 'sync-token') ?? ''
      return { kind: 'ok', stamp: ctag === '' && token === '' ? '' : `${ctag}|${token}` }
    },

    async findEvent(principal, path, uid) {
      const answer = await send(
        principal,
        'REPORT',
        path,
        '1',
        '<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:prop-filter name="UID"><C:text-match collation="i;octet">' +
          escapeXml(uid) +
          '</C:text-match></C:prop-filter></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>',
      )
      if (!answer) return { kind: 'error' }
      if (answer.status === 403) return { kind: 'forbidden' }
      if (answer.status === 404) return { kind: 'no_collection' }
      if (answer.status !== 207) return { kind: 'error' }
      const objects: string[] = []
      for (const block of responses(answer.text)) {
        const data = tagText(block, 'calendar-data')
        if (data) objects.push(data)
      }
      return objects.length === 0 ? { kind: 'absent' } : { kind: 'found', objects }
    },

    async listCalendars(principal) {
      const home = `/${principal}/`
      const answer = await send(
        principal,
        'PROPFIND',
        home,
        '1',
        '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
      )
      if (!answer || answer.status !== 207) return { kind: 'error' }
      const paths: string[] = []
      for (const block of responses(answer.text)) {
        if (!new RegExp(`<${NAME}calendar\\s*/>`, 'i').test(block)) continue
        const href = decodedHref(tagText(block, 'href') ?? '')
        if (href && href.startsWith(home) && COLLECTION.test(href)) paths.push(href)
      }
      return { kind: 'ok', paths: paths.sort() }
    },
  }
}
