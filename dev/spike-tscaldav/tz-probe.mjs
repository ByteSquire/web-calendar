// Does Radicale store CALDAV:calendar-timezone, and does it use it for floating times?
const RADICALE = process.env.RADICALE_URL ?? 'http://radicale:5232'
const sub = process.env.SUB
const headers = { 'X-Remote-User': sub }
const path = `/${sub}/tzprobe-${Date.now()}/`
const req = (method, p, extra = {}, body) =>
  fetch(RADICALE + p, { method, headers: { ...headers, ...extra }, body })
const VTZ = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//probe//EN',
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
  'END:VCALENDAR',
].join('\r\n')

const mk = await req(
  'MKCALENDAR',
  path,
  { 'content-type': 'application/xml' },
  `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>
<D:displayname>tz probe</D:displayname>
<C:calendar-timezone>${VTZ}</C:calendar-timezone>
</D:prop></D:set></C:mkcalendar>`,
)
console.log(
  'MKCALENDAR with calendar-timezone:',
  mk.status,
  mk.status >= 400 ? await mk.text() : '',
)

const pf = await req(
  'PROPFIND',
  path,
  { 'content-type': 'application/xml', depth: '0' },
  `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-timezone/><D:displayname/></D:prop></D:propfind>`,
)
const pfText = await pf.text()
console.log('PROPFIND status:', pf.status)
console.log(
  'calendar-timezone returned:',
  /calendar-timezone>[\s\S]*TZID:Europe\/Berlin/.test(pfText) ? 'yes (stored)' : 'NO',
)
console.log(
  pfText
    .split('\n')
    .filter((l) => /status|calendar-timezone/.test(l))
    .join('\n')
    .slice(0, 400),
)

// A floating 10:00 on 2026-11-04. Berlin is UTC+1 then, so 10:00 Berlin would be 09:00Z.
const ics = (uid, lines) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T000000Z\r\n${lines}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
const put = await req(
  'PUT',
  `${path}float.ics`,
  { 'content-type': 'text/calendar' },
  ics('float', 'SUMMARY:floating\r\nDTSTART:20261104T100000\r\nDTEND:20261104T110000'),
)
console.log('PUT floating event:', put.status)
const fb = await req(
  'REPORT',
  path,
  { 'content-type': 'application/xml', depth: '1' },
  `<?xml version="1.0"?><C:free-busy-query xmlns:C="urn:ietf:params:xml:ns:caldav"><C:time-range start="20261104T000000Z" end="20261105T000000Z"/></C:free-busy-query>`,
)
const fbText = await fb.text()
console.log(
  'free-busy of the floating 10:00:',
  fbText
    .split(/\r?\n/)
    .filter((l) => l.startsWith('FREEBUSY'))
    .join(' '),
  '(09:00Z would mean calendar-timezone is used, 10:00Z means floating is read as UTC)',
)
const query = async (start, end) => {
  const r = await req(
    'REPORT',
    path,
    { 'content-type': 'application/xml', depth: '1' },
    `<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${start}" end="${end}"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`,
  )
  return /float\.ics/.test(await r.text())
}
console.log(
  'time-range 09:00Z-09:30Z finds it:',
  await query('20261104T090000Z', '20261104T093000Z'),
)
console.log(
  'time-range 10:00Z-10:30Z finds it:',
  await query('20261104T100000Z', '20261104T103000Z'),
)
console.log('DELETE:', (await req('DELETE', path)).status)
