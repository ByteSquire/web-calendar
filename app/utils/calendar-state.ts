// Calendar UI state: pure helpers plus a store factory that takes its state container as an
// argument, so it runs in plain Vitest. `useCalendarState()` binds it to Nuxt's `useState`.
// The contract for other components is documented in app/composables/useCalendarState.ts.
import { computed, type Ref } from 'vue'
import { Temporal } from 'temporal-polyfill'
import type { MockData } from '../data/mock'
import { monthLong, monthShort, weekdayShort } from './date-names'
import { cleanFilterDraft, isEmptyFilterValue, passesFilters, type FilterDraft } from './filters'
import { N_, t } from './i18n'
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
  day: N_('Day'),
  '5day': N_('5 days'),
  week: N_('Week'),
  month: N_('Month'),
  year: N_('Year'),
  split: N_('Split'),
  list: N_('List'),
} satisfies Record<ViewType, string>

/**
 * Time span one band of the split view covers. `custom` is a range of dates the person enters
 * (`customDays` days from the anchor date), shared with the list view.
 */
export const SPLIT_SPANS = ['day', '5day', 'week', 'month', 'custom'] as const
export type SplitSpan = (typeof SPLIT_SPANS)[number]

/**
 * How the split view lays out its calendars: a row each with the dates across (FullCalendar's
 * timeline), or a column each with a row per day (utils/split-columns.ts).
 */
export type SplitOrientation = 'rows' | 'columns'

/** Time span the list view covers; `custom` as for the split view. */
export const LIST_SPANS = ['week', 'month', 'year', 'custom'] as const
export type ListSpan = (typeof LIST_SPANS)[number]

/** Labels of the period buttons; the fixed periods are named like the view types. */
export const SPAN_LABELS = {
  day: N_('Day'),
  '5day': N_('5 days'),
  week: N_('Week'),
  month: N_('Month'),
  year: N_('Year'),
  custom: N_('Custom range'),
} satisfies Record<SplitSpan | ListSpan, string>

/** The period a view type shows; navigation and the range label work on this. */
export type RangeKind = 'day' | '5day' | 'week' | 'month' | 'year' | 'custom'

/**
 * Longest custom range, in days: a whole year, also a leap year. It bounds what is loaded at once
 * and how wide the split view's timeline gets.
 */
export const MAX_CUSTOM_DAYS = 366

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
  /** All categories: a category filter names one, found here by its name. */
  categories?: readonly Category[]
  /** The name of each calendar's owner by calendar id, for person filters. */
  calendarOwners?: ReadonlyMap<string, string>
}

const dayMonth = (date: Temporal.PlainDate) =>
  t('{day} {month}', { day: date.day, month: monthShort(date.month) })

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

export function rangeKindOf(
  viewType: ViewType,
  splitSpan: SplitSpan,
  listSpan: ListSpan = 'week',
): RangeKind {
  switch (viewType) {
    case 'split':
      return splitSpan
    case 'list':
      return listSpan
    default:
      return viewType
  }
}

/**
 * The dates a period shows around `anchor`. Weeks start on Monday. A custom range starts at the
 * anchor and is `customDays` long.
 */
