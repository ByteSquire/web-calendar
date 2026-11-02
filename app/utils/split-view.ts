// Pure helpers for the split view (FR-6): one FullCalendar Premium resource timeline with a row
// per calendar (spike S2). The components only wire these results into FullCalendar.
import { Temporal } from 'temporal-polyfill'
import type { Calendar, CalendarEvent, EventStatus } from '../../shared/types/calendar'
import { SPLIT_SPANS, type SplitBand, type SplitSpan } from './calendar-state'
import { STATUS_LABELS } from './event-display'
import { BASE_CALENDAR_OPTIONS } from './fullcalendar'
import { t, tv } from './i18n'

// ---- Colour ----

export type SplitColorScheme = 'light' | 'dark'

/** Nuxt's colour mode value ('light', 'dark', or 'system' before it resolves) as a scheme. */
export function splitColorScheme(mode: string | undefined): SplitColorScheme {
  return mode === 'dark' ? 'dark' : 'light'
}

type Rgb = readonly [number, number, number]

function parseHexColor(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!match) return null
  const hex = match[1]!
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
  const part = (at: number) => parseInt(full.slice(at, at + 2), 16)
  return [part(0), part(2), part(4)]
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}`
}

function luminance([red, green, blue]: Rgb): number {
  const linear = (channel: number) => {
    const scaled = channel / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

/** WCAG contrast ratio (1 to 21); NaN if a colour is not `#rgb` or `#rrggbb`. */
function contrastRatio(first: string, second: string): number {
  const a = parseHexColor(first)
  const b = parseHexColor(second)
  if (!a || !b) return NaN
  const [la, lb] = [luminance(a), luminance(b)] as const
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const TEXT_CANDIDATES = ['#ffffff', '#111827', '#000000']

/**
 * Text colour for a background: white if it reaches the WCAG AA ratio for normal text (4.5),
 * otherwise the first darker candidate that does. Where white falls short, black always reaches
 * it, so every background gets a readable text colour.
 */
export function splitTextColor(background: string): string {
  if (!parseHexColor(background)) return TEXT_CANDIDATES[0]!
  return TEXT_CANDIDATES.find((text) => contrastRatio(background, text) >= 4.5) ?? '#000000'
}

/** `weight` of `first` plus the rest of `second`, in sRGB; `first` unchanged if unparsable. */
function mixColors(first: string, second: string, weight: number): string {
  const a = parseHexColor(first)
  const b = parseHexColor(second)
  if (!a || !b) return first
  const channel = (at: 0 | 1 | 2) => a[at] * weight + b[at] * (1 - weight)
  return toHex([channel(0), channel(1), channel(2)])
}

export interface SplitEventColors {
  color: string
  contrastColor: string
}

// A tentative event is a tint of the calendar colour on the page background of the stock
// FullCalendar palette (white, or #030712 in the dark scheme).
const TENTATIVE_TINT = {
  light: { base: '#ffffff', weight: 0.28 },
  dark: { base: '#030712', weight: 0.45 },
} satisfies Record<SplitColorScheme, { base: string; weight: number }>

/** Fill and text colour of an event: the calendar colour, lighter when tentative. */
export function splitEventColors(
  calendarColor: string,
  status: EventStatus,
  scheme: SplitColorScheme,
): SplitEventColors {
  const tint = TENTATIVE_TINT[scheme]
  const color =
    status === 'tentative' ? mixColors(calendarColor, tint.base, tint.weight) : calendarColor
  return { color, contrastColor: splitTextColor(color) }
}

// ---- Resources and events ----

export interface TimelineResource {
  id: string
  title: string
  extendedProps: {
    color: string
    /** Position in the band list; FullCalendar sorts by id and title unless told otherwise. */
    sortIndex: number
  }
}

export interface TimelineEvent {
  id: string
  /** The calendar id: every calendar is one row. */
  resourceId: string
  title: string
  start: string
  end: string
  allDay: boolean
  color: string
  contrastColor: string
  /** Style hooks, see the `<style>` of SplitTimeline.vue. */
  class: string
  extendedProps: { status: EventStatus; blocked: boolean; calendarName: string }
}

export function toTimelineResource(calendar: Calendar, index: number): TimelineResource {
  return {
    id: calendar.id,
    title: calendar.name,
    extendedProps: { color: calendar.color, sortIndex: index + 1 },
  }
}

/** Blocked events (free/busy only, FR-18) show "Busy" and carry none of the event's details. */
export function toTimelineEvent(
  event: CalendarEvent,
  calendar: Calendar,
  scheme: SplitColorScheme,
): TimelineEvent {
  const blocked = event.isBlocked === true
  return {
    id: event.id,
    resourceId: calendar.id,
    title: blocked ? t('Busy') : event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    ...splitEventColors(calendar.color, event.status, scheme),
    class: [
      'split-event',
      event.status !== 'confirmed' && `split-event--${event.status}`,
      blocked && 'split-event--busy',
    ]
      .filter(Boolean)
      .join(' '),
    extendedProps: { status: event.status, blocked, calendarName: calendar.name },
  }
}

/** Resources (rows) and events for a list of split bands, in band order. */
export function toTimelineData(bands: readonly SplitBand[], scheme: SplitColorScheme) {
  return {
    resources: bands.map((band, index) => toTimelineResource(band.calendar, index)),
    events: bands.flatMap((band) =>
      band.events.map((event) => toTimelineEvent(event, band.calendar, scheme)),
    ),
  }
}

/** What a screen reader needs beyond the visible text: the calendar and non-obvious status. */
export function timelineEventSrText(props: TimelineEvent['extendedProps']): string {
  return [
    props.calendarName,
    props.status !== 'confirmed' && tv(STATUS_LABELS[props.status]).toLowerCase(),
    props.blocked && t('details hidden'),
  ]
    .filter(Boolean)
    .join(', ')
}

// ---- Views and layout ----

const SPLIT_VIEW_NAMES = {
  day: 'resourceTimelineDay',
  '5day': 'resourceTimeline5Day',
  week: 'resourceTimelineWeek',
  month: 'resourceTimelineMonth',
} satisfies Record<SplitSpan, string>

/** The FullCalendar view that shows a split span. */
export function splitViewName(span: SplitSpan): string {
  return SPLIT_VIEW_NAMES[span]
}

export type SplitLayoutTier = 'phone' | 'compact' | 'desktop'

/** Phones are below 480 px, landscape phones and small tablets below the 768 px breakpoint. */
export function splitLayoutTier(width: number): SplitLayoutTier {
  if (width >= 768) return 'desktop'
  return width >= 480 ? 'compact' : 'phone'
}

export interface SplitLayout {
  tier: SplitLayoutTier
  /** Narrowest a time slot may get; the timeline scrolls sideways below this. */
  slotMinWidth: number
  /** Width of the sticky calendar column, in px. */
  resourceColumnsWidth: number
  slotDuration: { hours: number } | { days: number }
}

// The day span has hourly slots, the other spans one slot per day. Event titles are clipped to
// their slot, so on a 360 px phone the layout trades sideways scrolling for readable day columns:
// 100 to 110 px per day beside a 100 px label column leaves 260 px, so a week scrolls about two
// and a half screens. A landscape phone (about 640 px) fits a week with narrower slots. The
// month needs 28 to 31 slots, so its slots are narrow everywhere.
const SLOT_MIN_WIDTH = {
  phone: { day: 72, '5day': 110, week: 100, month: 44 },
  compact: { day: 56, '5day': 64, week: 64, month: 40 },
  desktop: { day: 64, '5day': 120, week: 110, month: 40 },
} satisfies Record<SplitLayoutTier, Record<SplitSpan, number>>

const RESOURCE_COLUMNS_WIDTH = { phone: 100, compact: 100, desktop: 168 } satisfies Record<
  SplitLayoutTier,
  number
>

function buildLayout(tier: SplitLayoutTier, span: SplitSpan): SplitLayout {
  return {
    tier,
    slotMinWidth: SLOT_MIN_WIDTH[tier][span],
    resourceColumnsWidth: RESOURCE_COLUMNS_WIDTH[tier],
    slotDuration: span === 'day' ? { hours: 1 } : { days: 1 },
  }
}

const layoutsOf = (tier: SplitLayoutTier): Record<SplitSpan, SplitLayout> => ({
  day: buildLayout(tier, 'day'),
  '5day': buildLayout(tier, '5day'),
  week: buildLayout(tier, 'week'),
  month: buildLayout(tier, 'month'),
})

const LAYOUTS: Record<SplitLayoutTier, Record<SplitSpan, SplitLayout>> = {
  phone: layoutsOf('phone'),
  compact: layoutsOf('compact'),
  desktop: layoutsOf('desktop'),
}

/**
 * Timeline sizing for a viewport width and a span. A width tier and span always give the same
 * object, so a resize inside a tier changes nothing downstream. Do not mutate it.
 */
export function splitLayoutFor(width: number, span: SplitSpan): Readonly<SplitLayout> {
  return LAYOUTS[splitLayoutTier(width)][span]
}

// ---- Day window ----

export interface SplitTimeWindow {
  slotMinTime: string
  slotMaxTime: string
}

const MINUTES_PER_DAY = 24 * 60
const hourTime = (hour: number) => `${String(hour).padStart(2, '0')}:00:00`

/**
 * Visible hours of the hourly day timeline: 07:00 to 19:00, widened to whole hours that cover
 * every timed event of `day`. Without this an event at 06:30 would be cut off while its band
 * still counts as non-empty.
 */
export function splitDayWindow(
  events: readonly CalendarEvent[],
  day: Temporal.PlainDate,
): SplitTimeWindow {
  const dayStart = day.toPlainDateTime()
  const minutesFromStart = (value: string) =>
    Math.round(
      Temporal.PlainDateTime.from(value.slice(0, 19))
        .since(dayStart, { largestUnit: 'minutes' })
        .total('minutes'),
    )
  let first = 7
  let last = 19
  for (const event of events) {
    if (event.allDay) continue
    const rawStart = minutesFromStart(event.start)
    const rawEnd = minutesFromStart(event.end)
    if (rawStart >= MINUTES_PER_DAY || (rawStart < 0 && rawEnd <= 0)) continue
    const start = Math.max(rawStart, 0)
    const end = Math.min(Math.max(rawEnd, start), MINUTES_PER_DAY)
    first = Math.min(first, Math.floor(start / 60))
    last = Math.max(last, Math.ceil(end / 60))
  }
  return { slotMinTime: hourTime(first), slotMaxTime: hourTime(last) }
}

/**
 * The `views` option: sizing per view, so switching the span needs no option juggling. Only the
 * day view trims the hours and labels them like the standard views (07:00); week, 5-day and month
 * show whole days under FullCalendar's own day labels. `slotHeaderFormat` formats every slot
 * header of a view, so it cannot be set for all views at once. FullCalendar has no built-in
 * five-day timeline, so that view is defined here.
 */
export function splitViews(tier: SplitLayoutTier, dayWindow: SplitTimeWindow) {
  const sizing = (span: SplitSpan) => ({
    slotDuration: LAYOUTS[tier][span].slotDuration,
    slotMinWidth: LAYOUTS[tier][span].slotMinWidth,
  })
  return Object.fromEntries(
    SPLIT_SPANS.map((span) => [
      SPLIT_VIEW_NAMES[span],
      {
        ...(span === '5day' && { type: 'resourceTimeline', duration: { days: 5 } }),
        ...(span === 'day' && {
          ...dayWindow,
          slotHeaderFormat: BASE_CALENDAR_OPTIONS.slotHeaderFormat,
        }),
        ...sizing(span),
      },
    ]),
  )
}
