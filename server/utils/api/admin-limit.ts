// A per-actor token bucket for admin routes, in memory and per process (like auth/throttle.ts: a
// restart or a second instance only makes it looser). The table is kept in order of the latest
// touch; buckets that have refilled completely are the same as none and go first when it is full.

export const DEFAULT_ADMIN_BURST = 20
export const DEFAULT_ADMIN_REFILL_PER_SEC = 1
export const DEFAULT_MAX_TRACKED_ACTORS = 10_000
const EPSILON = 1e-9

export interface AdminLimiterOptions {
  burst?: number
  refillPerSec?: number
  maxTracked?: number
  /** Milliseconds since the epoch. */
  now?: () => number
}

export interface AdminLimiter {
  /** Takes a token for `key`; null when allowed, else the whole seconds (>= 1) to wait. */
  take(key: string): number | null
  /** What `take` would answer, without taking anything (a bucket that is empty says so). */
  peek(key: string): number | null
  size(): number
}

interface Bucket {
  tokens: number
  at: number
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`)
  return value
}

export function createAdminLimiter(options: AdminLimiterOptions = {}): AdminLimiter {
  const burst = positive('burst', options.burst ?? DEFAULT_ADMIN_BURST)
  const perMs =
    positive('refillPerSec', options.refillPerSec ?? DEFAULT_ADMIN_REFILL_PER_SEC) / 1000
  const maxTracked = positive('maxTracked', options.maxTracked ?? DEFAULT_MAX_TRACKED_ACTORS)
  const clock = options.now ?? Date.now
  const entries = new Map<string, Bucket>()

  const isFull = (bucket: Bucket, now: number) =>
    bucket.tokens + Math.max(0, now - bucket.at) * perMs >= burst - EPSILON

  function makeRoom(now: number): void {
    if (entries.size <= maxTracked) return
    for (const [key, bucket] of entries) {
      if (!isFull(bucket, now)) break
      entries.delete(key)
    }
    for (const key of entries.keys()) {
      if (entries.size <= maxTracked) break
      entries.delete(key)
    }
  }

  return {
    take(key) {
      const now = clock()
      const bucket = entries.get(key) ?? { tokens: burst, at: now }
      bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) * perMs)
      bucket.at = now
      let wait: number | null = null
      if (bucket.tokens >= 1 - EPSILON) bucket.tokens = Math.max(0, bucket.tokens - 1)
      else wait = Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000 - EPSILON))
      entries.delete(key)
      entries.set(key, bucket)
      makeRoom(now)
      return wait
    },
    peek(key) {
      const bucket = entries.get(key)
      if (!bucket) return null
      const tokens = Math.min(burst, bucket.tokens + Math.max(0, clock() - bucket.at) * perMs)
      return tokens >= 1 - EPSILON
        ? null
        : Math.max(1, Math.ceil((1 - tokens) / perMs / 1000 - EPSILON))
    },
    size: () => entries.size,
  }
}
