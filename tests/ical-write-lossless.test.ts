// @vitest-environment node
// An edit of an event written by another client must change only what the user changed: attendees
// with parameters, alarms, X- properties, unusual rule parts, overrides and VTIMEZONEs all come back.
import { describe, expect, it } from 'vitest'
import { editEventResource, type WriteContext } from '../app/utils/ical/write'
import { contentLines, expand, splitEvents } from './ical-write-helpers'

const NOW = new Date('2026-10-30T12:00:00Z')
const BERLIN: WriteContext = {
  displayTimeZone: 'Europe/Berlin',
  orgTimeZone: 'Europe/Berlin',
  now: NOW,
}

/** A custom VTIMEZONE in the style of Outlook, deliberately not what the generator would write. */
const CUSTOM_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'X-LIC-LOCATION:Europe/Berlin',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
]

const LONG_DESCRIPTION =
  'DESCRIPTION:Agenda for the last working day of the month\\, please read the ' +
  'attached notes first.\\nItem 1: budget\\; item 2: hiring\\n\\nBring the printed copy - ' +
  "the room has no projector and the cleaning crew arrives at five o'clock sharp."

/** Folded exactly the way a client folds at 75 octets, so the fold itself is part of the proof. */
function fold(line: string): string {
  const parts: string[] = []
  let rest = line
  let width = 75
  while (rest.length > width) {
    parts.push(rest.slice(0, width))
    rest = rest.slice(width)
    width = 74
  }
  parts.push(rest)
  return parts.join('\r\n ')
}

const KITCHEN_SINK = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN',
  'X-WR-CALNAME:Team',
  ...CUSTOM_VTIMEZONE,
  'BEGIN:VEVENT',
  'CREATED:20260801T080000Z',
  'LAST-MODIFIED:20260901T080000Z',
  'DTSTAMP:20260901T080000Z',
  'UID:kitchen-sink@example.com',
  'SUMMARY:Month end review',
  'ORGANIZER;CN=Alice Example;SENT-BY="mailto:assistant@example.com":mailto:alice@example.com',
  'ATTENDEE;CN="Doe, John";PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT;RSVP=TRUE;X-NUM-GUESTS=0:mailto:john@example.com',
  'ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION;CUTYPE=INDIVIDUAL;DELEGATED-FROM="mailto:carol@example.com":mailto:bob@example.com',
  'DTSTART;TZID=W. Europe Standard Time:20260831T170000',
  'DTEND;TZID=W. Europe Standard Time:20260831T180000',
  'RRULE:BYSETPOS=-1;FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;WKST=SU',
  'RDATE;TZID=W. Europe Standard Time:20261225T100000',
  'EXDATE;TZID=W. Europe Standard Time:20261130T170000',
  'CATEGORIES:Work,Meeting',
  'CATEGORIES:Finance\\, Q4',
  'LOCATION:Room 1\\, Floor 2',
  LONG_DESCRIPTION,
  'CLASS:PUBLIC',
  'TRANSP:OPAQUE',
  'PRIORITY:5',
  'GEO:52.520008;13.404954',
  'X-CUSTOM-PROP;X-PARAM=1:keep\\nme\\, ok',
  'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="Foo\\nBar 1";X-TITLE=Home:geo:52.5,13.4',
  'X-MOZ-GENERATION:3',
  'ATTACH;FMTTYPE=application/pdf:https://example.com/notes.pdf',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER;RELATED=END:-PT15M',
  'DESCRIPTION:Reminder',
  'X-WR-ALARMUID:ABC',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:kitchen-sink@example.com',
  'DTSTAMP:20260901T080000Z',
  'SUMMARY:Month end review (moved)',
  'RECURRENCE-ID;TZID=W. Europe Standard Time:20260930T170000',
  'DTSTART;TZID=W. Europe Standard Time:20260930T130000',
  'DTEND;TZID=W. Europe Standard Time:20260930T140000',
  'SEQUENCE:1',
  'X-OVERRIDE-ONLY:yes',
  'END:VEVENT',
  'END:VCALENDAR',
]
  .map(fold)
  .join('\r\n')
  .concat('\r\n')