export function visibleRangeFor(
  kind: RangeKind,
  anchor: Temporal.PlainDate,
  customDays = 7,
): DateRange {
  switch (kind) {
    case 'custom':
      return { start: anchor, end: anchor.add({ days: customDays }) }
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

/**
 * Moves `anchor` one period forward (`1`) or back (`-1`). Month and year steps clamp the day; a
 * custom range moves by its own length, so the next range starts the day after this one ends.
 */
export function stepAnchorDate(
  kind: RangeKind,
  anchor: Temporal.PlainDate,
  direction: 1 | -1,
  customDays = 7,
): Temporal.PlainDate {
  switch (kind) {
    case 'custom':
      return anchor.add({ days: customDays * direction })
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
  // A custom range of one day is named like a day.
  switch (kind === 'custom' && first.equals(last) ? 'day' : kind) {
    case 'day':
      return t('{weekday}, {day} {month} {year}', {
        weekday: weekdayShort(first.dayOfWeek),
        day: first.day,
        month: monthShort(first.month),
        year: first.year,
      })
    case 'month':
      return `${monthLong(first.month)} ${first.year}`
    case 'year':
      return String(first.year)
    default:
      if (first.year !== last.year) {
        return `${dayMonth(first)} ${first.year} – ${dayMonth(last)} ${last.year}`
      }
      if (first.month !== last.month) return `${dayMonth(first)} – ${dayMonth(last)} ${last.year}`
      return `${t('{day}', { day: first.day })} – ${dayMonth(last)} ${last.year}`
  }
}

export type CustomRangeCheck =
  | { ok: true; first: Temporal.PlainDate; last: Temporal.PlainDate }
  | { ok: false; field: 'from' | 'to'; message: string }

function parseDate(value: string): Temporal.PlainDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' })
  } catch {
    return null
  }
}

/** Checks the dates of a custom range as entered (`YYYY-MM-DD`, both days included). */
export function checkCustomRange(from: string, to: string): CustomRangeCheck {
  const first = parseDate(from.trim())
  if (!first) return { ok: false, field: 'from', message: t('Enter a start date.') }
  const last = parseDate(to.trim())
  if (!last) return { ok: false, field: 'to', message: t('Enter an end date.') }
  if (Temporal.PlainDate.compare(last, first) < 0) {
    return { ok: false, field: 'to', message: t('The end date must not be before the start date.') }
  }
  if (first.until(last).days + 1 > MAX_CUSTOM_DAYS) {
    return {
      ok: false,
      field: 'to',
      message: t('Choose at most {count} days.', { count: MAX_CUSTOM_DAYS }),
    }
  }
  return { ok: true, first, last }
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
 * of them; the active filters then apply as `passesFilters` (utils/filters.ts) says: "show only"
 * filters of one kind are alternatives, different kinds all have to pass, and every "hide" filter
 * hides what it matches.
 */
export function filterCalendarEvents(
  events: readonly CalendarEvent[],
  criteria: EventCriteria,
): CalendarEvent[] {
  const context = {
    ...(criteria.categories ? { categories: criteria.categories } : {}),
    ...(criteria.calendarOwners ? { calendarOwners: criteria.calendarOwners } : {}),
  }
  return events.filter((event) => {
    if (!criteria.visibleCalendarIds.has(event.calendarId)) return false
    if (
      criteria.categoryIds.length > 0 &&
      !criteria.categoryIds.some((id) => event.categoryIds.includes(id))
    ) {
      return false
    }
    return passesFilters(event, criteria.filters, context)
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
  creator?: CalendarEvent['creator'],
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
    ...(creator ? { creator } : {}),
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

/**
 * A new filter with a local id, or null for an empty or taken name or an empty value. The dialog
 * checks the details first (`checkFilterDraft`, utils/filters.ts).
 */
export function createFilter(
  draft: FilterDraft,
  existing: readonly CalendarFilter[],
): CalendarFilter | null {
  const clean = cleanFilterDraft(draft)
  if (!clean.name || isEmptyFilterValue(clean)) return null
  const key = clean.name.toLowerCase()
  if (existing.some((filter) => filter.name.toLowerCase() === key)) return null
  return {
    id: uniqueId(
      `filter-${slugify(clean.name) || 'new'}`,
      existing.map((filter) => filter.id),
    ),
    ...clean,
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
  /**
   * Saves the viewer's colour for a calendar (`null`: back to the calendar's own); rejects when it
   * was not saved, and the colour then stays as it was.
   */
  persistCalendarColor?: (calendarId: string, color: string | null) => Promise<void>
  /** Saves a new category; resolves to the stored one (the server's id). */
  persistCategory?: (category: Category) => Promise<Category>
  /** Saves a new filter; resolves to the stored one (the server's id), rejects when not saved. */
  persistFilter?: (filter: CalendarFilter) => Promise<CalendarFilter>
  /** A new category could not be saved and was removed again. */
  onPersistError?: (what: 'category', name: string, error: unknown) => void
  /** Saves a renamed or recoloured category; resolves to the stored one, rejects when not saved. */
  saveCategory?: (category: Category) => Promise<Category>
  /** Deletes a category; rejects when it was not deleted. */
  removeCategory?: (category: Category) => Promise<void>
  /** Saves a changed filter; resolves to the stored one, rejects when not saved. */
  saveFilter?: (filter: CalendarFilter) => Promise<CalendarFilter>
  /** Deletes a filter; rejects when it was not deleted. */
  removeFilter?: (filter: CalendarFilter) => Promise<void>
  /** Renames a calendar the viewer may manage (`Calendar.manage`); rejects when not renamed. */
  renameCalendar?: (calendar: Calendar, name: string) => Promise<void>
  /** Deletes a calendar the viewer may manage, with its events; rejects when not deleted. */
  removeCalendar?: (calendar: Calendar) => Promise<void>
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
  const listSpan = state<ListSpan>('cal-list-span', () => 'week')
  const customDays = state<number>('cal-custom-days', () => 7)
  const splitOrientation = state<SplitOrientation>('cal-split-orientation', () => 'rows')
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
  // One dialog in two sizes: 'Quick add' (lean) or 'Add' (details, resources); the last opener decides.
  const quickAddFull = state<boolean>('cal-quick-add-full', () => false)
  const sidebarOpen = state<boolean>('cal-sidebar-open', options.sidebarOpen)

  const anchorDate = computed({
    get: () => Temporal.PlainDate.from(anchorIso.value),
    set: (date) => {
      anchorIso.value = date.toString()
    },
  })
  const rangeKind = computed(() => rangeKindOf(viewType.value, splitSpan.value, listSpan.value))
  const visibleRange = computed(() =>
    visibleRangeFor(rangeKind.value, anchorDate.value, customDays.value),
  )
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

  /** The name of each calendar's owner, where it is known; person filters fall back on it. */
  const calendarOwners = computed(
    () =>
      new Map(
        calendars.value.flatMap((calendar) =>
          calendar.ownerName ? [[calendar.id, calendar.ownerName] as const] : [],
        ),
      ),
  )

  const visibleEvents = computed(() =>
    filterCalendarEvents(events.value, {
      visibleCalendarIds: new Set(visibleCalendarIds.value),
      filters: activeFilters.value,
      categoryIds: selectedCategoryIds.value,
      categories: categories.value,
      calendarOwners: calendarOwners.value,
    }),
  )
  const visibleEventsInRange = computed(() =>
    eventsInRange(visibleEvents.value, visibleRange.value).sort(byStart),
  )
  const splitBands = computed(() =>
    buildSplitBands(calendars.value, visibleEvents.value, visibleRange.value),
  )

  function prev() {
    anchorDate.value = stepAnchorDate(rangeKind.value, anchorDate.value, -1, customDays.value)
  }

  function next() {
    anchorDate.value = stepAnchorDate(rangeKind.value, anchorDate.value, 1, customDays.value)
  }

  function today() {
    anchorDate.value = options.today()
  }

  /**
   * Switches the split or the list view to a custom range. It starts as the period the view
   * showed, so the person only changes the dates that differ.
   */
  function chooseCustomRange() {
    if (rangeKind.value === 'custom') return
    const { start, end } = visibleRange.value
    customDays.value = Math.min(start.until(end).days, MAX_CUSTOM_DAYS)
    anchorDate.value = start
    if (viewType.value === 'split') splitSpan.value = 'custom'
    else if (viewType.value === 'list') listSpan.value = 'custom'
  }

  /** Shows the dates `first` to `last` (both included) in the custom range; see `checkCustomRange`. */
  function setCustomRange(first: Temporal.PlainDate, last: Temporal.PlainDate) {
    customDays.value = first.until(last).days + 1
    anchorDate.value = first
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

  /**
   * The viewer's colour for a calendar, `null` for the calendar's own. Saved first (when there is
   * somewhere to save it): a refusal rejects and changes nothing.
   */
  async function setCalendarColor(id: string, color: string | null): Promise<void> {
    const calendar = calendars.value.find((item) => item.id === id)
    if (!calendar) return
    // A calendar that came without its own colour (the mock data) keeps the one it has now as such.
    const ownColor = calendar.ownColor ?? calendar.color
    await options.hooks?.persistCalendarColor?.(id, color)
    calendars.value = calendars.value.map((item) =>
      item.id === id ? { ...item, color: color ?? ownColor, ownColor } : item,
    )
  }

  /**
   * Renames a calendar the viewer may manage. With a backend the name is saved first and shown
   * after; rejects, and the calendar keeps its name, when it was not saved.
   */
  async function renameCalendar(id: string, name: string): Promise<void> {
    const calendar = calendars.value.find((item) => item.id === id)
    if (!calendar?.manage) return
    await options.hooks?.renameCalendar?.(calendar, name)
    calendars.value = calendars.value.map((item) => (item.id === id ? { ...item, name } : item))
  }

  /**
   * Deletes a calendar the viewer may manage, not their default one; like `renameCalendar`, the
   * server goes first.
   */
  async function deleteCalendar(id: string): Promise<void> {
    const calendar = calendars.value.find((item) => item.id === id)
    if (!calendar?.manage || (calendar.manage.kind === 'own' && calendar.manage.default)) return
    await options.hooks?.removeCalendar?.(calendar)
    calendars.value = calendars.value.filter((item) => item.id !== id)
    visibleCalendarIds.value = withIdPresent(visibleCalendarIds.value, id, false)
    events.value = events.value.filter((event) => event.calendarId !== id)
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
   * Ids of new categories whose save has not come back: they cannot be changed yet, because the
   * server's id is about to replace the local one.
   */
  const savingIds = state<string[]>('cal-saving-ids', () => [])
  const savedId = (id: string) => {
    savingIds.value = withIdPresent(savingIds.value, id, false)
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
      savingIds.value = withIdPresent(savingIds.value, category.id, true)
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
          savedId(category.id)
        },
        (error: unknown) => {
          savedId(category.id)
          categories.value = categories.value.filter((item) => item.id !== category.id)
          selectedCategoryIds.value = withIdPresent(selectedCategoryIds.value, category.id, false)
          options.hooks?.onPersistError?.('category', category.name, error)
        },
      )
    }
    return category
  }

  /**
   * Adds a filter and switches it on. Resolves to null, adding nothing, for an empty or taken name
   * or an empty value; with a backend it is saved first and shown after (the dialog that adds it
   * stays open until then), and rejects when it was not saved.
   */
  async function addFilter(draft: FilterDraft): Promise<CalendarFilter | null> {
    const filter = createFilter(draft, filters.value)
    if (!filter) return null
    const stored = options.hooks?.persistFilter ? await options.hooks.persistFilter(filter) : filter
    // A reload from the server meanwhile may have brought the saved one already.
    filters.value = [...filters.value.filter((item) => item.id !== stored.id), stored]
    setFilterActive(stored.id, true)
    return stored
  }

  /** Whether another real category (auto ones are names events carry, not rows) has this name. */
  function categoryNameTaken(name: string, except: string): boolean {
    const key = name.toLowerCase()
    return categories.value.some(
      (item) => item.id !== except && !isAutoCategory(item) && item.name.toLowerCase() === key,
    )
  }

  /**
   * Renames or recolours a category. Resolves to false, changing nothing, for an empty or taken
   * name; with a backend the change is saved first and shown after, and rejects when it was not.
   * Events carry categories by name, so one that carries the old name keeps it.
   */
  async function updateCategory(
    id: string,
    change: { name?: string; color?: string },
  ): Promise<boolean> {
    const current = categories.value.find((item) => item.id === id)
    if (!current || isAutoCategory(current)) return false
    const name = (change.name ?? current.name).trim()
    if (!name || categoryNameTaken(name, id)) return false
    const next: Category = { ...current, name, color: change.color ?? current.color }
    const stored = options.hooks?.saveCategory ? await options.hooks.saveCategory(next) : next
    categories.value = categories.value.map((item) => (item.id === id ? stored : item))
    return true
  }

  /**
   * Gives a category a colour. A name that only events carry (an auto category, no saved row)
   * becomes a saved category of that name and colour, so it keeps the colour and can be used as a
   * tag; the events link up with it by name. A saved one is recoloured (`updateCategory`). With a
   * backend the server goes first; rejects, changing nothing, when it did not save.
   */
  async function colorCategory(id: string, color: string): Promise<void> {
    const current = categories.value.find((item) => item.id === id)
    if (!current) return
    if (!isAutoCategory(current)) {
      await updateCategory(id, { color })
      return
    }
    const made = createCategory(current.name, categories.value)
    if (!made) return
    const category: Category = { ...made, color }
    const stored = options.hooks?.persistCategory
      ? await options.hooks.persistCategory(category)
      : category
    // The saved one takes the place of the name; a selection of it follows (reconcileSelection).
    categories.value = [
      ...categories.value.filter((item) => item.id !== id && item.id !== stored.id),
      stored,
    ]
    swapId(selectedCategoryIds, id, stored.id)
  }

  /** Deletes a category (no event changes); with a backend the server goes first. */
  async function deleteCategory(id: string): Promise<void> {
    const current = categories.value.find((item) => item.id === id)
    if (!current || isAutoCategory(current)) return
    await options.hooks?.removeCategory?.(current)
    categories.value = categories.value.filter((item) => item.id !== id)
    selectedCategoryIds.value = withIdPresent(selectedCategoryIds.value, id, false)
  }

  /**
   * Changes a filter: its name, kind, value and mode. Resolves to false, changing nothing, for an
   * empty or taken name or an empty value; with a backend the change is saved first and shown
   * after, and rejects when it was not.
   */
  async function updateFilter(id: string, draft: FilterDraft): Promise<boolean> {
    const current = filters.value.find((item) => item.id === id)
    const clean = cleanFilterDraft(draft)
    if (!current || !clean.name || isEmptyFilterValue(clean)) return false
    const key = clean.name.toLowerCase()
    if (filters.value.some((item) => item.id !== id && item.name.toLowerCase() === key)) {
      return false
    }
    const next: CalendarFilter = { ...current, ...clean }
    const stored = options.hooks?.saveFilter ? await options.hooks.saveFilter(next) : next
    filters.value = filters.value.map((item) => (item.id === id ? stored : item))
    return true
  }

  /** Deletes a filter; with a backend the server goes first. */
  async function deleteFilter(id: string): Promise<void> {
    const current = filters.value.find((item) => item.id === id)
    if (!current) return
    await options.hooks?.removeFilter?.(current)
    filters.value = filters.value.filter((item) => item.id !== id)
    activeFilterIds.value = withIdPresent(activeFilterIds.value, id, false)
  }

  function addEvent(input: NewEventInput): CalendarEvent {
    // The demo records who made an event, as the app does in CalDAV (X-WEB-CALENDAR-CREATOR).
    const { name, email } = currentUser.value
    const creator =
      name || email ? { ...(name ? { name } : {}), ...(email ? { email } : {}) } : undefined
    const event = createCalendarEvent(input, events.value, creator)
    events.value = [...events.value, event]
    return event
  }

  function selectEvent(id: string | null) {
    selectedEventId.value = id
  }

  function openQuickAdd(preset?: Partial<NewEventInput>) {
    quickAddFull.value = false
    quickAddPreset.value = preset ?? null
    quickAddOpen.value = true
  }

  /** The longer form: also the details and the resources to book. */
  function openAddEvent(preset?: Partial<NewEventInput>) {
    quickAddFull.value = true
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
    listSpan,
    customDays,
    splitOrientation,
    chooseCustomRange,
    setCustomRange,
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
    setCalendarColor,
    renameCalendar,
    deleteCalendar,
    setResourceVisible,
    activeFilterIds,
    activeFilters,
    setFilterActive,
    addFilter,
    updateFilter,
    deleteFilter,
    selectedCategoryIds,
    setCategorySelected,
    addCategory,
    updateCategory,
    colorCategory,
    deleteCategory,
    savingIds,
    visibleEvents,
    visibleEventsInRange,
    splitBands,
    addEvent,
    selectedEventId,
    selectedEvent,
    selectEvent,
    quickAddOpen,
    quickAddPreset,
    quickAddFull,
    openQuickAdd,
    openAddEvent,
    closeQuickAdd,
    sidebarOpen,
    toggleSidebar,
  }
}

export type CalendarState = ReturnType<typeof createCalendarState>
