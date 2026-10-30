// Spike: ts-caldav 0.4.5 through the app's CalDAV gateway to Radicale (design S4, S8).
// Run in the dev container with the gateway on GATEWAY_URL and a Kanidm access token:
//   ACCESS_TOKEN=... GATEWAY_URL=http://127.0.0.1:3300 node spike.mjs
import { CalDAVClient, CalDAVError } from 'ts-caldav'

const ORIGIN = process.env.GATEWAY_URL ?? 'http://127.0.0.1:3300'
const token = process.env.ACCESS_TOKEN
if (!token) throw new Error('ACCESS_TOKEN is required')

const section = (title) => console.log(`\n=== ${title}`)
const show = (label, value) =>
  console.log(`${label}:`, typeof value === 'string' ? value : JSON.stringify(value))

async function probe(title, fn) {
  section(title)
  try {
    await fn()
  } catch (error) {
    const extra =
      error instanceof CalDAVError
        ? ` status=${error.status} precondition=${error.precondition}`
        : ''
    console.log(`!! FAILED: ${error?.message ?? error}${extra}`)
    if (error?.cause) console.log('   cause:', error.cause?.message ?? error.cause)
  }
}

const raw = (method, path, { headers = {}, body } = {}) =>
  fetch(new URL(path, ORIGIN), {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    body,
  })

const VTZ = [
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
].join('\r\n')

const wrap = (body, tz = true) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//spike//EN', tz ? VTZ : '', body, 'END:VCALENDAR']
    .filter(Boolean)
    .join('\r\n') + '\r\n'

