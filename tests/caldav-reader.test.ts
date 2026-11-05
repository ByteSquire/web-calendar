// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DavError } from '../app/utils/caldav/errors'
import { createFlights, createLimiter } from '../app/utils/caldav/flights'
import { createCalendarReader } from '../app/utils/caldav/reader'
import type { CalendarReaderOptions } from '../app/utils/caldav/reader'
import type { DavObject, DavRange } from '../app/utils/caldav/types'

// The reader against a client whose requests the test completes by hand, so it can look at what is
// running, what is queued and what has been cancelled.

interface Pending {
  url: string
  range: DavRange
  expand: boolean
  signal: AbortSignal | undefined
  resolve: (objects: DavObject[]) => void
  reject: (error: unknown) => void
}

function controlled() {
  const calls: Pending[] = []
  let running = 0
  let peak = 0
  const client = {
    fetchObjects(
      url: string,
      range: DavRange,
      options: { expand?: boolean; signal?: AbortSignal } = {},
    ) {
      return new Promise<DavObject[]>((resolve, reject) => {
        running++
        peak = Math.max(peak, running)
        const done = () => {
          running--
        }
        const call: Pending = {
          url,
          range,
          expand: options.expand === true,
          signal: options.signal,
          resolve: (objects) => {
            done()
            resolve(objects)
          },
          reject: (error) => {
            done()
            reject(error)
          },
        }
        // Like the real client: an abort ends the request with an `aborted` error.
        options.signal?.addEventListener('abort', () =>
          call.reject(new DavError('aborted', 'the request was aborted')),
        )
        calls.push(call)
      })
    },
  }
  return { client, calls, peak: () => peak, running: () => running }
}

const object = (name: string): DavObject => ({
  url: `/c/${name}.ics`,
  etag: `"${name}"`,
  data: name,
})
const RANGE: DavRange = {
  start: new Date('2026-11-01T00:00:00Z'),
  end: new Date('2026-12-01T00:00:00Z'),
}
const cal = (name: string, expand = false) => ({ url: `/caldav/u/${name}/`, expand })
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(options: CalendarReaderOptions = {}) {
  const fake = controlled()
  let clock = 1_000_000
  const reader = createCalendarReader(fake.client, { now: () => clock, ...options })
  return { ...fake, reader, advance: (ms: number) => (clock += ms) }
}

/** Completes every request that arrives, answering with one object named after the calendar. */
function autoAnswer(s: ReturnType<typeof setup>) {
  let answered = 0
  return async () => {
    await tick()
    for (; answered < s.calls.length; answered++) {
      const call = s.calls[answered]!
      call.resolve([object(call.url.split('/').at(-2)!)])
    }
  }
}

