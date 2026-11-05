// What a calendar link shows of an event, and nothing more: the calendar data from Radicale is
// rebuilt from an allow-list instead of being passed on. Kept: the times (start, end or duration,
// the recurrence id of an expanded occurrence), the title, the place, the status and whether the
// time counts as busy, and the time zones the times refer to. Left out: the description, the
// people (organizer, attendees), attachments, links, alarms, categories and every X- property (the
// app's booking properties among them). An event marked private or confidential keeps its time
// only and is shown as busy.
import ICAL from 'ical.js'

const EVENT_PROPERTIES = new Set([
  'uid',
  'dtstamp',
  'dtstart',
  'dtend',
  'duration',
  'recurrence-id',
  'status',
  'transp',
  'summary',
  'location',
])
/** Dropped from an event that is private or confidential, on top of what is never kept. */
const PRIVATE_PROPERTIES = new Set(['summary', 'location'])
/** The parts of a time zone definition. */
const ZONE_COMPONENTS = new Set(['standard', 'daylight'])

export interface SanitizedObject {
  /** A VCALENDAR with only what a link may show. */
  data: string
  /** Every event in it was private or confidential: show it as busy, without a title. */
  blocked: boolean
}

function copyProperty(target: ICAL.Component, property: ICAL.Property): void {
  target.addProperty(new ICAL.Property(property.toJSON() as unknown as string))
}

/** A copy of a VTIMEZONE without X- properties or unknown parts. */
function cleanZone(zone: ICAL.Component): ICAL.Component {
  const out = new ICAL.Component('vtimezone')
  for (const property of zone.getAllProperties()) {
    if (!property.name.startsWith('x-')) copyProperty(out, property)
  }
  for (const part of zone.getAllSubcomponents()) {
    if (!ZONE_COMPONENTS.has(part.name)) continue
    const copy = new ICAL.Component(part.name)
    for (const property of part.getAllProperties()) {
      if (!property.name.startsWith('x-')) copyProperty(copy, property)
    }
    out.addSubcomponent(copy)
  }
  return out
}

function isPrivate(event: ICAL.Component): boolean {
  const value = event.getFirstPropertyValue('class')
  const kind = typeof value === 'string' ? value.toUpperCase() : ''
  return kind === 'PRIVATE' || kind === 'CONFIDENTIAL'
}

function cleanEvent(event: ICAL.Component): ICAL.Component {
  const out = new ICAL.Component('vevent')
  const hidden = isPrivate(event)
  for (const property of event.getAllProperties()) {
    if (!EVENT_PROPERTIES.has(property.name)) continue
    if (hidden && PRIVATE_PROPERTIES.has(property.name)) continue
    copyProperty(out, property)
  }
  return out
}

/**
 * One calendar object as a link may show it, or null when it holds no event or cannot be read
 * (it is then left out, like the reader of the app leaves out what it cannot read).
 */
export function sanitizeCalendarObject(text: string): SanitizedObject | null {
  let root: ICAL.Component
  try {
    root = new ICAL.Component(ICAL.parse(text) as unknown as unknown[])
  } catch {
    return null
  }
  if (root.name !== 'vcalendar') return null
  const events = root.getAllSubcomponents('vevent')
  if (events.length === 0) return null
  const out = new ICAL.Component('vcalendar')
  out.addPropertyWithValue('version', '2.0')
  out.addPropertyWithValue('prodid', '-//Web Calendar//Calendar link//EN')
  for (const zone of root.getAllSubcomponents('vtimezone')) out.addSubcomponent(cleanZone(zone))
  for (const event of events) out.addSubcomponent(cleanEvent(event))
  return { data: out.toString(), blocked: events.every(isPrivate) }
}