const lines = (ics: string): string[] => contentLines(ics)

describe('lossless edits', () => {
  it('a title edit keeps every other line of the master and the override exactly', () => {
    const { updated, created } = editEventResource(
      KITCHEN_SINK,
      { kind: 'series' },
      { title: 'Month end review (renamed)' },
      BERLIN,
    )
    expect(created).toBeNull()
    expect(updated).not.toBeNull()
    const [masterBefore = [], overrideBefore = []] = splitEvents(KITCHEN_SINK)
    const [masterAfter = [], overrideAfter = []] = splitEvents(updated!)
    expect(overrideAfter).toEqual(overrideBefore)

    // Only SUMMARY changed, plus the bookkeeping lines; everything else is in place, in order.
    const bookkeeping = ['SUMMARY:', 'SEQUENCE:', 'DTSTAMP:', 'LAST-MODIFIED:']
    const isBookkeeping = (line: string) => bookkeeping.some((prefix) => line.startsWith(prefix))
    expect(masterAfter.filter((line) => !isBookkeeping(line))).toEqual(
      masterBefore.filter((line) => !isBookkeeping(line)),
    )
    expect(masterAfter.filter(isBookkeeping).sort()).toEqual(
      [
        'DTSTAMP:20261030T120000Z',
        'LAST-MODIFIED:20261030T120000Z',
        'SEQUENCE:1',
        'SUMMARY:Month end review (renamed)',
      ].sort(),
    )
  })

  it('untouched lines keep their original folding byte for byte', () => {
    const { updated } = editEventResource(KITCHEN_SINK, { kind: 'series' }, { title: 'X' }, BERLIN)
    for (const line of KITCHEN_SINK.split(/\r\n(?! )/).filter(Boolean)) {
      if (
        line.startsWith('SUMMARY:') ||
        line.startsWith('DTSTAMP:') ||
        line.startsWith('LAST-MODIFIED:')
      ) {
        continue
      }
      expect(updated).toContain(line)
    }
  })

  it('keeps the RRULE string, the parameters and the VTIMEZONE byte-identical', () => {
    const { updated } = editEventResource(
      KITCHEN_SINK,
      { kind: 'series' },
      { title: 'Renamed', location: 'Elsewhere', status: 'tentative' },
      BERLIN,
    )
    const after = lines(updated!)
    expect(after).toContain('RRULE:BYSETPOS=-1;FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;WKST=SU')
    expect(after).toContain(
      'ATTENDEE;CN="Doe, John";PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT;RSVP=TRUE;X-NUM-GUESTS=0:mailto:john@example.com',
    )
    expect(after).toContain(
      'ORGANIZER;CN=Alice Example;SENT-BY="mailto:assistant@example.com":mailto:alice@example.com',
    )
    expect(after).toContain(
      'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="Foo\\nBar 1";X-TITLE=Home:geo:52.5,13.4',
    )
    expect(after).toContain('X-CUSTOM-PROP;X-PARAM=1:keep\\nme\\, ok')
    expect(after).toContain('CATEGORIES:Work,Meeting')
    expect(after).toContain('CATEGORIES:Finance\\, Q4')
    expect(after).toContain('TRIGGER;RELATED=END:-PT15M')
    expect(after).toContain('X-WR-ALARMUID:ABC')
    expect(after).toContain('LOCATION:Elsewhere')
    expect(after).toContain('STATUS:TENTATIVE')
    for (const line of CUSTOM_VTIMEZONE) expect(after).toContain(line)
    expect(updated!.endsWith('\r\n')).toBe(true)
    expect(updated).not.toMatch(/[^\r]\n/)
  })

  it('leaves the override alone and touches only the edited component', () => {
    const { updated } = editEventResource(KITCHEN_SINK, { kind: 'series' }, { title: 'T' }, BERLIN)
    const [masterBefore = [], overrideBefore = []] = splitEvents(KITCHEN_SINK)
    const [masterAfter = [], overrideAfter = []] = splitEvents(updated!)
    expect(overrideAfter).toEqual(overrideBefore)
    expect(masterAfter).not.toEqual(masterBefore)
  })

  it('refreshes SEQUENCE, DTSTAMP and LAST-MODIFIED on the touched component only', () => {
    const { updated } = editEventResource(KITCHEN_SINK, { kind: 'series' }, { title: 'T' }, BERLIN)
    const [master] = splitEvents(updated!)
    expect(master).toContain('SEQUENCE:1')
    expect(master).toContain('DTSTAMP:20261030T120000Z')
    expect(master).toContain('LAST-MODIFIED:20261030T120000Z')
    const again = editEventResource(updated!, { kind: 'series' }, { title: 'T2' }, BERLIN)
    expect(splitEvents(again.updated!)[0]).toContain('SEQUENCE:2')
  })

  it('returns the text untouched when the changes equal what is there', () => {
    const { updated } = editEventResource(
      KITCHEN_SINK,
      { kind: 'series' },
      {
        title: 'Month end review',
        location: 'Room 1, Floor 2',
        status: 'confirmed',
        categoryNames: ['Work', 'Meeting', 'Finance, Q4'],
      },
      BERLIN,
    )
    expect(updated).toBe(KITCHEN_SINK)
  })

  it('writes description changes escaped and drops a stale HTML copy', () => {
    const source = KITCHEN_SINK.replace(
      'BEGIN:VALARM',
      'X-ALT-DESC;FMTTYPE=text/html:<html>old</html>\r\nBEGIN:VALARM',
    )
    const { updated } = editEventResource(
      source,
      { kind: 'series' },
      { description: 'Line one\nLine two, with; special \\ chars' },
      BERLIN,
    )
    const after = lines(updated!)
    expect(after).toContain('DESCRIPTION:Line one\\nLine two\\, with\\; special \\\\ chars')
    expect(after.some((l) => l.startsWith('X-ALT-DESC'))).toBe(false)
  })

  it('removes a property when the change is null', () => {
    const { updated } = editEventResource(
      KITCHEN_SINK,
      { kind: 'series' },
      { description: null, location: null },
      BERLIN,
    )
    const after = lines(updated!)
    expect(after.some((l) => l.startsWith('DESCRIPTION:Agenda'))).toBe(false)
    expect(after.some((l) => l.startsWith('LOCATION:'))).toBe(false)
    // The alarm's own DESCRIPTION belongs to the VALARM and stays.
    expect(after).toContain('DESCRIPTION:Reminder')
  })

  it('replaces the categories with one line', () => {
    const { updated } = editEventResource(
      KITCHEN_SINK,
      { kind: 'series' },
      { categoryNames: ['Ops', 'A,B'] },
      BERLIN,
    )
    const after = lines(updated!)
    expect(after.filter((l) => l.startsWith('CATEGORIES'))).toEqual(['CATEGORIES:Ops,A\\,B'])
  })

  it('the edited resource still expands to the same occurrences', () => {
    const before = expand(KITCHEN_SINK, 12)
    const { updated } = editEventResource(KITCHEN_SINK, { kind: 'series' }, { title: 'T' }, BERLIN)
    const after = expand(updated!, 12)
    expect(after.map((o) => o.utc)).toEqual(before.map((o) => o.utc))
    expect(after.map((o) => o.summary)).toEqual(
      before.map((o) => (o.summary.includes('moved') ? o.summary : 'T')),
    )
  })

  it('accepts LF line endings and a BOM and writes CRLF', () => {
    const lf = String.fromCharCode(0xfeff) + KITCHEN_SINK.replace(/\r\n/g, '\n')
    const { updated } = editEventResource(lf, { kind: 'series' }, { title: 'T' }, BERLIN)
    expect(updated).not.toMatch(/[^\r]\n/)
    expect(lines(updated!)).toContain('SUMMARY:T')
  })
})
