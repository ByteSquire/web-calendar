// Seeing a person on the CalDAV gateway with an OIDC access token (a DAV client that signs in
// through the browser flow). Such a person may never open the web app, so the gateway is where the
// app learns they are active and what groups they are in. Each sighting is throttled per person,
// bounded in memory and in parallel work, and never delays or fails the request that caused it.
//
// The access token is held only for the call that uses it: it is not stored, not logged, not put in
// an error message.
import type { TokenGroups } from './source'

export const SIGHTING_INTERVAL_MS = 5 * 60 * 1000
export const SIGHTING_MAX_PEOPLE = 10_000
export const SIGHTING_MAX_PARALLEL = 4

export interface SightingDeps {
  /** The work of a sighting that is due; may reject (the error goes to `onError`). */
  refresh(sub: string, accessToken: string, tokenGroups: TokenGroups | undefined): Promise<void>
  /** Receives what `refresh` rejected with; it must not throw. */
  onError?: (error: unknown) => void
  /** Milliseconds, like `Date.now`. */
  now?: () => number
  intervalMs?: number
  maxPeople?: number
  maxParallel?: number
}

export interface SightingTracker {
  /** Starts a refresh when one is due for `sub`; returns at once and never throws. */
  note(sub: string, accessToken: string, tokenGroups: TokenGroups | undefined): void
  /** Refreshes running right now. */
  running(): number
  /** People remembered. */
  size(): number
}

export function createSightingTracker(deps: SightingDeps): SightingTracker {
  const now = deps.now ?? Date.now
  const intervalMs = deps.intervalMs ?? SIGHTING_INTERVAL_MS
  const maxPeople = deps.maxPeople ?? SIGHTING_MAX_PEOPLE
  const maxParallel = deps.maxParallel ?? SIGHTING_MAX_PARALLEL
  // When each person may be refreshed next. Cleared when full: the cost is one early refresh each.
  const nextAllowed = new Map<string, number>()
  let running = 0

  return {
    note(sub, accessToken, tokenGroups) {
      try {
        // Too much running: skip without using up the person's turn, a later request tries again.
        if (running >= maxParallel) return
        const at = now()
        const next = nextAllowed.get(sub)
        if (next !== undefined && at < next) return
        if (nextAllowed.size >= maxPeople && !nextAllowed.has(sub)) nextAllowed.clear()
        nextAllowed.set(sub, at + intervalMs)
        running += 1
        // `refresh` may throw before it returns a promise; either way the request goes on.
        void Promise.resolve()
          .then(() => deps.refresh(sub, accessToken, tokenGroups))
          .catch((error: unknown) => {
            try {
              deps.onError?.(error)
            } catch {
              // A broken logger must not turn into an unhandled rejection.
            }
          })
          .finally(() => {
            running -= 1
          })
      } catch {
        // Nothing here may reach the request.
      }
    },
    running: () => running,
    size: () => nextAllowed.size,
  }
}
