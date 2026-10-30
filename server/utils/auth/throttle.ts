import { clientGroupKey } from './client-address'

// Throttle for failed HTTP Basic logins (app tokens, design §6/§7). The credential is ALWAYS checked
// first (one HMAC and one indexed lookup, microseconds), and a correct one is accepted whatever the
// counters say: behind a reverse proxy every client has the proxy's address, so anything that refused
// a correct login because of other clients' failures would let a stranger lock everybody out. Only
// failures are counted, and the counters decide how a FAILED login is answered: 401, or 429 with
// Retry-After once the client is told to slow down. That bounds the noise in the log and tells
// misbehaving clients to back off; the strength of the tokens is what keeps them safe.
// In memory and per process: a restart or a second instance starts with empty counters, which only
// ever makes the limit looser.

/** Failures allowed per (client address, user name) within the window. */
export const DEFAULT_MAX_USER_FAILURES = 5
export const DEFAULT_WINDOW_SEC = 600
/** Failures a client address may make in a burst, and how many it gets back per second. */
export const DEFAULT_ADDRESS_BURST = 30
export const DEFAULT_ADDRESS_REFILL_PER_SEC = 10
export const DEFAULT_MAX_TRACKED_USERS = 10_000
export const DEFAULT_MAX_TRACKED_ADDRESSES = 10_000
/** The part of a user name that goes into a key, so an 8 KB user name cannot inflate the map. */
const MAX_USERNAME_KEY_LENGTH = 128
/** Longest user name written to the log. */
const MAX_USERNAME_LOG_LENGTH = 64
/** Slack for the floating point sums of a refilling bucket. */
const EPSILON = 1e-9

export interface BasicThrottleOptions {
  /** Failures per (client address, user name) within the window; reaching it blocks the key. */
  maxUserFailures?: number
  windowSec?: number
  /** Failures an address may make at once (the bucket's size). */
  addressBurst?: number
  /** Failures an address gets back per second, up to the burst. */
  addressRefillPerSec?: number
  /** Upper bounds for the two tables; the least recently failed keys make room. */
  maxTrackedUsers?: number
  maxTrackedAddresses?: number
  /** Milliseconds since the epoch. */
  now?: () => number
  /**
   * Called when a client starts being slowed down: once when a (address, user name) key reaches its
   * limit, and once per run of rate-limited failures of an address (not on every refusal).
   */
  onBlock?: (block: ThrottleBlock) => void
}

export interface ThrottleBlock {
  scope: 'user' | 'address'
  /** The client as the throttle counts it: an IPv4 address, or the /64 prefix of an IPv6 one. */
  address: string
  /** The user name as sent (scope `user` only). */
  username?: string
  retryAfterSec: number
}

export interface BasicThrottle {
  /**
   * The credentials were wrong: count the failure. Returns the whole seconds (at least 1) the client
   * is to wait when this failure puts it over a limit, so that the answer is a 429 instead of a 401,
   * and null otherwise. It is the later of the two waits when both limits are exceeded.
   */
  recordFailure(address: string | null | undefined, username: string): number | null
  /**
   * The credentials were right: the (address, user name) counter starts over. Nothing else changes,
   * and nothing was ever refused because of the counters.
   */
  recordSuccess(address: string | null | undefined, username: string): void
  /** Number of tracked keys, for tests and diagnostics. */
  size(): { users: number; addresses: number }
}

/**
 * Failure times per key. The table is kept in order of the latest failure (a key is moved to the end
 * when it fails again), so expired keys are all at the front and can be dropped without a full scan,
 * and the front is also the least recently failed key when the table is over its bound.
 */
