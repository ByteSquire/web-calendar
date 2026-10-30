// Saving what the viewer changes in the sidebar (FR-4, FR-5, FR-2): the calendar toggles go to
// `/api/calendar-prefs`, new categories and filters to their own routes. Plugged into the calendar
// state as its hooks; the state itself stays local-only without them (demo mode, unit tests).
import type { CalendarStateHooks } from '../calendar-state'
import type { ApiCategory, ApiFilter, ApiRequest } from './api-types'
import { toCategories } from './categories'
import { describeLoadError } from './errors'
import { toFilters } from './views'

export interface Timers {
  set: (callback: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** `dav:`, `ics:` or `ext:` refs, the only ones `/api/calendar-prefs` accepts. */
export function isPersistableRef(ref: string): boolean {
  return /^(?:dav|ics|ext):.+/s.test(ref) && ref.length <= 500
}

export interface KeyedDebouncer<V> {
  /** Remembers `value` for `key` and saves it after the quiet time; a newer value replaces it. */
  schedule: (key: string, value: V) => void
  /** Saves everything pending now. */
  flush: () => Promise<void>
  pending: () => number
}

/**
 * Per-key debounce, last value wins: toggling a calendar on and off in quick succession sends one
 * request with the final state. A save that fails is reported once and not retried (the UI keeps
 * what the viewer chose).
 */
export function createKeyedDebouncer<V>(options: {
  delayMs: number
  save: (key: string, value: V) => Promise<void>
  onError: (key: string, error: unknown) => void
  timers?: Timers
}): KeyedDebouncer<V> {
  const timers = options.timers ?? browserTimers
  const entries = new Map<string, { value: V; handle: unknown }>()

  async function send(key: string, value: V): Promise<void> {
    try {
      await options.save(key, value)
    } catch (error) {
      options.onError(key, error)
    }
  }

  return {
    schedule(key, value) {
      const previous = entries.get(key)
      if (previous) timers.clear(previous.handle)
      const handle = timers.set(() => {
        entries.delete(key)
        void send(key, value)
      }, options.delayMs)
      entries.set(key, { value, handle })
    },
    async flush() {
      const due = [...entries.entries()]
      entries.clear()
      for (const [, entry] of due) timers.clear(entry.handle)
      await Promise.all(due.map(([key, entry]) => send(key, entry.value)))
    },
    pending: () => entries.size,
  }
}

/** Why a save failed, as the tail of a sentence ("... could not be saved: <this>"). */
export function describeSaveError(error: unknown): string {
  const text = describeLoadError(error)
  // `describeLoadError` words reads; for saves the generic fallback reads better as this.
  return text === 'Could not be loaded' ? 'the server did not accept it' : text.toLowerCase()
}

export interface LiveHooksDeps {
  api: ApiRequest
  /** Shows a message to the viewer (a toast). */
  notify: (message: string) => void
  timers?: Timers
  /** Quiet time before a visibility toggle is sent. Default 400 ms. */
  delayMs?: number
}

export function createLiveHooks(deps: LiveHooksDeps): CalendarStateHooks {
  const visibility = createKeyedDebouncer<boolean>({
    delayMs: deps.delayMs ?? 400,
    ...(deps.timers ? { timers: deps.timers } : {}),
    save: async (ref, visible) => {
      await deps.api('/api/calendar-prefs', { method: 'PUT', body: { ref, visible } })
    },
    onError: (_ref, error) =>
      deps.notify(`The calendar setting could not be saved: ${describeSaveError(error)}.`),
  })

  return {
    onCalendarVisibility(calendarId, visible) {
      // Calendars that are not sources of the server (the mock data) have no preference to store.
      if (isPersistableRef(calendarId)) visibility.schedule(calendarId, visible)
    },
    async persistCategory(category) {
      const saved = await deps.api<ApiCategory>('/api/categories', {
        method: 'POST',
        body: { name: category.name, color: category.color },
      })
      return toCategories([saved])[0]!
    },
    async persistFilter(filter) {
      const saved = await deps.api<ApiFilter>('/api/filters', {
        method: 'POST',
        body: { name: filter.name, kind: filter.kind, value: filter.value },
      })
      return toFilters([saved])[0]!
    },
    onPersistError(what, name, error) {
      deps.notify(`The ${what} "${name}" could not be saved: ${describeSaveError(error)}.`)
    },
  }
}
