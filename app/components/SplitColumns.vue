<!--
  The split view with rows and columns swapped: a column per calendar and a row per day of the
  period (utils/split-columns.ts). An entry of one day is listed in its day's cell; an entry over
  several days is one block down those rows, in a lane at the start of its calendar's column, so its
  length shows; overlapping ones get lanes side by side. The lanes are only there on the days a
  block runs through: on the others the day's cell spans them (`colspan`), as in FullCalendar. The table scrolls inside itself, so the
  calendar names stay at the top and the dates at the start while it moves either way.

  It wears FullCalendar's classic theme (utils/fc-theme.ts): the borders and today of its day
  cells, the headers, and the block events of its entries, with the colours of the timeline. On
  paper the browser repeats the header on every page and keeps a day's row together.

  An entry is a button that opens it (`select`); a block of several days opens from anywhere on
  it, and its button (title, name for assistive technology) is in its first row. A click into an empty part of a day asks for a new event in that calendar on that day
  (`create`), as a tap on the timeline does.
-->
<template>
  <div
    ref="rootElement"
    class="split-columns"
    :class="themeClass('className')"
    :data-color-scheme="scheme"
  >
    <table class="split-columns__table">
      <thead>
        <tr>
          <th scope="col" class="split-columns__corner" :class="headerClass">
            <span :class="headerInnerClass">{{ t('Date') }}</span>
          </th>
          <th
            v-for="column in model.calendars"
            :key="column.calendar.id"
            scope="col"
            :colspan="column.lanes + 1"
            class="split-columns__calendar"
            :class="headerClass"
          >
            <span class="split-label" :title="column.calendar.name">
              <span
                class="split-label__dot"
                :style="{ backgroundColor: column.calendar.color }"
                aria-hidden="true"
              />{{ column.calendar.name }}
            </span>
          </th>
        </tr>
      </thead>
      <tbody @click="onBodyClick">
        <tr v-for="(day, row) in model.days" :key="day.toString()">
          <th
            scope="row"
            class="split-columns__date"
            :class="[dayClass(day), { 'split-columns__date--today': day.equals(today) }]"
            :aria-current="day.equals(today) ? 'date' : undefined"
          >
            <span class="split-columns__weekday">{{ weekdayShort(day.dayOfWeek) }}</span>
            <span class="split-columns__day-label">{{ dayLabel(day, row) }}</span>
          </th>
          <template v-for="column in model.calendars" :key="column.calendar.id">
            <template
              v-for="(cell, lane) in column.laneCells[row]!.slice(0, column.rowLanes[row])"
              :key="lane"
            >
              <!-- A piece of a block in each of its rows: the cells are the block, so it fills its
                   days and goes on after a page break. The first piece holds the title. -->
              <td
                v-if="cell.kind !== 'empty'"
                class="split-columns__lane split-columns__span"
                :class="[pieceClass(cell), cell.span.entry.class]"
                :style="colors(cell.span)"
                :data-event-id="cell.span.entry.id"
              >
                <button
                  v-if="cell.kind === 'start'"
                  type="button"
                  class="split-columns__span-button"
                >
                  <span :class="innerClass" aria-hidden="true">
                    <span v-if="cell.span.timeText" :class="timeClass">{{
                      cell.span.timeText
                    }}</span>
                    <span :class="[titleClass, 'split-columns__text split-event__title']"
                      ><span
                        v-for="(color, index) in cell.span.entry.extendedProps.categoryColors"
                        :key="index"
                        class="app-evt-tag"
                        :style="{ backgroundColor: color }"
                      />{{ cell.span.entry.title }}</span
                    >
                  </span>
                  <span class="sr-only">{{ cell.span.label }}</span>
                </button>
              </td>
              <td
                v-else-if="cell.kind === 'empty'"
                class="split-columns__lane"
                :class="dayClass(day)"
                :data-calendar-id="column.calendar.id"
                :data-date="day.toString()"
              />
            </template>
            <td
              class="split-columns__day"
              :colspan="column.lanes - column.rowLanes[row]! + 1"
              :class="dayClass(day)"
              :data-calendar-id="column.calendar.id"
              :data-date="day.toString()"
            >
              <button
                v-for="item in column.dayEntries[row]"
                :key="item.entry.id"
                type="button"
                class="split-columns__entry"
                :class="[entryClass, item.entry.class]"
                :style="colors(item)"
                :data-event-id="item.entry.id"
              >
                <span :class="innerClass" aria-hidden="true">
                  <span v-if="item.timeText" :class="timeClass">{{ item.timeText }}</span>
                  <span :class="[titleClass, 'split-columns__text split-event__title']"
                    ><span
                      v-for="(color, index) in item.entry.extendedProps.categoryColors"
                      :key="index"
                      class="app-evt-tag"
                      :style="{ backgroundColor: color }"
                    />{{ item.entry.title }}</span
                  >
                </span>
                <span class="sr-only">{{ item.label }}</span>
              </button>
            </td>
          </template>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { Temporal } from 'temporal-polyfill'
