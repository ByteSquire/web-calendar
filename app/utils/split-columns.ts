// The split view with rows and columns swapped (FR-6): a column per calendar, a row per day. An
// entry of one day is listed in its day's cell; an entry over several days of the range is one
// block that runs down those rows, in a lane of its calendar's column, so its length shows. A lane
// is only drawn in the rows a block of it (or of a lane after it) runs through; in the other rows
// the day's cell takes its width (`rowLanes`). The
// block is drawn as a piece in each of its rows (`start`, then `continued`), not as one cell over
// several rows: a page break may fall between any two days, and Firefox drops the rest of a cell
// that spans rows across a page break. Entries
// that overlap get lanes side by side; a calendar has as many lanes as it needs in the range, and
// none if nothing in it spans days. Pure: SplitColumns.vue draws the model.
// Tests: tests/split-columns.test.ts.
import { Temporal } from 'temporal-polyfill'
import type { Calendar, CalendarEvent, Category } from '../../shared/types/calendar'
import type { DateRange, SplitBand } from './calendar-state'
import { eventAssistiveLabel } from './event-display'
import { shownCategories } from './fullcalendar'
import { tc } from './i18n'
import { toTimelineEvent, type SplitColorScheme, type TimelineEvent } from './split-view'

export interface SplitColumnsEntry {
  /** Colours, title and style classes, as the timeline draws the entry. */
  entry: TimelineEvent
  /** The time shown before the title (`09:00–10:00`), empty for a whole day. */
  timeText: string
  /** The name for assistive technology: title, when, calendar, status, categories. */
  label: string
}

export interface SplitColumnsSpan extends SplitColumnsEntry {
  lane: number
  /** Index of the first day row it covers, and how many rows. */
  row: number
  rows: number
  /** It began before the first day shown, or goes on after the last. */
  continuesBefore: boolean
  continuesAfter: boolean
}

/**
 * What one lane holds in one day row: the first piece of a block (with its title), a later piece
 * of it, or nothing. `last` marks the piece in the block's last row.
 */
export type SplitColumnsLaneCell =
  | { kind: 'start'; span: SplitColumnsSpan; last: boolean }
  | { kind: 'continued'; span: SplitColumnsSpan; last: boolean }
  | { kind: 'empty' }

export interface SplitColumnsCalendar {
  calendar: Calendar
  lanes: number
  /** Per day row: one cell per lane. */
  laneCells: SplitColumnsLaneCell[][]
  /**
   * Per day row: how many lanes are drawn in it, up to the last one a block takes on that day. The
   * day's cell covers the others, so a calendar is only split on the days a block runs through.
   */
  rowLanes: number[]
  /** Per day row: the entries of that day alone, in order of time. */
  dayEntries: SplitColumnsEntry[][]
}

export interface SplitColumnsModel {
  days: Temporal.PlainDate[]
  calendars: SplitColumnsCalendar[]
}

function plainDateTime(value: string, allDay: boolean): Temporal.PlainDateTime {
  return allDay
    ? Temporal.PlainDate.from(value.slice(0, 10)).toPlainDateTime()
    : Temporal.PlainDateTime.from(value.slice(0, 19))
}

/**
 * The first and the last day an entry occupies. All-day ends are exclusive; a timed entry that ends
 * at midnight does not occupy the day it ends on. An end that is not after the start is a point.
 */
export function daysOccupied(event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>): {
  first: Temporal.PlainDate
  last: Temporal.PlainDate
} {
  const start = plainDateTime(event.start, event.allDay)
  const end = plainDateTime(event.end, event.allDay)
  const first = start.toPlainDate()
  if (Temporal.PlainDateTime.compare(end, start) <= 0) return { first, last: first }
  const last = end.subtract({ nanoseconds: 1 }).toPlainDate()
  return { first, last }
}

const hhmm = (value: string) => value.slice(11, 16)

