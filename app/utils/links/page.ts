// The page of a calendar link (app/pages/link/[slug].vue) without Vue: the calls of the public API,
// the session kept for the tab, and the events of what the server sent. No sign-in: plain `$fetch`.
import type { CalendarEvent } from '../../../shared/types/calendar'
import { freeBusyEvents } from '../ical/free-busy'
import { readCalendarObject } from '../ical/read'

export const LINK_CALENDAR_ID = 'link'
export const SESSION_HEADER = 'x-calendar-link-session'
const STORE_PREFIX = 'web-calendar:link-session:'

export type LinkLevel = 'read' | 'free_busy'

export interface LinkSession {
  token: string
  expiresAt: string
  calendar: { name: string; color: string | null }
  level: LinkLevel
}

/** What a read of the link brings: the calendar objects, or the busy times only. */
export type LinkRead =
  { level: 'read'; objects: string[] } | { level: 'free_busy'; freeBusy: string }

/** Why the page cannot show its calendar. */
export type LinkFailure = 'wrong_password' | 'unavailable' | 'session' | 'too_many' | 'other'

export function failureOf(error: unknown): LinkFailure {
  const record = (error ?? {}) as {
    statusCode?: number
    status?: number
    data?: { data?: { code?: string } }
  }
  const status = record.statusCode ?? record.status
  const code = record.data?.data?.code
  if (status === 429) return 'too_many'
  if (status === 404) return 'unavailable'
  if (status === 401) return code === 'wrong_password' ? 'wrong_password' : 'session'
  return 'other'
}

/** The session of this tab for the link, while it lasts (sessionStorage: gone with the tab). */
export function readStoredSession(slug: string, now = Date.now()): LinkSession | null {
  try {
    const text = window.sessionStorage.getItem(STORE_PREFIX + slug)
    if (!text) return null
    const value = JSON.parse(text) as LinkSession
    if (typeof value?.token !== 'string' || Date.parse(value.expiresAt) <= now) return null
    if (value.level !== 'read' && value.level !== 'free_busy') return null
    return value
  } catch {
    return null
  }
}

export function storeSession(slug: string, session: LinkSession | null): void {
  try {
    if (session) window.sessionStorage.setItem(STORE_PREFIX + slug, JSON.stringify(session))
    else window.sessionStorage.removeItem(STORE_PREFIX + slug)
  } catch {
    // Without storage the password is asked again after a reload; nothing else changes.
  }
}

export function openLink(slug: string, password: string): Promise<LinkSession> {
  return $fetch<LinkSession>(`/api/link/${encodeURIComponent(slug)}/session`, {
    method: 'POST',
    body: { password },
  })
}

export function fetchLinkRead(
  slug: string,
  token: string,
  range: { start: Date; end: Date },
): Promise<LinkRead> {
  return $fetch<LinkRead>(`/api/link/${encodeURIComponent(slug)}/events`, {
    query: { from: range.start.toISOString(), to: range.end.toISOString() },
    headers: { [SESSION_HEADER]: token },
  })
}

/**
 * The events of what the server sent, as the calendar view shows them: the objects read like the
 * live loader reads an expanded REPORT (what a read share shows), or the busy times as "Busy"
 * entries (what a free/busy share shows). Booking properties are not trusted here, as for a feed.
 */
export function linkEvents(
  read: LinkRead,
  context: { displayTimeZone: string; orgTimeZone: string; range: { start: Date; end: Date } },
): CalendarEvent[] {
  if (read.level === 'free_busy') {
    return freeBusyEvents(read.freeBusy, {
      calendarId: LINK_CALENDAR_ID,
      displayTimeZone: context.displayTimeZone,
    })
  }
  const events: CalendarEvent[] = []
  const seen = new Set<string>()
  for (const [index, data] of read.objects.entries()) {
    const found = readCalendarObject(data, {
      calendarId: LINK_CALENDAR_ID,
      // The id of an event is made from its object's address; the page has none to write to, so
      // each object gets a name of its own, or the events of different objects would share one id.
      href: `link-object-${index}`,
      displayTimeZone: context.displayTimeZone,
      orgTimeZone: context.orgTimeZone,
      range: context.range,
      expandRecurrence: false,
    })
    for (const event of found.events) {
      // The same occurrence twice (one object listed twice) is shown once.
      const key = `${event.uid}|${event.start}`
      if (seen.has(key)) continue
      seen.add(key)
      delete event.href
      delete event.etag
      events.push(event)
    }
  }
  return events
}
