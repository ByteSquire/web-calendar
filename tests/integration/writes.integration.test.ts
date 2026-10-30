// @vitest-environment node
//
// The write orchestration (app/utils/writes) through the gateway to the real Radicale, with the
// real CalDAV client. Skipped unless WRITES_IT=1. Needs the gateway and a fresh token (15 minutes):
//
//   cd dev/spike-s1 && ./spike.sh token alice        # on the host
//   WRITES_IT=1 GATEWAY_URL=http://127.0.0.1:3300 ALICE_ACCESS_TOKEN=... \
//     npx vitest run tests/integration/writes.integration.test.ts
//
// The test makes a scratch calendar in alice's home, creates a repeating event in it, edits one
// occurrence, edits "this and following", deletes one occurrence and then the rest, comparing
// what the server's REPORT expansion shows after each step, and deletes the scratch calendar.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCalDavClient } from '../../app/utils/caldav/client'
import type { CalDavClient } from '../../app/utils/caldav/client'
import { createCalendarReader } from '../../app/utils/caldav/reader'
import type { DavCalendar } from '../../app/utils/caldav/types'
import type { Calendar, CalendarEvent } from '../../shared/types/calendar'
import { davRef } from '../../app/utils/live/calendars'
import { readCalendarEvents } from '../../app/utils/live/events'
import { diffEventForm, eventFormFromEvent } from '../../app/utils/writes/event-form'
import { createEvent, deleteEvent, editEvent } from '../../app/utils/writes/orchestrate'
import { eventTargetOf } from '../../app/utils/writes/rules'
import type { EventTarget, WriteDeps } from '../../app/utils/writes/types'

const enabled = process.env.WRITES_IT === '1'
const origin = process.env.GATEWAY_URL ?? 'http://127.0.0.1:3300'
const token = process.env.ALICE_ACCESS_TOKEN ?? ''

