// "What changed for you since you last looked" (FR-19): the text of the one toast, and the time
// of the last look, kept in the browser's storage. Pure, with the storage injected.
import type { BookingUpdate } from '../../../shared/types/resources-api'

/** Namespaced like the other keys of the app; one per signed-in user, so accounts do not mix. */
export function lastSeenKey(userKey: string): string {
  return `web-calendar:resource-updates-seen:${userKey}`
}

export interface KeyValueStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function readLastSeen(store: KeyValueStore | null, key: string): string | null {
  try {
    const value = store?.getItem(key) ?? null
    return value !== null && !Number.isNaN(Date.parse(value)) ? value : null
  } catch {
    return null
  }
}

/** Storage can be full or blocked: not remembering only means the toast may come again. */
export function writeLastSeen(store: KeyValueStore | null, key: string, iso: string): void {
  try {
    store?.setItem(key, iso)
  } catch {
    // Ignored on purpose.
  }
}

/** The first look has nothing to compare with: it asks for the last day, not for all history. */
export function firstSinceIso(now: Date): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
}

function single(update: BookingUpdate): string {
  const name = update.resourceName
  if (update.reason === 'event_moved') {
    return `Your booking for ${name} moved, re-approval requested`
  }
  if (update.reason === 'event_removed')
    return `Your booking for ${name} was cancelled: the event is gone`
  if (update.reason === 'overlap') {
    return `Your booking for ${name} was declined: another request was approved for that time`
  }
  if (update.status === 'approved') return `Your booking for ${name} was approved`
  if (update.status === 'declined') return `Your booking for ${name} was declined`
  return `Your booking for ${name} was cancelled`
}

/** One text for any number of updates; null when nothing changed. */
export function updatesToastText(updates: readonly BookingUpdate[]): string | null {
  if (updates.length === 0) return null
  if (updates.length === 1) return single(updates[0]!)
  return `${updates.length} bookings changed`
}

/** The newest `decidedAt`, to remember as the last look; null for an empty list. */
export function newestDecision(updates: readonly BookingUpdate[]): string | null {
  let newest: string | null = null
  for (const update of updates) {
    if (newest === null || Date.parse(update.decidedAt) > Date.parse(newest)) {
      newest = update.decidedAt
    }
  }
  return newest
}
