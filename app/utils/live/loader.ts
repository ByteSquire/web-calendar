// The orchestration of live data (FR-8, FR-10, FR-3..FR-5): reads the sources (profile, calendar
// preferences, categories, filters, views, iCal subscriptions and the CalDAV collections) into the
// calendar state and then the events of the visible calendars for the loaded range.
//
// Everything is injected (CalDAV client and reader, the API, the state container, timers), so it
// runs in plain Vitest; app/composables/useLiveCalendar.ts binds it to Nuxt.
//
// Rules worth knowing:
// - A failing source never stops the others (NFR-4): its message goes to `status.errors`.
// - Events are kept per calendar. A load replaces the events of the calendars it read
//   successfully; a calendar that failed keeps what it had (nothing flashes) and gets a message;
//   a calendar that is switched off loses its events. A response is applied only if no newer
//   request for that calendar started meanwhile, so a slow old answer never overwrites a newer one.
// - The first calendar ("Personal") is created at most once per session, and only when the first
//   successful listing of the collections is empty.
import { computed, watch } from 'vue'
import type { Ref } from 'vue'
import type { Calendar, CalendarUser } from '../../../shared/types/calendar'
import type { CalDavClient } from '../caldav/client'
import { DavError } from '../caldav/errors'
import type { CalendarReader } from '../caldav/reader'
import type { DavCalendar } from '../caldav/types'
import type { CalendarState } from '../calendar-state'
import type {
  ApiCalendarPref,
  ApiCategory,
  ApiFilter,
  ApiIcalSubscription,
  ApiMe,
  ApiView,
} from './api-types'
import { buildCalendars, reconcileVisibleCalendars, subscriptionIdOf } from './calendars'
import {
  isAutoCategory,
  reconcileCategories,
  reconcileSelection,
  toCategories,
  withCategoryIds,
} from './categories'
import { describeLoadError, isSourceKey, SOURCE_KEYS } from './errors'
import { dedupeEvents, readCalendarEvents, type CalendarOutcome, type ReadContext } from './events'
import type { Timers } from './hooks'
import { loadRange, rangeKey } from './range'
import type { LiveStatusState } from './status'
import { toFilters, toViews } from './views'

export const DEFAULT_CALENDAR_NAME = 'Personal'
export const EVENTS_DEBOUNCE_MS = 150

/** The part of the calendar state the loader reads and writes. */
export type LiveStore = Pick<
  CalendarState,
  | 'currentUser'
  | 'calendars'
  | 'views'
  | 'categories'
  | 'selectedCategoryIds'
  | 'filters'
  | 'events'
  | 'visibleCalendarIds'
  | 'visibleRange'
>

export interface LiveDeps {
  store: LiveStore
  status: LiveStatusState
  client: Pick<CalDavClient, 'listCalendars' | 'createCalendar'>
  reader: Pick<CalendarReader, 'read'>
  /** GET a JSON route of the app's own API. */
  api: <T>(path: string) => Promise<T>
  /** The raw .ics of an iCal subscription (by its numeric id). */
  fetchIcs: (subscriptionId: string) => Promise<string>
  displayTimeZone: () => string
  orgTimeZone: () => string
  /** Bumped by the settings screen when sources change; see `useState('calendar-sources-version')`. */
  sourcesVersion: Ref<number>
  /** Called with the keys of problems that were not there before. */
  notifyProblems?: (keys: string[]) => void
  debounceMs?: number
  timers?: Timers
  now?: () => number
}

export interface LiveLoader {
  /** Loads the sources, then the events. Once; later calls return the same promise. */
  start: () => Promise<void>
  /** Reload everything, bypassing the 30 s read cache (FR-10). */
  refresh: () => Promise<void>
  /** Load one failed calendar again, or reload the sources for a `source:*` key. */
  retry: (key: string) => Promise<void>
  /** Load the events now (`only`: just those calendars; `force`: skip the read cache). */
  loadEvents: (options?: { force?: boolean; only?: readonly string[] }) => Promise<void>
  /** Reload the sources; calls that overlap run one after the other. */
  loadSources: () => Promise<void>
  dispose: () => void
}

const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function attempt<T>(run: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  return Promise.resolve()
    .then(run)
    .then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason: unknown) => ({ status: 'rejected', reason }) as const,
    )
}

function toUser(me: ApiMe): CalendarUser {
  return {
    id: String(me.id),
    oidcSub: me.sub,
    name: me.name ?? me.username ?? me.email ?? me.sub,
    email: me.email ?? '',
  }
}

