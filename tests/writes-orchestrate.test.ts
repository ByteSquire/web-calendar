// @vitest-environment node
// Create, edit and delete through the orchestration (app/utils/writes/orchestrate.ts) with a fake
// collection and the real iCalendar writer: which requests go out, in which order, with which
// conditions, and what the caller is told when one of them fails.
import { describe, expect, it } from 'vitest'
import { createEventResource, type NewEventInput, type WriteContext } from '../app/utils/ical/write'
import {
  createEvent,
  deleteEvent,
  editEvent,
  editScopeFor,
  resourceUrl,
} from '../app/utils/writes/orchestrate'
import type { EventTarget, ScopeChoice, WriteFailure } from '../app/utils/writes/types'
import {
  BERLIN_VTIMEZONE,
  contentLines,
  instants,
  masterLines,
  splitEvents,
  wrapCalendar,
} from './ical-write-helpers'
import { CALENDAR, FakeCalendarServer, makeEnv, NOW } from './writes-helpers'

const BERLIN: WriteContext = {
  displayTimeZone: 'Europe/Berlin',
  orgTimeZone: 'Europe/Berlin',
  now: NOW,
}
const when = (start: string, end: string, allDay = false) => ({ start, end, allDay })

// Mondays at 09:00 Berlin across the change to winter time on 25 October: six occurrences.
const WEEKLY_INPUT: NewEventInput = {
  title: 'Weekly',
  when: when('2026-10-12T09:00', '2026-10-12T10:00'),
  description: 'Agenda',
  location: 'Room 1',
  recurrence: { freq: 'WEEKLY', byDay: ['MO'], count: 6 },
}
const OCCURRENCE = {
  first: '2026-10-12T07:00:00Z',
  third: '2026-10-26T08:00:00Z',
  fourth: '2026-11-02T08:00:00Z',
  last: '2026-11-16T08:00:00Z',
}

// "The last weekday of the month": a rule that does not follow DTSTART, with a moved occurrence.
const LAST_WEEKDAY = wrapCalendar(
  [
    'BEGIN:VEVENT',
    'UID:lastday@example.com',
    'DTSTAMP:20260901T080000Z',
    'SUMMARY:Last weekday',
    'DTSTART;TZID=Europe/Berlin:20260831T170000',
    'DTEND;TZID=Europe/Berlin:20260831T180000',
    'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=6',
    'EXDATE;TZID=Europe/Berlin:20261130T170000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:lastday@example.com',
    'DTSTAMP:20260901T080000Z',
    'SUMMARY:Last weekday (early)',
    'RECURRENCE-ID;TZID=Europe/Berlin:20260930T170000',
    'DTSTART;TZID=Europe/Berlin:20260930T130000',
    'DTEND;TZID=Europe/Berlin:20260930T140000',
    'END:VEVENT',
  ],
  BERLIN_VTIMEZONE,
)

function seedEvent(server: FakeCalendarServer, input: NewEventInput = WEEKLY_INPUT) {
  const resource = createEventResource(input, BERLIN)
  const href = `${CALENDAR}${resource.uid}.ics`
  server.seed(href, resource.ics)
  return { href, uid: resource.uid, ics: resource.ics }
}

const target = (href: string, extra: Partial<EventTarget> = {}): EventTarget => ({
  href,
  calendarHref: CALENDAR,
  recurring: false,
  ...extra,
})
const recurringTarget = (href: string, recurrenceId: string): EventTarget =>
  target(href, { recurring: true, recurrenceId })

function failureOf(outcome: { ok: boolean; failure?: WriteFailure }): WriteFailure {
  expect(outcome.ok).toBe(false)
  return outcome.failure!
}