describe('reading', () => {
  it('answers each calendar on its own, in the order asked', async () => {
    const s = setup()
    const reading = s.reader.read([cal('a'), cal('b'), cal('c')], RANGE)
    await tick()
    s.calls[2]!.resolve([object('c')])
    s.calls[1]!.reject(new DavError('forbidden', 'no', { status: 403 }))
    s.calls[0]!.resolve([object('a1'), object('a2')])
    const results = await reading
    expect(results.map((r) => r.calendarUrl)).toEqual([
      '/caldav/u/a/',
      '/caldav/u/b/',
      '/caldav/u/c/',
    ])
    expect(results[0]).toEqual({
      calendarUrl: '/caldav/u/a/',
      objects: [object('a1'), object('a2')],
    })
    expect(results[1]!.objects).toBeUndefined()
    expect(results[1]!.error).toMatchObject({ kind: 'forbidden', status: 403 })
    expect(results[2]!.objects).toEqual([object('c')])
  })

  it('never rejects because of a failing calendar, whatever it throws', async () => {
    const s = setup()
    const reading = s.reader.read([cal('a'), cal('b'), cal('c')], RANGE)
    await tick()
    s.calls[0]!.reject(new TypeError('boom'))
    s.calls[1]!.reject('a string')
    s.calls[2]!.reject(new DOMException('x', 'AbortError'))
    const results = await reading
    expect(results.map((r) => r.error?.kind)).toEqual(['bad-response', 'bad-response', 'aborted'])
    expect(results.every((r) => r.error instanceof DavError)).toBe(true)
  })

  it('answers an empty list with an empty list', async () => {
    await expect(setup().reader.read([], RANGE)).resolves.toEqual([])
  })

  it.each([
    ['an invalid start', { start: new Date('x'), end: RANGE.end }],
    ['an invalid end', { start: RANGE.start, end: new Date(NaN) }],
    ['an empty range', { start: RANGE.start, end: RANGE.start }],
    ['an inverted range', { start: RANGE.end, end: RANGE.start }],
  ])('refuses %s as a caller bug', async (_name, range) => {
    const s = setup()
    await expect(s.reader.read([cal('a')], range)).rejects.toBeInstanceOf(RangeError)
    expect(s.calls).toHaveLength(0)
  })

  it('pads the range by a day on both sides, and passes expand on', async () => {
    const s = setup()
    void s.reader.read([cal('a', true), cal('b', false)], RANGE)
    await tick()
    expect(s.calls[0]!.range).toEqual({
      start: new Date('2026-10-31T00:00:00Z'),
      end: new Date('2026-12-02T00:00:00Z'),
    })
    expect(s.calls.map((c) => c.expand)).toEqual([true, false])
    expect(s.calls[0]!.range).toEqual(s.calls[1]!.range)
  })

  it('pads by padDays when configured, and not at all for 0', async () => {
    const wide = setup({ padDays: 3 })
    void wide.reader.read([cal('a')], RANGE)
    const none = setup({ padDays: 0 })
    void none.reader.read([cal('a')], RANGE)
    await tick()
    expect(wide.calls[0]!.range.start).toEqual(new Date('2026-10-29T00:00:00Z'))
    expect(none.calls[0]!.range).toEqual(RANGE)
  })
})