export function createLiveLoader(deps: LiveDeps): LiveLoader {
  const { store, status } = deps
  const timers = deps.timers ?? defaultTimers
  const now = deps.now ?? Date.now

  let disposed = false
  let started: Promise<void> | null = null
  let sourcesReady = false
  /** The first successful listing of the collections decides about the default calendar. */
  let defaultChecked = false
  let timer: unknown = null
  let working = 0
  let tokenCounter = 0
  /** calendar id -> token of the newest request for it. */
  const latest = new Map<string, number>()

  // ---- bookkeeping ----

  function beginWork() {
    working++
    status.loading.value = true
  }

  function endWork() {
    working--
    if (working <= 0) {
      working = 0
      status.loading.value = false
    }
  }

  /** Writes new errors and tells about those that were not there before. */
  function setErrors(next: Record<string, string>) {
    const before = status.errors.value
    status.errors.value = next
    const added = Object.keys(next).filter((key) => before[key] !== next[key])
    if (added.length > 0) deps.notifyProblems?.(added)
  }

  // ---- categories ----

  /**
   * Keeps the category list and the events consistent: auto categories for names without a real
   * one, and every event's `categoryIds` resolved against the current list. Called when the list
   * changes (the viewer added a category, the server's id replaced a local one).
   */
  function syncCategories() {
    const current = store.categories.value
    const next = reconcileCategories(current, store.events.value)
    if (next !== current) store.categories.value = [...next]
    const events = store.events.value
    const mapped = withCategoryIds(events, store.categories.value)
    if (mapped.some((event, index) => event !== events[index])) store.events.value = mapped
    // The selection must not point at a category that is gone (it would hide every event).
    const selected = reconcileSelection(store.selectedCategoryIds.value, store.categories.value)
    if (selected !== store.selectedCategoryIds.value)
      store.selectedCategoryIds.value = [...selected]
  }

  // ---- sources ----

  async function runSources(): Promise<void> {
    beginWork()
    try {
      const [me, prefs, categories, filters, views, subscriptions, collections] = await Promise.all(
        [
          attempt(() => deps.api<ApiMe>('/api/me')),
          attempt(() => deps.api<{ prefs: ApiCalendarPref[] }>('/api/calendar-prefs')),
          attempt(() => deps.api<{ categories: ApiCategory[] }>('/api/categories')),
          attempt(() => deps.api<{ filters: ApiFilter[] }>('/api/filters')),
          attempt(() => deps.api<{ views: ApiView[] }>('/api/views')),
          attempt(() =>
            deps.api<{ subscriptions: ApiIcalSubscription[] }>('/api/ical-subscriptions'),
          ),
          attempt(() => deps.client.listCalendars()),
        ],
      )
      if (disposed) return

      const problems: Record<string, string> = {}
      const fail = (key: string, result: PromiseRejectedResult) => {
        problems[key] = describeLoadError(result.reason)
      }

      if (me.status === 'fulfilled') store.currentUser.value = toUser(me.value)
      else fail(SOURCE_KEYS.me, me)

      if (prefs.status === 'rejected') fail(SOURCE_KEYS.prefs, prefs)
      if (categories.status === 'fulfilled') {
        // Auto categories already seen stay; the real ones come from the server.
        const kept = store.categories.value.filter(isAutoCategory)
        store.categories.value = [...toCategories(categories.value.categories), ...kept]
      } else fail(SOURCE_KEYS.categories, categories)
      if (filters.status === 'fulfilled') store.filters.value = toFilters(filters.value.filters)
      else fail(SOURCE_KEYS.filters, filters)
      if (views.status === 'fulfilled') store.views.value = toViews(views.value.views)
      else fail(SOURCE_KEYS.views, views)
      if (subscriptions.status === 'rejected') fail(SOURCE_KEYS.subscriptions, subscriptions)

      let collectionList: DavCalendar[] | null = null
      if (collections.status === 'fulfilled') {
        collectionList = collections.value
        if (!defaultChecked) {
          defaultChecked = true
          if (collectionList.length === 0) {
            collectionList = await createDefaultCalendar(problems)
          }
        }
      } else fail(SOURCE_KEYS.calendars, collections)
      if (disposed) return

      const previous = store.calendars.value
      const subscriptionList =
        subscriptions.status === 'fulfilled' ? subscriptions.value.subscriptions : null
      if (collectionList !== null || subscriptionList !== null) {
        const built = buildCalendars({
          collections: collectionList ?? [],
          subscriptions: subscriptionList ?? [],
          prefs: prefs.status === 'fulfilled' ? prefs.value.prefs : [],
          ...(me.status === 'fulfilled' ? { ownerId: String(me.value.id) } : {}),
        })
        // A part that could not be listed keeps what it had.
        const dav =
          collectionList !== null
            ? built.filter((c) => c.type === 'caldav')
            : previous.filter((c) => c.type === 'caldav')
        const ical =
          subscriptionList !== null
            ? built.filter((c) => c.type === 'ical')
            : previous.filter((c) => c.type === 'ical')
        const next = [...dav, ...ical]
        store.visibleCalendarIds.value = reconcileVisibleCalendars({
          visibleIds: store.visibleCalendarIds.value,
          previous,
          next,
        })
        store.calendars.value = next
      }

      // Keep the messages of calendars that still exist; the source messages are replaced.
      const known = new Set(store.calendars.value.map((calendar) => calendar.id))
      const calendarErrors = Object.fromEntries(
        Object.entries(status.errors.value).filter(([key]) => !isSourceKey(key) && known.has(key)),
      )
      setErrors({ ...calendarErrors, ...problems })
      syncCategories()
    } finally {
      endWork()
    }
  }

  /** The user has no calendar at all: make one. A failure is reported and retried on the next load. */
  async function createDefaultCalendar(problems: Record<string, string>): Promise<DavCalendar[]> {
    try {
      return [await deps.client.createCalendar({ displayName: DEFAULT_CALENDAR_NAME })]
    } catch (error) {
      if (error instanceof DavError && error.kind === 'exists') {
        // Another tab was faster: use what is there now.
        const listed = await attempt(() => deps.client.listCalendars())
        if (listed.status === 'fulfilled' && listed.value.length > 0) return listed.value
      }
      defaultChecked = false
      problems[SOURCE_KEYS.calendars] =
        `Could not create the first calendar: ${describeLoadError(error)}`
      return []
    }
  }

  let sourcesRunning: Promise<void> | null = null
  let sourcesQueued: Promise<void> | null = null

  function loadSources(): Promise<void> {
    if (!sourcesRunning) {
      const run = runSources().finally(() => {
        if (sourcesRunning === run) sourcesRunning = null
      })
      sourcesRunning = run
      return run
    }
    // A run is in flight and may have read the sources before the caller's change: run once more
    // afterwards (and never two at once, which could create two default calendars).
    sourcesQueued ??= sourcesRunning.then(() => {
      sourcesQueued = null
      return loadSources()
    })
    return sourcesQueued
  }

  // ---- events ----

  function cancelTimer() {
    if (timer !== null) {
      timers.clear(timer)
      timer = null
    }
  }

  function scheduleEvents() {
    cancelTimer()
    timer = timers.set(() => {
      timer = null
      void loadEvents()
    }, deps.debounceMs ?? EVENTS_DEBOUNCE_MS)
  }

  function outcomesFailed(calendars: readonly Calendar[], error: unknown): CalendarOutcome[] {
    return calendars.map((calendar) => ({ kind: 'failed', calendarId: calendar.id, error }))
  }

  async function readCaldav(
    calendars: readonly Calendar[],
    range: ReadContext['range'],
    force: boolean,
  ): Promise<CalendarOutcome[]> {
    try {
      const results = await deps.reader.read(
        // `expand`: Radicale returns the occurrences of a series as separate VEVENTs.
        calendars.map((calendar) => ({ url: calendar.href ?? '', expand: true })),
        range,
        { force },
      )
      return calendars.map((calendar, index): CalendarOutcome => {
        const result = results[index]
        if (result?.objects) {
          return { kind: 'caldav', calendarId: calendar.id, objects: result.objects }
        }
        const error = result?.error ?? new DavError('bad-response', 'no result for the calendar')
        return { kind: 'failed', calendarId: calendar.id, error }
      })
    } catch (error) {
      return outcomesFailed(calendars, error)
    }
  }

  function readIcal(calendars: readonly Calendar[]): Promise<CalendarOutcome[]> {
    return Promise.all(
      calendars.map(async (calendar): Promise<CalendarOutcome> => {
        const id = subscriptionIdOf(calendar.id)
        try {
          if (id === null) throw new DavError('bad-response', 'not a subscription')
          return { kind: 'ical', calendarId: calendar.id, text: await deps.fetchIcs(id) }
        } catch (error) {
          return { kind: 'failed', calendarId: calendar.id, error }
        }
      }),
    )
  }

  /** Puts the outcomes into the state. Returns whether any of them was still the newest. */
  function applyOutcomes(
    outcomes: readonly CalendarOutcome[],
    context: ReadContext,
    tokens: ReadonlyMap<string, number>,
  ): boolean {
    if (disposed) return false
    const fresh = outcomes
      .map((outcome) => readCalendarEvents(outcome, context))
      .filter(
        (result) =>
          !result.aborted && latest.get(result.calendarId) === tokens.get(result.calendarId),
      )
    if (fresh.length === 0) return false

    const errors = new Map(Object.entries(status.errors.value))
    const skipped = new Map(Object.entries(status.skipped.value))
    for (const result of fresh) {
      if (result.error !== null) errors.set(result.calendarId, result.error)
      else errors.delete(result.calendarId)
      if (result.skipped > 0) skipped.set(result.calendarId, result.skipped)
      else skipped.delete(result.calendarId)
    }

    const loaded = fresh.filter((result) => result.error === null)
    const replaced = new Set(loaded.map((result) => result.calendarId))
    const incoming = loaded.flatMap((result) => result.events)
    const categories = reconcileCategories(store.categories.value, incoming)
    if (categories !== store.categories.value) store.categories.value = [...categories]
    store.events.value = dedupeEvents([
      ...store.events.value.filter((event) => !replaced.has(event.calendarId)),
      ...withCategoryIds(incoming, store.categories.value),
    ])
    status.skipped.value = Object.fromEntries(skipped)
    setErrors(Object.fromEntries(errors))
    return true
  }

  /** Drops the events, messages and notes of calendars that are no longer loaded. */
  function prune(loadable: readonly Calendar[]) {
    const ids = new Set(loadable.map((calendar) => calendar.id))
    if (store.events.value.some((event) => !ids.has(event.calendarId))) {
      store.events.value = store.events.value.filter((event) => ids.has(event.calendarId))
    }
    const stale = (record: Record<string, unknown>) =>
      Object.keys(record).some((key) => !isSourceKey(key) && !ids.has(key))
    const keep = <T>(record: Record<string, T>) =>
      Object.fromEntries(Object.entries(record).filter(([key]) => isSourceKey(key) || ids.has(key)))
    if (stale(status.errors.value)) status.errors.value = keep(status.errors.value)
    if (stale(status.skipped.value)) status.skipped.value = keep(status.skipped.value)
  }

  async function loadEvents(
    options: { force?: boolean; only?: readonly string[] } = {},
  ): Promise<void> {
    cancelTimer()
    if (disposed) return
    const force = options.force ?? false
    const visible = new Set(store.visibleCalendarIds.value)
    const loadable = store.calendars.value.filter(
      (calendar) =>
        visible.has(calendar.id) && (calendar.type === 'caldav' || calendar.type === 'ical'),
    )
    if (!options.only) prune(loadable)
    const only = options.only
    const targets = only ? loadable.filter((calendar) => only.includes(calendar.id)) : loadable
    if (targets.length === 0) return

    const context: ReadContext = {
      displayTimeZone: deps.displayTimeZone(),
      orgTimeZone: deps.orgTimeZone(),
      range: loadRange(store.visibleRange.value, deps.displayTimeZone()),
    }
    const tokens = new Map<string, number>()
    for (const calendar of targets) {
      tokens.set(calendar.id, ++tokenCounter)
      latest.set(calendar.id, tokenCounter)
    }
    const caldav = targets.filter((calendar) => calendar.type === 'caldav')
    const ical = targets.filter((calendar) => calendar.type === 'ical')

    beginWork()
    try {
      // Each group is applied as soon as it is in, so a slow subscription does not hold back
      // the calendars of the built-in service.
      const applied = await Promise.all([
        caldav.length > 0
          ? readCaldav(caldav, context.range, force).then((o) => applyOutcomes(o, context, tokens))
          : false,
        ical.length > 0 ? readIcal(ical).then((o) => applyOutcomes(o, context, tokens)) : false,
      ])
      if (!disposed && applied.some(Boolean)) status.lastLoadedAt.value = now()
    } finally {
      endWork()
    }
  }

  // ---- lifecycle ----

  async function refresh(): Promise<void> {
    await loadSources()
    sourcesReady = true
    await loadEvents({ force: true })
  }

  function start(): Promise<void> {
    started ??= (async () => {
      await loadSources()
      sourcesReady = true
      await loadEvents()
    })()
    return started
  }

  function retry(key: string): Promise<void> {
    return isSourceKey(key) ? refresh() : loadEvents({ force: true, only: [key] })
  }

  // Range, visible calendars and zones decide what to load. `visibleRange` is a new object on every
  // change, so the watch compares a string.
  const eventsKey = computed(() =>
    [
      rangeKey(store.visibleRange.value, deps.displayTimeZone()),
      deps.orgTimeZone(),
      [...store.visibleCalendarIds.value].sort().join(','),
    ].join('|'),
  )
  const stops = [
    watch(
      eventsKey,
      () => {
        if (sourcesReady && !disposed) scheduleEvents()
      },
      { flush: 'sync' },
    ),
    watch(
      deps.sourcesVersion,
      () => {
        if (started && !disposed) void refresh()
      },
      { flush: 'sync' },
    ),
    // A category the viewer created, or the server's id replacing a local one, changes how the
    // events' category names resolve.
    watch(store.categories, () => syncCategories(), { flush: 'sync' }),
  ]

  return {
    start,
    refresh,
    retry,
    loadEvents,
    loadSources,
    dispose() {
      disposed = true
      cancelTimer()
      for (const stop of stops) stop()
    },
  }
}