describe('resourceUrl and editScopeFor', () => {
  it('names the resource after the UID and adds the slash of the collection', () => {
    expect(resourceUrl('/caldav/a/b/', 'u-1')).toBe('/caldav/a/b/u-1.ics')
    expect(resourceUrl('/caldav/a/b', 'u-1')).toBe('/caldav/a/b/u-1.ics')
    expect(resourceUrl('/caldav/a/b/', 'a b/c')).toBe('/caldav/a/b/a%20b%2Fc.ics')
  })

  it('has no choice for a single event', () => {
    expect(editScopeFor(target('/x.ics'), null)).toEqual({ kind: 'series' })
    expect(editScopeFor(target('/x.ics'), 'this')).toEqual({ kind: 'series' })
  })

  it.each<[ScopeChoice, object]>([
    ['this', { kind: 'instance', recurrenceId: OCCURRENCE.third }],
    ['following', { kind: 'thisAndFollowing', recurrenceId: OCCURRENCE.third }],
    ['all', { kind: 'series', recurrenceId: OCCURRENCE.third }],
  ])('maps "%s" of a recurring event to the writer scope', (choice, expected) => {
    expect(editScopeFor(recurringTarget('/x.ics', OCCURRENCE.third), choice)).toEqual(expected)
  })

  it('lets "all events" go without an occurrence but not the other two', () => {
    const noId = target('/x.ics', { recurring: true })
    expect(editScopeFor(noId, 'all')).toEqual({ kind: 'series' })
    expect(() => editScopeFor(noId, 'this')).toThrow(/occurrence/)
    expect(() => editScopeFor(noId, 'following')).toThrow(/occurrence/)
  })
})

describe('createEvent', () => {
  const input: NewEventInput = {
    title: 'Lunch',
    when: when('2026-11-05T12:00', '2026-11-05T13:00'),
    description: 'Pasta',
    recurrence: { freq: 'DAILY', count: 3 },
  }

  it('writes a new resource named after its UID, then drops the cache and reloads', async () => {
    const server = new FakeCalendarServer()
    const env = makeEnv(server)
    const outcome = await createEvent(env.deps, { calendarHref: CALENDAR, input })
    expect(outcome).toMatchObject({ ok: true })
    if (!outcome.ok) return

    expect(outcome.url).toBe(`${CALENDAR}${outcome.uid}.ics`)
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]).toMatchObject({ method: 'PUT', url: outcome.url, create: true })
    expect(server.calls[0]!.etag).toBeUndefined()
    const lines = contentLines(server.dataOf(outcome.url))
    expect(lines).toContain(`UID:${outcome.uid}`)
    expect(lines).toContain('SUMMARY:Lunch')
    expect(lines).toContain('DTSTART;TZID=Europe/Berlin:20261105T120000')
    expect(lines).toContain('RRULE:FREQ=DAILY;COUNT=3')
    expect(instants(server.dataOf(outcome.url))).toHaveLength(3)
    expect(env.invalidated).toEqual([CALENDAR])
    expect(env.refreshes()).toBe(1)
  })

  it('accepts a collection URL without the trailing slash', async () => {
    const server = new FakeCalendarServer()
    const outcome = await createEvent(makeEnv(server).deps, {
      calendarHref: '/caldav/alice/work',
      input,
    })
    expect(outcome.ok && outcome.url.startsWith('/caldav/alice/work/')).toBe(true)
  })

  it('tries once more with a fresh UID when the name is taken', async () => {
    const server = new FakeCalendarServer()
    server.failNext('PUT', 'exists')
    const env = makeEnv(server)
    const outcome = await createEvent(env.deps, { calendarHref: CALENDAR, input })
    expect(outcome.ok).toBe(true)
    const [first, second] = server.callsOf('PUT')
    expect(server.callsOf('PUT')).toHaveLength(2)
    expect(first!.url).not.toBe(second!.url)
    // The second resource has its own UID, not the one of the first attempt.
    const uidOf = (call: { data?: string }) =>
      contentLines(call.data!).find((l) => l.startsWith('UID:'))
    expect(uidOf(first!)).not.toBe(uidOf(second!))
    expect(server.resources.size).toBe(1)
    expect(env.refreshes()).toBe(1)
  })

  it('gives up when the second name is taken as well', async () => {
    const server = new FakeCalendarServer()
    server.failNext('PUT', 'exists')
    server.failNext('PUT', 'exists')
    const env = makeEnv(server)
    const failure = failureOf(await createEvent(env.deps, { calendarHref: CALENDAR, input }))
    expect(failure.kind).toBe('exists')
    expect(server.callsOf('PUT')).toHaveLength(2)
    expect(env.refreshes()).toBe(0)
  })

  it.each([
    ['forbidden', "You can't write to this calendar."],
    ['unauthorized', 'Your sign-in expired. Sign in again.'],
    ['network', 'The calendar service is not reachable. Check your connection and try again.'],
  ] as const)('reports a %s failure in words and leaves the cache alone', async (kind, message) => {
    const server = new FakeCalendarServer()
    server.failNext('PUT', kind)
    const env = makeEnv(server)
    const failure = failureOf(await createEvent(env.deps, { calendarHref: CALENDAR, input }))
    expect(failure).toMatchObject({ kind, message, reload: false, closeForm: false })
    expect(env.invalidated).toEqual([])
    expect(env.refreshes()).toBe(0)
  })

  it('refuses input the writer rejects, without a request', async () => {
    const server = new FakeCalendarServer()
    const bad = { ...input, when: when('2026-11-05T14:00', '2026-11-05T13:00') }
    const failure = failureOf(
      await createEvent(makeEnv(server).deps, { calendarHref: CALENDAR, input: bad }),
    )
    expect(failure.kind).toBe('invalid-input')
    expect(failure.message).toMatch(/ends before it starts/)
    expect(server.calls).toEqual([])
  })

  it('still succeeds when the reload afterwards fails', async () => {
    const server = new FakeCalendarServer()
    const env = makeEnv(server, {
      refresh: async () => {
        throw new Error('offline')
      },
    })
    const outcome = await createEvent(env.deps, { calendarHref: CALENDAR, input })
    expect(outcome.ok).toBe(true)
    expect(env.invalidated).toEqual([CALENDAR])
  })
})

