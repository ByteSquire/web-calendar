// The sidebar's calendars from what the sources report: the CalDAV collections of the built-in
// service (FR-8) and the iCal subscriptions (FR-7), with the viewer's preferences applied (FR-4,
// FR-5). Pure, so it runs in plain Vitest.
import type { Calendar } from '../../../shared/types/calendar'
import type { DavCalendar } from '../caldav/types'
import { ensureTrailingSlash, toDavPath } from '../caldav/urls'
import type { ApiCalendarPref, ApiIcalSubscription } from './api-types'
import { normalizeHexColor, paletteColor } from './palette'

/** The calendar ref (`Calendar.id`, `calendar_prefs.calendar_ref`) of a CalDAV collection. */
export function davRef(collectionUrl: string): string {
  return `dav:${ensureTrailingSlash(toDavPath(collectionUrl.trim()))}`
}

/** The numeric subscription id of an `ics:<id>` ref, or null for any other string. */
export function subscriptionIdOf(ref: string): string | null {
  const match = /^ics:([1-9][0-9]{0,14})$/.exec(ref)
  return match ? match[1]! : null
}

export interface BuildCalendarsInput {
  collections: readonly DavCalendar[]
  subscriptions: readonly ApiIcalSubscription[]
  prefs: readonly ApiCalendarPref[]
  /** Id of the signed-in user; set as `ownerId` of the CalDAV calendars (they are the user's own). */
  ownerId?: string
}

/**
 * CalDAV collections first, then subscriptions, each in the order the source gave them.
 * Colour: the viewer's override, else the source's, else the palette by position in this list.
 * A calendar without a stored preference is visible.
 */
export function buildCalendars(input: BuildCalendarsInput): Calendar[] {
  const prefs = new Map(input.prefs.map((pref) => [pref.ref, pref]))
  const seen = new Set<string>()
  const calendars: Calendar[] = []

  const add = (
    calendar: Omit<Calendar, 'color' | 'defaultVisible'>,
    sourceColor: string | null,
  ) => {
    // Two collections can never share a path, but a broken server answer must not make duplicate
    // ids (they are keys in the sidebar and in the state's look-ups).
    if (seen.has(calendar.id)) return
    seen.add(calendar.id)
    const pref = prefs.get(calendar.id)
    calendars.push({
      ...calendar,
      color:
        normalizeHexColor(pref?.color) ??
        normalizeHexColor(sourceColor) ??
        paletteColor(calendars.length),
      defaultVisible: pref?.visible ?? true,
    })
  }

  for (const collection of input.collections) {
    add(
      {
        id: davRef(collection.url),
        name: collection.displayName,
        type: 'caldav',
        href: toDavPath(collection.url),
        readOnly: collection.readOnly,
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
