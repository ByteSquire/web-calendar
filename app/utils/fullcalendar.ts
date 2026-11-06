// FullCalendar glue that runs without FullCalendar itself: view-type mapping, options that depend on
// the layout, the mapping of calendar events to FullCalendar event inputs and the colour decisions
// (text contrast, tentative and cancelled tints, schemes). CalendarMain.vue adds the plugins and
// the reactive state. Tests: tests/fullcalendar.test.ts.
import { Temporal } from 'temporal-polyfill'
import type { CalendarOptions, EventInput } from '@fullcalendar/vue3'
import type { Calendar, CalendarEvent, Category } from '../../shared/types/calendar'
import type { NewEventInput, SplitSpan, ViewType } from './calendar-state'
import { BUSY_TITLE, eventAssistiveLabel } from './event-display'
import { intlLocale, t, tc, tv } from './i18n'

// ---- Views ----

export const FULLCALENDAR_VIEW_NAMES = {
  day: 'timeGridDay',
  '5day': 'timeGrid5Day',
  week: 'timeGridWeek',
  month: 'dayGridMonth',
  year: 'multiMonthYear',
  list: 'listWeek',
} satisfies Record<Exclude<ViewType, 'split'>, string>

/** The FullCalendar view for a view type. The split view maps like its span (`splitSpan`). */
export function fullCalendarViewName(viewType: ViewType, splitSpan: SplitSpan = 'week'): string {
  return FULLCALENDAR_VIEW_NAMES[viewType === 'split' ? splitSpan : viewType]
}

/**
 * The calendar date FullCalendar reports as a `Date` (the start of a day in the organization time
 * zone, which the caller passes: `useDisplayTimeZone()`).
 */
export function plainDateInCalendarZone(date: Date, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
}

// ---- Options ----

/** Below this width of the calendar's own container the narrow-screen options apply. */
export const COMPACT_MAX_WIDTH = 700

export function isCompactWidth(width: number): boolean {
  return width < COMPACT_MAX_WIDTH
}

const TIME_FORMAT = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const

export const SCHEDULER_LICENSE_KEY = 'AGPL-My-Frontend-And-Backend-Are-Open-Source'

/**
 * Options that do not change while the app runs, apart from `timeZone`, which the caller adds from
 * the viewer's display zone (`useDisplayTimeZone()`, FR-29). Editing stays off in Phase 1: `editable` and
 * `selectable` are the master switches, the rest repeats them for events and drops.
 */
// ---- Accessible names of date links (WCAG 2.5.3, Label in Name) ----
//
// FullCalendar names a link to a date after the date and not after the text on screen: a month
// title shown as "Sep" is named "Go to 2026-09", and a column header shown as "Mon 26" is named
// "26 October 2026". A voice-control user who says what they see ("click Sep") then misses the
// link. Neither name has an option, so the hint is a function and the header is named when it is
// mounted. What is on screen does not change.

const MONTH_ISO = /^(\d{4})-(\d{2})$/
const monthAndYear = (first: Date) =>
  new Intl.DateTimeFormat(intlLocale(), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(first)

/** The name of a link to a date, from FullCalendar's text for it ("2026-09", "26 October 2026"). */
export function navLinkName(dateStr: string): string {
  const month = MONTH_ISO.exec(dateStr)
  if (!month) return t('Go to {date}', { date: dateStr })
  const first = new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1))
  return t('Go to {date}', { date: monthAndYear(first) })
}

/**
 * Puts the text on screen at the start of the name of a column header link, unless the name holds
 * it already: "Mon 26" and "26 October 2026" become "Mon 26, 26 October 2026".
 */
export function nameDayHeader(cell: HTMLElement): void {
  const link = cell.matches('[aria-label]') ? cell : cell.querySelector<HTMLElement>('[aria-label]')
  const shown = link?.textContent?.replace(/\s+/g, ' ').trim()
  const name = link?.getAttribute('aria-label')
  if (!link || !shown || !name || name.includes(shown)) return
  link.setAttribute('aria-label', `${shown}, ${name}`)
}

export const BASE_CALENDAR_OPTIONS = {
  // AGPLv3 key for projects whose frontend and backend are open source (design §2). The Premium
  // scroll grid, which lets narrow day columns pan sideways, and the split view's resource timeline
  // check it.
  schedulerLicenseKey: SCHEDULER_LICENSE_KEY,
  locale: 'en-gb',
  firstDay: 1,
  // The top bar owns navigation and the title.
  headerToolbar: false,
  footerToolbar: false,
  editable: false,
  selectable: false,
  eventStartEditable: false,
  eventDurationEditable: false,
  eventResizableFromStart: false,
  droppable: false,
  height: '100%',
  navLinks: true,
  navLinkHint: navLinkName,
  dayHeaderDidMount: ({ el }: { el: HTMLElement }) => nameDayHeader(el),
  nowIndicator: true,
  scrollTime: '07:00:00',
  moreLinkClick: 'popover',
  eventTimeFormat: TIME_FORMAT,
  slotHeaderFormat: TIME_FORMAT,
} satisfies CalendarOptions