describe('cache', () => {
  it('serves a repeated read from memory until the time to live is over', async () => {
    const s = setup({ ttlMs: 30_000 })
    const answer = autoAnswer(s)
    const first = s.reader.read([cal('a')], RANGE)
    await answer()
    expect((await first)[0]!.objects).toEqual([object('a')])

    s.advance(29_999)
    const again = await s.reader.read([cal('a')], RANGE)
    expect(again[0]!.objects).toEqual([object('a')])
    expect(s.calls).toHaveLength(1)

    s.advance(1) // exactly the time to live
    const later = s.reader.read([cal('a')], RANGE)
    await answer()
    expect((await later)[0]!.objects).toEqual([object('a')])
    expect(s.calls).toHaveLength(2)
  })

  it('starts the time to live when the answer arrives, not when it was asked for', async () => {
    const s = setup({ ttlMs: 30_000 })
    const first = s.reader.read([cal('a')], RANGE)
    await tick()
    s.advance(20_000)
    s.calls[0]!.resolve([object('a')])
    await first
    s.advance(25_000)
    await s.reader.read([cal('a')], RANGE)
    expect(s.calls).toHaveLength(1)
  })

  it('keys by calendar, exact padded range and expand', async () => {
    const s = setup()
    const answer = autoAnswer(s)
    const read = async (calendars: Parameters<typeof s.reader.read>[0], range = RANGE) => {
      const pending = s.reader.read(calendars, range)
      await answer()
      return pending
    }
    await read([cal('a')])
    await read([cal('a')]) // hit
    expect(s.calls).toHaveLength(1)
    await read([cal('b')]) // other calendar
    await read([cal('a', true)]) // same calendar and range, expanded
    await read([cal('a')], { start: RANGE.start, end: new Date(RANGE.end.getTime() + 1) }) // other range
    expect(s.calls).toHaveLength(4)
  })

  it('treats spellings of one calendar url as one calendar', async () => {
    const s = setup()
    const answer = autoAnswer(s)
    const first = s.reader.read([{ url: '/caldav/u/a/', expand: false }], RANGE)
    await answer()
    await first
    await s.reader.read([{ url: 'http://dav.test/caldav/u/a', expand: false }], RANGE)
    expect(s.calls).toHaveLength(1)
  })

  it('does not cache errors', async () => {
    const s = setup()
    const first = s.reader.read([cal('a')], RANGE)
    await tick()
    s.calls[0]!.reject(new DavError('unavailable', 'down', { status: 503 }))
    expect((await first)[0]!.error?.kind).toBe('unavailable')
    const second = s.reader.read([cal('a')], RANGE)
    await tick()
    expect(s.calls).toHaveLength(2)
    s.calls[1]!.resolve([object('a')])
    expect((await second)[0]!.objects).toEqual([object('a')])
  })

  it('hands out copies, so a caller cannot change what the next one sees', async () => {
    const s = setup()
    const answer = autoAnswer(s)
    const first = s.reader.read([cal('a')], RANGE)
    await answer()
    const a = (await first)[0]!.objects!
    a.push(object('junk'))
    const b = (await s.reader.read([cal('a')], RANGE))[0]!.objects!
    expect(b).toEqual([object('a')])
  })

  it('drops entries that have expired when it stores a new one', async () => {
    const s = setup({ ttlMs: 1_000 })
    const answer = autoAnswer(s)
    for (const name of ['a', 'b', 'c']) {
      const reading = s.reader.read([cal(name)], RANGE)
      await answer()
      await reading
      s.advance(2_000)
    }
    // All three expired; a read of the first one fetches again.
    const again = s.reader.read([cal('a')], RANGE)
    await answer()
    await again
    expect(s.calls).toHaveLength(4)
  })
})

describe('sharing a running request', () => {
  it('asks once when two reads want the same calendar and range at the same time', async () => {
    const s = setup()
    const one = s.reader.read([cal('a')], RANGE)
    const two = s.reader.read([cal('a'), cal('a')], RANGE)
    await tick()
    expect(s.calls).toHaveLength(1)
    s.calls[0]!.resolve([object('a')])
    const results = [...(await one), ...(await two)]
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.objects?.[0]?.url === '/c/a.ics')).toBe(true)
    expect(new Set(results.map((r) => r.objects)).size).toBe(3)
  })

  it('shares an error the same way', async () => {
    const s = setup()
    const one = s.reader.read([cal('a')], RANGE)
    const two = s.reader.read([cal('a')], RANGE)
    await tick()
    s.calls[0]!.reject(new DavError('network', 'offline'))
    expect((await one)[0]!.error?.kind).toBe('network')
    expect((await two)[0]!.error?.kind).toBe('network')
  })
})

describe('force', () => {
  it('bypasses the cache and refreshes it', async () => {
    const s = setup()
    const answer = autoAnswer(s)
    const first = s.reader.read([cal('a')], RANGE)
    await answer()
    await first
    const forced = s.reader.read([cal('a')], RANGE, { force: true })
    await tick()
    expect(s.calls).toHaveLength(2)
    s.calls[1]!.resolve([object('fresh')])
    expect((await forced)[0]!.objects).toEqual([object('fresh')])
    expect((await s.reader.read([cal('a')], RANGE))[0]!.objects).toEqual([object('fresh')])
    expect(s.calls).toHaveLength(2)
  })

  it('does not join a request that started before the refresh was asked for', async () => {
    const s = setup()
    const slow = s.reader.read([cal('a')], RANGE)
    await tick()
    const forced = s.reader.read([cal('a')], RANGE, { force: true })
    await tick()
    expect(s.calls).toHaveLength(2)
    s.calls[1]!.resolve([object('new')])
    s.calls[0]!.resolve([object('old')])
    expect((await forced)[0]!.objects).toEqual([object('new')])
    expect((await slow)[0]!.objects).toEqual([object('old')])
    // The slower, older answer does not replace the newer one in the cache.
    expect((await s.reader.read([cal('a')], RANGE))[0]!.objects).toEqual([object('new')])
  })
})