/** `09:00–10:00` for a timed entry; empty for an entry of whole days. */
export function entryTimeText(event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>): string {
  if (event.allDay) return ''
  const start = hhmm(event.start)
  const end = hhmm(event.end)
  return end && end !== start ? `${start}–${end}` : start
}

function entryOf(
  event: CalendarEvent,
  calendar: Calendar,
  scheme: SplitColorScheme,
  categoryById?: ReadonlyMap<string, Category>,
): SplitColumnsEntry {
  const label = eventAssistiveLabel(event, calendar.name, {
    nameBlocked: calendar.freeBusyOnly === true,
  })
  const categories = shownCategories(event, categoryById)
  return {
    entry: toTimelineEvent(event, calendar, scheme, categoryById),
    timeText: entryTimeText(event),
    label:
      categories.length > 0
        ? `${label}, ${tc('category {names} | categories {names}', categories.length, {
            names: categories.map((category) => category.name).join(', '),
          })}`
        : label,
  }
}

/** Lanes for blocks that may overlap: each takes the first lane that is free from its first row. */
function assignLanes(spans: Omit<SplitColumnsSpan, 'lane'>[]): SplitColumnsSpan[] {
  const sorted = [...spans].sort((a, b) => a.row - b.row || b.rows - a.rows)
  const laneEnds: number[] = []
  return sorted.map((span) => {
    let lane = laneEnds.findIndex((end) => end <= span.row)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = span.row + span.rows
    return { ...span, lane }
  })
}

/** The table for `bands` over the days of `range`, in band order. */
export function buildSplitColumns(
  bands: readonly SplitBand[],
  range: DateRange,
  scheme: SplitColorScheme,
  categoryById?: ReadonlyMap<string, Category>,
): SplitColumnsModel {
  const days: Temporal.PlainDate[] = []
  for (let day = range.start; Temporal.PlainDate.compare(day, range.end) < 0;) {
    days.push(day)
    day = day.add({ days: 1 })
  }
  const rowOf = (day: Temporal.PlainDate) => range.start.until(day).days

  const calendars = bands.map(({ calendar, events }) => {
    const dayEntries: SplitColumnsEntry[][] = days.map(() => [])
    const spans: Omit<SplitColumnsSpan, 'lane'>[] = []
    for (const event of events) {
      const { first, last } = daysOccupied(event)
      const firstRow = Math.max(rowOf(first), 0)
      const lastRow = Math.min(rowOf(last), days.length - 1)
      if (lastRow < firstRow) continue
      const entry = entryOf(event, calendar, scheme, categoryById)
      if (lastRow > firstRow) {
        spans.push({
          ...entry,
          row: firstRow,
          rows: lastRow - firstRow + 1,
          continuesBefore: rowOf(first) < 0,
          continuesAfter: rowOf(last) > days.length - 1,
        })
      } else {
        dayEntries[firstRow]!.push(entry)
      }
    }
    for (const list of dayEntries) {
      // Whole days first, then by time; the bands are sorted by start already.
      list.sort((a, b) => Number(b.entry.allDay) - Number(a.entry.allDay))
    }
    const placed = assignLanes(spans)
    const lanes = placed.reduce((count, span) => Math.max(count, span.lane + 1), 0)
    const laneCells: SplitColumnsLaneCell[][] = days.map(() =>
      Array.from({ length: lanes }, () => ({ kind: 'empty' as const })),
    )
    for (const span of placed) {
      const lastRow = span.row + span.rows - 1
      laneCells[span.row]![span.lane] = { kind: 'start', span, last: span.row === lastRow }
      for (let row = span.row + 1; row <= lastRow; row += 1) {
        laneCells[row]![span.lane] = { kind: 'continued', span, last: row === lastRow }
      }
    }
    const rowLanes = laneCells.map(
      (cells) => cells.findLastIndex((cell) => cell.kind !== 'empty') + 1,
    )
    return { calendar, lanes, laneCells, rowLanes, dayEntries }
  })
  return { days, calendars }
}
