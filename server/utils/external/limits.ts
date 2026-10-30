// Per-user limits of the external-account proxy (design §7): a token bucket on the request rate and
// a cap on requests in flight, so one user (or a script that borrowed their token) cannot turn this
// server into a request cannon or tie up all its sockets and buffers. In memory and per process,
// like the login throttle (server/utils/auth/throttle.ts), whose approach this follows: the table
// is kept in order of the latest touch, a bucket that has refilled completely is the same as none
// and is dropped first, and the table has a bound. A restart or a second instance starts with
// empty counters, which only ever makes the limit looser.

/** Requests a user may make at once, and how many they get back per second. */
export const DEFAULT_BURST = 60
export const DEFAULT_REFILL_PER_SEC = 20
/** Requests of one user in flight, and of all users together (a response is buffered, up to 10 MiB). */
export const DEFAULT_MAX_CONCURRENT_PER_USER = 8
export const DEFAULT_MAX_CONCURRENT_TOTAL = 32
export const DEFAULT_MAX_LIMITED_USERS = 10_000
/** Slack for the floating point sums of a refilling bucket. */
const EPSILON = 1e-9

export interface UserLimiterOptions {
  burst?: number
  refillPerSec?: number
  maxConcurrentPerUser?: number
  maxConcurrentTotal?: number
  /** Upper bound of the table; the least recently used buckets make room. */
  maxTrackedUsers?: number
  /** Milliseconds, like `Date.now`. */
  now?: () => number
}

export type Admission =
  /** `release` ends the request's slot; call it once the answer is complete (further calls do nothing). */
  { ok: true; release: () => void } | { ok: false; retryAfterSec: number }

export interface UserLimiter {
  /** A request starts: refused (with the seconds to wait) when the user is over a limit. */
  admit(userId: number): Admission
  /** Tracked buckets and requests in flight, for tests and diagnostics. */
  size(): { buckets: number; running: number }
}

interface Bucket {
  tokens: number
  /** When `tokens` was last brought up to date. */
  at: number
}

function positive(name: string, value: number, integer: boolean): number {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError(
      `${name} must be a positive ${integer ? 'integer' : 'number'}, got ${value}`,
    )
  }
  return value
}

export function createUserLimiter(options: UserLimiterOptions = {}): UserLimiter {
  const burst = positive('burst', options.burst ?? DEFAULT_BURST, true)
  const ratePerMs =
    positive('refillPerSec', options.refillPerSec ?? DEFAULT_REFILL_PER_SEC, false) / 1000
  const perUser = positive(
    'maxConcurrentPerUser',
    options.maxConcurrentPerUser ?? DEFAULT_MAX_CONCURRENT_PER_USER,
    true,
  )
  const total = positive(
    'maxConcurrentTotal',
    options.maxConcurrentTotal ?? DEFAULT_MAX_CONCURRENT_TOTAL,
    true,
  )
  const maxKeys = positive(
    'maxTrackedUsers',
    options.maxTrackedUsers ?? DEFAULT_MAX_LIMITED_USERS,
    true,
  )
  const clock = options.now ?? Date.now

  const buckets = new Map<number, Bucket>()
  const running = new Map<number, number>()
  let runningTotal = 0

  const refilled = (bucket: Bucket, now: number): number =>
    // A clock that jumped back refills nothing (and takes nothing away).
    Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) * ratePerMs)

  function makeRoom(now: number): void {
    if (buckets.size <= maxKeys) return
    for (const [key, bucket] of buckets) {
      if (refilled(bucket, now) < burst - EPSILON) break
      buckets.delete(key)
    }
    for (const key of buckets.keys()) {
      if (buckets.size <= maxKeys) break
      buckets.delete(key)
    }
  }

  return {
    admit(userId) {
      if (runningTotal >= total || (running.get(userId) ?? 0) >= perUser) {
        return { ok: false, retryAfterSec: 1 }
      }

      const now = clock()
      const known = buckets.get(userId)
      const bucket: Bucket = known
        ? { tokens: refilled(known, now), at: now }
        : { tokens: burst, at: now }
      if (bucket.tokens < 1 - EPSILON) {
        // Nothing is taken, but the touch keeps the table in order of use.
        buckets.delete(userId)
        buckets.set(userId, bucket)
        return {
          ok: false,
          retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerMs / 1000 - EPSILON)),
        }
      }
      bucket.tokens = Math.max(0, bucket.tokens - 1)
      buckets.delete(userId)
      buckets.set(userId, bucket)
      makeRoom(now)

      running.set(userId, (running.get(userId) ?? 0) + 1)
      runningTotal++
      let released = false
      return {
        ok: true,
        release() {
          if (released) return
          released = true
          runningTotal--
          const left = (running.get(userId) ?? 1) - 1
          if (left <= 0) running.delete(userId)
          else running.set(userId, left)
        },
      }
    },

    size: () => ({ buckets: buckets.size, running: runningTotal }),
  }
}
