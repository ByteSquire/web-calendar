// @vitest-environment node
//
// Importing an .ics file (app/utils/import) through the gateway to the real Radicale, with the real
// CalDAV client. Skipped unless IMPORT_IT=1. Needs the gateway and a fresh token (15 minutes):
//
//   cd dev/spike-s1 && ./spike.sh token alice        # on the host
//   IMPORT_IT=1 GATEWAY_URL=http://127.0.0.1:3300 ALICE_ACCESS_TOKEN=... \
//     npx vitest run tests/integration/import.integration.test.ts
//
// The test makes a scratch calendar in alice's home, imports files into it (a series with changed
// occurrences, time zones, hostile UIDs, a large event, files with errors), imports them again,
// cancels an import and finishes it, and deletes the scratch calendar.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCalDavClient } from '../../app/utils/caldav/client'
import type { CalDavClient } from '../../app/utils/caldav/client'
import type { DavCalendar } from '../../app/utils/caldav/types'
import { prepareImport, type ImportPlan } from '../../app/utils/import/preview'
import { runImport, type ImportReport } from '../../app/utils/import/run'
import { fixture } from '../ical-read-helpers'

const enabled = process.env.IMPORT_IT === '1'
const origin = process.env.GATEWAY_URL ?? 'http://127.0.0.1:3300'
const token = process.env.ALICE_ACCESS_TOKEN ?? ''

