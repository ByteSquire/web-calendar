// Spike: tsdav 2.5.0 as a transport only (raw .ics in and out) through the gateway.
import {
  createAccount,
  fetchCalendars,
  fetchCalendarObjects,
  createCalendarObject,
  updateCalendarObject,
  makeCalendar,
} from 'tsdav'

const ORIGIN = process.env.GATEWAY_URL ?? 'http://127.0.0.1:3300'
const token = process.env.ACCESS_TOKEN
const headers = { Authorization: `Bearer ${token}` }
const log = (l, v) => console.log(`${l}:`, typeof v === 'string' ? v : JSON.stringify(v))
const step = async (t, fn) => {
  console.log(`\n=== ${t}`)
  try {
    await fn()
  } catch (e) {
    console.log('!! FAILED:', e?.message ?? e)
  }
}

let account, calendar
await step('1. discovery', async () => {
  account = await createAccount({
    account: { serverUrl: `${ORIGIN}/caldav`, accountType: 'caldav' },
    headers,
    loadCollections: true,
    loadObjects: false,
  })
  log('principal', account.principalUrl)
  log('home', account.homeUrl)
  log(
    'calendars',
    (account.calendars ?? []).map((c) => ({
      name: c.displayName,
      url: c.url,
      color: c.calendarColor,
      ctag: c.ctag,
      comps: c.components,
    })),
  )
})
await step('2. makeCalendar + PUT raw fixtures', async () => {
  const url = `${account.homeUrl}tsdav-${Date.now()}/`
  const r = await makeCalendar({ url, props: { displayname: 'tsdav spike' }, headers })
  log('makeCalendar', String(r.status ?? r.ok))
  const cals = await fetchCalendars({ account, headers })
  calendar = cals.find((c) => c.displayName === 'tsdav spike')
  log('found', calendar ? calendar.url : 'NOT FOUND')
  const ics = (uid, body) =>
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T000000Z\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
  const a = await createCalendarObject({
    calendar,
    filename: 'a.ics',
    iCalString: ics(
      'a',
      'SUMMARY:A weekly\r\nDTSTART;TZID=Europe/Berlin:20261012T090000\r\nDTEND;TZID=Europe/Berlin:20261012T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8\r\nCATEGORIES:Work,Meeting\r\nATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:b@example.com\r\nX-KEEP:yes',
    ),
    headers,
  })
  log('create a', `${a.status} etag=${a.headers.get('etag')}`)
  const f = await createCalendarObject({
    calendar,
    filename: 'f.ics',
    iCalString: ics(
      'f',
      'SUMMARY:F yearly all-day\r\nDTSTART;VALUE=DATE:20201105\r\nDTEND;VALUE=DATE:20201106\r\nRRULE:FREQ=YEARLY',
    ),
    headers,
  })
  log('create f', String(f.status))
})
const range = { start: '2026-10-19T00:00:00Z', end: '2026-11-30T23:59:59Z' }
await step('3. fetchCalendarObjects without expand: raw data kept?', async () => {
  const objs = await fetchCalendarObjects({ calendar, timeRange: range, headers })
  for (const o of objs)
    log(o.url, {
      etag: o.etag,
      hasCategories: /CATEGORIES:Work,Meeting/.test(o.data),
      hasAttendeeParams: /CN=Bob;PARTSTAT=ACCEPTED/.test(o.data),
      x: /X-KEEP/.test(o.data),
      bytes: o.data.length,
    })
})
await step('4. fetchCalendarObjects with expand', async () => {
  const objs = await fetchCalendarObjects({ calendar, timeRange: range, expand: true, headers })
  for (const o of objs)
    console.log(
      o.url.split('/').pop(),
      o.data
        .split(/\r?\n/)
        .filter((l) => /^(RECURRENCE-ID|DTSTART)/.test(l))
        .join(' | '),
    )
})
await step('5. update with etag, then stale etag', async () => {
  const [a] = (await fetchCalendarObjects({ calendar, timeRange: range, headers })).filter((o) =>
    o.url.endsWith('a.ics'),
  )
  const edited = a.data.replace('SUMMARY:A weekly', 'SUMMARY:A weekly edited')
  const r1 = await updateCalendarObject({
    calendarObject: { url: a.url, data: edited, etag: a.etag },
    headers,
  })
  log('update with current etag', String(r1.status))
  const r2 = await updateCalendarObject({
    calendarObject: { url: a.url, data: edited + '', etag: a.etag },
    headers,
  })
  log('update with stale etag', String(r2.status))
})
await step('6. custom fetch is honoured (renewal / abort / limits live here)', async () => {
  let calls = 0
  const counting = (...args) => {
    calls++
    return fetch(...args)
  }
  await fetchCalendarObjects({ calendar, timeRange: range, headers, fetch: counting })
  log('requests through our fetch', String(calls))
})
await step('cleanup', async () => {
  const r = await fetch(new URL(calendar.url, ORIGIN), { method: 'DELETE', headers })
  log('DELETE calendar', String(r.status))
})