class FailureWindow {
  private readonly entries = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
  ) {}

  get size(): number {
    return this.entries.size
  }

  /** The failures of `key` that are still inside the window, oldest first (pruned in place). */
  private live(key: string, now: number): number[] | undefined {
    const times = this.entries.get(key)
    if (!times) return undefined
    const cutoff = now - this.windowMs
    let expired = 0
    while (expired < times.length && times[expired]! <= cutoff) expired++
    if (expired === times.length) {
      this.entries.delete(key)
      return undefined
    }
    if (expired > 0) times.splice(0, expired)
    return times
  }

  /**
   * When the key may fail again without being slowed down (milliseconds since the epoch), or null if
   * it is not blocked. It is blocked while `limit` or more failures are inside the window, and free
   * once the (count - limit + 1)th oldest one has left it; for exactly `limit` failures that is the
   * oldest.
   */
  unblockedAt(key: string, now: number): number | null {
    const times = this.live(key, now)
    if (!times || times.length < this.limit) return null
    return times[times.length - this.limit]! + this.windowMs
  }

  /** Records a failure; true when it is the one that makes the key blocked. */
  add(key: string, now: number): boolean {
    const times = this.live(key, now) ?? []
    const wasBlocked = times.length >= this.limit
    times.push(now)
    // A client that keeps failing while it is blocked pushes its own release back; only the newest
    // `limit` matter for when the block ends, so the list stays short whatever happens.
    if (times.length > this.limit) times.splice(0, times.length - this.limit)
    this.entries.delete(key)
    this.entries.set(key, times)
    this.makeRoom(now)
    return !wasBlocked && times.length >= this.limit
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  private makeRoom(now: number): void {
    if (this.entries.size <= this.maxKeys) return
    const cutoff = now - this.windowMs
    for (const [key, times] of this.entries) {
      if (times[times.length - 1]! > cutoff) break
      this.entries.delete(key)
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxKeys) break
      this.entries.delete(key)
    }
  }
}

interface Bucket {
  tokens: number
  /** When `tokens` was last brought up to date. */
  at: number
  /** The current run of refusals has been reported. */
  limited: boolean
}

/**
 * A token bucket per client address: every failure takes one token, tokens come back at a steady
 * rate up to the burst. It limits how fast an address may fail, not for how long: once it stops
 * failing it is back to normal within `burst / rate` seconds, and the bucket never refuses a
 * correct login (it is not even asked). Like `FailureWindow`, the table is in order of the latest
 * touch; a bucket that has refilled completely is the same as no bucket, so those are dropped first.
 */
class FailureBuckets {
  private readonly entries = new Map<string, Bucket>()
  private readonly ratePerMs: number

  constructor(
    private readonly burst: number,
    refillPerSec: number,
    private readonly maxKeys: number,
  ) {
    this.ratePerMs = refillPerSec / 1000
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * Takes a token for one failure. `waitMs` is how long until one is available when none was (the
   * failure is then refused without taking anything), `starts` tells that this refusal opens a new
   * run of refusals, so that a flood is reported once and not on every request.
   */
  take(key: string, now: number): { waitMs: number | null; starts: boolean } {
    const known = this.entries.get(key)
    const bucket: Bucket = known ?? { tokens: this.burst, at: now, limited: false }
    // A clock that jumped back refills nothing (and takes nothing away).
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + Math.max(0, now - bucket.at) * this.ratePerMs,
    )
    bucket.at = now
    if (bucket.tokens >= this.burst - EPSILON) bucket.limited = false

    let waitMs: number | null = null
    let starts = false
    if (bucket.tokens >= 1 - EPSILON) {
      bucket.tokens = Math.max(0, bucket.tokens - 1)
    } else {
      waitMs = (1 - bucket.tokens) / this.ratePerMs
      starts = !bucket.limited
      bucket.limited = true
    }
    this.entries.delete(key)
    this.entries.set(key, bucket)
    this.makeRoom(now)
    return { waitMs, starts }
  }

  private isFull(bucket: Bucket, now: number): boolean {
    return bucket.tokens + Math.max(0, now - bucket.at) * this.ratePerMs >= this.burst - EPSILON
  }

  private makeRoom(now: number): void {
    if (this.entries.size <= this.maxKeys) return
    for (const [key, bucket] of this.entries) {
      if (!this.isFull(bucket, now)) break
      this.entries.delete(key)
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxKeys) break
      this.entries.delete(key)
    }
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${value}`)
  }
  return value
}

function positiveNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number, got ${value}`)
  }
  return value
}

