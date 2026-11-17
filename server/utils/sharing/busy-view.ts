import type { Database } from 'better-sqlite3'
import { sharedCalendarId } from '../../../shared/utils/shared-calendar-name'
import type { CalendarAclRow, CalendarRow } from '../../db/types'
import { escapeXml, responses, tagText, type StoreSend } from '../resources/reconcile-reader'
import { busyEntries, busyToken, type BusyEntry } from './busy-copy'
import { computeDesiredShares } from './desired'
import type { GroupMembership } from './membership'
import { splitCollectionPath } from './names'

// The gateway's answer for a calendar shared at "Busy times only" (design §8). Radicale lets such a
// share (`f`) answer a free/busy query only, so calendar apps list it and cannot sync it. For the
// reads a calendar app makes (PROPFIND, calendar-query, calendar-multiget, sync-collection, GET) the
// gateway answers itself, with the busy copies of the owner's events (busy-copy.ts), which it reads
// as the owner, at the path the database names, only after the pre-check granted the share. Every
// other request (a free/busy query, OPTIONS, anything unknown, every write) goes to Radicale as the
// caller, where the `f` share keeps deciding: a gap here can break a client, never leak.

export interface BusyShare {
  calendarId: number
  calendar: CalendarRow
  /** The owner's principal and collection, from `calendars.collection_path`. */
  owner: string
  ownerPath: string
  /** The collection name in the caller's home (`shared-12`, `shared-12-team`), decoded. */
  collection: string
  /** The entry the path names below the collection, decoded; null for the collection itself. */
  item: string | null
}

export interface BusyRequest {
  sub: string
  share: BusyShare
  method: string
  depth: string | null
  /** The request body as text ('' when there is none). */
  body: string
}

export interface BusyView {
  /** The free/busy-only share the path is in for this caller, or null (Radicale answers then). */
  shareOf(sub: string, upstreamPath: string): Promise<BusyShare | null>
  /** The answer, or 'pass' for a request Radicale answers as the caller. */
  answer(request: BusyRequest): Promise<Response | 'pass'>
}

const D = 'DAV:'
const C = 'urn:ietf:params:xml:ns:caldav'
const CS = 'http://calendarserver.org/ns/'
const ICAL = 'http://apple.com/ns/ical/'
const PREFIX: Record<string, string> = { [D]: 'D', [C]: 'C', [CS]: 'CS', [ICAL]: 'ICAL' }
const ENTRY_NAME = /^[0-9a-f]{32}\.ics$/
const CACHE_SIZE = 64

interface WantedProp {
  ns: string
  name: string
}

function segmentsOf(upstreamPath: string): string[] | null {
  const segments: string[] = []
  for (const raw of upstreamPath.split('/').filter((part) => part !== '')) {
    try {
      segments.push(decodeURIComponent(raw))
    } catch {
      return null
    }
  }
  return segments
}

/** The last segment of an href, decoded; '' when it cannot be decoded. */
function lastSegment(href: string): string {
  try {
    return decodeURIComponent(href).split('/').filter(Boolean).pop() ?? ''
  } catch {
    return ''
  }
}

/** The properties a PROPFIND or REPORT asks for, or 'all' (allprop, or no `prop`). */
export function requestedProps(body: string): WantedProp[] | 'all' {
  const namespaces = new Map<string, string>()
  for (const match of body.matchAll(/xmlns(?::([\w.-]+))?\s*=\s*"([^"]*)"/g)) {
    namespaces.set(match[1] ?? '', match[2]!)
  }
  const prop = /<(?:[\w.-]+:)?prop(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?prop>/.exec(body)
  if (!prop) return 'all'
  const wanted: WantedProp[] = []
  let depth = 0
  for (const tag of prop[1]!.matchAll(/<(\/?)(?:([\w.-]+):)?([\w-]+)[^>]*?(\/?)>/g)) {
    const [, closing, prefix, name, selfClosing] = tag
    if (closing) {
      depth -= 1
      continue
    }
    if (depth === 0) wanted.push({ ns: namespaces.get(prefix ?? '') ?? D, name: name! })
    if (!selfClosing) depth += 1
  }
  return wanted
}

