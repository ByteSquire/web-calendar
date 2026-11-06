/**
 * Shared calendar state: the single source of truth for the sidebar, top bar, main area, split
 * view, event sheet and quick-add. Every call returns the same underlying state (Nuxt `useState`),
 * so any component may call it. Always destructure refs and use them as refs (`viewType.value`,
 * or `v-model="viewType"` in templates); the functions are plain and need no `this`.
 * Logic and tests: app/utils/calendar-state.ts, tests/calendar-state.test.ts.
 *
 * View type and date
 * - `viewType: Ref<ViewType>`: 'day' | '5day' | 'week' | 'month' | 'year' | 'split' | 'list'.
 *   Assign it to switch views; the anchor date is kept. `VIEW_TYPES` and `VIEW_TYPE_LABELS`
 *   (utils/calendar-state.ts) give the switcher its order and labels.
 * - `anchorDate: Ref<Temporal.PlainDate>` (writable): the selected date. Any date inside the
 *   shown period; views keep it when the type changes. Assign it after a date click or when the
 *   calendar reports a new date.
 * - `prev() / next() / today()`: step `anchorDate` by one period of the current view: day 1 day,
 *   5day 5 days, week and list 7 days, month 1 month, year 1 year (the day is clamped, so
 *   31 Jan + 1 month = 28 Feb), split like its underlying span.
 * - `visibleRange: Ref<{ start, end }>`: PlainDates, `end` exclusive. day: the anchor; 5day:
 *   the anchor and the next 4 days; week and list: Monday to Monday (FullCalendar
 *   `firstDay: 1`; list is FullCalendar `listWeek`); month: 1st to the 1st of the next month (the
 *   grid also shows days of the adjacent months; FullCalendar fetches those itself); year:
 *   Jan 1 to Jan 1; split: the range of `splitSpan`.
 * - `rangeKind: Ref<'day'|'5day'|'week'|'month'|'year'>`: the period `visibleRange` covers.
 * - `rangeLabel: Ref<string>`: English title such as "Wed, 28 Oct 2026", "26 – 30 Oct 2026",
 *   "October 2026" or "2026".
 * - `splitSpan: Ref<'day'|'5day'|'week'|'month'>`: what one split band covers, default 'week'.
 *   Only the split view uses it; the split view may change it.
 *
 * Reference data (in-memory copies of the mock data in demo mode; in live mode they start empty and
 * `useLiveCalendar()` fills them from the API and CalDAV, see composables/useLiveCalendar.ts)
 * - `currentUser`, `views`, `calendars`, `resources`, `categories`, `filters`, `events`: Refs of
 *   arrays. Do not mutate in place; use the actions below.
 * - `calendarById`, `categoryById`, `resourceById`: Ref<Map> for look-ups (colour, name).
 * - `regularCalendars`: calendars except `type: 'resource'` (those appear as resources). A
 *   resource is shown through its own calendar (`resource.calendarId`), so the resource calendars
 *   take part in visibility, filtering and split bands like any other calendar.
 *
 * Views, visibility, filters
 * - `selectedViewId: Ref<string|null>` (null = no view) and `selectedView`.
 *   `selectView(id | null)`: a view sets `visibleCalendarIds` to the view's calendars; null
 *   clears the selection and restores each calendar's `defaultVisible`. Toggling a single
 *   calendar afterwards keeps the view selected (FR-5: filtering within a view).
 * - `visibleCalendarIds: Ref<string[]>` (initially the calendars with `defaultVisible`),
 *   `setCalendarVisible(id, visible)`, `visibleResourceIds`, `setResourceVisible(id, visible)`.
 * - `setCalendarColor(id, color | null)`: the viewer's colour for a calendar, null for its own
 *   (`ownColor`); saved first, and a refusal rejects and changes nothing.
 * - `filters` (all) and `activeFilterIds`, `activeFilters`, `setFilterActive(id, active)`,
 *   `addFilter(text)` (adds and activates a text filter; null if empty or taken).
 * - `categories` and `selectedCategoryIds`, `setCategorySelected(id, selected)`,
 *   `addCategory(name)` (null if empty or taken). Selected categories narrow the events to
 *   those carrying any of them; none selected means no restriction.
 * - Filter rules: category filters keep events carrying that category; text filters keep events
 *   whose title, location or description contains the text; status filters hide events with that
 *   status. Several filters of one kind: category and text either one, status all. Kinds, the
 *   category selection and calendar visibility are combined with AND.
 *
 * Events
 * - `events`: the in-memory store, seeded from the mock data (live mode: the events of the visible
 *   calendars around the shown range, loaded by `useLiveCalendar()`).
 * - `visibleEvents`: events of visible calendars that pass filters and the category selection,
 *   in any date range. Feed these to FullCalendar; it clips to its own range. Events have
 *   `calendarId`, `allDay` (end exclusive when all-day), `status`, `isBlocked`, `categoryIds`.
 * - `visibleEventsInRange`: the same, limited to `visibleRange` and sorted by start.
 * - `addEvent(input): CalendarEvent`: appends to `events` (id and uid are generated, status
 *   'confirmed'). `input`: `{ title, calendarId, start, end, allDay?, ... }` with `start`/`end` as
 *   `YYYY-MM-DD` (all-day) or local `YYYY-MM-DDTHH:mm`. The caller validates title, calendar and
 *   that end is after start. Reactive consumers update at once.
 * - `selectedEventId: Ref<string|null>`, `selectedEvent` (the event or null),
 *   `selectEvent(id | null)`: set on event click; `EventSheet` is open while it is set.
 *
 * Split view
 * - `splitBands: Ref<{ calendar: Calendar; events: CalendarEvent[] }[]>`: one entry per visible
 *   calendar that has at least one filtered event inside `visibleRange` (calendar order; events
 *   sorted by start). Calendars without events are omitted, which is the band hiding of FR-6.
 *
 * Quick-add and Add
 * - `quickAddOpen: Ref<boolean>`, `quickAddPreset: Ref<Partial<NewEventInput>|null>`.
 *   Open it with `openQuickAdd(preset?)` (for example a clicked date as `start`/`end`); the
 *   modal reads the preset when it opens and closes with `closeQuickAdd()`. Setting
 *   `quickAddOpen` directly is fine for closing, not for opening with a preset.
 * - `openAddEvent(preset?)` opens the same dialog as the longer "Add" form (`quickAddFull` is
 *   true): also the details (location, description) and the resources to book. `openQuickAdd`
 *   opens the lean one.
 *
 * Live mode (signed in; see composables/useLiveCalendar.ts)
 * - The state starts empty and `useLiveCalendar()` (called by the default layout) fills `currentUser`,
 *   `calendars`, `views`, `categories`, `filters`, `visibleCalendarIds` and `events`. Calendar ids
 *   are refs (`dav:<path>`, `ics:<id>`); category ids of names no category has are `auto:<name>`.
 *   Progress and problems: `useLiveStatus()`.
 * - `setCalendarVisible` saves the viewer's choice (`/api/calendar-prefs`, debounced; a failure
 *   shows a toast and keeps the toggle) and updates the calendar's `defaultVisible`. Selecting a
 *   view is not saved. `addCategory` / `addFilter` still return at once; the item carries a local
 *   id until the server answers and is removed again (with a toast) if the save fails.
 * - Without a sign-in provider (demo mode) none of this runs and the mock data is used.
 *
 * Layout
 * - `sidebarOpen: Ref<boolean>`, `toggleSidebar()`. Desktop (>= 768 px): the sidebar column is
 *   shown or collapsed. Below 768 px: the slideover is open or closed. It starts open on a desktop
 *   and closed on a phone, in either orientation (`sidebarStartsOpen`), and keeps its value when
 *   the viewport crosses the breakpoint (a phone turned sideways).
 */
