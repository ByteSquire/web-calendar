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
// - External accounts (FR-8) have a track of their own (external.ts): the built-in calendars do not
//   wait for them, and each account is merged in as soon as its server has answered.
import { computed, watch } from 'vue'
import type { Ref } from 'vue'
import type { Calendar, CalendarResource, CalendarUser } from '../../../shared/types/calendar'
import type { AvailabilityResponse } from '../../../shared/types/resources-api'
import type { CalDavClient } from '../caldav/client'
import { DavError } from '../caldav/errors'
import type { CalendarReader } from '../caldav/reader'
import type { DavCalendar } from '../caldav/types'
import type { CalendarState } from '../calendar-state'
import {
  availabilityRanges,
  availabilityToEvents,
  apiIdOfResourceCalendar,
  isResourceCalendarId,
  toCalendarResources,
  toResourceCalendars,
} from '../resources/availability'
import type { ApiResource } from '../resources/types'
import type { ExternalSource } from '../external/source'
import type {
  ApiCalendarPref,
  ApiCategory,
  ApiFilter,
  ApiIcalSubscription,
  ApiMe,
  ApiView,
} from './api-types'
import {
  buildCalendars,
  externalAccountIdOf,
  isAvailabilityCollection,
  isExternalRef,
  reconcileVisibleCalendars,
  subscriptionIdOf,
} from './calendars'
import {
  isAutoCategory,
  reconcileCategories,
  reconcileSelection,
  toCategories,
  withCategoryIds,
} from './categories'
import {
  describeLoadError,
  externalAccountKey,
  isExternalSourceKey,
  isSourceKey,
  SOURCE_KEYS,
} from './errors'
import { dedupeEvents, readCalendarEvents, type CalendarOutcome, type ReadContext } from './events'
import { createExternalTrack } from './external'
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
> & {
  /** Where the resources of the API go; a store without it (tests, demo) gets none. */
  resources?: Ref<CalendarResource[]>
}

/** Resources in live mode (FR-16..FR-18); without it the loader knows none. */
export interface ResourceSource {
  /** The resources the viewer may read, each time the list was read. */
  onList?: (list: readonly ApiResource[]) => void
}

export interface LiveDeps {
  store: LiveStore
  status: LiveStatusState
  client: Pick<CalDavClient, 'listCalendars' | 'createCalendar'>
  reader: Pick<CalendarReader, 'read'>
  /** GET a JSON route of the app's own API. */
  api: <T>(path: string) => Promise<T>
  /** The raw .ics of an iCal subscription (by its numeric id). */
  fetchIcs: (subscriptionId: string) => Promise<string>
  /** The external CalDAV accounts (FR-8); without it the loader knows none. */
  external?: ExternalSource
  resources?: ResourceSource
  displayTimeZone: () => string
  orgTimeZone: () => string
  /**
   * Called with the zone the user chose (FR-32) every time the profile is read, null for the
   * browser's zone. The display zone follows it, and the events are then loaded in the new zone.
   */
  setUserTimeZone?: (zone: string | null) => void
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
  /**
   * Reload everything, bypassing the 30 s read cache (FR-10). `external: false` leaves the
   * external accounts alone: a write to the built-in service reloads its own calendars and must
   * neither wait for the accounts' servers nor spend the proxy's request budget on them.
   */
  refresh: (options?: { external?: boolean }) => Promise<void>
  /** Load one failed calendar again, or reload the sources for a `source:*` key. */
  retry: (key: string) => Promise<void>
  /**
   * Load the events now (`only`: just those calendars; `force`: skip the read cache;
   * `skipExternal`: leave the external accounts' calendars to their own track).
   */
  loadEvents: (options?: {
    force?: boolean
    only?: readonly string[]
    skipExternal?: boolean
  }) => Promise<void>
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
  /** The viewer's calendar preferences as the last load of the sources read them. */
  let preferences: ApiCalendarPref[] = []
  /** The newest availability answers (one per piece of the range), kept to match titles later. */
  let availability: AvailabilityResponse[] = []
  let availabilityToken = 0
  const externalTrack = deps.external
    ? createExternalTrack({
        source: deps.external,
        store,
        status,
        prefs: () => preferences,
        setErrors,
        loadEvents: (options) => loadEvents(options),
        prune: () => prune(visibleLoadable()),
        beginWork,
        endWork,
        disposed: () => disposed,
      })
    : null

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
    // A "enter the password" offer belongs to a problem; it goes with it.
    const fixes = status.passwordFor.value
    if (Object.keys(fixes).some((key) => !(key in next))) {
      status.passwordFor.value = Object.fromEntries(
        Object.entries(fixes).filter(([key]) => key in next),
      )
    }
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
      const [me, prefs, categories, filters, views, subscriptions, collections, resourceList] =
        await Promise.all([
          attempt(() => deps.api<ApiMe>('/api/me')),
          attempt(() => deps.api<{ prefs: ApiCalendarPref[] }>('/api/calendar-prefs')),
          attempt(() => deps.api<{ categories: ApiCategory[] }>('/api/categories')),
          attempt(() => deps.api<{ filters: ApiFilter[] }>('/api/filters')),
          attempt(() => deps.api<{ views: ApiView[] }>('/api/views')),
          attempt(() =>
            deps.api<{ subscriptions: ApiIcalSubscription[] }>('/api/ical-subscriptions'),
          ),
          attempt(() => listOwnCalendars()),
          deps.resources
            ? attempt(() => deps.api<{ resources: ApiResource[] }>('/api/resources'))
            : Promise.resolve(null),
        ])
      if (disposed) return

