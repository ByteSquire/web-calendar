// @vitest-environment node
//
// The CalDAV transport (app/utils/caldav) through the gateway to the real Radicale. Skipped unless
// CALDAV_IT=1. Needs the gateway and a fresh token (they live 15 minutes), as for the gateway test:
//
//   cd dev/spike-s1 && ./spike.sh token alice        # on the host
//   CALDAV_IT=1 GATEWAY_URL=http://127.0.0.1:3300 ALICE_ACCESS_TOKEN=... \
//     npx vitest run tests/integration/caldav.integration.test.ts
//
// The test makes a scratch calendar in alice's home, works in it and deletes it again.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCalDavClient } from '../../app/utils/caldav/client'
import type { CalDavClient } from '../../app/utils/caldav/client'
import { DavError } from '../../app/utils/caldav/errors'
import { createCalendarReader } from '../../app/utils/caldav/reader'
import type { DavCalendar, DavObject } from '../../app/utils/caldav/types'

const enabled = process.env.CALDAV_IT === '1'
const origin = process.env.GATEWAY_URL ?? 'http://127.0.0.1:3300'
const token = process.env.ALICE_ACCESS_TOKEN ?? ''

const authed =
  (accessToken: string): typeof fetch =>
  (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${accessToken}`)
    return fetch(input, { ...init, headers })
  }

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
]
const vevent = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']
const calendarText = (...parts: string[][]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//web-calendar it//EN',
    ...parts.flat(),
    'END:VCALENDAR',
  ]
    .join('\r\n')
    .concat('\r\n')
const STAMP = 'DTSTAMP:20261001T000000Z'

// Weekly Monday series across the daylight-saving change of 25 Oct, one date removed, one moved.
const WEEKLY = calendarText(
  VTIMEZONE,
  vevent(
    'UID:it-weekly',
    STAMP,
    'SUMMARY:Weekly',
    'DTSTART;TZID=Europe/Berlin:20261012T090000',
    'DTEND;TZID=Europe/Berlin:20261012T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8',
    'EXDATE;TZID=Europe/Berlin:20261102T090000',
    'CATEGORIES:Work,Meeting',
    'ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:bob@example.com',
    'X-KEEP:yes',
  ),
  vevent(
    'UID:it-weekly',
    STAMP,
    'SUMMARY:Weekly (moved)',
    'RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000',
    'DTSTART;TZID=Europe/Berlin:20261026T140000',
    'DTEND;TZID=Europe/Berlin:20261026T150000',
  ),
)
const YEARLY = calendarText(
  vevent(
    'UID:it-yearly',
    STAMP,
    'SUMMARY:Yearly all-day',
    'DTSTART;VALUE=DATE:20201105',
    'DTEND;VALUE=DATE:20201106',
    'RRULE:FREQ=YEARLY',
  ),
)
const FLOATING = calendarText(
  vevent(
    'UID:it-floating',
    STAMP,
    'SUMMARY:Floating café ✓ & <more>',
    'DTSTART:20261104T100000',
    'DTEND:20261104T110000',
  ),
)

const RANGE = { start: new Date('2026-10-19T00:00:00Z'), end: new Date('2026-11-30T23:59:59Z') }

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    if (error instanceof DavError) return error.kind
    throw error
  }
}

describe.skipIf(!enabled)('CalDAV transport against the gateway and Radicale', () => {
  const client: CalDavClient = createCalDavClient({
    baseUrl: `${origin}/caldav`,
    fetch: authed(token),
  })
  const slug = `it-${Date.now()}`
  let home = ''
  let scratch: DavCalendar
  const etags = new Map<string, string>()
  const hrefOf = (name: string) => `${scratch.url}${name}.ics`
  const byName = (objects: DavObject[], name: string) =>
    objects.find((o) => o.url.endsWith(`/${name}.ics`))

  beforeAll(() => {
    if (!token) throw new Error('ALICE_ACCESS_TOKEN is required with CALDAV_IT=1')
  })

  afterAll(async () => {
    if (scratch) await client.deleteObject(scratch.url).catch(() => undefined)
  })

  it('discovers the principal and the calendar home', async () => {
    const discovered = await client.discover()
    expect(discovered.principalUrl).toMatch(/^\/caldav\/[0-9a-f-]{36}\/$/)
    expect(discovered.homeUrl).toMatch(/^\/caldav\/[0-9a-f-]{36}\/$/)
    home = discovered.homeUrl
  })

  it('is unauthorized with a bad token', async () => {
    const bad = createCalDavClient({ baseUrl: `${origin}/caldav`, fetch: authed('not-a-token') })
    expect(await kindOf(bad.discover())).toBe('unauthorized')
  })

  it('makes a scratch calendar and finds it in the listing', async () => {
    scratch = await client.createCalendar({ displayName: 'IT scratch <&>', color: '#336699', slug })
    expect(scratch.url).toBe(`${home}${slug}/`)
    const listed = (await client.listCalendars()).find((c) => c.url === scratch.url)
    expect(listed).toMatchObject({
      displayName: 'IT scratch <&>',
      color: '#336699',
      components: ['VEVENT'],
      readOnly: false,
    })
    expect(listed?.ctag).toMatch(/^"?[0-9a-f]+"?$/)
  })

  it('refuses to make the same calendar twice', async () => {
    expect(await kindOf(client.createCalendar({ displayName: 'again', slug }))).toBe('exists')
  })

  it('creates events and gets their ETags', async () => {
    for (const [name, data] of [
      ['weekly', WEEKLY],
      ['yearly', YEARLY],
      ['floating', FLOATING],
    ] as const) {
      const saved = await client.putObject({ url: hrefOf(name), data, create: true })
      expect(saved.url).toBe(hrefOf(name))
      expect(saved.etag).toMatch(/^"[^"]+"$/)
      etags.set(name, saved.etag)
    }
  })

  it('refuses to create an event twice', async () => {
    expect(
      await kindOf(client.putObject({ url: hrefOf('weekly'), data: WEEKLY, create: true })),
    ).toBe('exists')
  })

  it('reads the events of a range in one request, without expanding', async () => {
    const objects = await client.fetchObjects(scratch.url, RANGE)
    expect(objects.map((o) => o.url).sort()).toEqual(
      ['floating', 'weekly', 'yearly'].map(hrefOf).sort(),
    )
    for (const [name, etag] of etags) expect(byName(objects, name)?.etag).toBe(etag)
    const weekly = byName(objects, 'weekly')!.data
    expect(weekly).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8')
    expect(weekly).toContain('EXDATE;TZID=Europe/Berlin:20261102T090000')
    expect(weekly).toContain('CATEGORIES:Work,Meeting')
    expect(weekly).toContain('X-KEEP:yes')
    expect(weekly).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000')
    expect(byName(objects, 'floating')!.data).toContain('SUMMARY:Floating café ✓ & <more>')
  })

  it('lets the server expand recurrences, daylight saving included', async () => {
    const objects = await client.fetchObjects(scratch.url, RANGE, { expand: true })
    const weekly = byName(objects, 'weekly')!.data
    expect(weekly).not.toContain('RRULE')
    // 09:00 Berlin is 07:00Z before 25 Oct and 08:00Z after; 2 Nov is excluded, 26 Oct moved.
    expect(weekly).toContain('DTSTART:20261019T070000Z')
    expect(weekly).toContain('DTSTART:20261026T130000Z')
    expect(weekly).toContain('DTSTART:20261109T080000Z')
    expect(weekly).not.toContain('DTSTART:20261102')
    expect(weekly).not.toContain('DTSTART:20261026T080000Z')
    expect(byName(objects, 'yearly')!.data).toContain('DTSTART;VALUE=DATE:20261105')
  })

  it('reads one object by its address', async () => {
    const object = await client.getObject(hrefOf('floating'))
    expect(object.etag).toBe(etags.get('floating'))
    expect(object.data).toContain('UID:it-floating')
    expect(await kindOf(client.getObject(hrefOf('missing')))).toBe('not-found')
  })

  it('updates with the ETag, and a second update with the stale ETag is a conflict', async () => {
    const before = await client.getObject(hrefOf('floating'))
    const edited = before.data.replace('SUMMARY:Floating', 'SUMMARY:Edited floating')
    const saved = await client.putObject({ url: before.url, data: edited, etag: before.etag })
    expect(saved.etag).not.toBe(before.etag)
    expect((await client.getObject(before.url)).data).toContain('SUMMARY:Edited floating')

    const stale = await client
      .putObject({ url: before.url, data: edited, etag: before.etag })
      .catch((e: unknown) => e)
    expect(stale).toBeInstanceOf(DavError)
    expect(stale).toMatchObject({ kind: 'conflict', status: 412 })
    etags.set('floating', saved.etag)
  })

  it('reads several calendars through the reader, one of them missing', async () => {
    const reader = createCalendarReader(client)
    const results = await reader.read(
      [
        { url: scratch.url, expand: false },
        { url: `${home}no-such-calendar/`, expand: false },
      ],
      RANGE,
    )
    expect(results[0]!.objects).toHaveLength(3)
    expect(results[1]!.error?.kind).toBe('not-found')
  })

  it('deletes with the ETag; a stale one is a conflict', async () => {
    expect(await kindOf(client.deleteObject(hrefOf('floating'), '"stale"'))).toBe('conflict')
    await client.deleteObject(hrefOf('floating'), etags.get('floating'))
    expect(await kindOf(client.getObject(hrefOf('floating')))).toBe('not-found')
    expect(await kindOf(client.deleteObject(hrefOf('floating')))).toBe('not-found')
    const left = await client.fetchObjects(scratch.url, RANGE)
    expect(left.map((o) => o.url)).not.toContain(hrefOf('floating'))
  })

  it('removes the scratch calendar', async () => {
    await client.deleteObject(scratch.url)
    expect((await client.listCalendars()).map((c) => c.url)).not.toContain(scratch.url)
    expect(await kindOf(client.fetchObjects(scratch.url, RANGE))).toBe('not-found')
  })
})