const vevent = (lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n')
const stamp = 'DTSTAMP:20261001T000000Z'

const FIXTURES = {
  // Weekly Monday series with an EXDATE and a moved occurrence, across the DST change of 25 Oct.
  'a-weekly': wrap(
    [
      vevent([
        'UID:a-weekly',
        stamp,
        'SUMMARY:A weekly',
        'DTSTART;TZID=Europe/Berlin:20261012T090000',
        'DTEND;TZID=Europe/Berlin:20261012T100000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8',
        'EXDATE;TZID=Europe/Berlin:20261102T090000',
      ]),
      vevent([
        'UID:a-weekly',
        stamp,
        'SUMMARY:A weekly (moved)',
        'RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000',
        'DTSTART;TZID=Europe/Berlin:20261026T140000',
        'DTEND;TZID=Europe/Berlin:20261026T150000',
      ]),
    ].join('\r\n'),
  ),
  // Last weekday of the month: BYSETPOS is outside ts-caldav's documented rule model.
  'b-lastweekday': wrap(
    vevent([
      'UID:b-lastweekday',
      stamp,
      'SUMMARY:B last weekday',
      'DTSTART;TZID=Europe/Berlin:20260831T170000',
      'DTEND;TZID=Europe/Berlin:20260831T180000',
      'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=6',
      'LOCATION:Room 1\\, Floor 2',
      'DESCRIPTION:Line one\\nLine two\\, with comma',
      'CATEGORIES:Work,Meeting',
      'ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:bob@example.com',
      'ORGANIZER;CN=Alice:mailto:alice@example.com',
      'X-CUSTOM-PROP:keep me',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'DESCRIPTION:Reminder',
      'END:VALARM',
    ]),
  ),
  'c-allday-cancelled': wrap(
    vevent([
      'UID:c-allday-cancelled',
      stamp,
      'SUMMARY:C all-day cancelled',
      'DTSTART;VALUE=DATE:20261103',
      'DTEND;VALUE=DATE:20261106',
      'STATUS:CANCELLED',
    ]),
    false,
  ),
  'd-floating': wrap(
    vevent([
      'UID:d-floating',
      stamp,
      'SUMMARY:D floating',
      'DTSTART:20261104T100000',
      'DTEND:20261104T110000',
    ]),
    false,
  ),
  'e-utc': wrap(
    vevent([
      'UID:e-utc',
      stamp,
      'SUMMARY:E utc',
      'DTSTART:20261105T083000Z',
      'DTEND:20261105T093000Z',
    ]),
    false,
  ),
  'f-yearly-allday': wrap(
    vevent([
      'UID:f-yearly-allday',
      stamp,
      'SUMMARY:F yearly all-day',
      'DTSTART;VALUE=DATE:20201105',
      'DTEND;VALUE=DATE:20201106',
      'RRULE:FREQ=YEARLY',
    ]),
    false,
  ),
}

const RANGE = { start: new Date('2026-10-19T00:00:00Z'), end: new Date('2026-11-30T23:59:59Z') }
const fmt = (e) => ({
  uid: e.uid,
  summary: e.summary,
  start: e.start?.toISOString(),
  end: e.end?.toISOString(),
  whole: e.wholeDay,
  tz: e.startTzid,
  status: e.status,
  rrule: e.recurrenceRule,
  exdates: e.exdates?.map((d) => d.toISOString()),
  recId: e.recurrenceId?.toISOString(),
  custom: e.customFields,
})
const byStart = (a, b) => (a.start ?? '').localeCompare(b.start ?? '')

let client
let calendarUrl
let calendarPath

await probe('1. create client, discovery through the gateway', async () => {
  client = await CalDAVClient.create({
    baseUrl: `${ORIGIN}/caldav`,
    auth: { type: 'oauth', accessToken: token },
  })
  show('userPrincipal', client.userPrincipal)
  show('calendarHome', client.calendarHome)
  const calendars = await client.getCalendars()
  show(
    'existing calendars',
    calendars.map((c) => ({
      name: c.displayName,
      url: c.url,
      color: c.color,
      comps: c.supportedComponents,
    })),
  )
})

await probe(
  '2. MKCALENDAR a scratch calendar (ts-caldav has no create-calendar call)',
  async () => {
    const home = new URL(client.calendarHome, ORIGIN).pathname
    calendarPath = `${home.replace(/\/$/, '')}/spike-${Date.now()}/`
    const response = await raw('MKCALENDAR', calendarPath, {
      headers: { 'content-type': 'application/xml' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>
<D:displayname>Spike</D:displayname>
<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
</D:prop></D:set></C:mkcalendar>`,
    })
    show('MKCALENDAR status', String(response.status))
    const calendars = await client.getCalendars()
    const mine = calendars.find((c) => c.displayName === 'Spike')
    show('found by getCalendars', mine ? { url: mine.url, ctag: mine.ctag } : 'NOT FOUND')
    calendarUrl = mine?.url
    show('calendar url used by ts-caldav (note any /caldav/caldav doubling)', calendarUrl)
  },
)

await probe('3. PUT fixtures from "other clients"', async () => {
  for (const [name, ics] of Object.entries(FIXTURES)) {
    const response = await raw('PUT', `${calendarPath}${name}.ics`, {
      headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
      body: ics,
    })
    show(`PUT ${name}`, `${response.status} etag=${response.headers.get('etag')}`)
  }
})

await probe(
  '4. getEvents without expand (what the client would have to expand itself)',
  async () => {
    const events = (await client.getEvents(calendarUrl, RANGE)).map(fmt).sort(byStart)
    for (const e of events) show(`${e.uid}${e.recId ? ' [override]' : ''}`, e)
  },
)

await probe('5. getEvents with expand:true (Radicale server-side expansion)', async () => {
  const events = (await client.getEvents(calendarUrl, { ...RANGE, expand: true }))
    .map(fmt)
    .sort(byStart)
  for (const e of events) {
    console.log(
      `${e.start}  ${e.uid.padEnd(20)} ${e.summary}  end=${e.end} whole=${e.whole} rrule=${e.rrule ? 'yes' : 'no'}`,
    )
  }
  console.log(
    'expected a-weekly: 2026-10-19T07:00Z, 2026-10-26T13:00Z (moved to 14:00 Berlin), NOT 2026-11-02, 2026-11-09T08:00Z, 16T08:00Z, 23T08:00Z, 30T08:00Z (count 8 ends Nov 30)',
  )
  console.log('expected b-lastweekday: 2026-10-30T16:00Z, 2026-11-30T16:00Z')
})

await probe('6. raw expand REPORT: what Radicale actually sends', async () => {
  const response = await raw('REPORT', calendarPath, {
    headers: { 'content-type': 'application/xml', depth: '1' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/>
<C:calendar-data><C:expand start="20261019T000000Z" end="20261130T235959Z"/></C:calendar-data></D:prop>
<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
<C:time-range start="20261019T000000Z" end="20261130T235959Z"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`,
  })
  const text = await response.text()
  show('status', String(response.status))
  const lines = text
    .split(/\r?\n/)
    .filter((l) => /^(UID|DTSTART|RECURRENCE-ID|SUMMARY|RRULE|EXDATE)/.test(l))
  console.log(lines.join('\n'))
})

await probe('7. free-busy-query (S4)', async () => {
  const response = await raw('REPORT', calendarPath, {
    headers: { 'content-type': 'application/xml', depth: '1' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:time-range start="20261019T000000Z" end="20261130T235959Z"/></C:free-busy-query>`,
  })
  show('status', String(response.status))
  console.log(
    (await response.text())
      .split(/\r?\n/)
      .filter((l) => /FREEBUSY|BEGIN|END/.test(l))
      .join('\n'),
  )
})

await probe('8. updateEvent round trip on b-lastweekday: what survives?', async () => {
  const events = await client.getEvents(calendarUrl, RANGE)
  const b = events.find((e) => e.uid === 'b-lastweekday')
  show('parsed rrule', b.recurrenceRule)
  show('parsed custom fields', b.customFields)
  const before = await (await raw('GET', new URL(b.href, ORIGIN).pathname)).text()
  await client.updateEvent(calendarUrl, { ...b, summary: 'B last weekday (edited)' })
  const after = await (await raw('GET', new URL(b.href, ORIGIN).pathname)).text()
  const checks = [
    'BYSETPOS=-1',
    'X-CUSTOM-PROP',
    'ATTENDEE',
    'ORGANIZER',
    'VALARM',
    'CATEGORIES',
    'LOCATION',
    'DESCRIPTION',
    'TZID=Europe/Berlin',
    'VTIMEZONE',
  ]
  for (const key of checks)
    show(
      key,
      `${before.includes(key) ? 'before' : '-'} -> ${after.includes(key) ? 'after' : 'LOST'}`,
    )
  console.log('--- stored after update ---\n' + after.split(/\r?\n/).join('\n'))
})

await probe('9. updateEvent on a series with an override (a-weekly)', async () => {
  const events = await client.getEvents(calendarUrl, RANGE)
  const master = events.find((e) => e.uid === 'a-weekly' && !e.recurrenceId)
  const hrefPath = new URL(master.href, ORIGIN).pathname
  await client.updateEvent(calendarUrl, { ...master, summary: 'A weekly (edited)' })
  const after = await (await raw('GET', hrefPath)).text()
  show('RECURRENCE-ID overrides after update', String((after.match(/RECURRENCE-ID/g) ?? []).length))
  show('EXDATE after update', after.includes('EXDATE') ? 'kept' : 'LOST')
})

await probe('10. stale ETag write must be refused (412)', async () => {
  const [event] = (await client.getEvents(calendarUrl, RANGE)).filter((e) => e.uid === 'e-utc')
  await client.updateEvent(calendarUrl, { ...event, summary: 'E first edit' })
  try {
    await client.updateEvent(calendarUrl, { ...event, summary: 'E second edit with the old etag' })
    console.log('!! second update with a stale etag SUCCEEDED (lost update)')
  } catch (error) {
    show('stale update', `refused: status=${error.status} ${error.message}`)
  }
})

await probe('11. ts-caldav-made series: occurrence edit and delete', async () => {
  const created = await client.createEvent(calendarUrl, {
    summary: 'T series',
    start: new Date('2026-10-20T07:00:00Z'),
    end: new Date('2026-10-20T08:00:00Z'),
    startTzid: 'Europe/Berlin',
    endTzid: 'Europe/Berlin',
    recurrenceRule: { freq: 'WEEKLY', byday: ['TU'], count: 6 },
  })
  show('created', created)
  const hrefPath = new URL(created.href, ORIGIN).pathname
  const get = async () =>
    (await (await raw('GET', hrefPath)).text())
      .split(/\r?\n/)
      .filter((l) => /^(DTSTART|RRULE|EXDATE|RECURRENCE-ID|SUMMARY)/.test(l))
      .join(' | ')
  show('stored', await get())
  const master = { href: created.href, uid: created.uid, etag: created.etag }
  const nov3 = new Date('2026-11-03T08:00:00Z')
  const r1 = await client.updateOccurrence(calendarUrl, master, nov3, {
    summary: 'T moved',
    start: new Date('2026-11-03T13:00:00Z'),
    end: new Date('2026-11-03T14:00:00Z'),
  })
  show('after updateOccurrence', await get())
  const r2 = await client.deleteOccurrence(
    calendarUrl,
    { href: created.href, etag: r1.etag },
    new Date('2026-11-10T08:00:00Z'),
  )
  show('after deleteOccurrence(this)', await get())
  const r3 = await client.deleteOccurrence(
    calendarUrl,
    { href: created.href, etag: r2.etag },
    new Date('2026-11-17T08:00:00Z'),
    { scope: 'thisAndFuture' },
  )
  show('after deleteOccurrence(thisAndFuture)', await get())
  show('result', r3)
})

await probe('12. createEvent / update / delete of a plain event; DST wall-clock', async () => {
  const created = await client.createEvent(calendarUrl, {
    summary: 'Plain',
    start: new Date('2026-10-25T00:30:00Z'),
    end: new Date('2026-10-25T01:30:00Z'),
    startTzid: 'Europe/Berlin',
    endTzid: 'Europe/Berlin',
  })
  const stored = await (await raw('GET', new URL(created.href, ORIGIN).pathname)).text()
  console.log(
    stored
      .split(/\r?\n/)
      .filter((l) => /^(DTSTART|DTEND)/.test(l))
      .join(' | '),
  )
  await client.deleteEvent(calendarUrl, {
    href: created.href,
    uid: created.uid,
    etag: created.etag,
  })
  show('deleted', 'ok')
})

await probe('13. bad token: error shape', async () => {
  const bad = await CalDAVClient.create({
    baseUrl: `${ORIGIN}/caldav`,
    auth: { type: 'oauth', accessToken: 'not-a-token' },
  }).catch((error) => error)
  show('error', `${bad?.constructor?.name} status=${bad?.status} ${bad?.message}`)
})

await probe('cleanup', async () => {
  if (!calendarPath) return
  const response = await raw('DELETE', calendarPath)
  show('DELETE scratch calendar', String(response.status))
})
