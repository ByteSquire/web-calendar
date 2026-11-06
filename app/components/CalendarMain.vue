<!--
  Standard views (day, 5 days, week, month, year, list) on FullCalendar v7. The shared state is
  authoritative: `viewType` and `anchorDate` drive the calendar through its API, and the calendar
  only writes back where it navigates by itself (a click on a day number). Editing is off in
  Phase 1; events open the sheet (`selectEvent`), date cells open quick-add.
  Mapping and options live in utils/fullcalendar.ts; the colours of the theme in assets/css/main.css.
  With "Category colours on events" an entry shows a dot per category before its title.
-->
<template>
  <div
    ref="rootElement"
    class="calendar-main h-full min-h-0"
    :class="`calendar-view-${viewType}`"
    data-calendar-main
    tabindex="-1"
    role="region"
    :aria-label="t('Calendar, {range}', { range: rangeLabel })"
    @pointerdown.capture="dateTap.start"
    @click="dateTap.click"
  >
    <FullCalendar ref="calendar" :options="options">
      <!-- Visible text is hidden from assistive technology; the label below names the entry. -->
      <template #eventContent="arg">
        <template v-if="!dotsOnly">
          <div v-if="arg.timeText" :class="arg.timeClass" aria-hidden="true">
            {{ arg.timeText }}
          </div>
          <div :class="[arg.titleClass, titleStyle(arg)]" aria-hidden="true">
            <span
              v-for="(color, index) in arg.event.extendedProps.categoryColors"
              :key="index"
              class="app-evt-tag"
              :style="{ backgroundColor: color }"
            />{{ arg.event.title }}
          </div>
        </template>
        <span class="sr-only">{{ entryLabel(arg) }}</span>
      </template>
    </FullCalendar>
  </div>
</template>

<script setup lang="ts">
import FullCalendar from '@fullcalendar/vue3'
import dayGridPlugin from '@fullcalendar/vue3/daygrid'
import interactionPlugin from '@fullcalendar/vue3/interaction'
import listPlugin from '@fullcalendar/vue3/list'
import deLocale from '@fullcalendar/vue3/locales/de'
import enGbLocale from '@fullcalendar/vue3/locales/en-gb'
import multiMonthPlugin from '@fullcalendar/vue3/multimonth'
import classicTheme from '@fullcalendar/vue3/themes/classic'
import timeGridPlugin from '@fullcalendar/vue3/timegrid'
import scrollGridPlugin from '@fullcalendar/vue3-scheduler/scrollgrid'
import type {
  CalendarOptions,
  DateClickInfo,
  EventClickInfo,
  EventDisplayInfo,
} from '@fullcalendar/vue3'
import { locale, t } from '~/utils/i18n'
import {
  BASE_CALENDAR_OPTIONS,
  calendarLayoutOptions,
  eventDisplayFor,
  fullCalendarViewName,
  isCompactWidth,
  plainDateInCalendarZone,
  quickAddPresetForClick,
  toFullCalendarEvents,
  type ColorScheme,
  type EventExtendedProps,
} from '~/utils/fullcalendar'

const PLUGINS = [
  classicTheme,
  dayGridPlugin,
  timeGridPlugin,
  listPlugin,
  multiMonthPlugin,
  interactionPlugin,
  // `dayMinWidth` (narrow screens) needs it.
  scrollGridPlugin,
]

const {
  viewType,
  splitSpan,
  anchorDate,
  rangeLabel,
  visibleEvents,
  calendarById,
  categoryById,
  selectEvent,
  openQuickAdd,
} = useCalendarState()

const timeZone = useDisplayTimeZone()
const linkView = useCalendarLinkView()
const colorMode = useColorMode()
const scheme = computed<ColorScheme>(() => (colorMode.value === 'dark' ? 'dark' : 'light'))

const rootElement = ref<HTMLElement | null>(null)
const calendar = ref<InstanceType<typeof FullCalendar> | null>(null)
const dateTap = useDateClickGesture<ReturnType<typeof quickAddPresetForClick>>(openQuickAdd)

