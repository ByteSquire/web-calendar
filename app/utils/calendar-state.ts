// Calendar UI state: pure helpers plus a store factory that takes its state container as an
// argument, so it runs in plain Vitest. `useCalendarState()` binds it to Nuxt's `useState`.
// The contract for other components is documented in app/composables/useCalendarState.ts.
import { computed, type Ref } from 'vue'
import { Temporal } from 'temporal-polyfill'
import type { MockData } from '../data/mock'
import { isAutoCategory } from './live/categories'
import type {
  Calendar,
  CalendarEvent,
  CalendarFilter,
  CalendarResource,
  CalendarView,
  Category,
  EventStatus,
} from '../../shared/types/calendar'

export const VIEW_TYPES = ['day', '5day', 'week', 'month', 'year', 'split', 'list'] as const
export type ViewType = (typeof VIEW_TYPES)[number]

/** Switcher labels, in the order of `VIEW_TYPES` (FR-22). */
export const VIEW_TYPE_LABELS = {
  day: 'Day',
  '5day': '5 days',
  week: 'Week',
  month: 'Month',
  year: 'Year',
  split: 'Split',
  list: 'List',
} satisfies Record<ViewType, string>

/** Time span one band of the split view covers. */
export const SPLIT_SPANS = ['day', '5day', 'week', 'month'] as const
export type SplitSpan = (typeof SPLIT_SPANS)[number]

/** The period a view type shows; navigation and the range label work on this. */
export type RangeKind = 'day' | '5day' | 'week' | 'month' | 'year'

/** Half-open range of dates: `start` is included, `end` is not. */
export interface DateRange {
  start: Temporal.PlainDate
  end: Temporal.PlainDate
}

export interface SplitBand {
  calendar: Calendar
  events: CalendarEvent[]
}

export interface NewEventInput {
  title: string
  calendarId: string
  /** `YYYY-MM-DD` for all-day events, `YYYY-MM-DDTHH:mm[:ss]` otherwise. */
  start: string
  /** Same format as `start`; exclusive for all-day events. */
  end: string
  allDay?: boolean
  status?: EventStatus
  description?: string
  location?: string
  categoryIds?: string[]
}

export interface EventCriteria {
  visibleCalendarIds: ReadonlySet<string>
  /** Active filters; see `filterCalendarEvents` for how they combine. */
  filters: readonly CalendarFilter[]
  /** Selected categories; empty means no restriction. */
  categoryIds: readonly string[]
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const shortMonth = (date: Temporal.PlainDate) => MONTHS[date.month - 1]!.slice(0, 3)
const dayMonth = (date: Temporal.PlainDate) => `${date.day} ${shortMonth(date)}`

const CATEGORY_COLORS = [
  '#1d4ed8',
  '#047857',
  '#6d28d9',
  '#b45309',
  '#0f766e',
  '#b91c1c',
  '#9d174d',
  '#4d7c0f',
]

// ---- Date range and navigation ----

export function rangeKindOf(viewType: ViewType, splitSpan: SplitSpan): RangeKind {
  switch (viewType) {
    case 'split':
      return splitSpan
    case 'list':
      return 'week'
    default:
      return viewType
  }
}

/** The dates a period shows around `anchor`. Weeks start on Monday. */
export function visibleRangeFor(kind: RangeKind, anchor: Temporal.PlainDate): DateRange {
  switch (kind) {
    case 'day':
      return { start: anchor, end: anchor.add({ days: 1 }) }
    case '5day':
      return { start: anchor, end: anchor.add({ days: 5 }) }
    case 'week': {
      const start = anchor.subtract({ days: anchor.dayOfWeek - 1 })
      return { start, end: start.add({ days: 7 }) }
    }
    case 'month': {
      const start = anchor.with({ day: 1 })
      return { start, end: start.add({ months: 1 }) }
    }
    case 'year': {
      const start = anchor.with({ month: 1, day: 1 })
      return { start, end: start.add({ years: 1 }) }
    }
  }
}

/** Moves `anchor` one period forward (`1`) or back (`-1`). Month and year steps clamp the day. */
export function stepAnchorDate(
  kind: RangeKind,
  anchor: Temporal.PlainDate,
  direction: 1 | -1,
): Temporal.PlainDate {
  switch (kind) {
    case 'day':
      return anchor.add({ days: direction })
    case '5day':
      return anchor.add({ days: 5 * direction })
    case 'week':
      return anchor.add({ days: 7 * direction })
    case 'month':
      return anchor.add({ months: direction })
    case 'year':
      return anchor.add({ years: direction })
  }
}

/** Short English label such as `Wed, 28 Oct 2026`, `26 – 30 Oct 2026` or `October 2026`. */
export function formatRangeLabel(kind: RangeKind, range: DateRange): string {
  const first = range.start
  const last = range.end.subtract({ days: 1 })
  switch (kind) {
    case 'day':
      return `${WEEKDAYS[first.dayOfWeek - 1]}, ${first.day} ${shortMonth(first)} ${first.year}`
    case 'month':
      return `${MONTHS[first.month - 1]} ${first.year}`
    case 'year':
      return String(first.year)
    default:
      if (first.year !== last.year) {
        return `${dayMonth(first)} ${first.year} – ${dayMonth(last)} ${last.year}`
      }
      if (first.month !== last.month) return `${dayMonth(first)} – ${dayMonth(last)} ${last.year}`
      return `${first.day} – ${dayMonth(last)} ${last.year}`
  }
}

// ---- Events ----

function parseLocal(value: string, allDay: boolean): Temporal.PlainDateTime {
  return allDay
    ? Temporal.PlainDate.from(value.slice(0, 10)).toPlainDateTime()
    : Temporal.PlainDateTime.from(value.slice(0, 19))
}

/** True when the event occupies any time inside the range. Zero-length events count as a point. */
export function eventOverlapsRange(event: CalendarEvent, range: DateRange): boolean {
  const compare = Temporal.PlainDateTime.compare
  const start = parseLocal(event.start, event.allDay)
  const end = parseLocal(event.end, event.allDay)
  const rangeStart = range.start.toPlainDateTime()
  const rangeEnd = range.end.toPlainDateTime()
  if (compare(end, start) <= 0) {
    return compare(start, rangeStart) >= 0 && compare(start, rangeEnd) < 0
  }
  return compare(start, rangeEnd) < 0 && compare(end, rangeStart) > 0
}

export function eventsInRange(events: readonly CalendarEvent[], range: DateRange): CalendarEvent[] {
  return events.filter((event) => eventOverlapsRange(event, range))
}

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1
  return a.title.localeCompare(b.title)
}

