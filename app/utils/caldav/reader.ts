// Reading several calendars for a visible range (design §7: one request per visible calendar, in
// parallel with a limit, kept 30 s in memory). The reader never fails as a whole (NFR-4): each
// calendar comes back with its objects (or, for a free/busy share, its busy times) or with its own
// error, and an abort ends the waiting without touching what other callers share or what is cached.
import { DavError, isAbortError } from './errors'
import { createFlights, createLimiter } from './flights'
import type { CalDavClient } from './client'
import type { DavObject, DavRange } from './types'
import { ensureTrailingSlash, toDavPath } from './urls'

export interface ReadCalendar {
  url: string
  /** Let the server expand recurring events into instances. */
  expand: boolean
  /** Ask for the busy times only (a free/busy share, which cannot query its events). */
  freeBusy?: boolean
}

export interface ReadResult {
  /** The `url` of the requested calendar, as passed in. */
  calendarUrl: string
  objects?: DavObject[]
  /** The VFREEBUSY text, for a calendar read with `freeBusy`. */
  freeBusy?: string
  error?: DavError
}

export interface CalendarReaderOptions {
  /** How long a successful answer is reused. Default 30 s. */
  ttlMs?: number
  /** Requests running at once, across all `read` calls. Default 6. */
  concurrency?: number
  /**
   * Days added to both ends of the range. Radicale matches floating and all-day events as if they
   * were UTC, so a wall-clock day can fall just outside the UTC range the viewer asked for; the
   * consumer filters by the true range. Default 1.
   */
  padDays?: number
  /** Clock (tests). */
  now?: () => number
}

export interface CalendarReader {
  /** One result per calendar, in the order given. Never rejects because a calendar failed or the signal fired. */
  read(
    calendars: readonly ReadCalendar[],
    range: DavRange,
    options?: { signal?: AbortSignal; force?: boolean },
  ): Promise<ReadResult[]>
  /** Forget everything cached or running for a calendar (after the user's own write to it). */
  invalidate(calendarUrl: string): void
  /** Forget everything. */
  clear(): void
}

/** What one request brought: the objects, or the busy times of a free/busy share. */
type Answer = { objects: DavObject[] } | { freeBusy: string }

interface CacheEntry {
  expires: number
  /** Order in which the requests started, so a slow old answer never replaces a newer one. */
  sequence: number
  answer: Answer
}

const DAY_MS = 86_400_000

/** One calendar, whichever way its href is spelled. */
const calendarKey = (url: string) => ensureTrailingSlash(toDavPath(url))

/** Anything that is not a DavError by now is a bug in the client, not in the network. */
function asDavError(error: unknown): DavError {
  if (error instanceof DavError) return error
  if (isAbortError(error))
    return new DavError('aborted', 'the request was aborted', { cause: error })
  const message = error instanceof Error ? error.message : String(error)
  return new DavError('bad-response', `unexpected failure: ${message}`, { cause: error })
}

/** A copy for the caller, so nobody changes what is cached. */
function resultOf(calendarUrl: string, answer: Answer): ReadResult {
  return 'objects' in answer
    ? { calendarUrl, objects: answer.objects.slice() }
    : { calendarUrl, freeBusy: answer.freeBusy }
}

export function createCalendarReader(
  client: Pick<CalDavClient, 'fetchObjects' | 'fetchFreeBusy'>,
  options: CalendarReaderOptions = {},
): CalendarReader {
  const ttlMs = options.ttlMs ?? 30_000
  const padMs = (options.padDays ?? 1) * DAY_MS
  const now = options.now ?? Date.now
  const limiter = createLimiter(options.concurrency ?? 6)
  const flights = createFlights<Answer>()

  /** calendar -> (range and expand) -> answer */
  const cache = new Map<string, Map<string, CacheEntry>>()
  /** Bumped by `invalidate`/`clear`: an answer for an older state is returned but not kept. */
  const generations = new Map<string, number>()
  let epoch = 0
  let sequence = 0

  const generationOf = (calendar: string) => `${epoch}:${generations.get(calendar) ?? 0}`

  function sweep(): void {
    const time = now()
    for (const [calendar, entries] of cache) {
      for (const [key, entry] of entries) if (entry.expires <= time) entries.delete(key)
      if (entries.size === 0) cache.delete(calendar)
    }
  }

  function store(calendar: string, key: string, entry: CacheEntry): void {
    sweep()
    const entries = cache.get(calendar) ?? new Map<string, CacheEntry>()
    const existing = entries.get(key)
    if (existing && existing.sequence > entry.sequence) return
    entries.set(key, entry)
    cache.set(calendar, entries)
  }

  async function readOne(
    calendar: ReadCalendar,
    padded: DavRange,
    { signal, force = false }: { signal?: AbortSignal; force?: boolean },
  ): Promise<ReadResult> {
    const calendarUrl = calendar.url
    const key = calendarKey(calendarUrl)
    const mode = calendar.freeBusy ? 'free-busy' : calendar.expand ? 'expanded' : 'raw'
    const rangeKey = `${mode} ${padded.start.toISOString()} ${padded.end.toISOString()}`
    try {
      if (signal?.aborted) throw new DavError('aborted', 'the request was aborted')
      if (!force) {
        const hit = cache.get(key)?.get(rangeKey)
        if (hit && hit.expires > now()) return resultOf(calendarUrl, hit.answer)
      }

      const generation = generationOf(key)
      const started = ++sequence
      const answer = await flights.join(
        `${key}\n${rangeKey}`,
        (shared) =>
          limiter.run(async (): Promise<Answer> => {
            const result: Answer = calendar.freeBusy
              ? { freeBusy: await client.fetchFreeBusy(calendarUrl, padded, { signal: shared }) }
              : {
                  objects: await client.fetchObjects(calendarUrl, padded, {
                    expand: calendar.expand,
                    signal: shared,
                  }),
                }
            if (generationOf(key) === generation) {
              store(key, rangeKey, { expires: now() + ttlMs, sequence: started, answer: result })
            }
            return result
          }, shared),
        { ...(signal ? { signal } : {}), fresh: force },
      )
      return resultOf(calendarUrl, answer)
    } catch (error) {
      return { calendarUrl, error: asDavError(error) }
    }
  }

  return {
    async read(calendars, range, readOptions = {}) {
      const start = range.start.getTime()
      const end = range.end.getTime()
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
        throw new RangeError('the range needs valid dates and start before end')
      }
      const padded = { start: new Date(start - padMs), end: new Date(end + padMs) }
      return Promise.all(calendars.map((calendar) => readOne(calendar, padded, readOptions)))
    },

    invalidate(calendarUrl) {
      const key = calendarKey(calendarUrl)
      generations.set(key, (generations.get(key) ?? 0) + 1)
      cache.delete(key)
      flights.drop(`${key}\n`)
    },

    clear() {
      epoch++
      cache.clear()
      flights.drop('')
    },
  }
}
