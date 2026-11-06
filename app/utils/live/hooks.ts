// Saving what the viewer changes in the sidebar (FR-4, FR-5, FR-2): the calendar toggles and
// colours go to `/api/calendar-prefs`, new categories and filters to their own routes. Plugged into the calendar
// state as its hooks; the state itself stays local-only without them (demo mode, unit tests).
import type { CalendarStateHooks } from '../calendar-state'
import type { ApiCalendarPref, ApiCategory, ApiFilter, ApiRequest } from './api-types'
import { toCategories } from './categories'
import { locale, t } from '../i18n'
import { describeLoadError } from './errors'
import { toFilters } from './views'
import type { Category } from '../../../shared/types/calendar'

export interface Timers {
  set: (callback: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** `dav:`, `ics:` or `ext:` refs, the calendars whose preferences `/api/calendar-prefs` keeps. */
export function isPersistableRef(ref: string): boolean {
  return /^(?:dav|ics|ext):.+/s.test(ref) && ref.length <= 500
}

/** A calendar whose colour is kept: one of `isPersistableRef`, or a resource's (`res:<id>`). */
export function isColorRef(ref: string): boolean {
  return isPersistableRef(ref) || /^res:[1-9][0-9]{0,14}$/.test(ref)
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
  if (text === describeLoadError(undefined)) return t('the server did not accept it')
  // English continues the sentence in lower case; German nouns keep their capital.
  return locale.value === 'en' ? text.toLowerCase() : text
}

export interface LiveHooksDeps {
  api: ApiRequest
  /** Renames a collection of the viewer's own home in CalDAV (its displayname). */
  renameOwnCalendar?: (href: string, name: string) => Promise<void>
  /** Shows a message to the viewer (a toast). */
  notify: (message: string) => void
  timers?: Timers
  /** Quiet time before a visibility toggle is sent. Default 400 ms. */
  delayMs?: number
}

/** The hooks, and who hears of a saved preference (the loader keeps its copy current). */
export type LiveHooks = CalendarStateHooks & {
  onPreferenceSaved: (listener: (pref: ApiCalendarPref) => void) => () => void
}

/** A category of the viewer's own goes to /api/categories; a shared one to the admin route. */
function categoryPath(category: Category): string {
  const id = encodeURIComponent(category.id)
  return category.shared ? `/api/admin/categories/${id}` : `/api/categories/${id}`
}

function groupCalendarPath(manage: { groupId: number; calendarId: number }): string {
  return `/api/groups/${manage.groupId}/calendars/${manage.calendarId}`
}

export function createLiveHooks(deps: LiveHooksDeps): LiveHooks {
  const listeners = new Set<(pref: ApiCalendarPref) => void>()
  const visibility = createKeyedDebouncer<boolean>({
    delayMs: deps.delayMs ?? 400,
    ...(deps.timers ? { timers: deps.timers } : {}),
    save: async (ref, visible) => {
      await deps.api('/api/calendar-prefs', { method: 'PUT', body: { ref, visible } })
    },
    onError: (_ref, error) =>
      deps.notify(
        t('The calendar setting could not be saved: {reason}.', {
          reason: describeSaveError(error),
        }),
      ),
  })

  return {
    onPreferenceSaved(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async persistCalendarColor(calendarId, color) {
      // Calendars that are not sources of the server (the mock data) keep the colour locally.
      if (!isColorRef(calendarId)) return
      const saved = await deps.api<ApiCalendarPref>('/api/calendar-prefs', {
        method: 'PUT',
        body: { ref: calendarId, color },
      })
      for (const listener of listeners) listener(saved)
    },
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
    async saveCategory(category) {
      const saved = await deps.api<ApiCategory>(categoryPath(category), {
        method: 'PUT',
        body: { name: category.name, color: category.color },
      })
      return toCategories([saved])[0]!
    },
    async removeCategory(category) {
      await deps.api(categoryPath(category), { method: 'DELETE' })
    },
    async saveFilter(filter) {
      const saved = await deps.api<ApiFilter>(`/api/filters/${encodeURIComponent(filter.id)}`, {
        method: 'PUT',
        body: { name: filter.name, kind: filter.kind, value: filter.value },
      })
      return toFilters([saved])[0]!
    },
    async removeFilter(filter) {
      await deps.api(`/api/filters/${encodeURIComponent(filter.id)}`, { method: 'DELETE' })
    },
    async renameCalendar(calendar, name) {
      const manage = calendar.manage
      if (manage?.kind === 'group') {
        await deps.api(groupCalendarPath(manage), { method: 'PATCH', body: { name } })
      } else if (manage?.kind === 'own' && calendar.href && deps.renameOwnCalendar) {
        await deps.renameOwnCalendar(calendar.href, name)
      }
    },
    async removeCalendar(calendar) {
      const manage = calendar.manage
      if (manage?.kind === 'group') {
        await deps.api(groupCalendarPath(manage), { method: 'DELETE' })
      } else if (manage?.kind === 'own' && calendar.href) {
        await deps.api('/api/me/calendars', { method: 'DELETE', query: { href: calendar.href } })
        // The viewer's colour and visibility of a calendar that is gone; it is no loss if this fails.
        if (isPersistableRef(calendar.id)) {
          await deps
            .api('/api/calendar-prefs', { method: 'DELETE', query: { ref: calendar.id } })
            .catch(() => undefined)
        }
      }
    },
    onPersistError(what, name, error) {
      const reason = describeSaveError(error)
      deps.notify(
        what === 'category'
          ? t('The category "{name}" could not be saved: {reason}.', { name, reason })
          : t('The filter "{name}" could not be saved: {reason}.', { name, reason }),
      )
    },
  }
}