import type { Category } from '../../shared/types/calendar'
import type { DateRange, NewEventInput, SplitBand } from '~/utils/calendar-state'
import { monthShort, weekdayShort } from '~/utils/date-names'
import { themeClass } from '~/utils/fc-theme'
import { t } from '~/utils/i18n'
import {
  buildSplitColumns,
  type SplitColumnsEntry,
  type SplitColumnsLaneCell,
} from '~/utils/split-columns'
import type { SplitColorScheme } from '~/utils/split-view'

const props = defineProps<{
  bands: readonly SplitBand[]
  range: DateRange
  scheme: SplitColorScheme
  today: Temporal.PlainDate
  /** Given when the entries show a dot per category ("Category colours on events"). */
  categoryById?: ReadonlyMap<string, Category>
}>()

const emit = defineEmits<{
  select: [eventId: string]
  /** A new event was asked for in an empty part of a day: that day and the column's calendar. */
  create: [preset: Partial<NewEventInput>]
}>()

const rootElement = ref<HTMLElement | null>(null)
// The table scrolls sideways when the calendars do not fit: give that scroller a tab stop.
useKeyboardScrollers(rootElement)

const model = computed(() =>
  buildSplitColumns(props.bands, props.range, props.scheme, props.categoryById),
)

// The theme's classes, as FullCalendar gives them to its own headers, day cells and events.
const headerClass = themeClass('dayHeaderClass', { isMajor: false })
const headerInnerClass = themeClass('dayHeaderInnerClass', { isNarrow: false })
const eventBase = [themeClass('eventClass', { event: {} }), themeClass('blockEventClass', {})].join(
  ' ',
)
// Every entry is a card like those of the week's time grid (a "column event"): time above title.
const entryClass = [
  eventBase,
  themeClass('columnEventClass', { isStart: true, isEnd: true }),
  'split-event',
].join(' ')
const innerClass = [
  themeClass('blockEventInnerClass', {}),
  themeClass('columnEventInnerClass', { isShort: false }),
].join(' ')
// Bold like the times on the timeline: the theme gives that to the time of its row events.
const timeClass = [
  themeClass('columnEventTimeClass', { isShort: false }),
  themeClass('rowEventTimeClass', {}),
].join(' ')
const titleClass = themeClass('columnEventTitleClass', { isShort: false, isNarrow: false })

/** A piece of a block: closed at the top where the entry begins, at the bottom where it ends. */
function pieceClass(cell: Exclude<SplitColumnsLaneCell, { kind: 'empty' }>): string {
  const isStart = cell.kind === 'start' && !cell.span.continuesBefore
  const isEnd = cell.last && !cell.span.continuesAfter
  return [
    eventBase,
    themeClass('columnEventClass', { isStart, isEnd }),
    'split-event',
    isStart && 'split-columns__span--start',
    isEnd && 'split-columns__span--end',
  ]
    .filter(Boolean)
    .join(' ')
}

function dayClass(day: Temporal.PlainDate): string {
  return themeClass('dayCellClass', { isToday: day.equals(props.today), isMajor: false })
}

/** The month is named on the first row and where a new month begins; the year where it changes. */
function dayLabel(day: Temporal.PlainDate, row: number): string {
  const newMonth = row === 0 || day.day === 1
  if (!newMonth) return String(day.day)
  const yearShown = row === 0 || (day.month === 1 && day.day === 1)
  const dayMonth = t('{day} {month}', { day: day.day, month: monthShort(day.month) })
  return yearShown ? `${dayMonth} ${day.year}` : dayMonth
}

function colors(item: SplitColumnsEntry) {
  return {
    '--fc-event-color': item.entry.color,
    '--fc-event-contrast-color': item.entry.contrastColor,
  }
}

// One handler for the whole table: an entry, by mouse, touch or keyboard (Enter on its button
// sends a click), or else an empty part of a day.
function onBodyClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  const owner = target.closest<HTMLElement>('[data-event-id]')
  if (owner?.dataset.eventId) {
    emit('select', owner.dataset.eventId)
    return
  }
  if (target.closest('button')) return
  const cell = target.closest<HTMLElement>('td[data-date]')
  const date = cell?.dataset.date
  const calendarId = cell?.dataset.calendarId
  if (!date || !calendarId) return
  const end = Temporal.PlainDate.from(date).add({ days: 1 }).toString()
  emit('create', { start: date, end, allDay: true, calendarId })
}
</script>

<style>
/* Unscoped like SplitTimeline's: FullCalendar's theme and the app's event rules are global, and
 * these have to win over the theme's utilities at the same specificity. */
.split-columns {
  min-height: 0;
  overflow: auto;
  overscroll-behavior-x: contain;
  font-size: 14px;
}

.split-columns__table {
  min-width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  background: var(--fc-classic-background);
  color: var(--fc-classic-foreground);
}

.split-columns th,
.split-columns td {
  vertical-align: top;
  text-align: start;
  font-weight: inherit;
  padding: 0;
}

