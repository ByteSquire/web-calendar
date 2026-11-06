// The sidebar's calendars from what the sources report: the CalDAV collections of the built-in
// service (FR-8) and the iCal subscriptions (FR-7), with the viewer's preferences applied (FR-4,
// FR-5). Pure, so it runs in plain Vitest.
import type { Calendar } from '../../../shared/types/calendar'
import type { ExternalAccount } from '../../../shared/types/external'
import type { DavCalendar } from '../caldav/types'
import { ensureTrailingSlash, toDavPath } from '../caldav/urls'
import { sharedCalendarId } from '../../../shared/utils/shared-calendar-name'
import { calendarLabel } from '../calendar-label'
import type { ApiCalendarPref, ApiIcalSubscription, ApiSharedCalendar } from './api-types'
import { normalizeHexColor, paletteColor } from './palette'

/**
 * The collection every member of `web_calendar_users` finds in their home once the group file the
 * app writes lists them: the booked times of the resources, shared free/busy only (design §5, §8).
 * Third-party CalDAV clients may list it; the web app reads availability through its own API, so it
 * is no calendar of the sidebar, and a full read of it is refused by Radicale (403).
 */
export const AVAILABILITY_COLLECTION = 'resource-availability'

/** True for `<home>/resource-availability/`, as a path or an absolute URL. */
export function isAvailabilityCollection(collectionUrl: string): boolean {
  const path = toDavPath(collectionUrl.trim()).split(/[?#]/, 1)[0] ?? ''
  const segments = path.split('/').filter((segment) => segment !== '')
  // `/caldav/<home>/resource-availability/`: the gateway prefix, the home, the collection.
  const last = segments.at(-1)
  return (
    segments.length >= 2 && last !== undefined && decodeSegment(last) === AVAILABILITY_COLLECTION
  )
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** The calendar ref (`Calendar.id`, `calendar_prefs.calendar_ref`) of a CalDAV collection. */
export function davRef(collectionUrl: string): string {
  return `dav:${ensureTrailingSlash(toDavPath(collectionUrl.trim()))}`
}

/**
 * The calendar ref of a collection of an external account: `ext:<account id>:<collection URL>`.
 * The URL is absolute, on the account's origin, with a trailing slash (what discovery returns).
 */
export function externalRef(accountId: number, collectionUrl: string): string {
  return `ext:${accountId}:${ensureTrailingSlash(collectionUrl.trim())}`
}

/** The account id of an `ext:<id>:<url>` ref, or null for any other string. */
export function externalAccountIdOf(ref: string): number | null {
  const match = /^ext:([1-9][0-9]{0,14}):./s.exec(ref)
  return match ? Number(match[1]) : null
}

export function isExternalRef(ref: string): boolean {
  return externalAccountIdOf(ref) !== null
}

/** The numeric subscription id of an `ics:<id>` ref, or null for any other string. */
export function subscriptionIdOf(ref: string): string | null {
  const match = /^ics:([1-9][0-9]{0,14})$/.exec(ref)
  return match ? match[1]! : null
}

/** The calendars discovery found behind one external account. */
export interface ExternalCollections {
  account: Pick<ExternalAccount, 'id' | 'color'>
  collections: readonly DavCalendar[]
}

/** The longest ref `/api/calendar-prefs` accepts. */
const MAX_REF_LENGTH = 500

export interface BuildCalendarsInput {
  collections: readonly DavCalendar[]
  subscriptions: readonly ApiIcalSubscription[]
  prefs: readonly ApiCalendarPref[]
  /** Id of the signed-in user; set as `ownerId` of the CalDAV calendars (they are the user's own). */
  ownerId?: string
  /** The calendars of the external accounts, in the order of the accounts. Always read-only. */
  external?: readonly ExternalCollections[]
  /** Position of the first calendar in the whole list, for the palette (see `external`). */
  paletteOffset?: number
  /**
   * The calendars shared with the viewer (`/api/shared-calendars`): a person's calendar mapped into
   * the viewer's home (`shared-<id>…`) is named with its owner, "Personal Calendar (Alice)", as on
   * the access page, so it is not mistaken for the viewer's own of the same name.
   */
  shared?: readonly ApiSharedCalendar[]
}

/** The name of a collection in the viewer's home, with the owner when it is someone's calendar. */
function collectionName(collection: DavCalendar, shared: ReadonlyMap<number, ApiSharedCalendar>) {
  const segment = toDavPath(collection.url).split('/').filter(Boolean).pop() ?? ''
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    // keep the encoded segment; it is then no share name
  }
  const id = sharedCalendarId(decoded)
  const calendar = id === null ? undefined : shared.get(id)
  return calendar
    ? calendarLabel({ name: collection.displayName, kind: calendar.kind, owner: calendar.owner })
    : collection.displayName
}

/**
 * CalDAV collections first, then subscriptions, then the external accounts' calendars, each in
 * the order the source gave them.
 * Colour: the viewer's override, else the source's (for an external calendar the account's, else
 * the server's), else the palette by position in this list. A calendar without a stored
 * preference is visible.
 */
export function buildCalendars(input: BuildCalendarsInput): Calendar[] {
  const prefs = new Map(input.prefs.map((pref) => [pref.ref, pref]))
  const shared = new Map((input.shared ?? []).map((calendar) => [calendar.id, calendar]))
  const seen = new Set<string>()
  const calendars: Calendar[] = []

  const add = (
    calendar: Omit<Calendar, 'color' | 'ownColor' | 'defaultVisible'>,
    sourceColor: string | null,
  ) => {
    // Two collections can never share a path, but a broken server answer must not make duplicate
    // ids (they are keys in the sidebar and in the state's look-ups).
    if (seen.has(calendar.id)) return
    seen.add(calendar.id)
    const pref = prefs.get(calendar.id)
    const ownColor =
      normalizeHexColor(sourceColor) ?? paletteColor((input.paletteOffset ?? 0) + calendars.length)
    calendars.push({
      ...calendar,
      color: normalizeHexColor(pref?.color) ?? ownColor,
      ownColor,
      defaultVisible: pref?.visible ?? true,
    })
  }

  for (const collection of input.collections) {
    add(
      {
        id: davRef(collection.url),
        name: collectionName(collection, shared),
        type: 'caldav',
        href: toDavPath(collection.url),
        readOnly: collection.readOnly,
        ...(collection.freeBusyOnly ? { freeBusyOnly: true } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      },
      collection.color,
    )
  }
  for (const subscription of input.subscriptions) {
    add(
      {
        id: subscription.ref,
        name: subscription.name,
        type: 'ical',
        readOnly: true,
        sourceUrl: subscription.url,
      },
      subscription.color,
    )
  }
  for (const { account, collections } of input.external ?? []) {
    for (const collection of collections) {
      const id = externalRef(account.id, collection.url)
      // A ref the server would refuse could not be stored in preferences or views.
      if (id.length > MAX_REF_LENGTH) continue
      add(
        {
          id,
          name: collection.displayName,
          type: 'caldav',
          href: collection.url,
          readOnly: true,
          caldavAccountId: String(account.id),
        },
        normalizeHexColor(account.color) ?? collection.color,
      )
    }
  }
  return calendars
}

/**
 * The visible set after the calendars were (re)loaded. What the viewer has chosen stays (minus
 * calendars that are gone); a calendar that was not known before starts as its preference says.
 * On the first load nothing was known, so this is the set of calendars visible by default.
 */
export function reconcileVisibleCalendars(input: {
  visibleIds: readonly string[]
  previous: readonly Calendar[]
  next: readonly Calendar[]
}): string[] {
  const known = new Set(input.previous.map((calendar) => calendar.id))
  const visible = new Set(input.visibleIds)
  return input.next
    .filter((calendar) =>
      known.has(calendar.id) ? visible.has(calendar.id) : calendar.defaultVisible,
    )
    .map((calendar) => calendar.id)
}