/**
 * Two counters over failed logins: a sliding window per (client address, lower-cased user name),
 * and a token bucket per client address. A client is its IPv4 address or, for IPv6, its /64 (see
 * `clientGroupKey`: a client with a whole /64 cannot start over with a new address). The address in
 * the first key is what keeps a stranger from making a user's own client look bad: guessing for
 * "alice" from elsewhere counts against the guesser. The bucket slows a client that sprays user
 * names. Neither ever refuses a correct login.
 */
export function createBasicThrottle(options: BasicThrottleOptions = {}): BasicThrottle {
  const maxUser = positiveInteger(
    'maxUserFailures',
    options.maxUserFailures ?? DEFAULT_MAX_USER_FAILURES,
  )
  const windowSec = positiveInteger('windowSec', options.windowSec ?? DEFAULT_WINDOW_SEC)
  const burst = positiveInteger('addressBurst', options.addressBurst ?? DEFAULT_ADDRESS_BURST)
  const refill = positiveNumber(
    'addressRefillPerSec',
    options.addressRefillPerSec ?? DEFAULT_ADDRESS_REFILL_PER_SEC,
  )
  const clock = options.now ?? Date.now
  const users = new FailureWindow(
    maxUser,
    windowSec * 1000,
    positiveInteger('maxTrackedUsers', options.maxTrackedUsers ?? DEFAULT_MAX_TRACKED_USERS),
  )
  const addresses = new FailureBuckets(
    burst,
    refill,
    positiveInteger(
      'maxTrackedAddresses',
      options.maxTrackedAddresses ?? DEFAULT_MAX_TRACKED_ADDRESSES,
    ),
  )

  // The client key (an address or a /64 prefix) has no line break, so the first one separates it
  // from the user name.
  const userKey = (address: string, username: string) =>
    `${address}\n${username.toLowerCase().slice(0, MAX_USERNAME_KEY_LENGTH)}`
  const seconds = (waitMs: number) => Math.max(1, Math.ceil((waitMs - EPSILON) / 1000))

  function announce(block: Omit<ThrottleBlock, 'retryAfterSec'>, waitMs: number) {
    if (!options.onBlock) return
    try {
      options.onBlock({ ...block, retryAfterSec: seconds(waitMs) })
    } catch {
      // A broken logger must not turn a failed login into a 500.
    }
  }

  return {
    recordFailure(address, username) {
      const now = clock()
      const client = clientGroupKey(address)
      const key = userKey(client, username)

      const userBecameBlocked = users.add(key, now)
      const userUntil = users.unblockedAt(key, now)
      // The window is the longest a key ever waits; the clamp guards against a clock that jumped back.
      const userWaitMs = userUntil === null ? null : Math.min(userUntil - now, windowSec * 1000)
      const bucket = addresses.take(client, now)

      if (userBecameBlocked && userWaitMs !== null) {
        announce({ scope: 'user', address: client, username }, userWaitMs)
      }
      if (bucket.starts && bucket.waitMs !== null) {
        announce({ scope: 'address', address: client }, bucket.waitMs)
      }
      if (userWaitMs === null && bucket.waitMs === null) return null
      return seconds(Math.max(userWaitMs ?? 0, bucket.waitMs ?? 0))
    },

    recordSuccess(address, username) {
      users.delete(userKey(clientGroupKey(address), username))
    },

    size: () => ({ users: users.size, addresses: addresses.size }),
  }
}

/**
 * The log line for a new block. The user name is client-supplied (a Basic user name may hold a line
 * break, or the password typed into the wrong field), so it is cut to 64 characters and quoted with
 * JSON escapes. Neither a password nor a token ever reaches this function.
 */
export function describeBlock(block: ThrottleBlock): string {
  const wait = `for at least ${block.retryAfterSec} s`
  if (block.scope === 'address') {
    return `failed Basic logins from ${block.address} come too fast; answering them with 429 ${wait} (correct logins are not affected)`
  }
  const name = JSON.stringify((block.username ?? '').slice(0, MAX_USERNAME_LOG_LENGTH))
  return `too many failed Basic logins for user ${name} from ${block.address}; answering them with 429 ${wait} (correct logins are not affected)`
}