      const problems: Record<string, string> = {}
      const fail = (key: string, result: PromiseRejectedResult) => {
        problems[key] = describeLoadError(result.reason)
      }

      if (me.status === 'fulfilled') {
        store.currentUser.value = toUser(me.value)
        deps.setUserTimeZone?.(me.value.timeZone)
      } else fail(SOURCE_KEYS.me, me)

      if (prefs.status === 'rejected') fail(SOURCE_KEYS.prefs, prefs)
      else preferences = prefs.value.prefs
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
          // What the external accounts' servers listed last; their own track keeps that current.
          external: externalTrack?.collections() ?? [],
        })
        // A part that could not be listed keeps what it had. External calendars are `caldav`
        // calendars too, told apart by their ref.
        const isDav = (c: Calendar) => c.type === 'caldav' && !isExternalRef(c.id)
        const dav = collectionList !== null ? built.filter(isDav) : previous.filter(isDav)
        const ical =
          subscriptionList !== null
            ? built.filter((c) => c.type === 'ical')
            : previous.filter((c) => c.type === 'ical')
        const next = [
          ...dav,
          ...ical,
          ...built.filter((c) => isExternalRef(c.id)),
          ...previous.filter((c) => c.type === 'resource'),
        ]
        store.visibleCalendarIds.value = reconcileVisibleCalendars({
          visibleIds: store.visibleCalendarIds.value,
          previous,
          next,
        })
        store.calendars.value = next
      }

      if (resourceList) applyResources(resourceList, problems)

      // Keep the messages of calendars that still exist; the source messages are replaced, except
      // those of the external accounts, which their own track keeps.
      const known = new Set(store.calendars.value.map((calendar) => calendar.id))
      const calendarErrors = Object.fromEntries(
        Object.entries(status.errors.value).filter(
          ([key]) => isExternalSourceKey(key) || (!isSourceKey(key) && known.has(key)),
        ),
      )
      setErrors({ ...calendarErrors, ...problems })
      syncCategories()
    } finally {
      endWork()
    }
  }

  /** The resources become sidebar entries; a listing that failed keeps the ones it had. */
  function applyResources(
    result: PromiseSettledResult<{ resources: ApiResource[] }>,
    problems: Record<string, string>,
  ) {
    if (result.status === 'rejected') {
      problems[SOURCE_KEYS.resources] = describeLoadError(result.reason)
      return
    }
    const list = result.value.resources
    const previous = store.calendars.value
    const next = [...previous.filter((c) => c.type !== 'resource'), ...toResourceCalendars(list)]
    store.visibleCalendarIds.value = reconcileVisibleCalendars({
      visibleIds: store.visibleCalendarIds.value,
      previous,
      next,
    })
    store.calendars.value = next
    if (store.resources) store.resources.value = toCalendarResources(list)
    deps.resources?.onList?.(list)
  }

  // ---- availability of the resources ----

  /** Puts the availability entries into the events, with the titles of events the browser has. */
  function applyAvailability() {
    const own = store.events.value.filter((event) => !isResourceCalendarId(event.calendarId))
    const titles = new Map<string, string>()
    for (const event of own)
      if (!event.isBlocked && !titles.has(event.uid)) titles.set(event.uid, event.title)
    const entries = availability.flatMap((answer) =>
      availabilityToEvents(answer, {
        displayTimeZone: deps.displayTimeZone(),
        titleOf: (uid) => titles.get(uid),
      }),
    )
    const next = dedupeEvents([...own, ...entries])
    const current = store.events.value
    if (next.length !== current.length || next.some((event, index) => event !== current[index])) {
      store.events.value = next
    }
  }

  /** The availability of the visible resources for the loaded range. Never throws. */
  async function loadAvailability(): Promise<void> {
    if (!deps.resources || disposed) return
    const token = ++availabilityToken
    const visible = new Set(store.visibleCalendarIds.value)
    const ids = store.calendars.value
      .filter((calendar) => calendar.type === 'resource' && visible.has(calendar.id))
      .flatMap((calendar) => apiIdOfResourceCalendar(calendar.id) ?? [])
    if (ids.length === 0) {
      availability = []
      applyAvailability()
      return
    }
    const range = loadRange(store.visibleRange.value, deps.displayTimeZone())
    beginWork()
    try {
      const answers = await Promise.all(
        availabilityRanges(range.start, range.end).map(({ from, to }) =>
          attempt(() =>
            deps.api<AvailabilityResponse>(
              `/api/resources/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&resource=${ids.join(',')}`,
            ),
          ),
        ),
      )
      if (disposed || token !== availabilityToken) return
      const ok = answers.flatMap((answer) => (answer.status === 'fulfilled' ? [answer.value] : []))
      const failed = answers.find((answer) => answer.status === 'rejected')
      const others = Object.entries(status.errors.value).filter(
        ([key]) => key !== SOURCE_KEYS.availability,
      )
      setErrors({
        ...Object.fromEntries(others),
        ...(failed && failed.status === 'rejected'
          ? { [SOURCE_KEYS.availability]: describeLoadError(failed.reason) }
          : {}),
      })
      // Nothing came in: what is shown stays instead of flashing away.
      if (ok.length === 0) return
      availability = ok
      applyAvailability()
    } finally {
      endWork()
    }
  }

  /**
   * The collections of the user's home that are calendars to show. The availability collection is
   * left out (see `isAvailabilityCollection`): it is not the user's calendar, and counting it would
   * also keep a user with no calendar of their own from getting the first one.
   */
  async function listOwnCalendars(): Promise<DavCalendar[]> {
    return (await deps.client.listCalendars()).filter(
      (calendar) => !isAvailabilityCollection(calendar.url),
    )
  }

  /** The user has no calendar at all: make one. A failure is reported and retried on the next load. */
  async function createDefaultCalendar(problems: Record<string, string>): Promise<DavCalendar[]> {
    try {
      return [await deps.client.createCalendar({ displayName: DEFAULT_CALENDAR_NAME })]
    } catch (error) {
      if (error instanceof DavError && error.kind === 'exists') {
        // Another tab was faster: use what is there now.
        const listed = await attempt(() => listOwnCalendars())
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

  /** Only an account with a login can be cured by entering a password again. */
  function hasLogin(accountId: number): boolean {
    return status.externalAccounts.value.some(
      (account) => account.id === accountId && account.authMode === 'basic',
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
    const fixes = new Map(Object.entries(status.passwordFor.value))
    // A login that fails fails in every calendar of its account: one entry for the account.
    const loginProblems = new Map<number, string>()
    for (const result of fresh) {
      const accountId = externalAccountIdOf(result.calendarId)
      if (
        result.needsPassword &&
        accountId !== null &&
        hasLogin(accountId) &&
        result.error !== null
      ) {
        errors.delete(result.calendarId)
        loginProblems.set(accountId, result.error)
      } else if (result.error !== null) errors.set(result.calendarId, result.error)
      else {
        errors.delete(result.calendarId)
        // It can be read: the account's login works, whatever was wrong with it is over.
        if (accountId !== null && fixes.delete(externalAccountKey(accountId))) {
          errors.delete(externalAccountKey(accountId))
        }
      }
      if (result.skipped > 0) skipped.set(result.calendarId, result.skipped)
      else skipped.delete(result.calendarId)
    }
    for (const [accountId, message] of loginProblems) {
      errors.set(externalAccountKey(accountId), message)
      fixes.set(externalAccountKey(accountId), accountId)
    }
    if (loginProblems.size > 0 || fixes.size !== Object.keys(status.passwordFor.value).length) {
      status.passwordFor.value = Object.fromEntries(fixes)
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
    // Resource calendars are not read from CalDAV: their entries come from `loadAvailability`.
    const ids = new Set([
      ...loadable.map((calendar) => calendar.id),
      ...store.calendars.value.filter((c) => c.type === 'resource').map((c) => c.id),
    ])
    if (store.events.value.some((event) => !ids.has(event.calendarId))) {
      store.events.value = store.events.value.filter((event) => ids.has(event.calendarId))
    }
    // Source keys stay; so do those of the external accounts that still exist.
    const kept = (key: string) =>
      ids.has(key) ||
      (isExternalSourceKey(key) ? externalTrack?.knowsKey(key) === true : isSourceKey(key))
    const stale = (record: Record<string, unknown>) => Object.keys(record).some((key) => !kept(key))
    const keep = <T>(record: Record<string, T>) =>
      Object.fromEntries(Object.entries(record).filter(([key]) => kept(key)))
    if (stale(status.errors.value)) status.errors.value = keep(status.errors.value)
    if (stale(status.skipped.value)) status.skipped.value = keep(status.skipped.value)
  }

  /** The calendars to show events of: the visible ones that have events. */
  function visibleLoadable(): Calendar[] {
    const visible = new Set(store.visibleCalendarIds.value)
    return store.calendars.value.filter(
      (calendar) =>
        visible.has(calendar.id) && (calendar.type === 'caldav' || calendar.type === 'ical'),
    )
  }

  async function loadEvents(
    options: { force?: boolean; only?: readonly string[]; skipExternal?: boolean } = {},
  ): Promise<void> {
    cancelTimer()
    if (disposed) return
    const force = options.force ?? false
    const loadable = visibleLoadable()
    if (!options.only) prune(loadable)
    const only = options.only
    const picked = only ? loadable.filter((calendar) => only.includes(calendar.id)) : loadable
    const targets = options.skipExternal
      ? picked.filter((calendar) => !isExternalRef(calendar.id))
      : picked
    const availabilityLoaded = options.only ? Promise.resolve() : loadAvailability()
    if (targets.length === 0) {
      await availabilityLoaded
      return
    }

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
    const caldav = targets.filter(
      (calendar) => calendar.type === 'caldav' && !isExternalRef(calendar.id),
    )
    const ical = targets.filter((calendar) => calendar.type === 'ical')
    // One group per account: a slow or failing account holds back no other.
    const external = new Map<number, Calendar[]>()
    for (const calendar of targets) {
      const accountId = externalAccountIdOf(calendar.id)
      if (accountId !== null)
        external.set(accountId, [...(external.get(accountId) ?? []), calendar])
    }

    beginWork()
    try {
      // Each group is applied as soon as it is in, so a slow subscription does not hold back
      // the calendars of the built-in service.
      const applied = await Promise.all([
        caldav.length > 0
          ? readCaldav(caldav, context.range, force).then((o) => applyOutcomes(o, context, tokens))
          : false,
        ical.length > 0 ? readIcal(ical).then((o) => applyOutcomes(o, context, tokens)) : false,
        ...[...external].map(([accountId, calendars]) =>
          externalTrack
            ? externalTrack
                .read(accountId, calendars, context.range, force)
                .then((o) => applyOutcomes(o, context, tokens))
            : false,
        ),
      ])
      await availabilityLoaded
      // New events may be the ones the availability entries belong to.
      if (availability.length > 0 && !disposed) applyAvailability()
      if (!disposed && applied.some(Boolean)) status.lastLoadedAt.value = now()
    } finally {
      endWork()
    }
  }

  // ---- lifecycle ----

  async function refresh(options: { external?: boolean } = {}): Promise<void> {
    await loadSources()
    sourcesReady = true
    await Promise.all([
      loadEvents({ force: true, skipExternal: true }),
      options.external === false ? undefined : externalTrack?.run(true),
    ])
  }

  function start(): Promise<void> {
    started ??= (async () => {
      await loadSources()
      sourcesReady = true
      await Promise.all([loadEvents({ skipExternal: true }), externalTrack?.run(false)])
    })()
    return started
  }

  function retry(key: string): Promise<void> {
    if (!isSourceKey(key)) return loadEvents({ force: true, only: [key] })
    // A problem of the built-in sources is retried without waiting for the external accounts, and
    // a problem of an account without reloading the built-in sources.
    return isExternalSourceKey(key)
      ? (externalTrack?.run(true) ?? Promise.resolve())
      : refresh({ external: false })
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
