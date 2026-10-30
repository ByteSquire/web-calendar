import { IcalFetchError } from './errors'
import type { IcalProxyConfig } from './config'
import { fetchIcal, type FetchOptions, type FetchResult } from './fetcher'
import type { AddressPolicy } from './ssrf'

// The in-memory cache in front of the fetcher (design §4, §7). Within the TTL a file is served
// without asking the source; after that the source is asked again with the stored validators
// (a 304 keeps the body). Any failure drops the entry and is reported: an outage shows an error,
// never stale data. The cache is bounded, concurrent requests for one URL share one fetch, and
// one user can have only a few fetches running at the same time.

export const MAX_CACHE_ENTRIES = 200
export const MAX_CACHE_BYTES = 64 * 1024 * 1024
export const MAX_FETCHES_PER_USER = 4

export interface IcalDocument {
  body: string
  etag: string | null
}

export interface IcalRequestContext {
  userId: number
  /** For the log only. */
  subscriptionId: number
}

export interface IcalProxy {
  get(url: string, context: IcalRequestContext): Promise<IcalDocument>
  clear(): void
  stats(): { entries: number; bytes: number; inFlight: number }
}

export interface IcalProxyDeps {
  config: IcalProxyConfig
  policy: AddressPolicy
  /** Milliseconds, like `Date.now`. */
  now?: () => number
  fetch?: (url: string, options: FetchOptions) => Promise<FetchResult>
  log?: (message: string) => void
  maxEntries?: number
  maxBytes?: number
  maxFetchesPerUser?: number
}

interface Entry {
  body: string
  bytes: number
  etag: string | null
  lastModified: string | null
  fetchedAt: number
}

/** At most `limit` holders at a time per key; the rest wait in order. */
class KeyedLimiter {
  private readonly active = new Map<number, number>()
  private readonly waiting = new Map<number, (() => void)[]>()

  constructor(private readonly limit: number) {}

  async acquire(key: number): Promise<() => void> {
    const running = this.active.get(key) ?? 0
    if (running >= this.limit) {
      await new Promise<void>((resolve) => {
        const queue = this.waiting.get(key) ?? []
        queue.push(resolve)
        this.waiting.set(key, queue)
      })
      // The releasing holder handed its slot over; `active` already counts it.
    } else {
      this.active.set(key, running + 1)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const queue = this.waiting.get(key)
      const next = queue?.shift()
      if (queue?.length === 0) this.waiting.delete(key)
      if (next) {
        next()
        return
      }
      const left = (this.active.get(key) ?? 1) - 1
      if (left <= 0) this.active.delete(key)
      else this.active.set(key, left)
    }
  }
}

/** Log line without the path and query: private feeds put their secret there. */
function describeSource(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid-url'
  }
}

export function createIcalProxy(deps: IcalProxyDeps): IcalProxy {
  const { config, policy } = deps
  const now = deps.now ?? Date.now
  const fetchFile = deps.fetch ?? fetchIcal
  const log = deps.log ?? ((message: string) => console.warn(message))
  const maxEntries = deps.maxEntries ?? MAX_CACHE_ENTRIES
  const maxBytes = deps.maxBytes ?? MAX_CACHE_BYTES
  const ttlMs = config.cacheTtlSec * 1000

  // A Map iterates in insertion order, so re-inserting on use keeps the least recently used first.
  const entries = new Map<string, Entry>()
  let totalBytes = 0
  const inFlight = new Map<string, Promise<IcalDocument>>()
  const limiter = new KeyedLimiter(deps.maxFetchesPerUser ?? MAX_FETCHES_PER_USER)

  function remove(url: string): void {
    const entry = entries.get(url)
    if (!entry) return
    entries.delete(url)
    totalBytes -= entry.bytes
  }

  function store(url: string, entry: Entry): void {
    remove(url)
    // A file that alone exceeds the budget would only evict everything else.
    if (entry.bytes > maxBytes) return
    entries.set(url, entry)
    totalBytes += entry.bytes
    for (const [oldest] of entries) {
      if (entries.size <= maxEntries && totalBytes <= maxBytes) break
      remove(oldest)
    }
  }

  function touch(url: string, entry: Entry): void {
    entries.delete(url)
    entries.set(url, entry)
  }

  async function refresh(url: string, context: IcalRequestContext): Promise<IcalDocument> {
    const release = await limiter.acquire(context.userId)
    try {
      const stale = entries.get(url)
      const validators =
        stale && (stale.etag || stale.lastModified)
          ? { etag: stale.etag, lastModified: stale.lastModified }
          : undefined
      let result: FetchResult
      try {
        result = await fetchFile(url, {
          policy,
          maxBytes: config.maxBytes,
          timeoutMs: config.timeoutMs,
          validators,
        })
      } catch (error) {
        remove(url)
        const failure =
          error instanceof IcalFetchError
            ? error
            : new IcalFetchError('unreachable', 'unexpected error', { cause: error })
        log(
          `[ical-proxy] sub ${context.subscriptionId} host=${describeSource(url)}: ${failure.reason}` +
            (failure.detail ? ` (${failure.detail})` : ''),
        )
        throw failure
      }

      if (result.kind === 'not-modified') {
        // `validators` was set, so `stale` exists; the entry is kept for as long as the source agrees.
        const entry: Entry = {
          ...stale!,
          etag: result.etag ?? stale!.etag,
          lastModified: result.lastModified ?? stale!.lastModified,
          fetchedAt: now(),
        }
        store(url, entry)
        return { body: entry.body, etag: entry.etag }
      }
      store(url, {
        body: result.body,
        bytes: result.bytes,
        etag: result.etag,
        lastModified: result.lastModified,
        fetchedAt: now(),
      })
      return { body: result.body, etag: result.etag }
    } finally {
      release()
    }
  }

  return {
    async get(url, context) {
      const cached = entries.get(url)
      if (cached && now() - cached.fetchedAt < ttlMs) {
        touch(url, cached)
        return { body: cached.body, etag: cached.etag }
      }
      // Joiners wait for the fetch that is already running and take no slot of their own.
      let pending = inFlight.get(url)
      if (!pending) {
        pending = refresh(url, context).finally(() => inFlight.delete(url))
        inFlight.set(url, pending)
      }
      return pending
    },
    clear() {
      entries.clear()
      totalBytes = 0
    },
    stats: () => ({ entries: entries.size, bytes: totalBytes, inFlight: inFlight.size }),
  }
}
