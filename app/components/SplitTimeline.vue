<!--
  The split view's timeline: one FullCalendar Premium resource timeline with a row per band.
  It is a pure view of its props. Navigation lives in the shared calendar state (top bar), and
  the calendar never navigates itself (no toolbar, no nav links, not editable), so there is no
  feedback loop: a change of `date` or `span` is pushed with `changeView`, bands and colours
  through the reactive options. `initialView` and `initialDate` are only read at mount and are
  captured once here.

  A tap on an empty cell asks for a new event in that row's calendar (`create`), under the same
  rules as in the standard views (composables/useDateClickGesture.ts).

  The calendar column is a pane of its own beside the scrolling timeline, so labels stay in place
  when the timeline scrolls sideways. `height: 'auto'` lets the surrounding main area do the
  vertical scrolling, which also makes the date header sticky against it.

  Printing (composables/usePrinting.ts): the labels and entries are made by utils/entry-content.ts
  and not by Vue slots, and the light colours are passed on during `beforeprint`, so both are there
  when Firefox takes its copy of the page.
-->
<template>
  <div
    ref="rootElement"
    class="split-timeline"
    :style="{ '--split-label-width': `${labelWidth}px` }"
    @pointerdown.capture="dateTap.start"
    @click="dateTap.click"
  >
    <FullCalendar ref="calendar" :options="options" />
  </div>
</template>

<script setup lang="ts">
import { Temporal } from 'temporal-polyfill'
import FullCalendar, { type CalendarOptions, type DateClickInfo } from '@fullcalendar/vue3'
import interactionPlugin from '@fullcalendar/vue3/interaction'
import deLocale from '@fullcalendar/vue3/locales/de'
import enGbLocale from '@fullcalendar/vue3/locales/en-gb'
import classicTheme from '@fullcalendar/vue3/themes/classic'
import adaptivePlugin from '@fullcalendar/vue3-scheduler/adaptive'
import resourceTimeline from '@fullcalendar/vue3-scheduler/resource-timeline'
import { locale, t } from '~/utils/i18n'
import type { NewEventInput, SplitBand, SplitSpan } from '~/utils/calendar-state'
import type { Category } from '../../shared/types/calendar'
import {
  BASE_CALENDAR_OPTIONS,
  SCHEDULER_LICENSE_KEY,
  quickAddPresetForClick,
} from '~/utils/fullcalendar'
import {
  splitDayWindow,
  splitLayoutFor,
  splitLayoutTier,
  splitViewName,
  splitViews,
  toTimelineData,
  type SplitColorScheme,
} from '~/utils/split-view'
import { splitEntryContent, splitLabelContent } from '~/utils/entry-content'

const props = defineProps<{
  bands: readonly SplitBand[]
  /** The selected date, `YYYY-MM-DD`. */
  date: string
  span: SplitSpan
  /** Length of the custom range in days (`span` 'custom'). */
  customDays: number
  scheme: SplitColorScheme
  /** The zone the events are in and the timeline shows (FR-29), an IANA name. */
  timeZone: string
  /** Given when the entries show a dot per category ("Category colours on events"). */
  categoryById?: ReadonlyMap<string, Category>
}>()

const emit = defineEmits<{
  select: [eventId: string]
  /** A new event was asked for on an empty cell: its time and the calendar of its row. */
  create: [preset: Partial<NewEventInput>]
}>()

const dateTap = useDateClickGesture<Partial<NewEventInput>>((preset) => emit('create', preset))

// Not reactive: FullCalendar only reads these when it mounts; changes go through `changeView`.
const initialView = splitViewName(props.span)
const initialDate = props.date

const calendar = ref<InstanceType<typeof FullCalendar> | null>(null)
const rootElement = ref<HTMLElement | null>(null)
// The timeline scrolls sideways on narrow screens: give that scroller a tab stop.
useKeyboardScrollers(rootElement)

// Window width picks the sizing. A resize inside one tier changes nothing (see splitLayoutFor).
const width = ref(typeof window === 'undefined' ? 1024 : window.innerWidth)
const updateWidth = () => {
  width.value = window.innerWidth
}
onMounted(() => {
  updateWidth()
  window.addEventListener('resize', updateWidth)
})
onBeforeUnmount(() => window.removeEventListener('resize', updateWidth))

const tier = computed(() => splitLayoutTier(width.value))
const layout = computed(() => splitLayoutFor(width.value, props.span))
// The label has to fit the column minus the margins of its cell.
const labelWidth = computed(() => layout.value.resourceColumnsWidth - 20)

