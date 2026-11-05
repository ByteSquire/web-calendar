// Userinfo with a short memory (L5): one answer per user is kept for a minute and concurrent
// requests of a user share one call, so a loop of `GET /api/me` costs the identity provider one
// request, not one per call. Admin checks pass `maxAgeMs: 0` and so never use a kept answer; they
// still join a call that is already running, which is as fresh as a call of their own.
import { fetchUserinfo, type UserinfoResult } from './userinfo'

export const USERINFO_TTL_MS = 60_000
/** A failed call is remembered only briefly: long enough to spare Kanidm a retry loop. */
export const USERINFO_FAILURE_TTL_MS = 5_000
export const USERINFO_MAX_ENTRIES = 500

export interface UserinfoLookup {
  issuer: string
  /** The verified `sub` of the token; the cache is keyed by it. */
  sub: string
  accessToken: string | null
  /** When the token expires, in ms since the epoch: an answer is never kept longer than that. */
  tokenExpiresAtMs?: number | null
}

export interface UserinfoClient {
  /** `maxAgeMs`: use a kept answer only if it is younger than this (0 = never). */
  get(lookup: UserinfoLookup, options?: { maxAgeMs?: number }): Promise<UserinfoResult>
  /** Forgets every kept answer (tests, and a log-out of everybody if that is ever needed). */
  clear(): void
  size(): number
}

export interface UserinfoClientOptions {
  fetch: typeof fetch
  /** The userinfo endpoint of an issuer, from its discovery document; null when it has none. */
  endpointOf: (issuer: string) => string | null
  /** Milliseconds, like `Date.now`. */
  now?: () => number
  ttlMs?: number
  failureTtlMs?: number
  maxEntries?: number
  timeoutMs?: number
}

interface Entry {
  result: UserinfoResult
  storedAt: number
  expiresAt: number
}

/**
 * The `exp` claim of a JWT in milliseconds, or null. The signature is NOT checked here: call it
 * only for a token `requireUser` has verified in the same request.
 */
export function tokenExpiresAtMs(token: string | null): number | null {
  const payload = token?.split('.')[1]
  if (!payload) return null
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const exp = (claims as { exp?: unknown } | null)?.exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

export function createUserinfoClient(options: UserinfoClientOptions): UserinfoClient {
  const clock = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? USERINFO_TTL_MS
  const failureTtlMs = options.failureTtlMs ?? USERINFO_FAILURE_TTL_MS
  const maxEntries = options.maxEntries ?? USERINFO_MAX_ENTRIES
  // Map keeps insertion order, so the first key is the oldest answer.
  const entries = new Map<string, Entry>()
  const inFlight = new Map<string, Promise<UserinfoResult>>()

  function remember(lookup: UserinfoLookup, result: UserinfoResult, now: number): void {
    const lifetime = result.ok ? ttlMs : failureTtlMs
    const expiresAt = Math.min(now + lifetime, lookup.tokenExpiresAtMs ?? Infinity)
    entries.delete(lookup.sub)
    if (expiresAt <= now) return
    if (entries.size >= maxEntries) {
      for (const [sub, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(sub)
      }
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!)
    }
    entries.set(lookup.sub, { result, storedAt: now, expiresAt })
  }

  return {
    get(lookup, { maxAgeMs = Infinity } = {}) {
      // Nothing to ask for (no endpoint known, no token): no cache, no shared call.
      const endpoint = lookup.issuer ? options.endpointOf(lookup.issuer) : null
      if (!endpoint || !lookup.accessToken) {
        return fetchUserinfo({
          endpoint,
          accessToken: lookup.accessToken,
          expectedSub: lookup.sub,
          fetch: options.fetch,
        })
      }

      const now = clock()
      const kept = entries.get(lookup.sub)
      if (kept && kept.expiresAt > now && now - kept.storedAt < maxAgeMs) {
        return Promise.resolve(kept.result)
      }
      const running = inFlight.get(lookup.sub)
      if (running) return running

      const call = fetchUserinfo({
        endpoint,
        accessToken: lookup.accessToken,
        expectedSub: lookup.sub,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      }).then((result) => {
        remember(lookup, result, clock())
        return result
      })
      inFlight.set(lookup.sub, call)
      // fetchUserinfo never rejects, so this only runs after the answer is stored.
      void call.finally(() => inFlight.delete(lookup.sub))
      return call
    },
    clear() {
      entries.clear()
    },
    size() {
      return entries.size
    },
  }
}