// Narrow-screen sizes. A day column narrower than DAY_MIN_WIDTH scrolls sideways inside the
// calendar instead of squeezing the events, so the page itself never scrolls horizontally.
const DAY_MIN_WIDTH = 76

/**
 * Options that depend on the width of the calendar: sizes for the time grids and the month grid,
 * and the view definitions (`timeGrid5Day` is the custom five-day view).
 */
export function calendarLayoutOptions(compact: boolean): CalendarOptions {
  const panning = compact ? { dayMinWidth: DAY_MIN_WIDTH } : {}
  return {
    // Day columns narrower than this use the small text of the theme.
    dayNarrowWidth: 64,
    eventMinHeight: 22,
    eventShortHeight: 36,
    eventMinWidth: 24,
    views: {
      timeGrid: {
        slotMinHeight: 32,
        eventMaxStack: compact ? 2 : 4,
      },
      timeGridWeek: panning,
      timeGrid5Day: { type: 'timeGrid', duration: { days: 5 }, ...panning },
      dayGridMonth: {
        expandRows: true,
        fixedWeekCount: false,
        dayMaxEvents: true,
        displayEventTime: !compact,
      },
      multiMonthYear: {
        multiMonthMaxColumns: compact ? 1 : 3,
        dayMaxEvents: 2,
      },
    },
  }
}

/**
 * How entries are drawn. In the month, timed ones are filled strips in their calendar's colour, like
 * all-day ones and like the cards of the week, instead of FullCalendar's default there of a dot and
 * plain text. FullCalendar reads this option for the whole calendar, not per view, so it follows the
 * view type; the year keeps its dots.
 */
export function eventDisplayFor(viewType: ViewType): 'block' | 'auto' {
  return viewType === 'month' ? 'block' : 'auto'
}

// ---- Colours ----

export type ColorScheme = 'light' | 'dark'

export type EventKind = 'confirmed' | 'tentative' | 'cancelled' | 'blocked'

type Rgb = readonly [number, number, number]

/** Page background behind the calendar in each scheme (Nuxt UI neutral 50/900 with slate). */
const SURFACE: Record<ColorScheme, string> = { light: '#ffffff', dark: '#0f172a' }
/** Neutral fill of blocked ("Busy") events. */
const BUSY_FILL: Record<ColorScheme, string> = { light: '#475569', dark: '#cbd5e1' }
const FALLBACK_COLOR = '#475569'
const LIGHT_TEXT = '#ffffff'
const DARK_TEXT = '#000000'
/** Share of the calendar colour kept in the fill of tentative and cancelled events. */
const TINT_WEIGHT = { tentative: 0.4, cancelled: 0.25 }

/** Parses `#rgb`, `#rrggbb` and `#rrggbbaa` (the alpha is ignored); null for anything else. */
export function parseHexColor(value: string | undefined): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value?.trim() ?? '')
  if (!match) return null
  let hex = match[1]!
  if (hex.length === 3) {
    hex = [...hex].map((digit) => digit + digit).join('')
  }
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as unknown as Rgb
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color) ?? parseHexColor(FALLBACK_COLOR)!
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a)
  return (light! + 0.05) / (dark! + 0.05)
}

/** White or black, whichever reads better on `background`; always at least 4.5:1 (NFR-3). */
export function readableTextColor(background: string): string {
  return contrastRatio(background, LIGHT_TEXT) >= contrastRatio(background, DARK_TEXT)
    ? LIGHT_TEXT
    : DARK_TEXT
}

/** `weight` of `foreground` over `background`, as `#rrggbb`. */
export function mixColors(foreground: string, background: string, weight: number): string {
  const front = parseHexColor(foreground) ?? parseHexColor(FALLBACK_COLOR)!
  const back = parseHexColor(background) ?? parseHexColor(FALLBACK_COLOR)!
  return toHex(
    front.map((channel, index) => channel * weight + back[index]! * (1 - weight)) as unknown as Rgb,
  )
}

/**
 * Fill and text colour of an event. Confirmed events use the calendar colour; tentative and
 * cancelled ones a tint of it that sits closer to the page background of the scheme, which reads
 * as lighter in the light scheme and dimmer in the dark one; blocked events a neutral grey. The
 * text colour is chosen for the final fill, so contrast holds in both schemes.
 */