describe('editEvent: single events', () => {
  const single: NewEventInput = {
    title: 'Dentist',
    when: when('2026-11-05T09:00', '2026-11-05T10:00'),
  }

  it('fetches the current copy and writes it back with that copy ETag', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, single)
    // The state still holds an older tag; someone saved since. The write must use the fresh one.
    const fresh = server.touch(href)
    const env = makeEnv(server)
    const outcome = await editEvent(env.deps, {
      target: target(href),
      scope: null,
      changes: { title: 'Dentist (moved)', when: when('2026-11-05T11:00', '2026-11-05T12:00') },
    })
    expect(outcome).toEqual({ ok: true, unchanged: false, split: false })
    expect(server.calls.map((call) => call.method)).toEqual(['GET', 'PUT'])
    expect(server.calls[1]).toMatchObject({ url: href, etag: fresh })
    expect(server.calls[1]!.create).toBeUndefined()
    const lines = contentLines(server.dataOf(href))
    expect(lines).toContain('SUMMARY:Dentist (moved)')
    expect(lines).toContain('DTSTART;TZID=Europe/Berlin:20261105T110000')
    expect(env.invalidated).toEqual([CALENDAR])
    expect(env.refreshes()).toBe(1)
  })

  it('sends nothing when nothing changed', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, single)
    const env = makeEnv(server)
    const outcome = await editEvent(env.deps, { target: target(href), scope: null, changes: {} })
    expect(outcome).toEqual({ ok: true, unchanged: true, split: false })
    expect(server.calls).toEqual([])
    expect(env.refreshes()).toBe(0)
  })

  it('skips the PUT when the writer hands the same text back', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, single)
    const env = makeEnv(server)
    const outcome = await editEvent(env.deps, {
      target: target(href),
      scope: null,
      changes: { title: 'Dentist', status: 'confirmed' },
    })
    expect(outcome).toEqual({ ok: true, unchanged: true, split: false })
    expect(server.calls.map((call) => call.method)).toEqual(['GET'])
    expect(env.refreshes()).toBe(0)
  })

  it('reports a change by someone else, reloads and asks to close the form', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, single)
    server.failNext('PUT', 'conflict')
    const env = makeEnv(server)
    const failure = failureOf(
      await editEvent(env.deps, { target: target(href), scope: null, changes: { title: 'New' } }),
    )
    expect(failure).toMatchObject({
      kind: 'conflict',
      message: 'This event was changed by someone else. It has been reloaded — try again.',
      reload: true,
      closeForm: true,
    })
    expect(env.invalidated).toEqual([CALENDAR])
    expect(env.refreshes()).toBe(1)
  })

  it('catches a change between the GET and the PUT through the ETag', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, single)
    // The fake saves a competing copy as soon as the GET is answered.
    const original = server.client.getObject
    server.client.getObject = async (url) => {
      const object = await original(url)
      server.touch(url)
      return object
    }
    const failure = failureOf(
      await editEvent(makeEnv(server).deps, {
        target: target(href),
        scope: null,
        changes: { title: 'New' },
      }),
    )
    expect(failure.kind).toBe('conflict')
    expect(contentLines(server.dataOf(href))).toContain('SUMMARY:Dentist')
  })

  it('says the event is gone when the GET finds nothing', async () => {
    const server = new FakeCalendarServer()
    const env = makeEnv(server)
    const failure = failureOf(
      await editEvent(env.deps, {
        target: target(`${CALENDAR}gone.ics`),
        scope: null,
        changes: { title: 'New' },
      }),
    )
    expect(failure).toMatchObject({ kind: 'not-found', reload: true, closeForm: true })
    expect(failure.message).toMatch(/no longer exists/)
    expect(env.refreshes()).toBe(1)
    expect(server.callsOf('PUT')).toEqual([])
  })

  it('keeps the form open for a failure the person can retry', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, single)
    server.failNext('PUT', 'unavailable')
    const failure = failureOf(
      await editEvent(makeEnv(server).deps, {
        target: target(href),
        scope: null,
        changes: { title: 'New' },
      }),
    )
    expect(failure).toMatchObject({ kind: 'unavailable', reload: false, closeForm: false })
  })

  it('refuses invalid changes from the writer without a PUT', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, single)
    const failure = failureOf(
      await editEvent(makeEnv(server).deps, {
        target: target(href),
        scope: null,
        changes: { title: '   ' },
      }),
    )
    expect(failure.kind).toBe('invalid-input')
    expect(server.callsOf('PUT')).toEqual([])
  })

  it('explains an event that is not iCalendar this app can read', async () => {
    const server = new FakeCalendarServer()
    const href = `${CALENDAR}junk.ics`
    server.seed(href, 'this is not a calendar')
    const failure = failureOf(
      await editEvent(makeEnv(server).deps, {
        target: target(href),
        scope: null,
        changes: { title: 'New' },
      }),
    )
    expect(failure.kind).toBe('unparseable')
  })
})

