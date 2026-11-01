// Splits the text of an `.ics` file into CalDAV resources, one per UID (FR-7, importing a file). A
// file holds many events, a calendar collection holds one resource per UID, and a recurring event has
// to stay in one resource together with its RECURRENCE-ID overrides. Like the writer (write-lines.ts)
// this works on the original lines: every line that is kept comes out as it went in, folds included,
// and nothing is re-serialised through ical.js.
//
// The file is untrusted and may be damaged (NFR-4). The text is cut into top-level components by a
// scan that survives missing and stray END lines and gives up on nesting deeper than a calendar has,
// and each component is parsed on its own, so a broken one costs only itself. Nothing is expanded or
// evaluated; the work is linear in the size of the text.
import { sha256Hex } from '../import/naming'
import {
  firstProp,
  insertProp,
  makeProp,
  paramValue,
  parseDocument,
  props,
  rawValue,
  serializeDocument,
  subcomponents,
  unescapeText,
  type Comp,
  type Prop,
} from './write-lines'
import { IMPORT_ALLOWED_X_PROPERTIES } from './x-properties'

// The writer's own PRODID (write.ts), for a file that has none.
const PRODID = '-//web-calendar//Web Calendar//EN'

/** Components that sit directly in a VCALENDAR: one of them cannot start inside another. */
const TOP_LEVEL = new Set(['VEVENT', 'VTODO', 'VJOURNAL', 'VFREEBUSY', 'VTIMEZONE'])
/** VEVENT > VALARM is the deepest a real component goes. */
const MAX_DEPTH = 4

export type SkipReason =
  /** Not a VEVENT (a VTODO, VJOURNAL, VFREEBUSY or something else). */
  | 'not-an-event'
  /** A VEVENT without a start: the calendar service refuses it and no view could place it. */
  | 'no-start'
  /** No END line, a stray or crossed END, or nested too deep: the component cannot be trusted. */
  | 'damaged'
  /** The same UID and RECURRENCE-ID as an event earlier in the file. */
  | 'duplicate'

export interface SkippedComponent {
  reason: SkipReason
  /** Upper-case name of the component, for example `VTODO`. */
  component: string
  /** The SUMMARY as written, unescaped; empty when there is none. Untrusted: clean it before showing it. */
  summary: string
}

/** One CalDAV resource: every VEVENT of one UID. */
export interface SplitResource {
  uid: string
  /** The SUMMARY of the series (else of its first event). Untrusted, as above. */
  summary: string
  /** The complete `.ics` text of the resource, CRLF line ends. */
  ics: string
  /** VEVENTs in it: the master and its overrides. */
  events: number
}

export interface SplitResult {
  /** Set when the text cannot be imported at all; there are no resources then. */
  problem: 'not-icalendar' | 'unsupported-version' | null
  /** `X-WR-CALNAME` or `NAME` of the file, as written (unescaped); null when it has none. */
  calendarName: string | null
  /** In the order the UIDs first appear in the file. */
  resources: SplitResource[]
  skipped: SkippedComponent[]
}

/** A top-level component cut out of the text. */
interface Block {
  /** Upper-case component name. */
  name: string
  /** The physical lines from BEGIN to END; empty when the scan gave up on the block. */
  lines: string[]
  complete: boolean
}

interface OpenBlock extends Block {
  /** The components entered and not left yet, outermost first. */
  stack: string[]
}

interface Scan {
  /** Lines outside any component: the properties of the calendar. */
  header: string[]
  blocks: Block[]
  /** How many `BEGIN:VCALENDAR` lines there were. */
  calendars: number
}