const authed =
  (accessToken: string): typeof fetch =>
  (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${accessToken}`)
    return fetch(input, { ...init, headers })
  }

const RANGE = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-12-31T00:00:00Z') }
const BERLIN = { displayTimeZone: 'Europe/Berlin', orgTimeZone: 'Europe/Berlin' }

interface Instance {
  summary: string
  start: string
}

describe.skipIf(!enabled)('event writes against the gateway and Radicale', () => {
  const client: CalDavClient = createCalDavClient({
    baseUrl: `${origin}/caldav`,
    fetch: authed(token),
  })
  const reader = createCalendarReader(client, { ttlMs: 30_000 })
  let refreshes = 0
  const deps: WriteDeps = {
    client,
    reader,
    refresh: async () => {
      refreshes += 1
    },
    zones: () => BERLIN,
  }
  let scratch: DavCalendar
  let seriesHref = ''
  let newHalfHref = ''

  /** What the server's REPORT with `expand` shows: one entry per occurrence, in time order. */
  async function expanded(): Promise<Instance[]> {
    const objects = await client.fetchObjects(scratch.url, RANGE, { expand: true })
    const instances: Instance[] = []
    for (const object of objects) {
      for (const block of object.data.split('BEGIN:VEVENT').slice(1)) {
        instances.push({
          summary: /^SUMMARY:(.*)$/m.exec(block)?.[1]?.trim() ?? '',
          start: /^DTSTART[^:]*:(\S+)/m.exec(block)?.[1] ?? '',
        })
      }
    }
    return instances.sort((a, b) => a.start.localeCompare(b.start))
  }
  /**
   * What the app's loader makes of the same REPORT (the code path of the live calendar): the events
   * the sheet would show, with the `href`, `recurring` and `recurrenceId` the write path relies on.
   */
  async function loaded(): Promise<CalendarEvent[]> {
    const objects = await client.fetchObjects(scratch.url, RANGE, { expand: true })
    const result = readCalendarEvents(
      { kind: 'caldav', calendarId: davRef(scratch.url), objects },
      { ...BERLIN, range: RANGE },
    )
    expect(result.error).toBeNull()
    expect(result.skipped).toBe(0)
    return [...result.events].sort((a, b) => a.start.localeCompare(b.start))
  }
  /** The write target of a loaded event, the way the event sheet derives it. */
  function targetOf(event: CalendarEvent): EventTarget {
    const calendar: Calendar = {
      id: davRef(scratch.url),
      name: 'scratch',
      type: 'caldav',
      color: '#336699',
      defaultVisible: true,
      href: scratch.url,
    }
    const found = eventTargetOf(event, new Map([[calendar.id, calendar]]))
    if (!found) throw new Error(`the sheet would not allow writing to ${event.id}`)
    return found
  }
  const log = (label: string, instances: Instance[]) =>
    console.log(`${label}:\n${instances.map((i) => `  ${i.start}  ${i.summary}`).join('\n')}`)
  const target = (href: string, recurrenceId: string): EventTarget => ({
    href,
    calendarHref: scratch.url,
    recurring: true,
    recurrenceId,
  })

  beforeAll(async () => {
    if (!token) throw new Error('ALICE_ACCESS_TOKEN is required with WRITES_IT=1')
    scratch = await client.createCalendar({
      displayName: 'writes-it scratch',
      slug: `wr-${Date.now()}`,
    })
  })

  afterAll(async () => {
    if (scratch) await client.deleteObject(scratch.url).catch(() => undefined)
  })

  it('creates a repeating event: six Mondays at 09:00 Berlin across the change of winter time', async () => {
    const outcome = await createEvent(deps, {
      calendarHref: scratch.url,
      input: {
        title: 'Weekly',
        when: { start: '2026-10-12T09:00', end: '2026-10-12T10:00', allDay: false },
        description: 'Agenda',
        location: 'Room 1',
        categoryNames: ['Work', 'Meeting'],
        recurrence: { freq: 'WEEKLY', byDay: ['MO'], count: 6 },
      },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    seriesHref = outcome.url
    expect(refreshes).toBe(1)

    const all = await expanded()
    log('after create', all)
    expect(all.map((i) => i.start)).toEqual([
      '20261012T070000Z',
      '20261019T070000Z',
      '20261026T080000Z',
      '20261102T080000Z',
      '20261109T080000Z',
      '20261116T080000Z',
    ])
    expect(new Set(all.map((i) => i.summary))).toEqual(new Set(['Weekly']))
  })

  it('shows every occurrence to the loader as part of a series, the first one too', async () => {
    const events = await loaded()
    expect(events).toHaveLength(6)
    expect(events.map((e) => e.recurrenceId)).toEqual([
      '2026-10-12T07:00:00Z',
      '2026-10-19T07:00:00Z',
      '2026-10-26T08:00:00Z',
      '2026-11-02T08:00:00Z',
      '2026-11-09T08:00:00Z',
      '2026-11-16T08:00:00Z',
    ])
    for (const event of events) {
      expect(event).toMatchObject({
        recurring: true,
        href: seriesHref,
        title: 'Weekly',
        description: 'Agenda',
        location: 'Room 1',
        categoryNames: ['Work', 'Meeting'],
      })
      expect(targetOf(event)).toEqual({
        href: seriesHref,
        calendarHref: scratch.url,
        recurring: true,
        recurrenceId: event.recurrenceId,
      })
    }
    // Times in the display zone: 09:00 Berlin before and after the change of winter time.
    expect(events.map((e) => e.start.slice(11, 16))).toEqual(Array(6).fill('09:00'))
  })

  it('edits one occurrence from what the loader showed, through the edit form', async () => {
    const third = (await loaded())[2]!
    expect(third.recurrenceId).toBe('2026-10-26T08:00:00Z')
    const original = eventFormFromEvent(third)
    const changes = diffEventForm(original, {
      ...original,
      title: 'Weekly (special)',
      start: '2026-10-26T14:00',
      end: '2026-10-26T15:00',
    })
    // The categories, description and location were read and are left alone.
    expect(Object.keys(changes).sort()).toEqual(['title', 'when'])
    const outcome = await editEvent(deps, { target: targetOf(third), scope: 'this', changes })
    expect(outcome).toMatchObject({ ok: true, unchanged: false, split: false })
    const all = await expanded()
    log('after editing the third occurrence', all)
    expect(all).toHaveLength(6)
    expect(all.find((i) => i.summary === 'Weekly (special)')?.start).toBe('20261026T130000Z')
    expect(all.filter((i) => i.summary === 'Weekly')).toHaveLength(5)

    // The moved occurrence keeps the id of its ORIGINAL slot, so a second edit finds it again.
    const events = await loaded()
    const moved = events.find((e) => e.title === 'Weekly (special)')!
    expect(moved).toMatchObject({
      recurring: true,
      recurrenceId: '2026-10-26T08:00:00Z',
      start: '2026-10-26T14:00:00',
      categoryNames: ['Work', 'Meeting'],
    })
  })

  it('edits this and following: the series splits and nothing is lost or doubled', async () => {
    const before = await client.fetchObjects(scratch.url, RANGE)
    expect(before).toHaveLength(1)
    const fourth = (await loaded()).find((e) => e.recurrenceId === '2026-11-02T08:00:00Z')!
    const original = eventFormFromEvent(fourth)
    const outcome = await editEvent(deps, {
      target: targetOf(fourth),
      scope: 'following',
      changes: diffEventForm(original, {
        ...original,
        title: 'Weekly (room 2)',
        location: 'Room 2',
      }),
    })
    expect(outcome).toMatchObject({ ok: true, unchanged: false, split: true })
    const objects = await client.fetchObjects(scratch.url, RANGE)
    expect(objects).toHaveLength(2)
    newHalfHref = objects.find((o) => o.url !== seriesHref)!.url
    const all = await expanded()
    log('after editing this and following', all)
    expect(all).toHaveLength(6)
    expect(all.slice(0, 3).map((i) => i.summary)).toEqual(['Weekly', 'Weekly', 'Weekly (special)'])
    expect(all.slice(3).map((i) => i.summary)).toEqual(Array(3).fill('Weekly (room 2)'))
    expect(all.slice(3).map((i) => i.start)).toEqual([
      '20261102T080000Z',
      '20261109T080000Z',
      '20261116T080000Z',
    ])
  })

  it('deletes one occurrence of the new series', async () => {
    const outcome = await deleteEvent(deps, {
      target: target(newHalfHref, '2026-11-09T08:00:00Z'),
      scope: 'this',
    })
    expect(outcome).toEqual({ ok: true, alreadyGone: false })
    const all = await expanded()
    log('after deleting 9 November', all)
    expect(all.map((i) => i.start)).not.toContain('20261109T080000Z')
    expect(all).toHaveLength(5)
  })

  it('notices a change by someone else between the read and the write', async () => {
    let touched = false
    const racing: WriteDeps = {
      ...deps,
      client: {
        getObject: async (url, signal) => {
          const object = await client.getObject(url, signal)
          if (!touched) {
            touched = true
            // Someone saves the resource, unconditionally, right after we read it. (Radicale's
            // ETag follows the content: saving the same text again would not change it.)
            const other = object.data.replace(/^(SUMMARY:.*?)\r?$/m, '$1 (by someone else)')
            await client.putObject({ url, data: other })
          }
          return object
        },
        putObject: (args) => client.putObject(args),
        deleteObject: (url, etag) => client.deleteObject(url, etag),
      },
    }
    const outcome = await editEvent(racing, {
      target: target(newHalfHref, '2026-11-02T08:00:00Z'),
      scope: 'this',
      changes: { title: 'Too late' },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure).toMatchObject({ kind: 'conflict', reload: true, closeForm: true })
    expect(outcome.failure.message).toBe(
      'This event was changed by someone else. It has been reloaded — try again.',
    )
    expect((await expanded()).some((i) => i.summary === 'Too late')).toBe(false)
  })

  it('deletes the rest: this and following, then the whole old series', async () => {
    const following = await deleteEvent(deps, {
      target: target(newHalfHref, '2026-11-02T08:00:00Z'),
      scope: 'following',
    })
    // The first occurrence of the new series: nothing is left of its resource.
    expect(following).toEqual({ ok: true, alreadyGone: false })
    expect((await client.fetchObjects(scratch.url, RANGE)).map((o) => o.url)).toEqual([seriesHref])

    const rest = await deleteEvent(deps, {
      target: target(seriesHref, '2026-10-12T07:00:00Z'),
      scope: 'all',
    })
    expect(rest).toEqual({ ok: true, alreadyGone: false })
    expect(await client.fetchObjects(scratch.url, RANGE)).toEqual([])

    // The event is gone: deleting it again counts as done.
    expect(
      await deleteEvent(deps, { target: target(seriesHref, '2026-10-12T07:00:00Z'), scope: 'all' }),
    ).toEqual({ ok: true, alreadyGone: true })
  })
})