describe('invalidate and clear', () => {
  it('forgets one calendar and keeps the others', async () => {
    const s = setup()
    const answer = autoAnswer(s)
    const first = s.reader.read([cal('a'), cal('b')], RANGE)
    await answer()
    await first
    s.reader.invalidate('/caldav/u/a/')
    const again = s.reader.read([cal('a'), cal('b')], RANGE)
    await answer()
    await again
    expect(s.calls.map((c) => c.url)).toEqual(['/caldav/u/a/', '/caldav/u/b/', '/caldav/u/a/'])
  })

  it('does not keep an answer for a read that started before the invalidation', async () => {
    const s = setup()
    const stale = s.reader.read([cal('a')], RANGE)
    await tick()
    s.reader.invalidate('/caldav/u/a')
    s.calls[0]!.resolve([object('stale')])
    // The caller that asked before the write still gets what it asked for ...
    expect((await stale)[0]!.objects).toEqual([object('stale')])
    // ... but the next read goes to the server.
    const next = s.reader.read([cal('a')], RANGE)
    await tick()
    expect(s.calls).toHaveLength(2)
    s.calls[1]!.resolve([object('fresh')])
    expect((await next)[0]!.objects).toEqual([object('fresh')])
  })

  it('does not let a read after the invalidation join the request that started before it', async () => {
    const s = setup()
    void s.reader.read([cal('a')], RANGE)
    await tick()
    s.reader.invalidate('/caldav/u/a/')
    const after = s.reader.read([cal('a')], RANGE)
    await tick()
    expect(s.calls).toHaveLength(2)
    s.calls[1]!.resolve([object('fresh')])
    expect((await after)[0]!.objects).toEqual([object('fresh')])
  })

  it('clear() forgets everything, running requests included', async () => {
    const s = setup()
    const answer = autoAnswer(s)
    const first = s.reader.read([cal('a')], RANGE)
    await answer()
    await first
    const running = s.reader.read([cal('b')], RANGE)
    await tick()
    s.reader.clear()
    s.calls[1]!.resolve([object('b')])
    await running
    const again = s.reader.read([cal('a'), cal('b')], RANGE)
    await tick()
    expect(s.calls).toHaveLength(4)
    s.calls[2]!.resolve([])
    s.calls[3]!.resolve([])
    await again
  })
})