/* Lines between cells once, not twice: each cell draws its end and bottom edge. */
.split-columns tbody td,
.split-columns tbody th,
.split-columns thead th {
  border-width: 0 1px 1px 0;
}

/* Calendar names stay at the top and the dates at the start while the table scrolls. */
.split-columns thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--fc-classic-background);
  padding: 6px 8px;
  vertical-align: bottom;
}

.split-columns .split-columns__date {
  position: sticky;
  inset-inline-start: 0;
  z-index: 1;
  min-width: 4rem;
  padding: 4px 8px;
  background: var(--fc-classic-background);
  font-size: 13px;
  line-height: 1.3;
}

/* The weekday over the date, so the column stays narrow on a phone. */
.split-columns__day-label {
  display: block;
  white-space: nowrap;
}

/* Today: the theme tints its cells, but the date column needs a solid background to cover what
 * scrolls under it, so the tint goes on top of it as an image. */
.split-columns .split-columns__date.split-columns__date--today {
  background-image: linear-gradient(var(--fc-classic-today), var(--fc-classic-today));
}

.split-columns .split-columns__corner {
  inset-inline-start: 0;
  z-index: 3;
}

.split-columns__weekday {
  display: block;
  color: var(--fc-classic-muted-foreground);
}

.split-columns .split-label {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  white-space: normal;
  overflow-wrap: anywhere;
  font-weight: 600;
  line-height: 1.25;
}

.split-columns .split-label__dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-inline-end: 5px;
  border-radius: 9999px;
  vertical-align: -1px;
  box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 40%, transparent);
}

/* A day: wide enough for a title of a few words, entries stacked. `height: 1px` lets a block of
 * several days fill its cells (a percentage height inside a table cell needs one). */
.split-columns .split-columns__day {
  min-width: 8rem;
  height: 1px;
  padding: 2px;
}

.split-columns .split-columns__lane {
  width: 5.5rem;
  min-width: 5.5rem;
  max-width: 7rem;
  height: 1px;
  padding: 2px 0 2px 2px;
}

.split-columns .split-columns__entry,
.split-columns .split-columns__span-button {
  display: flex;
  flex-direction: column;
  width: 100%;
  text-align: start;
  font: inherit;
  cursor: pointer;
}

.split-columns .split-columns__entry {
  margin-bottom: 2px;
}

/* The block: the theme's event classes on its cells. The sides run through all its rows, the top
 * and bottom edges close it where the entry begins and ends; no ring, which would draw a line
 * across the block between two days. */
.split-columns tbody td.split-columns__span {
  border-width: 0 1px;
  padding: 0;
  cursor: pointer;
  box-shadow: none;
}

.split-columns tbody td.split-columns__span--start {
  border-top-width: 1px;
}

.split-columns tbody td.split-columns__span--end {
  border-bottom-width: 1px;
}

.split-columns .split-columns__span-button {
  color: inherit;
}

/* The theme cuts titles to one line, which suits its narrow grid cells; here they may wrap. */
.split-columns .split-columns__text {
  white-space: normal;
  overflow-wrap: anywhere;
}

/* Same marks as the timeline: a dashed edge for tentative, struck through for cancelled. */
.split-columns .split-event--tentative {
  border-style: dashed;
  border-color: var(--fc-event-contrast-color);
}

.split-columns .split-event--cancelled .split-event__title {
  text-decoration: line-through;
}

/* Tap targets of 44 px on phones, small tablets and any touch screen. */
@media (max-width: 767px), (pointer: coarse) {
  .split-columns .split-columns__entry {
    min-height: 44px;
  }

  .split-columns .split-columns__span-button {
    min-height: 44px;
  }

  /* Every piece of a block is part of what is tapped, also in a row with nothing else in it. */
  .split-columns tbody td.split-columns__span {
    height: 44px;
  }

  .split-columns .split-columns__day {
    min-width: 7rem;
  }

  .split-columns .split-columns__lane {
    width: 4.5rem;
    min-width: 4.5rem;
  }
}

@media print {
  .split-columns {
    overflow: visible;
  }

  .split-columns thead th,
  .split-columns .split-columns__date {
    position: static;
  }

  /* Paper cannot scroll sideways: the columns share the page width, and titles wrap to fit. */
  .split-columns__table {
    width: 100%;
    min-width: 0;
  }

  .split-columns .split-columns__day {
    min-width: 0;
  }

  .split-columns .split-columns__lane {
    width: 3rem;
    min-width: 3rem;
  }

  /* A narrow page matches the phone rules above; paper has no fingers. */
  .split-columns .split-columns__entry,
  .split-columns .split-columns__span-button {
    min-height: 0;
  }

  /* A day's row stays on one page; the header repeats on every page (a table header does). */
  .split-columns tbody tr {
    break-inside: avoid;
  }

  .split-columns .split-event--tentative {
    border-color: var(--fc-event-color);
  }

  .split-columns .split-columns__date.split-columns__date--today {
    background-image: none;
  }

  /* The colour dots are backgrounds, which browsers leave out on paper unless told. */
  .split-columns .split-label__dot,
  .split-columns .app-evt-tag {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
}
</style>
