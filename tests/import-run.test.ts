// @vitest-environment node
// FR-7, importing a file: the events are written one request each with `If-None-Match: *`, a few at
// a time. What the calendar already has is "already there", an event the service refuses costs only
// itself, and an answer that holds for all of them (or an outage) stops the run (NFR-4).
import { describe, expect, it } from 'vitest'
import { DavError } from '../app/utils/caldav/errors'
import type { DavCalendar } from '../app/utils/caldav/types'
import type { SplitResource } from '../app/utils/ical/split'
import { CONCURRENCY, MAX_CONSECUTIVE_FAILURES } from '../app/utils/import/limits'
import {
  ALREADY_THERE,
  describeFailure,
  INTERRUPTED,
  NOT_TRIED_CANCELLED,
  NOT_TRIED_STOPPED,
  summarize,
} from '../app/utils/import/messages'
import { resourceHref, resourceName } from '../app/utils/import/naming'
import { runImport, type ImportClient, type ImportReport } from '../app/utils/import/run'

const CALENDAR = '/caldav/alice/work/'

const calendar = (extra: Partial<DavCalendar> = {}): DavCalendar => ({
  url: CALENDAR,
  displayName: 'Work',
  color: null,
  ctag: null,
  components: ['VEVENT'],
  readOnly: false,
  ...extra,
})

const resources = (count: number): SplitResource[] =>
  Array.from({ length: count }, (_, i) => ({
    uid: `uid-${i}`,
    summary: `Event ${i}`,
    ics: `BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n# ${i}\r\n`,
    events: 1,
  }))

const dav = (kind: ConstructorParameters<typeof DavError>[0], status?: number) =>
  new DavError(kind, `${kind} ${status ?? ''}`, status === undefined ? {} : { status })

type Put = Parameters<ImportClient['putObject']>[0]

/** The calendar service: records the writes and answers them with whatever `answer` does. */
class Service {
  puts: Put[] = []
  running = 0
  mostRunning = 0
  listing: DavCalendar[] | Error = [calendar()]
  /** Throw to fail the write number `index` (counting from 0, in the order they arrived). */
  answer: (index: number, put: Put) => void = () => undefined

  client: ImportClient = {
    listCalendars: async () => {
      if (this.listing instanceof Error) throw this.listing
      return this.listing
    },
    putObject: async (put) => {
      const index = this.puts.length
      this.puts.push(put)
      this.running += 1
      this.mostRunning = Math.max(this.mostRunning, this.running)
      try {
        await new Promise((resolve) => setTimeout(resolve, 1))
        if (put.signal?.aborted) throw dav('aborted')
        this.answer(index, put)
        return { url: put.url, etag: '"1"' }
      } finally {
        this.running -= 1
      }
    },
  }
}

const statuses = (report: ImportReport) => report.items.map((item) => item.status)

describe('writing the events', () => {
  it('puts each one to a hashed name in the calendar, never over an existing one', async () => {
    const service = new Service()
    const events = resources(7)
    const report = await runImport(service.client, { calendarHref: CALENDAR, resources: events })

    expect(report).toMatchObject({ created: 7, exists: 0, failed: 0, notDone: 0, stopped: null })
    expect(statuses(report)).toEqual(Array(7).fill('created'))
    expect(service.puts).toHaveLength(7)
    for (const [i, event] of events.entries()) {
      const put = service.puts.find((p) => p.data === event.ics)!
      expect(put.url).toBe(resourceHref(CALENDAR, await resourceName(`uid-${i}`)))
      expect(put.create).toBe(true)
      expect(put.etag).toBeUndefined()
    }
  })

  it('has at most four requests running at a time, and uses them', async () => {
    const service = new Service()
    await runImport(service.client, { calendarHref: CALENDAR, resources: resources(30) })
    expect(CONCURRENCY).toBe(4)
    expect(service.mostRunning).toBe(4)
  })

  it('reports the progress after every event', async () => {
    const progress: number[] = []
    await runImport(new Service().client, {
      calendarHref: CALENDAR,
      resources: resources(9),
      onProgress: (value) => {
        expect(value.total).toBe(9)
        progress.push(value.done)
      },
    })
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('gives a result for every event, in the file’s order, with its cleaned title', async () => {
    const events = resources(3)
    events[1]!.summary = 'Two\r\nlines'
    events[2]!.summary = ''
    const report = await runImport(new Service().client, {
      calendarHref: CALENDAR,
      resources: events,
    })
    expect(report.items.map((item) => [item.uid, item.title])).toEqual([
      ['uid-0', 'Event 0'],
      ['uid-1', 'Two lines'],
      ['uid-2', '(no title)'],
    ])
  })

  it('does nothing for a file without events', async () => {
    const service = new Service()
    const report = await runImport(service.client, { calendarHref: CALENDAR, resources: [] })
    expect(report).toMatchObject({ items: [], created: 0, stopped: null, cancelled: false })
    expect(service.puts).toEqual([])
  })

  it('finds the calendar whether or not its address ends in a slash or is absolute', async () => {
    for (const href of ['/caldav/alice/work', 'http://localhost:3000/caldav/alice/work/']) {
      const service = new Service()
      const report = await runImport(service.client, {
        calendarHref: href,
        resources: resources(1),
      })
      expect(report.created).toBe(1)
    }
  })
})

describe('what the calendar already has', () => {
  it('is "already there" for the same name (412) and for the same UID under another name (409)', async () => {
    const service = new Service()
    service.answer = (index) => {
      if (index === 1) throw dav('exists', 412)
      if (index === 3) throw dav('conflict', 409)
    }
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(5),
    })
    expect(report).toMatchObject({ created: 3, exists: 2, failed: 0, stopped: null })
    expect(report.items.filter((i) => i.status === 'exists').map((i) => i.message)).toEqual([
      ALREADY_THERE,
      ALREADY_THERE,
    ])
  })

  it('is all "already there" when the file is imported again', async () => {
    const service = new Service()
    service.answer = () => {
      throw dav('exists', 412)
    }
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(12),
    })
    expect(report).toMatchObject({ created: 0, exists: 12, failed: 0, stopped: null })
    expect(summarize(report)).toBe('Nothing was imported. 12 events were already in the calendar.')
  })

  it('is no service-side overwrite: every write is a create', async () => {
    const service = new Service()
    await runImport(service.client, { calendarHref: CALENDAR, resources: resources(6) })
    expect(service.puts.every((put) => put.create === true && put.etag === undefined)).toBe(true)
  })
})