/**
 * Events of visible calendars that pass the filters and the category selection.
 * Combination rules: a calendar must be visible; if categories are selected the event needs one
 * of them; category filters match any carried category (several: either), text filters match
 * title, location or description case-insensitively (several: either); status filters hide the
 * events with that status (several: all apply). Different groups all have to pass.
 */
export function filterCalendarEvents(
  events: readonly CalendarEvent[],
  criteria: EventCriteria,
): CalendarEvent[] {
  const categoryFilters = criteria.filters.filter((f) => f.kind === 'category').map((f) => f.value)
  const textFilters = criteria.filters
    .filter((f) => f.kind === 'text')
    .map((f) => f.value.trim().toLowerCase())
  const hiddenStatuses = criteria.filters.filter((f) => f.kind === 'status').map((f) => f.value)

  return events.filter((event) => {
    if (!criteria.visibleCalendarIds.has(event.calendarId)) return false
    if (
      criteria.categoryIds.length > 0 &&
      !criteria.categoryIds.some((id) => event.categoryIds.includes(id))
    ) {
      return false
    }
    if (
      categoryFilters.length > 0 &&
      !categoryFilters.some((id) => event.categoryIds.includes(id))
    ) {
      return false
    }
    if (textFilters.length > 0) {
      const text = `${event.title} ${event.location ?? ''} ${event.description ?? ''}`.toLowerCase()
      if (!textFilters.some((needle) => text.includes(needle))) return false
    }
    return !hiddenStatuses.includes(event.status)
  })
}

/**
 * One band per calendar that has at least one of `events` in `range`, in `calendars` order.
 * Pass the already filtered (visible) events; calendars without any are omitted (FR-6).
 */
export function buildSplitBands(
  calendars: readonly Calendar[],
  events: readonly CalendarEvent[],
  range: DateRange,
): SplitBand[] {
  const byCalendar = new Map<string, CalendarEvent[]>()
  for (const event of eventsInRange(events, range)) {
    const list = byCalendar.get(event.calendarId)
    if (list) list.push(event)
    else byCalendar.set(event.calendarId, [event])
  }
  const bands: SplitBand[] = []
  for (const calendar of calendars) {
    const list = byCalendar.get(calendar.id)
    if (list) bands.push({ calendar, events: list.sort(byStart) })
  }
  return bands
}

// ---- Visibility, selection and creation ----