const data = computed(() => toTimelineData(props.bands, props.scheme, props.categoryById))
const dayWindow = computed(() =>
  splitDayWindow(
    props.bands.flatMap((band) => band.events),
    Temporal.PlainDate.from(props.date),
  ),
)

// `adaptivePlugin`: the layout for paper while the page prints (composables/usePrinting.ts).
const plugins = [classicTheme, resourceTimeline, interactionPlugin, adaptivePlugin]

const options = computed<CalendarOptions>(() => ({
  plugins,
  schedulerLicenseKey: SCHEDULER_LICENSE_KEY,
  // Same time zone, locale and 24-hour times as the standard views.
  timeZone: props.timeZone,
  locales: [enGbLocale, deLocale],
  locale: locale.value === 'de' ? 'de' : BASE_CALENDAR_OPTIONS.locale,
  eventTimeFormat: BASE_CALENDAR_OPTIONS.eventTimeFormat,
  colorScheme: props.scheme,
  initialView,
  initialDate,
  views: splitViews(tier.value, dayWindow.value, props.customDays),
  headerToolbar: false,
  firstDay: 1,
  height: 'auto',
  editable: false,
  selectable: false,
  resources: data.value.resources,
  events: data.value.events,
  // Rows follow the sidebar's calendar order, not FullCalendar's default order by id.
  resourceOrder: 'sortIndex',
  resourceColumns: [{ field: 'title', headerContent: t('Calendar') }],
  resourceColumnsWidth: layout.value.resourceColumnsWidth,
  resourceCellContent: splitLabelContent,
  eventContent: splitEntryContent,
  // A tap target is at least 44 px wide, also for a short event.
  eventMinWidth: 44,
  eventClick: (info) => {
    dateTap.claim()
    emit('select', info.event.id)
  },
  dateClick: onDateClick,
}))

// Paper is light (composables/usePrinting.ts). The `scheme` prop follows only with the parent's
// next update, after Firefox has taken its copy of the page, so the colours are passed on here.
onPrintChange((printing) => {
  const scheme = printing ? 'light' : props.scheme
  const next = toTimelineData(props.bands, scheme, props.categoryById)
  calendar.value
    ?.getApi()
    .resetOptions({ colorScheme: scheme, resources: next.resources, events: next.events }, [
      'colorScheme',
      'resources',
      'events',
    ])
})

function onDateClick(info: DateClickInfo) {
  dateTap.hit({
    ...quickAddPresetForClick(info.dateStr, info.allDay),
    // The row is the calendar: a new event starts in it.
    ...(info.resource ? { calendarId: info.resource.id } : {}),
  })
}

// The length of a custom range reaches FullCalendar through `views`; it is watched here too, so
// the timeline is drawn again for it even when the span and the first date stay.
watch(
  () => [props.span, props.date, props.customDays] as const,
  ([span, date]) => calendar.value?.getApi().changeView(splitViewName(span), date),
)
</script>

<style>
/* Unscoped on purpose: FullCalendar creates the event elements, and Vue's scope attribute
 * cannot reach them. Everything is prefixed with .split-timeline. FullCalendar's CSS is
 * unlayered, so these rules are too (and are specific enough to win). Colours come from the
 * event's own CSS variables and `currentColor`, so they follow the light and dark schemes. */

/* The calendar label wraps instead of being clipped, so a name stays readable on a phone. The
 * colour dot is part of the text flow, so only the first line gives up space for it. */
.split-timeline .split-label {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  max-width: var(--split-label-width);
  overflow: hidden;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.25;
  font-weight: 600;
  font-size: 0.75rem;
}

.split-timeline .split-label__dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 5px;
  border-radius: 9999px;
  vertical-align: -1px;
  box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 40%, transparent);
}

@media (min-width: 768px) {
  .split-timeline .split-label {
    font-size: 0.875rem;
  }
}

/* An outline in the text colour keeps events visible when their fill is close to the page. */
.split-timeline .split-event {
  align-items: center;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fc-event-contrast-color) 30%, transparent);
}

.split-timeline .split-event--tentative {
  border: 2px dashed var(--fc-event-contrast-color);
}

/* Paper leaves the fill out, and the text colour of the fill can be white: the edge takes the
 * entry's colour instead. */
@media print {
  .split-timeline .split-event.split-event--tentative {
    border-color: var(--fc-event-color);
  }
}

.split-timeline .split-event--cancelled .split-event__title {
  text-decoration: line-through;
}

/* Tap targets of 44 px on phones, small tablets and any touch screen. */
@media (max-width: 767px), (pointer: coarse) {
  .split-timeline .split-event {
    min-height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .split-timeline,
  .split-timeline *,
  .split-timeline *::before,
  .split-timeline *::after {
    animation-duration: 0.01ms !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