function scan(text: string): Scan {
  const header: string[] = []
  const blocks: Block[] = []
  let calendars = 0
  let open: OpenBlock | null = null
  const close = (block: OpenBlock, complete: boolean): void => {
    blocks.push({ name: block.name, lines: block.lines, complete })
  }

  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    if (line === '') continue
    const folded = line.startsWith(' ') || line.startsWith('\t')
    const begin = folded ? null : /^BEGIN:(.*)$/i.exec(line)
    const end = folded || begin ? null : /^END:(.*)$/i.exec(line)
    const name = (begin ?? end)?.[1]?.trim().toUpperCase() ?? ''

    // A component cannot start inside another one and a calendar does not end inside one: the open
    // component lost its END line. What it holds is not trusted, the lines after it are read anew.
    if (
      open &&
      ((begin && (name === 'VCALENDAR' || TOP_LEVEL.has(name))) || (end && name === 'VCALENDAR'))
    ) {
      close(open, false)
      open = null
    }

    if (!open) {
      if (begin) {
        if (name === 'VCALENDAR') calendars++
        else open = { name, lines: [line], stack: [name], complete: true }
      } else if (!end) {
        header.push(line)
      }
      continue
    }

    // Too deep: the lines are no longer kept, the block waits for the next top-level line.
    if (!open.complete && open.lines.length === 0) continue
    open.lines.push(line)
    if (begin) {
      if (open.stack.length >= MAX_DEPTH) {
        open.complete = false
        open.lines = []
      } else open.stack.push(name)
    } else if (end) {
      const at = open.stack.lastIndexOf(name)
      if (at !== open.stack.length - 1) open.complete = false
      if (at >= 0) open.stack.length = at
      if (open.stack.length === 0) {
        close(open, open.complete)
        open = null
      }
    }
  }
  if (open) close(open, false)
  return { header, blocks, calendars }
}

/** The SUMMARY of a block that is not read as a whole (an unfolded first line is enough to name it). */
function summaryOfLines(lines: readonly string[]): string {
  for (const line of lines) {
    const value = /^SUMMARY(?:;[^:]*)?:(.*)$/i.exec(line)?.[1]
    if (value !== undefined) return unescapeText(value)
  }
  return ''
}

function textOf(prop: Prop | undefined): string {
  return prop ? unescapeText(rawValue(prop)).trim() : ''
}

/** Every TZID parameter in the component and the ones inside it (VALARM). */
function collectTzids(comp: Comp, into: Set<string>): void {
  for (const child of comp.children) {
    if (child.kind === 'comp') collectTzids(child, into)
    else if (/;TZID=/i.test(child.text)) {
      const tzid = paramValue(child, 'TZID')
      if (tzid) into.add(tzid)
    }
  }
}

interface ParsedEvent {
  comp: Comp
  uid: string
  /** Empty for a master, else the RECURRENCE-ID line: which occurrence the override replaces. */
  slot: string
  summary: string
  tzids: Set<string>
}

/**
 * Removes the X- properties of the event itself (those of its alarms are no claim about the event)
 * unless allow-listed: a file from outside must not say that an event books a resource.
 */
function stripForeignXProperties(comp: Comp): void {
  comp.children = comp.children.filter(
    (child) =>
      child.kind !== 'prop' ||
      !child.name.startsWith('X-') ||
      IMPORT_ALLOWED_X_PROPERTIES.has(child.name),
  )
}

/** The VEVENT of a block, or why it is not usable. */
function readEvent(block: Block): ParsedEvent | 'damaged' | 'no-start' {
  if (!block.complete) return 'damaged'
  let comp: Comp | undefined
  try {
    comp = subcomponents(parseDocument(block.lines.join('\r\n')), 'VEVENT')[0]
  } catch {
    return 'damaged'
  }
  if (!comp) return 'damaged'
  stripForeignXProperties(comp)
  const start = firstProp(comp, 'DTSTART')
  if (!start || rawValue(start).trim() === '') return 'no-start'
  const recurrenceId = firstProp(comp, 'RECURRENCE-ID')
  const tzids = new Set<string>()
  collectTzids(comp, tzids)
  return {
    comp,
    uid: textOf(firstProp(comp, 'UID')),
    slot: recurrenceId ? recurrenceId.text.trim().toUpperCase() : '',
    summary: textOf(firstProp(comp, 'SUMMARY')),
    tzids,
  }
}

/** The TZID a VTIMEZONE block defines and the parsed component, or null when it cannot be read. */
function readZone(block: Block): { tzid: string; comp: Comp } | null {
  if (!block.complete) return null
  try {
    const comp = subcomponents(parseDocument(block.lines.join('\r\n')), 'VTIMEZONE')[0]
    const tzid = comp ? textOf(firstProp(comp, 'TZID')) : ''
    return comp && tzid ? { tzid, comp } : null
  } catch {
    return null
  }
}