// The calendar sizes itself from its container (ResizeObserver); options that cannot be expressed
// that way follow the container width. The first guess uses the window until the observer reports.
const compact = ref(typeof window !== 'undefined' && isCompactWidth(window.innerWidth))
let resizeObserver: ResizeObserver | undefined

onMounted(() => {
  if (!rootElement.value || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry) compact.value = isCompactWidth(entry.contentRect.width)
  })
  resizeObserver.observe(rootElement.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())

// Narrow screens pan the day columns sideways: give that scroller a tab stop.
useKeyboardScrollers(rootElement)

// The year overview is too dense for text: entries show as dots and bars.
const dotsOnly = computed(() => viewType.value === 'year')

// "Category colours on events" (the ⋮ menu): a dot per category before the title, not in the year
// view, where an entry is a dot already.
const { shown: categoryColorsShown } = useCategoryColorsOnEvents()
const events = computed(() =>
  toFullCalendarEvents(visibleEvents.value, {
    calendarById: calendarById.value,
    scheme: scheme.value,
    ...(categoryColorsShown.value && !dotsOnly.value ? { categoryById: categoryById.value } : {}),
  }),
)

// View and date are read once: afterwards the watcher below moves the calendar. Putting them in
// the options would reset the calendar on every navigation.
const initialView = fullCalendarViewName(viewType.value, splitSpan.value)
const initialDate = anchorDate.value.toString()

// Month and day names, "all-day" and the other words of the grids follow the language.
const calendarLocale = computed(() => (locale.value === 'de' ? 'de' : 'en-gb'))

const options = computed<CalendarOptions>(() => ({
  ...BASE_CALENDAR_OPTIONS,
  timeZone: timeZone.value,
  ...calendarLayoutOptions(compact.value),
  plugins: PLUGINS,
  locales: [enGbLocale, deLocale],
  locale: calendarLocale.value,
  initialView,
  initialDate,
  colorScheme: scheme.value,
  eventDisplay: eventDisplayFor(viewType.value),
  events: events.value,
  eventClick: onEventClick,
  dateClick: onDateClick,
  navLinkDayClick: onDayNumberClick,
}))

// State -> calendar. `changeView` keeps FullCalendar's own date, so the date is set afterwards;
// both run in one batch to render once.
watch(
  [() => fullCalendarViewName(viewType.value, splitSpan.value), () => anchorDate.value.toString()],
  ([view, date]) => {
    const api = calendar.value?.getApi()
    if (!api) return
    api.batchRendering(() => {
      if (api.view.type !== view) api.changeView(view)
      if (api.formatIso(api.getDate(), true) !== date) api.gotoDate(date)
    })
  },
)

// Calendar -> state. A click on a day number opens that day; the state is written only if the
// date differs, so the watcher above has nothing to undo.
function onDayNumberClick(date: Date) {
  dateTap.claim()
  const target = plainDateInCalendarZone(date, timeZone.value)
  if (!target.equals(anchorDate.value)) anchorDate.value = target
  viewType.value = 'day'
}

function onEventClick(info: EventClickInfo) {
  dateTap.claim()
  info.jsEvent.preventDefault()
  const { eventId } = info.event.extendedProps as Partial<EventExtendedProps>
  if (eventId) selectEvent(eventId)
}

function onDateClick(info: DateClickInfo) {
  // The page of a calendar link is read-only: a click on a date adds nothing.
  if (linkView.value) return
  dateTap.hit(quickAddPresetForClick(info.dateStr, info.allDay))
}

function extendedProps(arg: EventDisplayInfo) {
  return arg.event.extendedProps as Partial<EventExtendedProps>
}

function entryLabel(arg: EventDisplayInfo): string {
  return extendedProps(arg).label ?? arg.event.title
}

function titleStyle(arg: EventDisplayInfo): string {
  const kind = extendedProps(arg).kind
  if (kind === 'cancelled') return 'line-through'
  return kind === 'tentative' ? 'italic' : ''
}
</script>