const authed =
  (accessToken: string): typeof fetch =>
  (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${accessToken}`)
    return fetch(input, { ...init, headers })
  }

const RANGE = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2027-12-31T00:00:00Z') }

const event = (uid: string, extra: string[] = []): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//web-calendar//import test//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T080000Z',
    `SUMMARY:${uid}`,
    'DTSTART:20261110T100000Z',
    'DTEND:20261110T110000Z',
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')

/** Several one-event calendars in one file, as a feed has them. */
const feed = (uids: string[]): string =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${uids
    .map((uid) => event(uid).split('\r\n').slice(3, -2).join('\r\n'))
    .join('\r\n')}\r\nEND:VCALENDAR\r\n`

describe.skipIf(!enabled)('importing a file against the gateway and Radicale', () => {
  const client: CalDavClient = createCalDavClient({
    baseUrl: `${origin}/caldav`,
    fetch: authed(token),
  })
  let scratch: DavCalendar

  async function planOf(text: string): Promise<ImportPlan> {
    const result = await prepareImport(new File([text], 'import.ics', { type: 'text/calendar' }))
    if (!result.ok) throw new Error(result.message)
    return result.plan
  }
  const importInto = async (text: string, signal?: AbortSignal): Promise<ImportReport> =>
    runImport(client, {
      calendarHref: scratch.url,
      resources: (await planOf(text)).resources,
      ...(signal ? { signal } : {}),
    })
  const stored = () => client.fetchObjects(scratch.url, RANGE)
  /** True when the resource text has a UID line that is exactly `UID:<uid>` (or matches the pattern). */
  const hasUid = (data: string, uid: string | RegExp): boolean =>
    data
      .split(/\r?\n/)
      .some((line) => (typeof uid === 'string' ? line === `UID:${uid}` : uid.test(line)))
  /** The resource of a UID, by what is in it. */
  const resourceOf = async (uid: string) =>
    (await stored()).find((object) => hasUid(object.data, uid))

  /** What the server's REPORT with `expand` shows for the UID: one entry per occurrence. */
  async function expanded(uid: string): Promise<{ summary: string; start: string }[]> {
    const objects = await client.fetchObjects(scratch.url, RANGE, { expand: true })
    return objects
      .filter((object) => hasUid(object.data, uid))
      .flatMap((object) => object.data.split('BEGIN:VEVENT').slice(1))
      .map((block) => ({
        summary: /^SUMMARY:(.*)$/m.exec(block)?.[1]?.trim() ?? '',
        start: /^DTSTART[^:]*:(\S+)/m.exec(block)?.[1] ?? '',
      }))
      .sort((a, b) => a.start.localeCompare(b.start))
  }

  beforeAll(async () => {
    if (!token) throw new Error('ALICE_ACCESS_TOKEN is required with IMPORT_IT=1')
    scratch = await client.createCalendar({
      displayName: 'import-it scratch',
      slug: `im-${Date.now()}`,
    })
  })

  afterAll(async () => {
    if (scratch) await client.deleteObject(scratch.url).catch(() => undefined)
  })

  it('imports a series with its changed occurrences as one resource, and a single event beside it', async () => {
    const report = await importInto(fixture('import-recurring-overrides.ics'))
    expect(report).toMatchObject({ created: 2, exists: 0, failed: 0, notDone: 0, stopped: null })

    const objects = await stored()
    expect(objects).toHaveLength(2)
    for (const object of objects) {
      // Named after a hash of the UID, directly in the scratch calendar.
      expect(object.url).toMatch(new RegExp(`^${scratch.url}[0-9a-f]{32}\\.ics$`))
    }
    const series = (await resourceOf('series-1@example.com'))!
    expect(series.data.match(/BEGIN:VEVENT/g)).toHaveLength(3)
    expect(series.data).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261019T090000')
    expect(series.data).toContain('BEGIN:VTIMEZONE')
    expect(series.data).not.toContain('METHOD')

    // The server reads it as the series it was: six Mondays, two of them changed.
    const all = await expanded('series-1@example.com')
    expect(all.map((i) => i.start)).toEqual([
      '20261012T070000Z',
      '20261019T120000Z',
      '20261026T080000Z',
      '20261102T080000Z',
      '20261109T080000Z',
      '20261116T080000Z',
    ])
    expect(all.map((i) => i.summary)).toEqual([
      'Weekly planning',
      'Weekly planning (moved)',
      'Weekly planning (shorter)',
      'Weekly planning',
      'Weekly planning',
      'Weekly planning',
    ])
  })

  it('finds every event again when the file is imported a second time', async () => {
    const report = await importInto(fixture('import-recurring-overrides.ics'))
    expect(report).toMatchObject({ created: 0, exists: 2, failed: 0, stopped: null })
    expect(await stored()).toHaveLength(2)
  })

  it('takes an event whose UID is in the calendar under another name for "already there"', async () => {
    await client.putObject({
      url: `${scratch.url}by-hand.ics`,
      data: event('under-another-name'),
      create: true,
    })
    const report = await importInto(event('under-another-name', ['LOCATION:from the file']))
    expect(report).toMatchObject({ created: 0, exists: 1, failed: 0 })
    const matching = (await stored()).filter((o) => hasUid(o.data, 'under-another-name'))
    expect(matching.map((o) => o.url)).toEqual([`${scratch.url}by-hand.ics`])
    expect(matching[0]?.data).not.toContain('from the file')
  })

  it('writes the other events of a file whose time zones and mix of components differ', async () => {
    const report = await importInto(fixture('import-two-timezones.ics'))
    expect(report).toMatchObject({ created: 6, failed: 0, stopped: null })
    const flight = (await resourceOf('both-zones'))!
    expect(flight.data).toContain('TZID:America/New_York')
    expect(flight.data).toContain('TZID:Europe/Berlin')
    expect(flight.data).not.toContain('Asia/Tokyo')

    const mixed = await importInto(fixture('import-mixed.ics'))
    // A to-do, a journal entry, a free/busy block, an event without a start and two damaged ones are
    // not in the plan; the rest is written, the event without a UID under a made-up one.
    expect(mixed).toMatchObject({ created: 5, failed: 0, stopped: null })
  })

  it('reports an event the service refuses by itself and writes the rest', async () => {
    const report = await importInto(fixture('mixed-good-bad.ics'))
    // "Month thirteen" is not a date: Radicale answers 400. The others are written.
    expect(report).toMatchObject({ created: 3, failed: 1, notDone: 0, stopped: null })
    const refused = report.items.find((item) => item.status === 'failed')
    expect(refused).toMatchObject({
      uid: 'bad-date',
      title: 'Month thirteen',
      message: 'The calendar service did not accept this event.',
    })
  })

  it('names resources after a hash whatever the UIDs hold, and keeps the UIDs inside', async () => {
    const before = new Set((await stored()).map((o) => o.url))
    const report = await importInto(fixture('import-hostile-uids.ics'))
    expect(report).toMatchObject({ created: 6, failed: 0, stopped: null })
    const added = (await stored()).filter((o) => !before.has(o.url))
    expect(added).toHaveLength(6)
    for (const object of added) {
      expect(object.url).toMatch(new RegExp(`^${scratch.url}[0-9a-f]{32}\\.ics$`))
    }
    expect(added.some((o) => hasUid(o.data, '../../etc/passwd'))).toBe(true)
    // Nothing reached outside the scratch calendar.
    const calendars = await client.listCalendars()
    expect(calendars.some((c) => c.url.includes('etc') || c.url.includes('other-user'))).toBe(false)
  })

  it('imports an event without a UID once: the made-up UID is the same the next time', async () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'DTSTAMP:20261001T080000Z',
      'SUMMARY:Nameless',
      'DTSTART:20261120T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    expect(await importInto(text)).toMatchObject({ created: 1, exists: 0 })
    expect(await importInto(text)).toMatchObject({ created: 0, exists: 1 })
  })

  it('takes an event of almost the largest size a file can have', async () => {
    const report = await importInto(event('large', [`DESCRIPTION:${'x'.repeat(4 * 1024 * 1024)}`]))
    expect(report).toMatchObject({ created: 1, failed: 0, stopped: null })
    expect((await resourceOf('large'))?.data.length).toBeGreaterThan(4 * 1024 * 1024)
  }, 60_000)

  it('can be cancelled, keeps what was written, and finishes when it is run again', async () => {
    const uids = Array.from({ length: 40 }, (_, i) => `cancel-${i}`)
    const controller = new AbortController()
    const plan = await planOf(feed(uids))
    expect(plan.resources).toHaveLength(40)
    const first = await runImport(client, {
      calendarHref: scratch.url,
      resources: plan.resources,
      signal: controller.signal,
      onProgress: ({ done }) => {
        if (done >= 5) controller.abort()
      },
    })
    expect(first.cancelled).toBe(true)
    expect(first.created + first.notDone + first.interrupted).toBe(40)
    expect(first.notDone).toBeGreaterThan(0)

    // A request that was cut off may still have been stored: the second run finds those too.
    const second = await runImport(client, { calendarHref: scratch.url, resources: plan.resources })
    expect(second).toMatchObject({ failed: 0, notDone: 0, stopped: null })
    expect(second.created + second.exists).toBe(40)
    expect(second.exists).toBeGreaterThanOrEqual(first.created)
    const stored40 = (await stored()).filter((o) => hasUid(o.data, /^UID:cancel-\d+$/))
    expect(stored40).toHaveLength(40)
  }, 60_000)

  it('does not write to a calendar that was deleted meanwhile', async () => {
    const gone = await client.createCalendar({
      displayName: 'import-it gone',
      slug: `gone-${Date.now()}`,
    })
    await client.deleteObject(gone.url)
    const report = await runImport(client, {
      calendarHref: gone.url,
      resources: (await planOf(event('nowhere'))).resources,
    })
    expect(report).toMatchObject({ created: 0, exists: 0, notDone: 1 })
    expect(report.stopped).toBe(
      'This calendar no longer exists. Reload the page and choose another calendar.',
    )
  })
})