describe('an event the service does not take', () => {
  it('costs only itself, with the reason in words', async () => {
    const service = new Service()
    service.answer = (index) => {
      if (index === 0) throw dav('rejected', 413)
      if (index === 1) throw dav('rejected', 400)
    }
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(6),
    })
    expect(report).toMatchObject({ created: 4, failed: 2, stopped: null })
    expect(
      report.items
        .filter((i) => i.status === 'failed')
        .map((i) => i.message)
        .sort(),
    ).toEqual([
      'The calendar service did not accept this event.',
      'Too large for the calendar service.',
    ])
  })

  it('does not stop the run, however many are refused in a row', async () => {
    const service = new Service()
    service.answer = () => {
      throw dav('rejected', 400)
    }
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(40),
    })
    expect(report).toMatchObject({ failed: 40, notDone: 0, stopped: null })
    expect(service.puts).toHaveLength(40)
  })
})

describe('an answer that holds for every event', () => {
  it.each([
    ['unauthorized', 'Your sign-in expired. Sign in again.'],
    ['forbidden', "You can't write to this calendar."],
    ['not-found', 'This calendar no longer exists. Reload the page and choose another calendar.'],
  ] as const)('stops the run: %s', async (kind, message) => {
    const service = new Service()
    service.answer = () => {
      throw dav(kind, 401)
    }
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(40),
    })
    expect(report.stopped).toBe(message)
    // The ones running when the first answer came; nothing starts after it.
    expect(service.puts.length).toBeLessThanOrEqual(CONCURRENCY)
    expect(report.failed + report.notDone).toBe(40)
    expect(report.notDone).toBeGreaterThanOrEqual(40 - CONCURRENCY)
    expect(report.items.find((i) => i.status === 'not-done')?.message).toBe(NOT_TRIED_STOPPED)
    expect(report.cancelled).toBe(false)
  })

  it('stops when the service cannot be reached several times in a row', async () => {
    const service = new Service()
    service.answer = () => {
      throw dav('network')
    }
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(40),
    })
    expect(report.stopped).toBe(
      `Stopped after ${MAX_CONSECUTIVE_FAILURES} failures in a row. The calendar service is not reachable.`,
    )
    expect(service.puts.length).toBeLessThan(MAX_CONSECUTIVE_FAILURES + CONCURRENCY)
    expect(report.notDone).toBeGreaterThan(20)
  })

  it('goes on when the failures are scattered between answers that worked', async () => {
    const service = new Service()
    service.answer = (index) => {
      if (index % 2 === 0) throw dav('unavailable', 503)
    }
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(40),
    })
    expect(report).toMatchObject({ created: 20, failed: 20, notDone: 0, stopped: null })
  })

  it('counts an unexpected error like an outage, since the next event will meet it too', async () => {
    const service = new Service()
    service.answer = () => {
      throw new TypeError('crypto.subtle is undefined')
    }
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(40),
    })
    expect(report.stopped).toContain('Something went wrong while saving this event.')
    expect(report.items.find((i) => i.status === 'failed')?.message).toBe(
      'Something went wrong while saving this event.',
    )
  })
})