import { Temporal } from 'temporal-polyfill'
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { createCalendarState, type CalendarState } from '~/utils/calendar-state'
import type { ApiRequest } from '~/utils/live/api-types'
import { createLiveHooks, type LiveHooks } from '~/utils/live/hooks'
import { emptySeed, isLiveConfig } from '~/utils/live/seed'
import { sidebarStartsOpen } from '~/utils/viewport'

// One set of hooks per app: they hold the pending (debounced) preference saves.
const liveHooks = new WeakMap<object, LiveHooks>()

/** The hooks that save the sidebar's changes; the live loader listens to the saved preferences. */
export function useLiveHooks(): LiveHooks {
  const nuxtApp = useNuxtApp()
  let hooks = liveHooks.get(nuxtApp)
  if (!hooks) {
    const fetchApi = useAuthFetch() as (path: string, options?: object) => Promise<unknown>
    const toast = useToast()
    const api: ApiRequest = <T>(path: string, options?: object) =>
      fetchApi(path, options) as Promise<T>
    hooks = createLiveHooks({
      api,
      notify: (message) =>
        toast.add({ title: message, icon: 'i-lucide-triangle-alert', color: 'warning' }),
    })
    liveHooks.set(nuxtApp, hooks)
  }
  return hooks
}

export function useCalendarState(): CalendarState {
  const timeZone = useDisplayTimeZone()
  // Live mode starts empty and is filled by `useLiveCalendar()`; demo mode (and a server without a
  // sign-in provider, which is also what component tests see) shows the mock data.
  const live = isLiveConfig(useServerConfigState().value)
  return createCalendarState(useState, {
    seed: live ? emptySeed : useMockData,
    // "Today" is the date in the viewer's display zone (FR-29).
    today: () => Temporal.Now.plainDateISO(timeZone.value),
    sidebarOpen: sidebarStartsOpen,
    ...(live ? { hooks: useLiveHooks() } : {}),
  })
}