export function defaultVisibleCalendarIds(calendars: readonly Calendar[]): string[] {
  return calendars.filter((calendar) => calendar.defaultVisible).map((calendar) => calendar.id)
}

/** The view's calendars, minus ids that no longer exist. */
export function calendarIdsForView(view: CalendarView, calendars: readonly Calendar[]): string[] {
  const known = new Set(calendars.map((calendar) => calendar.id))
  return view.calendarIds.filter((id) => known.has(id))
}

/** Returns a copy of `ids` that contains `id` exactly when `present` is true. */
export function withIdPresent(ids: readonly string[], id: string, present: boolean): string[] {
  const rest = ids.filter((existing) => existing !== id)
  return present ? [...rest, id] : rest
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let candidate = base
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`
  return candidate
}

/** Builds the event that quick-add stores. The caller validates title and range. */
export function createCalendarEvent(
  input: NewEventInput,
  existing: readonly CalendarEvent[],
): CalendarEvent {
  const id = uniqueId(
    'evt-new',
    existing.map((event) => event.id),
  )
  return {
    id,
    uid: id,
    calendarId: input.calendarId,
    title: input.title.trim() || 'Untitled event',
    start: input.start,
    end: input.end,
    allDay: input.allDay ?? false,
    status: input.status ?? 'confirmed',
    categoryIds: input.categoryIds ?? [],
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
  }
}

/** A new category with the next palette colour, or null for an empty or duplicate name. */
export function createCategory(name: string, existing: readonly Category[]): Category | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  // Auto categories (names only events carry) do not count: creating the real one is how the
  // viewer adopts such a name.
  if (
    existing.some(
      (category) =>
        !isAutoCategory(category) && category.name.toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    return null
  }
  return {
    id: uniqueId(
      `cat-${slugify(trimmed) || 'new'}`,
      existing.map((category) => category.id),
    ),
    name: trimmed,
    color: CATEGORY_COLORS[existing.length % CATEGORY_COLORS.length]!,
  }
}

/** A new text filter, or null for an empty or duplicate text. */
export function createTextFilter(
  text: string,
  existing: readonly CalendarFilter[],
): CalendarFilter | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (existing.some((filter) => filter.name.toLowerCase() === trimmed.toLowerCase())) return null
  return {
    id: uniqueId(
      `filter-${slugify(trimmed) || 'new'}`,
      existing.map((filter) => filter.id),
    ),
    name: trimmed,
    kind: 'text',
    value: trimmed,
  }
}

// ---- Store ----

/** Same shape as Nuxt's `useState`: one shared ref per key, created by `init` on first use. */
export type StateFactory = <T>(key: string, init: () => T) => Ref<T>

/**
 * Side effects of the live mode (saving to the server). Without hooks the store is purely local,
 * which is what the demo mode and the unit tests use. The hooks never throw into the store:
 * `persist*` reject and the store rolls the change back; the others report their own failures.
 */
export interface CalendarStateHooks {
  /** A calendar was switched on or off by the viewer (not by selecting a view). */
  onCalendarVisibility?: (calendarId: string, visible: boolean) => void
  /** Saves a new category; resolves to the stored one (the server's id). */
  persistCategory?: (category: Category) => Promise<Category>
  /** Saves a new filter; resolves to the stored one (the server's id). */
  persistFilter?: (filter: CalendarFilter) => Promise<CalendarFilter>
  /** A new category or filter could not be saved and was removed again. */
  onPersistError?: (what: 'category' | 'filter', name: string, error: unknown) => void
}

export interface CalendarStateOptions {
  /** Initial data; called at most once per store instance, and only if no state exists yet. */
  seed: () => MockData
  today: () => Temporal.PlainDate
  /** Initial `sidebarOpen`: open on desktop, closed below the breakpoint. */
  sidebarOpen: () => boolean
  hooks?: CalendarStateHooks
}

export function createCalendarState(state: StateFactory, options: CalendarStateOptions) {
  let seeded: MockData | undefined
  const seed = () => (seeded ??= options.seed())

  // Navigation
  const viewType = state<ViewType>('cal-view-type', () => 'week')
  const splitSpan = state<SplitSpan>('cal-split-span', () => 'week')
  const anchorIso = state<string>('cal-anchor', () => options.today().toString())

  // Data
  const currentUser = state('cal-user', () => seed().currentUser)
  const views = state<CalendarView[]>('cal-views', () => seed().views)
  const calendars = state<Calendar[]>('cal-calendars', () => seed().calendars)
  const resources = state<CalendarResource[]>('cal-resources', () => seed().resources)
  const categories = state<Category[]>('cal-categories', () => seed().categories)
  const filters = state<CalendarFilter[]>('cal-filters', () => seed().filters)
  const events = state<CalendarEvent[]>('cal-events', () => seed().events)

  // Selection and visibility
  const selectedViewId = state<string | null>('cal-selected-view', () => null)
  const visibleCalendarIds = state<string[]>('cal-visible-calendars', () =>
    defaultVisibleCalendarIds(seed().calendars),
  )
  const activeFilterIds = state<string[]>('cal-active-filters', () => [])
  const selectedCategoryIds = state<string[]>('cal-selected-categories', () => [])

  // UI
  const selectedEventId = state<string | null>('cal-selected-event', () => null)
  const quickAddOpen = state<boolean>('cal-quick-add-open', () => false)
  const quickAddPreset = state<Partial<NewEventInput> | null>('cal-quick-add-preset', () => null)
  const sidebarOpen = state<boolean>('cal-sidebar-open', options.sidebarOpen)

  const anchorDate = computed({
    get: () => Temporal.PlainDate.from(anchorIso.value),
    set: (date) => {
      anchorIso.value = date.toString()
    },
  })
  const rangeKind = computed(() => rangeKindOf(viewType.value, splitSpan.value))
  const visibleRange = computed(() => visibleRangeFor(rangeKind.value, anchorDate.value))
  const rangeLabel = computed(() => formatRangeLabel(rangeKind.value, visibleRange.value))

  const calendarById = computed(() => new Map(calendars.value.map((item) => [item.id, item])))
  const categoryById = computed(() => new Map(categories.value.map((item) => [item.id, item])))
  const resourceById = computed(() => new Map(resources.value.map((item) => [item.id, item])))
  /** Calendars for the sidebar's calendar list; resource calendars are listed as resources. */
  const regularCalendars = computed(() =>
    calendars.value.filter((calendar) => calendar.type !== 'resource'),
  )
  const visibleResourceIds = computed(() =>
    resources.value
      .filter((resource) => visibleCalendarIds.value.includes(resource.calendarId))
      .map((resource) => resource.id),
  )
  const selectedView = computed(
    () => views.value.find((v) => v.id === selectedViewId.value) ?? null,
  )
  const selectedEvent = computed(
    () => events.value.find((e) => e.id === selectedEventId.value) ?? null,
  )
  const activeFilters = computed(() =>
    filters.value.filter((filter) => activeFilterIds.value.includes(filter.id)),
  )

  const visibleEvents = computed(() =>
    filterCalendarEvents(events.value, {
      visibleCalendarIds: new Set(visibleCalendarIds.value),
      filters: activeFilters.value,
      categoryIds: selectedCategoryIds.value,
    }),
  )
  const visibleEventsInRange = computed(() =>
    eventsInRange(visibleEvents.value, visibleRange.value).sort(byStart),
  )
  const splitBands = computed(() =>
    buildSplitBands(calendars.value, visibleEvents.value, visibleRange.value),
  )

  function prev() {
    anchorDate.value = stepAnchorDate(rangeKind.value, anchorDate.value, -1)
  }

  function next() {
    anchorDate.value = stepAnchorDate(rangeKind.value, anchorDate.value, 1)
  }

  function today() {
    anchorDate.value = options.today()
  }

  /** Selecting a view shows exactly its calendars; `null` clears it and restores the defaults. */
  function selectView(id: string | null) {
    if (id === null) {
      selectedViewId.value = null
      visibleCalendarIds.value = defaultVisibleCalendarIds(calendars.value)
      return
    }
    const view = views.value.find((item) => item.id === id)
    if (!view) return
    selectedViewId.value = id
    visibleCalendarIds.value = calendarIdsForView(view, calendars.value)
  }

  function setCalendarVisible(id: string, visible: boolean) {
    visibleCalendarIds.value = withIdPresent(visibleCalendarIds.value, id, visible)
    const onVisibility = options.hooks?.onCalendarVisibility
    if (onVisibility) {
      // The toggle is the viewer's saved preference: clearing a view must bring back this state,
      // not the one from before the toggle.
      calendars.value = calendars.value.map((calendar) =>
        calendar.id === id && calendar.defaultVisible !== visible
          ? { ...calendar, defaultVisible: visible }
          : calendar,
      )
      onVisibility(id, visible)
    }
  }

  /** A resource is shown through its own calendar. */
  function setResourceVisible(id: string, visible: boolean) {
    const resource = resourceById.value.get(id)
    if (resource) setCalendarVisible(resource.calendarId, visible)
  }

  function setFilterActive(id: string, active: boolean) {
    activeFilterIds.value = withIdPresent(activeFilterIds.value, id, active)
  }

  function setCategorySelected(id: string, selected: boolean) {
    selectedCategoryIds.value = withIdPresent(selectedCategoryIds.value, id, selected)
  }

  /** `from` -> `to` in a list of ids (the local id gives way to the server's). */
  function swapId(ids: Ref<string[]>, from: string, to: string) {
    if (ids.value.includes(from)) ids.value = ids.value.map((id) => (id === from ? to : id))
  }

  /**
   * Returns the new category, or null if the name is empty or already taken. With a backend the
   * category appears at once under a local id; the server's id replaces it when the save is done,
   * and a failed save removes it again.
   */
  function addCategory(name: string): Category | null {
    const category = createCategory(name, categories.value)
    if (!category) return null
    categories.value = [...categories.value, category]
    const persist = options.hooks?.persistCategory
    if (persist) {
      persist(category).then(
        (saved) => {
          // A reload from the server meanwhile may have dropped the local copy: add the saved one.
          if (categories.value.some((item) => item.id === category.id)) {
            categories.value = categories.value.map((item) =>
              item.id === category.id ? saved : item,
            )
          } else if (!categories.value.some((item) => item.id === saved.id)) {
            categories.value = [...categories.value, saved]
          }
          swapId(selectedCategoryIds, category.id, saved.id)
        },
        (error: unknown) => {
          categories.value = categories.value.filter((item) => item.id !== category.id)
          selectedCategoryIds.value = withIdPresent(selectedCategoryIds.value, category.id, false)
          options.hooks?.onPersistError?.('category', category.name, error)
        },
      )
    }
    return category
  }

  /**
   * Adds a text filter and activates it; null if the text is empty or already taken. Saved like
   * `addCategory`.
   */
  function addFilter(text: string): CalendarFilter | null {
    const filter = createTextFilter(text, filters.value)
    if (!filter) return null
    filters.value = [...filters.value, filter]
    setFilterActive(filter.id, true)
    const persist = options.hooks?.persistFilter
    if (persist) {
      persist(filter).then(
        (saved) => {
          if (filters.value.some((item) => item.id === filter.id)) {
            filters.value = filters.value.map((item) => (item.id === filter.id ? saved : item))
          } else if (!filters.value.some((item) => item.id === saved.id)) {
            filters.value = [...filters.value, saved]
          }
          swapId(activeFilterIds, filter.id, saved.id)
        },
        (error: unknown) => {
          filters.value = filters.value.filter((item) => item.id !== filter.id)
          activeFilterIds.value = withIdPresent(activeFilterIds.value, filter.id, false)
          options.hooks?.onPersistError?.('filter', filter.name, error)
        },
      )
    }
    return filter
  }

  function addEvent(input: NewEventInput): CalendarEvent {
    const event = createCalendarEvent(input, events.value)
    events.value = [...events.value, event]
    return event
  }

  function selectEvent(id: string | null) {
    selectedEventId.value = id
  }

  function openQuickAdd(preset?: Partial<NewEventInput>) {
    quickAddPreset.value = preset ?? null
    quickAddOpen.value = true
  }

  function closeQuickAdd() {
    quickAddOpen.value = false
    quickAddPreset.value = null
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  return {
    viewType,
    splitSpan,
    anchorDate,
    rangeKind,
    visibleRange,
    rangeLabel,
    prev,
    next,
    today,
    currentUser,
    views,
    calendars,
    resources,
    categories,
    filters,
    events,
    calendarById,
    categoryById,
    resourceById,
    regularCalendars,
    selectedViewId,
    selectedView,
    selectView,
    visibleCalendarIds,
    visibleResourceIds,
    setCalendarVisible,
    setResourceVisible,
    activeFilterIds,
    activeFilters,
    setFilterActive,
    addFilter,
    selectedCategoryIds,
    setCategorySelected,
    addCategory,
    visibleEvents,
    visibleEventsInRange,
    splitBands,
    addEvent,
    selectedEventId,
    selectedEvent,
    selectEvent,
    quickAddOpen,
    quickAddPreset,
    openQuickAdd,
    closeQuickAdd,
    sidebarOpen,
    toggleSidebar,
  }
}

export type CalendarState = ReturnType<typeof createCalendarState>