describe('aborting', () => {
  it('ends the wait with an aborted error and cancels the request', async () => {
    const s = setup()
    const controller = new AbortController()
    const reading = s.reader.read([cal('a')], RANGE, { signal: controller.signal })
    await tick()
    controller.abort()
    const [result] = await reading
    expect(result!.error?.kind).toBe('aborted')
    expect(s.calls[0]!.signal?.aborted).toBe(true)
  })

  it('does not poison the cache', async () => {
    const s = setup()
    const controller = new AbortController()
    const reading = s.reader.read([cal('a')], RANGE, { signal: controller.signal })
    await tick()
    controller.abort()
    await reading
    const next = s.reader.read([cal('a')], RANGE)
    await tick()
    expect(s.calls).toHaveLength(2)
    expect(s.calls[1]!.signal?.aborted).toBe(false)
    s.calls[1]!.resolve([object('a')])
    expect((await next)[0]!.objects).toEqual([object('a')])
  })

  it('sends no request when the signal has already fired', async () => {
    const s = setup()
    const controller = new AbortController()
    controller.abort()
    const [result] = await s.reader.read([cal('a')], RANGE, { signal: controller.signal })
    expect(result!.error?.kind).toBe('aborted')
    expect(s.calls).toHaveLength(0)
  })

  it('keeps a shared request alive for the caller that stays', async () => {
    const s = setup()
    const quitter = new AbortController()
    const one = s.reader.read([cal('a')], RANGE, { signal: quitter.signal })
    const two = s.reader.read([cal('a')], RANGE)
    await tick()
    quitter.abort()
    expect((await one)[0]!.error?.kind).toBe('aborted')
    expect(s.calls[0]!.signal?.aborted).toBe(false)
    s.calls[0]!.resolve([object('a')])
    expect((await two)[0]!.objects).toEqual([object('a')])
  })

  it('cancels a shared request once every caller has left', async () => {
    const s = setup()
    const first = new AbortController()
    const second = new AbortController()
    const one = s.reader.read([cal('a')], RANGE, { signal: first.signal })
    const two = s.reader.read([cal('a')], RANGE, { signal: second.signal })
    await tick()
    first.abort()
    expect(s.calls[0]!.signal?.aborted).toBe(false)
    second.abort()
    expect(s.calls[0]!.signal?.aborted).toBe(true)
    expect((await one)[0]!.error?.kind).toBe('aborted')
    expect((await two)[0]!.error?.kind).toBe('aborted')
  })

  it('aborts one calendar’s wait without touching the other calendars of the read', async () => {
    const s = setup()
    const controller = new AbortController()
    const reading = s.reader.read([cal('a'), cal('b')], RANGE, { signal: controller.signal })
    await tick()
    s.calls[1]!.resolve([object('b')])
    await tick()
    controller.abort()
    const results = await reading
    // b had already arrived; a was cut off.
    expect(results[0]!.error?.kind).toBe('aborted')
    expect(results[1]!.objects).toEqual([object('b')])
  })
})

describe('concurrency', () => {
  it('runs at most `concurrency` requests at a time, across reads', async () => {
    const s = setup({ concurrency: 3 })
    const names = Array.from({ length: 10 }, (_, i) => `c${i}`)
    const one = s.reader.read(
      names.slice(0, 6).map((n) => cal(n)),
      RANGE,
    )
    const two = s.reader.read(
      names.slice(6).map((n) => cal(n)),
      RANGE,
    )
    await tick()
    expect(s.calls).toHaveLength(3)
    expect(s.running()).toBe(3)

    let finished = 0
    while (finished < 10) {
      s.calls[finished]!.resolve([object(`c${finished}`)])
      finished++
      await tick()
      expect(s.running()).toBeLessThanOrEqual(3)
    }
    expect(s.peak()).toBe(3)
    expect((await one).every((r) => r.objects)).toBe(true)
    expect((await two).every((r) => r.objects)).toBe(true)
  })

  it('defaults to six', async () => {
    const s = setup()
    void s.reader.read(
      Array.from({ length: 20 }, (_, i) => cal(`c${i}`)),
      RANGE,
    )
    await tick()
    expect(s.running()).toBe(6)
  })

  it('never sends a request for a read that gave up while it was queued', async () => {
    const s = setup({ concurrency: 1 })
    const waiting = new AbortController()
    void s.reader.read([cal('first')], RANGE)
    const queued = s.reader.read([cal('queued')], RANGE, { signal: waiting.signal })
    const other = s.reader.read([cal('other')], RANGE)
    await tick()
    expect(s.calls.map((c) => c.url)).toEqual(['/caldav/u/first/'])
    waiting.abort()
    expect((await queued)[0]!.error?.kind).toBe('aborted')
    s.calls[0]!.resolve([])
    await tick()
    expect(s.calls.map((c) => c.url)).toEqual(['/caldav/u/first/', '/caldav/u/other/'])
    s.calls[1]!.resolve([])
    await other
  })

  it('frees the slot when a request fails', async () => {
    const s = setup({ concurrency: 1 })
    const reading = s.reader.read([cal('a'), cal('b')], RANGE)
    await tick()
    s.calls[0]!.reject(new DavError('network', 'offline'))
    await tick()
    expect(s.calls).toHaveLength(2)
    s.calls[1]!.resolve([])
    expect((await reading).map((r) => r.error?.kind)).toEqual(['network', undefined])
  })
})