describe('editEvent: recurring events', () => {
  it('"This event" writes one override and leaves the rest of the series alone', async () => {
    const server = new FakeCalendarServer()
    const { href, ics } = seedEvent(server)
    const env = makeEnv(server)
    const outcome = await editEvent(env.deps, {
      target: recurringTarget(href, OCCURRENCE.third),
      scope: 'this',
      changes: { title: 'Weekly (special)', when: when('2026-10-26T14:00', '2026-10-26T15:00') },
    })
    expect(outcome).toEqual({ ok: true, unchanged: false, split: false })
    expect(server.callsOf('PUT')).toHaveLength(1)
    expect(server.calls.map((call) => call.method)).toEqual(['GET', 'PUT'])
    const [master, override] = splitEvents(server.dataOf(href))
    expect(master).toContain('SUMMARY:Weekly')
    expect(override).toContain('SUMMARY:Weekly (special)')
    expect(override).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000')
    const before = instants(ics)
    const after = instants(server.dataOf(href))
    expect(after).toHaveLength(6)
    expect(after.filter((instant) => !before.includes(instant))).toEqual([
      '2026-10-26T13:00:00.000Z',
    ])
  })

  it('"All events" from a later occurrence moves the whole series by the same amount', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server)
    const outcome = await editEvent(makeEnv(server).deps, {
      // Opened from the fourth Monday (08:00 UTC = 09:00 Berlin): one hour later for all.
      target: recurringTarget(href, OCCURRENCE.fourth),
      scope: 'all',
      changes: { when: when('2026-11-02T10:00', '2026-11-02T11:00') },
    })
    expect(outcome.ok).toBe(true)
    expect(server.callsOf('PUT')).toHaveLength(1)
    expect(instants(server.dataOf(href))).toEqual([
      '2026-10-12T08:00:00.000Z',
      '2026-10-19T08:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
      '2026-11-09T09:00:00.000Z',
      '2026-11-16T09:00:00.000Z',
    ])
    expect(contentLines(server.dataOf(href))).toContain(
      'DTSTART;TZID=Europe/Berlin:20261012T100000',
    )
  })

  it('"This and following" writes the new series first, then shortens the old one', async () => {
    const server = new FakeCalendarServer()
    const { href, uid, ics } = seedEvent(server)
    const env = makeEnv(server)
    const outcome = await editEvent(env.deps, {
      target: recurringTarget(href, OCCURRENCE.fourth),
      scope: 'following',
      changes: { title: 'Weekly (new room)', location: 'Room 2' },
    })
    expect(outcome).toEqual({ ok: true, unchanged: false, split: true })

    expect(server.calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'PUT'])
    const [, created, updated] = server.calls
    // The second half is created (conditionally, under its own name) BEFORE the old one is cut.
    expect(created).toMatchObject({ method: 'PUT', create: true })
    expect(created!.url).not.toBe(href)
    expect(created!.url.startsWith(CALENDAR)).toBe(true)
    expect(created!.etag).toBeUndefined()
    expect(updated).toMatchObject({ method: 'PUT', url: href })
    expect(updated!.etag).toBeDefined()
    expect(updated!.create).toBeUndefined()

    const oldHalf = server.dataOf(href)
    const newHalf = server.dataOf(created!.url)
    expect(
      masterLines(oldHalf).some((line) => line.startsWith('RRULE:') && line.includes('UNTIL=')),
    ).toBe(true)
    expect(contentLines(newHalf)).toContain('SUMMARY:Weekly (new room)')
    expect(contentLines(newHalf)).toContain('LOCATION:Room 2')
    expect(contentLines(newHalf).find((l) => l.startsWith('UID:'))).not.toBe(`UID:${uid}`)
    // Together the two resources still hold the six Mondays.
    expect([...instants(oldHalf), ...instants(newHalf)].sort()).toEqual(instants(ics))
    expect(instants(oldHalf)).toHaveLength(3)
    expect(env.invalidated).toEqual([CALENDAR])
    expect(env.refreshes()).toBe(1)
  })

  it('"This and following" on the first occurrence is the whole series: one PUT', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server)
    const outcome = await editEvent(makeEnv(server).deps, {
      target: recurringTarget(href, OCCURRENCE.first),
      scope: 'following',
      changes: { title: 'Renamed' },
    })
    expect(outcome).toEqual({ ok: true, unchanged: false, split: false })
    expect(server.callsOf('PUT')).toHaveLength(1)
    expect(server.resources.size).toBe(1)
    expect(contentLines(server.dataOf(href))).toContain('SUMMARY:Renamed')
  })

  it('leaves duplicates, and says so, when the old half cannot be updated', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server)
    // The create passes; the update of the old half hits a competing save.
    server.failNext('PUT', 'conflict', 1)
    const env = makeEnv(server)
    const failure = failureOf(
      await editEvent(env.deps, {
        target: recurringTarget(href, OCCURRENCE.fourth),
        scope: 'following',
        changes: { title: 'Renamed' },
      }),
    )
    expect(failure.kind).toBe('partial')
    expect(failure.message).toMatch(/appear twice/)
    expect(failure.message).toMatch(/someone else/)
    expect(failure).toMatchObject({ reload: true, closeForm: true })
    // The new series exists next to the untouched old one: nothing was lost.
    expect(server.resources.size).toBe(2)
    expect(instants(server.dataOf(href))).toHaveLength(6)
    expect(env.invalidated).toEqual([CALENDAR])
    expect(env.refreshes()).toBe(1)
  })

  it('writes nothing else when the new series cannot be created', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server)
    server.failNext('PUT', 'network')
    const env = makeEnv(server)
    const failure = failureOf(
      await editEvent(env.deps, {
        target: recurringTarget(href, OCCURRENCE.fourth),
        scope: 'following',
        changes: { title: 'Renamed' },
      }),
    )
    expect(failure).toMatchObject({ kind: 'network', reload: false })
    expect(server.callsOf('PUT')).toHaveLength(1)
    expect(server.resources.size).toBe(1)
  })

  it('refuses "All events" for a rule that does not follow a move to another day', async () => {
    const server = new FakeCalendarServer()
    const href = `${CALENDAR}lastday.ics`
    server.seed(href, LAST_WEEKDAY)
    const env = makeEnv(server)
    const failure = failureOf(
      await editEvent(env.deps, {
        target: recurringTarget(href, '2026-08-31T15:00:00Z'),
        scope: 'all',
        changes: { when: when('2026-09-01T17:00', '2026-09-01T18:00') },
      }),
    )
    expect(failure.kind).toBe('unsupported')
    expect(failure.message).toMatch(/single occurrences/)
    expect(failure.message).toMatch(/This and following events/)
    expect(server.callsOf('PUT')).toEqual([])
    // Moving only the time of day is fine for the same series.
    const ok = await editEvent(env.deps, {
      target: recurringTarget(href, '2026-08-31T15:00:00Z'),
      scope: 'all',
      changes: { when: when('2026-08-31T18:00', '2026-08-31T19:00') },
    })
    expect(ok.ok).toBe(true)
  })

  it('says so when the occurrence is not part of the series (any more)', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server)
    const env = makeEnv(server)
    const failure = failureOf(
      await editEvent(env.deps, {
        target: recurringTarget(href, '2026-10-13T07:00:00Z'),
        scope: 'this',
        changes: { title: 'x' },
      }),
    )
    expect(failure).toMatchObject({ kind: 'unknown-instance', reload: true, closeForm: true })
    expect(env.refreshes()).toBe(1)
  })

  it('does not guess the occurrence of an event that does not name it', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server)
    const failure = failureOf(
      await editEvent(makeEnv(server).deps, {
        target: target(href, { recurring: true }),
        scope: 'this',
        changes: { title: 'x' },
      }),
    )
    expect(failure.kind).toBe('unknown-instance')
    expect(server.calls).toEqual([])
  })
})