function element(prop: WantedProp, content?: string): string {
  const known = PREFIX[prop.ns]
  const open = known ? `${known}:${prop.name}` : `x:${prop.name} xmlns:x="${escapeXml(prop.ns)}"`
  const close = known ? `${known}:${prop.name}` : `x:${prop.name}`
  return content === undefined ? `<${open}/>` : `<${open}>${content}</${close}>`
}

function propstats(found: string[], missing: WantedProp[]): string {
  const parts: string[] = []
  if (found.length > 0) {
    parts.push(
      `<D:propstat><D:prop>${found.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`,
    )
  }
  if (missing.length > 0) {
    parts.push(
      `<D:propstat><D:prop>${missing.map((prop) => element(prop)).join('')}</D:prop>` +
        '<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>',
    )
  }
  return parts.join('')
}

function multistatus(inner: string): Response {
  return new Response(
    '<?xml version="1.0" encoding="utf-8"?>' +
      `<D:multistatus xmlns:D="${D}" xmlns:C="${C}" xmlns:CS="${CS}" xmlns:ICAL="${ICAL}">${inner}</D:multistatus>`,
    {
      status: 207,
      headers: {
        'content-type': 'text/xml; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    },
  )
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

const COLLECTION_DEFAULT: WantedProp[] = [
  { ns: D, name: 'resourcetype' },
  { ns: D, name: 'displayname' },
  { ns: CS, name: 'getctag' },
  { ns: D, name: 'sync-token' },
  { ns: D, name: 'current-user-privilege-set' },
  { ns: C, name: 'supported-calendar-component-set' },
]
const ENTRY_DEFAULT: WantedProp[] = [
  { ns: D, name: 'getetag' },
  { ns: D, name: 'getcontenttype' },
  { ns: D, name: 'resourcetype' },
]

export function createBusyView(options: {
  db: Database
  membership: GroupMembership
  /** Reads Radicale as a principal (createStoreSend): refuses odd principals and paths, times out. */
  send: StoreSend
  log?: (message: string) => void
}): BusyView {
  const { db, membership, send } = options
  const log = options.log ?? ((message: string) => console.warn(message))
  const calendarById = db.prepare<[number], CalendarRow>('SELECT * FROM calendars WHERE id = ?')
  const rulesOf = db.prepare<[number], CalendarAclRow>(
    'SELECT * FROM calendar_acl WHERE calendar_id = ?',
  )
  const cache = new Map<string, { stamp: string; entries: BusyEntry[] }>()

  /** The busy copies of the owner's calendar, read again only when Radicale's stamp changed. */
  async function entriesOf(share: BusyShare): Promise<BusyEntry[] | 'missing' | null> {
    const stampAnswer = await send(
      share.owner,
      'PROPFIND',
      share.ownerPath,
      '0',
      `<?xml version="1.0"?><D:propfind xmlns:D="${D}" xmlns:CS="${CS}"><D:prop><CS:getctag/><D:sync-token/></D:prop></D:propfind>`,
    )
    // A calendar its owner deleted keeps its row; its share answers as Radicale would, 404.
    if (stampAnswer?.status === 404) return 'missing'
    if (!stampAnswer || stampAnswer.status !== 207) return null
    const stamp = `${tagText(stampAnswer.text, 'getctag') ?? ''}|${tagText(stampAnswer.text, 'sync-token') ?? ''}`
    const cached = cache.get(share.ownerPath)
    if (cached && stamp !== '|' && cached.stamp === stamp) return cached.entries
    const query = await send(
      share.owner,
      'REPORT',
      share.ownerPath,
      '1',
      `<?xml version="1.0"?><C:calendar-query xmlns:D="${D}" xmlns:C="${C}"><D:prop><C:calendar-data/></D:prop>` +
        '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>',
    )
    if (query?.status === 404) return 'missing'
    if (!query || query.status !== 207) return null
    const objects: string[] = []
    for (const block of responses(query.text)) {
      const data = tagText(block, 'calendar-data')
      if (data) objects.push(data)
    }
    const entries = busyEntries(share.calendarId, objects)
    cache.delete(share.ownerPath)
    cache.set(share.ownerPath, { stamp, entries })
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
    return entries
  }

  return {
    async shareOf(sub, upstreamPath) {
      const segments = segmentsOf(upstreamPath)
      if (!segments || segments.length < 2 || segments.length > 3 || segments[0] !== sub) {
        return null
      }
      const collection = segments[1]!
      const calendarId = sharedCalendarId(collection)
      if (calendarId === null) return null
      const calendar = calendarById.get(calendarId)
      const owner = calendar ? splitCollectionPath(calendar.collection_path) : null
      if (!calendar || !owner) return null
      // The share this name is, as the reconcile makes it (one source of truth), and whether it is
      // the caller's: their own, or one of a group they are in (everyone signed in is in the group
      // of everyone; the pre-check grants that without the file, so here too).
      const desired = computeDesiredShares(
        rulesOf.all(calendarId),
        new Map([[calendarId, calendar]]),
      )
      const share = desired.shares.find(
        (candidate) => candidate.pathOrToken.replace('{user}', sub) === `/${sub}/${collection}/`,
      )
      if (!share || share.permissions !== 'f') return null
      if (share.kind === 'user' && share.user !== sub) return null
      if (share.kind === 'group' && share.user !== ':web_calendar_users') {
        if (!(await membership.groupsOf(sub)).has(share.user.slice(1))) return null
      }
      return {
        calendarId,
        calendar,
        owner: owner.owner,
        ownerPath: calendar.collection_path,
        collection,
        item: segments[2] ?? null,
      }
    },

    async answer(request) {
      const { share, sub, method } = request
      const isRead =
        method === 'PROPFIND' || method === 'REPORT' || method === 'GET' || method === 'HEAD'
      if (!isRead) return 'pass'
      const root = /<(?:[\w.-]+:)?([\w-]+)[\s>/]/.exec(
        request.body.replace(/<\?xml[^>]*\?>/, ''),
      )?.[1]
      if (method === 'REPORT') {
        if (share.item !== null) return 'pass'
        if (
          root !== 'calendar-query' &&
          root !== 'calendar-multiget' &&
          root !== 'sync-collection'
        ) {
          return 'pass' // a free/busy query (the web app's) and anything unknown: Radicale decides
        }
      }
      if ((method === 'GET' || method === 'HEAD') && share.item === null) return 'pass'
      if (share.item !== null && !ENTRY_NAME.test(share.item)) return plain(404, 'Not Found')

      const entries = await entriesOf(share)
      if (entries === 'missing') return plain(404, 'Not Found')
      if (entries === null) {
        log(`[gateway] the busy view of calendar ${share.calendarId} could not be read`)
        return plain(502, 'Bad Gateway')
      }
      const token = busyToken(entries)
      const base = `/caldav/${encodeURIComponent(sub)}/${encodeURIComponent(share.collection)}/`
      const byName = new Map(entries.map((entry) => [entry.name, entry]))

      if (method === 'GET' || method === 'HEAD') {
        const entry = byName.get(share.item!)
        if (!entry) return plain(404, 'Not Found')
        return new Response(method === 'HEAD' ? null : entry.ics, {
          status: 200,
          headers: {
            'content-type': 'text/calendar; charset=utf-8',
            etag: entry.etag,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        })
      }

      const wanted = requestedProps(request.body)
      const collectionResponse = (): string => {
        const asked = wanted === 'all' ? COLLECTION_DEFAULT : wanted
        const found: string[] = []
        const missing: WantedProp[] = []
        for (const prop of asked) {
          const key = `${prop.ns}|${prop.name}`
          if (key === `${D}|resourcetype`)
            found.push('<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>')
          else if (key === `${D}|displayname`)
            found.push(element(prop, escapeXml(share.calendar.name)))
          else if (key === `${CS}|getctag`) found.push(element(prop, escapeXml(token)))
          else if (key === `${D}|sync-token`) found.push(element(prop, escapeXml(token)))
          else if (key === `${D}|current-user-privilege-set`) {
            found.push(
              '<D:current-user-privilege-set><D:privilege><D:read/></D:privilege>' +
                '<D:privilege><C:read-free-busy/></D:privilege></D:current-user-privilege-set>',
            )
          } else if (key === `${C}|supported-calendar-component-set`) {
            found.push(
              '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>',
            )
          } else if (key === `${D}|supported-report-set`) {
            found.push(
              '<D:supported-report-set>' +
                [
                  'C:calendar-query',
                  'C:calendar-multiget',
                  'C:free-busy-query',
                  'D:sync-collection',
                ]
                  .map(
                    (report) =>
                      `<D:supported-report><D:report><${report}/></D:report></D:supported-report>`,
                  )
                  .join('') +
                '</D:supported-report-set>',
            )
          } else if (key === `${ICAL}|calendar-color` && share.calendar.color) {
            found.push(element(prop, escapeXml(share.calendar.color)))
          } else missing.push(prop)
        }
        return `<D:response><D:href>${escapeXml(base)}</D:href>${propstats(found, missing)}</D:response>`
      }
      const entryResponse = (entry: BusyEntry, defaults = ENTRY_DEFAULT): string => {
        const asked = wanted === 'all' ? defaults : wanted
        const found: string[] = []
        const missing: WantedProp[] = []
        for (const prop of asked) {
          const key = `${prop.ns}|${prop.name}`
          if (key === `${D}|getetag`) found.push(element(prop, escapeXml(entry.etag)))
          else if (key === `${D}|getcontenttype`) {
            found.push(element(prop, 'text/calendar; charset=utf-8; component=VEVENT'))
          } else if (key === `${D}|resourcetype`) found.push('<D:resourcetype/>')
          else if (key === `${C}|calendar-data`) found.push(element(prop, escapeXml(entry.ics)))
          else if (key === `${D}|getcontentlength`) {
            found.push(element(prop, String(Buffer.byteLength(entry.ics))))
          } else missing.push(prop)
        }
        return `<D:response><D:href>${escapeXml(base + entry.name)}</D:href>${propstats(found, missing)}</D:response>`
      }

      if (method === 'PROPFIND') {
        if (share.item !== null) {
          const entry = byName.get(share.item)
          return entry ? multistatus(entryResponse(entry)) : plain(404, 'Not Found')
        }
        const children = request.depth === '0' ? [] : entries.map((entry) => entryResponse(entry))
        return multistatus(collectionResponse() + children.join(''))
      }

      if (root === 'calendar-query') {
        // Only events are here; a query for tasks or journals finds nothing. A time range is not
        // applied: every busy copy is answered, which a calendar app keeps as it would a larger range.
        const filters = [...request.body.matchAll(/comp-filter[^>]*name\s*=\s*"([^"]+)"/gi)].map(
          (match) => match[1]!.toUpperCase(),
        )
        const nested = filters.filter((name) => name !== 'VCALENDAR')
        const matching = nested.length === 0 || nested.includes('VEVENT') ? entries : []
        return multistatus(matching.map((entry) => entryResponse(entry)).join(''))
      }

      if (root === 'calendar-multiget') {
        const parts: string[] = []
        for (const href of request.body.matchAll(
          /<(?:[\w.-]+:)?href>([^<]*)<\/(?:[\w.-]+:)?href>/g,
        )) {
          const raw = href[1]!.trim()
          const entry = byName.get(lastSegment(raw.replace(/&amp;/g, '&')))
          parts.push(
            entry
              ? entryResponse(entry)
              : `<D:response><D:href>${escapeXml(raw)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
          )
        }
        return multistatus(parts.join(''))
      }

      // sync-collection: everything for a first sync, nothing for the current token, and for any
      // other token the error that makes a client start over (RFC 6578 §3.2), so a removed event
      // never stays behind in the app.
      const given = tagText(request.body, 'sync-token') ?? ''
      if (given !== '' && given !== token) {
        return new Response(
          `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="${D}"><D:valid-sync-token/></D:error>`,
          {
            status: 403,
            headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' },
          },
        )
      }
      const changed = given === '' ? entries.map((entry) => entryResponse(entry)) : []
      return multistatus(`${changed.join('')}<D:sync-token>${escapeXml(token)}</D:sync-token>`)
    },
  }
}