describe('createFlights', () => {
  it('runs one request per key and hands everyone the result', async () => {
    const flights = createFlights<number>()
    let runs = 0
    const start = async () => {
      runs++
      await tick()
      return 7
    }
    const results = await Promise.all([
      flights.join('k', start),
      flights.join('k', start),
      flights.join('other', start),
    ])
    expect(results).toEqual([7, 7, 7])
    expect(runs).toBe(2)
    await flights.join('k', start)
    expect(runs).toBe(3)
  })

  it('turns a start that throws into a rejection and does not keep it', async () => {
    const flights = createFlights<number>()
    const boom = () => {
      throw new Error('sync')
    }
    await expect(flights.join('k', boom)).rejects.toThrow('sync')
    await expect(flights.join('k', async () => 1)).resolves.toBe(1)
  })
})

describe('createLimiter', () => {
  it.each([[0], [-1], [1.5], [NaN]])('refuses a limit of %s', (limit) => {
    expect(() => createLimiter(limit)).toThrow(RangeError)
  })

  it('runs tasks in order of arrival and returns their results', async () => {
    const limiter = createLimiter(1)
    const order: number[] = []
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        limiter.run(async () => {
          order.push(n)
          await tick()
          return n * 2
        }),
      ),
    )
    expect(results).toEqual([2, 4, 6])
    expect(order).toEqual([1, 2, 3])
  })

  it('releases the slot when a task throws', async () => {
    const limiter = createLimiter(1)
    await expect(
      limiter.run(async () => {
        throw new Error('x')
      }),
    ).rejects.toThrow('x')
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok')
  })
})

describe('busy times', () => {
  const FREE_BUSY = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VFREEBUSY',
    'FREEBUSY;FBTYPE=BUSY:20261105T090000Z/20261105T100000Z',
    'END:VFREEBUSY',
    'END:VCALENDAR',
  ].join('\r\n')

  function busyClient() {
    const calls: string[] = []
    const client = {
      fetchObjects: async (url: string) => {
        calls.push(`objects ${url}`)
        return [object('x')]
      },
      fetchFreeBusy: async (url: string, range: DavRange) => {
        calls.push(`free-busy ${url} ${range.start.toISOString()}`)
        if (url.includes('refused')) throw new DavError('forbidden', 'no', { status: 403 })
        return FREE_BUSY
      },
    }
    return { calls, reader: createCalendarReader(client, { now: () => 1 }) }
  }

  it('reads a free/busy share with a free-busy query, padded and kept apart from its objects', async () => {
    const { calls, reader } = busyClient()
    const busy = { url: '/caldav/u/f/', expand: true, freeBusy: true }
    expect(await reader.read([busy], RANGE)).toEqual([
      { calendarUrl: '/caldav/u/f/', freeBusy: FREE_BUSY },
    ])
    // the second read comes from memory
    await reader.read([busy], RANGE)
    expect(calls).toEqual(['free-busy /caldav/u/f/ 2026-10-31T00:00:00.000Z'])
    // the objects of the same calendar are another answer
    await reader.read([{ url: '/caldav/u/f/', expand: true }], RANGE)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe('objects /caldav/u/f/')
  })

  it('gives a refused query to its own calendar only', async () => {
    const { reader } = busyClient()
    const [refused, fine] = await reader.read(
      [
        { url: '/caldav/u/refused/', expand: true, freeBusy: true },
        { url: '/caldav/u/f/', expand: true, freeBusy: true },
      ],
      RANGE,
    )
    expect(refused!.error?.kind).toBe('forbidden')
    expect(fine!.freeBusy).toBe(FREE_BUSY)
  })
})