describe('deleteEvent', () => {
  it('deletes a single event with the ETag of the fetched copy', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, {
      title: 'Dentist',
      when: when('2026-11-05T09:00', '2026-11-05T10:00'),
    })
    const fresh = server.touch(href)
    const env = makeEnv(server)
    const outcome = await deleteEvent(env.deps, { target: target(href), scope: null })
    expect(outcome).toEqual({ ok: true, alreadyGone: false })
    expect(server.calls).toEqual([
      { method: 'GET', url: href },
      { method: 'DELETE', url: href, etag: fresh },
    ])
    expect(server.resources.size).toBe(0)
    expect(env.invalidated).toEqual([CALENDAR])
    expect(env.refreshes()).toBe(1)
  })

  it('"This event" of a series writes an exclusion instead of deleting the resource', async () => {
    const server = new FakeCalendarServer()
    const { href, ics } = seedEvent(server)
    const outcome = await deleteEvent(makeEnv(server).deps, {
      target: recurringTarget(href, OCCURRENCE.third),
      scope: 'this',
    })
    expect(outcome).toEqual({ ok: true, alreadyGone: false })
    expect(server.callsOf('DELETE')).toEqual([])
    expect(server.callsOf('PUT')).toHaveLength(1)
    expect(server.callsOf('PUT')[0]!.etag).toBeDefined()
    expect(instants(server.dataOf(href))).toEqual(
      instants(ics).filter((instant) => instant !== '2026-10-26T08:00:00.000Z'),
    )
  })

  it('"This and following" cuts the series; at the first occurrence the resource goes', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server)
    await deleteEvent(makeEnv(server).deps, {
      target: recurringTarget(href, OCCURRENCE.fourth),
      scope: 'following',
    })
    expect(server.callsOf('DELETE')).toEqual([])
    expect(instants(server.dataOf(href))).toHaveLength(3)

    server.calls.length = 0
    const outcome = await deleteEvent(makeEnv(server).deps, {
      target: recurringTarget(href, OCCURRENCE.first),
      scope: 'following',
    })
    expect(outcome.ok).toBe(true)
    expect(server.callsOf('PUT')).toEqual([])
    expect(server.callsOf('DELETE')).toHaveLength(1)
    expect(server.resources.size).toBe(0)
  })

  it('"All events" deletes the resource', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server)
    const outcome = await deleteEvent(makeEnv(server).deps, {
      target: recurringTarget(href, OCCURRENCE.third),
      scope: 'all',
    })
    expect(outcome.ok).toBe(true)
    expect(server.callsOf('DELETE')).toHaveLength(1)
    expect(server.resources.size).toBe(0)
  })

  it('deletes the resource when the last occurrence goes', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, {
      title: 'Twice',
      when: when('2026-11-05T09:00', '2026-11-05T10:00'),
      recurrence: { freq: 'DAILY', count: 2 },
    })
    const first = await deleteEvent(makeEnv(server).deps, {
      target: recurringTarget(href, '2026-11-05T08:00:00Z'),
      scope: 'this',
    })
    expect(first.ok).toBe(true)
    expect(server.callsOf('DELETE')).toEqual([])
    expect(server.resources.size).toBe(1)

    const last = await deleteEvent(makeEnv(server).deps, {
      target: recurringTarget(href, '2026-11-06T08:00:00Z'),
      scope: 'this',
    })
    expect(last.ok).toBe(true)
    expect(server.callsOf('DELETE')).toHaveLength(1)
    expect(server.resources.size).toBe(0)
  })

  it.each([
    ['the GET', 'GET'],
    ['the DELETE', 'DELETE'],
  ] as const)('counts an event that is already gone at %s as deleted', async (_name, method) => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, {
      title: 'Dentist',
      when: when('2026-11-05T09:00', '2026-11-05T10:00'),
    })
    server.failNext(method, 'not-found')
    const env = makeEnv(server)
    const outcome = await deleteEvent(env.deps, { target: target(href), scope: null })
    expect(outcome).toEqual({ ok: true, alreadyGone: true })
    expect(env.invalidated).toEqual([CALENDAR])
    expect(env.refreshes()).toBe(1)
  })

  it('reports a change by someone else and reloads', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, {
      title: 'Dentist',
      when: when('2026-11-05T09:00', '2026-11-05T10:00'),
    })
    server.failNext('DELETE', 'conflict')
    const env = makeEnv(server)
    const failure = failureOf(await deleteEvent(env.deps, { target: target(href), scope: null }))
    expect(failure).toMatchObject({ kind: 'conflict', reload: true, closeForm: true })
    expect(server.resources.size).toBe(1)
    expect(env.refreshes()).toBe(1)
  })

  it('reports a read-only calendar without reloading', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server, {
      title: 'Dentist',
      when: when('2026-11-05T09:00', '2026-11-05T10:00'),
    })
    server.failNext('DELETE', 'forbidden')
    const env = makeEnv(server)
    const failure = failureOf(await deleteEvent(env.deps, { target: target(href), scope: null }))
    expect(failure).toMatchObject({
      kind: 'forbidden',
      message: "You can't write to this calendar.",
      reload: false,
    })
    expect(env.refreshes()).toBe(0)
  })

  it('reports an occurrence that was deleted already', async () => {
    const server = new FakeCalendarServer()
    const { href } = seedEvent(server)
    const first = await deleteEvent(makeEnv(server).deps, {
      target: recurringTarget(href, OCCURRENCE.third),
      scope: 'this',
    })
    expect(first.ok).toBe(true)
    const env = makeEnv(server)
    const failure = failureOf(
      await deleteEvent(env.deps, {
        target: recurringTarget(href, OCCURRENCE.third),
        scope: 'this',
      }),
    )
    expect(failure).toMatchObject({ kind: 'unknown-instance', reload: true })
    expect(env.refreshes()).toBe(1)
  })
})
