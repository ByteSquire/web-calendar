// Requests in flight per user (security review 2026-11-01, finding 9). A valid user could otherwise
// run any number of heavy REPORT and PROPFIND requests at once and keep the gateway, the app and
// Radicale busy for everybody. The limit counts requests, not their rate: a sync client sends a
// burst of requests one after another, which stays far below a small limit.

/** Requests one user may have in flight at the same time, by default. */
export const DEFAULT_GATEWAY_MAX_CONCURRENT_PER_USER = 8

export interface ConcurrencyLimiter {
  /**
   * Takes a slot for `key`. Returns the function that gives it back (safe to call more than once),
   * or null when `key` already has the maximum in flight.
   */
  acquire(key: string): (() => void) | null
  /** Requests `key` has in flight. */
  inFlight(key: string): number
}

/**
 * @param max requests per key; a positive integer
 * @param onBlocked called once each time a key reaches the maximum and then asks for more, not for
 *   every refused request (a blocked client retries in a loop; the log must not)
 */
export function createConcurrencyLimiter(max: number, onBlocked?: () => void): ConcurrencyLimiter {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new RangeError(`the concurrency limit must be a positive integer, got ${max}`)
  }
  const counts = new Map<string, number>()
  const reported = new Set<string>()
  return {
    acquire(key) {
      const current = counts.get(key) ?? 0
      if (current >= max) {
        if (!reported.has(key)) {
          reported.add(key)
          onBlocked?.()
        }
        return null
      }
      counts.set(key, current + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const left = (counts.get(key) ?? 1) - 1
        if (left <= 0) {
          counts.delete(key)
          reported.delete(key)
        } else {
          counts.set(key, left)
        }
      }
    },
    inFlight: (key) => counts.get(key) ?? 0,
  }
}

/**
 * The body of a response that gives its slot back when the body has been read to its end, has
 * failed, or has been abandoned (the client went away). A request is in flight until then: a large
 * REPORT answer streams for as long as the client takes to read it.
 */
export function releaseWhenDone(
  body: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          release()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      release()
      await reader.cancel(reason)
    },
  })
}