export function eventColors(
  calendarColor: string | undefined,
  kind: EventKind,
  scheme: ColorScheme,
): { color: string; contrastColor: string } {
  let color: string
  if (kind === 'blocked') {
    color = BUSY_FILL[scheme]
  } else {
    const base = toHex(parseHexColor(calendarColor) ?? parseHexColor(FALLBACK_COLOR)!)
    color = kind === 'confirmed' ? base : mixColors(base, SURFACE[scheme], TINT_WEIGHT[kind])
  }
  return { color, contrastColor: readableTextColor(color) }
}

// ---- Events ----

export function eventKind(event: Pick<CalendarEvent, 'status' | 'isBlocked'>): EventKind {
  return event.isBlocked ? 'blocked' : event.status
}

export interface EventMappingContext {
  calendarById: ReadonlyMap<string, Calendar>
  scheme: ColorScheme
  /** Given when the entries show their categories' colours ("Category colours on events"). */
  categoryById?: ReadonlyMap<string, Category>
}

/** What the calendar keeps with each entry: the id for clicks and the assistive label. */
export interface EventExtendedProps {
  eventId: string
  calendarId: string
  kind: EventKind
  label: string
  /** The colours of the entry's categories, in their order; empty unless they are shown. */
  categoryColors: string[]
}

/**
 * The categories an entry shows as coloured dots: its own (a saved category or a name it carries),
 * in their order. A busy time shows none: it must not tell what the event is about.
 */
export function shownCategories(
  event: Pick<CalendarEvent, 'categoryIds' | 'isBlocked'>,
  categoryById: ReadonlyMap<string, Category> | undefined,
): Category[] {
  if (!categoryById || event.isBlocked) return []
  return event.categoryIds.flatMap((id) => {
    const category = categoryById.get(id)
    return category ? [category] : []
  })
}

/** `YYYY-MM-DD` for all-day events, `YYYY-MM-DDTHH:mm:ss` otherwise, so strings compare in order. */
function normalizeBoundary(value: string, allDay: boolean): string {
  if (allDay) return value.slice(0, 10)
  return (value.length === 16 ? `${value}:00` : value).slice(0, 19)
}

/**
 * Maps a stored event to a FullCalendar input. Start and end are wall-clock strings in the
 * viewer's display zone and FullCalendar reads them in its own `timeZone` (the same zone). All-day ends are
 * exclusive on both sides. An end that is not after the start is left out, so FullCalendar uses its
 * default duration.
 */
export function toFullCalendarEvent(
  event: CalendarEvent,
  context: EventMappingContext,
): EventInput {
  const kind = eventKind(event)
  const calendar = context.calendarById.get(event.calendarId)
  const start = normalizeBoundary(event.start, event.allDay)
  const end = normalizeBoundary(event.end, event.allDay)
  const categories = shownCategories(event, context.categoryById)
  const label = eventAssistiveLabel(event, calendar?.name, {
    nameBlocked: calendar?.freeBusyOnly === true,
  })
  const extendedProps: EventExtendedProps = {
    eventId: event.id,
    calendarId: event.calendarId,
    kind,
    label:
      categories.length > 0
        ? `${label}, ${tc('category {names} | categories {names}', categories.length, {
            names: categories.map((category) => category.name).join(', '),
          })}`
        : label,
    categoryColors: categories.map((category) => category.color),
  }
  return {
    id: event.id,
    title: kind === 'blocked' ? tv(BUSY_TITLE) : event.title,
    start,
    ...(end > start ? { end } : {}),
    allDay: event.allDay,
    ...eventColors(calendar?.color, kind, context.scheme),
    // A tentative busy time (FBTYPE=BUSY-TENTATIVE) keeps its dashed edge, as in the split view.
    className:
      kind === 'blocked' && event.status === 'tentative'
        ? 'app-evt app-evt-blocked app-evt-tentative'
        : `app-evt app-evt-${kind}`,
    extendedProps,
  }
}

export function toFullCalendarEvents(
  events: readonly CalendarEvent[],
  context: EventMappingContext,
): EventInput[] {
  return events.map((event) => toFullCalendarEvent(event, context))
}

// ---- Date clicks ----

/**
 * Quick-add preset for a click on `dateStr` (FullCalendar's `dateStr`: a date, or a date-time whose
 * leading part is the wall-clock time in the display zone). A date cell gives a one-day all-day event; a
 * time slot gives a one-hour event starting there.
 */
export function quickAddPresetForClick(
  dateStr: string,
  allDay: boolean,
): Required<Pick<NewEventInput, 'start' | 'end' | 'allDay'>> {
  if (allDay) {
    const start = Temporal.PlainDate.from(dateStr.slice(0, 10))
    return { start: start.toString(), end: start.add({ days: 1 }).toString(), allDay: true }
  }
  const start = Temporal.PlainDateTime.from(dateStr.slice(0, 16))
  const toLocal = (time: Temporal.PlainDateTime) => time.toString({ smallestUnit: 'minute' })
  return { start: toLocal(start), end: toLocal(start.add({ hours: 1 })), allDay: false }
}