interface Group {
  uid: string
  events: ParsedEvent[]
  slots: Set<string>
}

const wrap = (name: string, children: Comp['children']): Comp => ({
  kind: 'comp',
  name,
  beginRaw: '',
  endRaw: '',
  children,
})

/** The calendar's own properties (VERSION, PRODID, ...) as a component. */
function readHeader(lines: readonly string[]): Comp {
  try {
    return parseDocument(lines.join('\r\n'))
  } catch {
    return wrap('', [])
  }
}

/**
 * The VCALENDAR of one resource: VERSION and PRODID, the VTIMEZONEs the events refer to, the
 * events. Calendar properties such as METHOD (a calendar collection must not hold one, RFC 4791
 * §4.1) and `X-WR-CALNAME` describe the file, not the event, and stay behind.
 */
function buildResource(group: Group, zones: Map<string, Comp>, prodid: Prop | undefined): string {
  const tzids = new Set(group.events.flatMap((event) => [...event.tzids]))
  const used = [...tzids]
    .map((tzid) => zones.get(tzid))
    .filter((zone): zone is Comp => zone !== undefined)
  const calendar = wrap('VCALENDAR', [
    makeProp('VERSION', [], '2.0'),
    prodid ?? makeProp('PRODID', [], PRODID),
    ...used,
    ...group.events.map((event) => event.comp),
  ])
  return serializeDocument(wrap('', [calendar]))
}

/**
 * The resources of a file. A VEVENT without a UID gets one made from a hash of its own lines, so
 * importing the same file again finds the event again. What cannot be imported is listed in
 * `skipped`; the rest of the file is not affected by it.
 */
export async function splitCalendar(text: string): Promise<SplitResult> {
  const { header, blocks, calendars } = scan(text)
  const none = (problem: SplitResult['problem']): SplitResult => ({
    problem,
    calendarName: null,
    resources: [],
    skipped: [],
  })
  if (calendars === 0 && blocks.length === 0) return none('not-icalendar')

  const head = readHeader(header)
  // A vCalendar 1.0 file looks alike and means something else: not ours to relabel as 2.0.
  if (props(head, 'VERSION').some((version) => rawValue(version).trim() !== '2.0')) {
    return none('unsupported-version')
  }
  const prodid = props(head, 'PRODID').find((prop) => rawValue(prop).trim() !== '')
  const name = textOf(firstProp(head, 'X-WR-CALNAME')) || textOf(firstProp(head, 'NAME'))

  const zones = new Map<string, Comp>()
  const groups = new Map<string, Group>()
  const skipped: SkippedComponent[] = []
  for (const block of blocks) {
    if (block.name === 'VTIMEZONE') {
      const zone = readZone(block)
      if (zone && !zones.has(zone.tzid)) zones.set(zone.tzid, zone.comp)
      continue
    }
    if (block.name !== 'VEVENT') {
      skipped.push({
        reason: 'not-an-event',
        component: block.name,
        summary: summaryOfLines(block.lines),
      })
      continue
    }
    const event = readEvent(block)
    if (typeof event === 'string') {
      skipped.push({
        reason: event,
        component: block.name,
        summary: summaryOfLines(block.lines),
      })
      continue
    }
    if (!event.uid) {
      event.uid = `${(await sha256Hex(block.lines.join('\n'))).slice(0, 32)}@web-calendar.invalid`
      insertProp(event.comp, makeProp('UID', [], event.uid))
    }
    let group = groups.get(event.uid)
    if (!group) groups.set(event.uid, (group = { uid: event.uid, events: [], slots: new Set() }))
    if (group.slots.has(event.slot)) {
      skipped.push({ reason: 'duplicate', component: block.name, summary: event.summary })
      continue
    }
    group.slots.add(event.slot)
    group.events.push(event)
  }

  const resources = [...groups.values()].map((group) => ({
    uid: group.uid,
    summary: (group.events.find((event) => event.slot === '') ?? group.events[0])!.summary,
    ics: buildResource(group, zones, prodid),
    events: group.events.length,
  }))
  return { problem: null, calendarName: name || null, resources, skipped }
}