describe('the calendar', () => {
  it('must still be there: nothing is written to one that was deleted (a 409 would look like "already there")', async () => {
    const service = new Service()
    service.listing = [calendar({ url: '/caldav/alice/other/' })]
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(5),
    })
    expect(service.puts).toEqual([])
    expect(report.stopped).toBe(
      'This calendar no longer exists. Reload the page and choose another calendar.',
    )
    expect(report).toMatchObject({ created: 0, notDone: 5 })
  })

  it('must still be writable', async () => {
    const service = new Service()
    service.listing = [calendar({ readOnly: true })]
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(5),
    })
    expect(service.puts).toEqual([])
    expect(report.stopped).toBe("You can't write to this calendar.")
  })

  it('is looked up with the words of the failure when the service cannot say', async () => {
    const service = new Service()
    service.listing = dav('network')
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(5),
    })
    expect(service.puts).toEqual([])
    expect(report.stopped).toBe('The calendar service is not reachable.')
  })
})

describe('cancelling', () => {
  it('stops the requests, keeps what was written and says the rest was not imported', async () => {
    const service = new Service()
    const controller = new AbortController()
    service.answer = (index) => {
      if (index === 5) controller.abort()
    }
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(60),
      signal: controller.signal,
    })
    expect(report.cancelled).toBe(true)
    expect(report.stopped).toBeNull()
    expect(report.created).toBeGreaterThanOrEqual(5)
    expect(report.created + report.notDone + report.interrupted).toBe(60)
    expect(report.notDone).toBeGreaterThan(40)
    expect(service.puts.length).toBeLessThan(5 + 1 + CONCURRENCY)
    expect(report.items.find((i) => i.status === 'not-done')?.message).toBe(NOT_TRIED_CANCELLED)
    expect(summarize(report)).toMatch(
      /^Imported \d+ events\. \d+ events were not imported because the import was cancelled\.( \d+ events? (was|were) being sent when the import was cancelled and may have been saved\.)?$/,
    )
  })

  it('does not say an event that was being sent was not imported: it may have been saved', async () => {
    const service = new Service()
    const controller = new AbortController()
    // Four are sent at once; the first answer cancels, the other three are cut off.
    service.answer = (index) => {
      if (index === 0) controller.abort()
    }
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(4),
      signal: controller.signal,
    })
    expect(report).toMatchObject({ created: 1, interrupted: 3, notDone: 0, failed: 0 })
    expect(report.items.filter((i) => i.status === 'interrupted').map((i) => i.message)).toEqual(
      Array(3).fill(INTERRUPTED),
    )
    expect(summarize(report)).toBe(
      'Imported 1 event. 3 events were being sent when the import was cancelled and may have been saved.',
    )
  })

  it('writes nothing when it is cancelled before it starts', async () => {
    const service = new Service()
    const controller = new AbortController()
    controller.abort()
    const report = await runImport(service.client, {
      calendarHref: CALENDAR,
      resources: resources(5),
      signal: controller.signal,
    })
    expect(service.puts).toEqual([])
    expect(report).toMatchObject({ cancelled: true, notDone: 5, stopped: null })
  })
})

describe('describeFailure', () => {
  it.each([
    ['exists', undefined, 'exists'],
    ['conflict', 409, 'exists'],
    ['conflict', 412, 'failed'],
    ['aborted', undefined, 'interrupted'],
    ['unauthorized', 401, 'failed'],
    ['forbidden', 403, 'failed'],
    ['not-found', 404, 'failed'],
    ['rejected', 413, 'failed'],
    ['rejected', 400, 'failed'],
    ['unavailable', 503, 'failed'],
    ['network', undefined, 'failed'],
    ['bad-response', undefined, 'failed'],
  ] as const)('%s (%s) is %s', (kind, status, expected) => {
    expect(describeFailure(dav(kind, status)).status).toBe(expected)
  })

  it('has a sentence for every kind, and only the ones that hold for all events stop the run', () => {
    const kinds = [
      'unauthorized',
      'forbidden',
      'not-found',
      'conflict',
      'exists',
      'unavailable',
      'network',
      'aborted',
      'bad-response',
      'rejected',
    ] as const
    const stops = kinds.filter((kind) => describeFailure(dav(kind)).stops)
    expect(stops).toEqual(['unauthorized', 'forbidden', 'not-found'])
    for (const kind of kinds) expect(describeFailure(dav(kind)).message).toMatch(/^[A-Z].*[.]$/)
  })
})

describe('summarize', () => {
  const report = (extra: Partial<ImportReport>): ImportReport => ({
    items: [],
    created: 0,
    exists: 0,
    failed: 0,
    notDone: 0,
    interrupted: 0,
    cancelled: false,
    stopped: null,
    ...extra,
  })

  it('counts what happened, in sentences', () => {
    expect(summarize(report({ created: 1 }))).toBe('Imported 1 event.')
    expect(summarize(report({ created: 12, exists: 1, failed: 2 }))).toBe(
      'Imported 12 events. 1 event was already in the calendar. 2 events could not be imported.',
    )
    expect(summarize(report({ created: 3, notDone: 1, stopped: 'x' }))).toBe(
      'Imported 3 events. 1 event was not imported because the import stopped.',
    )
    expect(summarize(report({}))).toBe('Nothing was imported.')
  })
})
