// @vitest-environment node
// FR-7, importing a file: what the person is shown before importing. Everything echoed from the
// file (its name, the calendar name, titles) is cleaned of characters that break or reorder a line.
import { describe, expect, it } from 'vitest'
import { displayText, NO_TITLE, planImport, titleOf } from '../app/utils/import/preview'
import { fixture } from './ical-read-helpers'

const char = (...codes: number[]): string => String.fromCodePoint(...codes)
const crlf = (lines: string[]): string => lines.join('\r\n') + '\r\n'
const event = (...lines: string[]): string[] => [
  'BEGIN:VEVENT',
  'DTSTART:20261110T100000Z',
  ...lines,
  'END:VEVENT',
]

describe('displayText', () => {
  it('turns control characters and line breaks into one space and trims', () => {
    expect(displayText('  Team\r\nmeeting\t\u0007now\u0000  ')).toBe('Team meeting now')
    expect(displayText(char(0x85, 0x2028, 0x2029) + 'a' + char(0x7f) + 'b')).toBe('a b')
  })

  it('removes the characters that reorder or hide text', () => {
    // Embeddings, overrides, isolates, marks and the byte order mark.
    const bidi = char(0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069)
    expect(displayText(`gnp${char(0x202e)}.exe`)).toBe('gnp .exe')
    expect(displayText(`a${bidi}b`)).toBe('a b')
    expect(displayText(`${char(0xfeff)}x${char(0x200e, 0x200f, 0x061c)}y`)).toBe('x y')
  })

  it('keeps what belongs in a name: accents, scripts, emoji and joiners', () => {
    expect(displayText('Café 日本語 العربية')).toBe('Café 日本語 العربية')
    const family = char(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
    expect(displayText(`Party ${family}`)).toBe(`Party ${family}`)
  })

  it('writes composed characters in one form', () => {
    expect(displayText('Cafe' + char(0x301))).toBe('Caf' + char(0xe9))
  })

  it('does not touch markup: the UI shows it as text, which cannot run', () => {
    expect(displayText('<img src=x onerror=alert(1)> & <script>')).toBe(
      '<img src=x onerror=alert(1)> & <script>',
    )
  })

  it('cuts a long text at the limit, on a character, with an ellipsis', () => {
    expect(displayText('x'.repeat(120))).toBe('x'.repeat(120))
    expect(displayText('x'.repeat(121))).toBe(`${'x'.repeat(119)}…`)
    expect(displayText('😀'.repeat(200), 10)).toBe(`${'😀'.repeat(9)}…`)
    // Without a pass over the whole value: it can be as long as the file.
    expect(displayText('y'.repeat(5 * 1024 * 1024))).toBe(`${'y'.repeat(119)}…`)
  })

  it('is empty when nothing is left', () => {
    expect(displayText('')).toBe('')
    expect(displayText(char(0, 1, 2, 0x202e) + '  \r\n ')).toBe('')
  })
})

describe('titleOf', () => {
  it('is the cleaned title, or a placeholder for an event without one', () => {
    expect(titleOf('Lunch\nwith  Sam')).toBe('Lunch with Sam')
    expect(titleOf('')).toBe(NO_TITLE)
    expect(titleOf(char(0x202e, 0))).toBe(NO_TITLE)
  })
})

describe('the plan of a file', () => {
  it('counts the events, names the calendar and lists the first titles', async () => {
    const result = await planImport('team.ics', fixture('import-recurring-overrides.ics'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.preview).toEqual({
      fileName: 'team.ics',
      calendarName: 'Team calendar',
      // The series with its two changed occurrences is one event.
      events: 2,
      sample: ['Weekly planning', 'Lunch'],
      skipped: [],
      skippedCount: 0,
    })
    expect(result.plan.resources.map((r) => r.uid)).toEqual([
      'series-1@example.com',
      'single-1@example.com',
    ])
  })

  it('says what is not imported, one line per kind with its count', async () => {
    const result = await planImport('mixed.ics', fixture('import-mixed.ics'))
    if (!result.ok) throw new Error(result.message)
    expect(result.plan.preview.events).toBe(5)
    expect(result.plan.preview.skippedCount).toBe(7)
    expect(result.plan.preview.skipped).toEqual([
      { text: '1 to-do (only events are imported)', count: 1 },
      { text: '1 journal entry (only events are imported)', count: 1 },
      { text: '1 free/busy block (only events are imported)', count: 1 },
      { text: '1 event without a start time', count: 1 },
      { text: '1 repeated event (the same ID as an earlier one in the file)', count: 1 },
      { text: '2 damaged items that could not be read', count: 2 },
    ])
    expect(result.plan.preview.calendarName).toBe('Projects')
  })

  it('counts several of a kind together, and other components as "other items"', async () => {
    const todo = (n: number) => ['BEGIN:VTODO', `UID:t${n}`, 'END:VTODO']
    const text = crlf([
      'BEGIN:VCALENDAR',
      ...todo(1),
      ...todo(2),
      ...todo(3),
      'BEGIN:X-THING',
      'END:X-THING',
      'BEGIN:VAVAILABILITY',
      'END:VAVAILABILITY',
      'END:VCALENDAR',
    ])
    const result = await planImport('x.ics', text)
    if (!result.ok) throw new Error(result.message)
    expect(result.plan.preview.skipped).toEqual([
      { text: '3 to-dos (only events are imported)', count: 3 },
      { text: '2 other items (only events are imported)', count: 2 },
    ])
    expect(result.plan.preview.events).toBe(0)
  })

  it('is a plan with no events for a calendar that holds none', async () => {
    const result = await planImport(
      'empty.ics',
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n',
    )
    expect(result.ok && result.plan.preview.events).toBe(0)
  })

  it('cleans every text it takes from the file', async () => {
    const text = crlf([
      'BEGIN:VCALENDAR',
      `X-WR-CALNAME:Work${char(0x202e)}live${char(7)}`,
      ...event('UID:a', `SUMMARY:<b>Bold</b>${char(0x202e)}\\nsecond line`),
      ...event('UID:b', 'SUMMARY:' + 'z'.repeat(500)),
      ...event('UID:c'),
      'END:VCALENDAR',
    ])
    const result = await planImport(`evil${char(0x202e)}name\r\n.ics`, text)
    if (!result.ok) throw new Error(result.message)
    expect(result.plan.preview.fileName).toBe('evil name .ics')
    expect(result.plan.preview.calendarName).toBe('Work live')
    expect(result.plan.preview.sample).toEqual([
      '<b>Bold</b> second line',
      `${'z'.repeat(119)}…`,
      NO_TITLE,
    ])
  })

  it('gives a nameless calendar and an empty file name a null and a placeholder', async () => {
    const result = await planImport(char(0x202e), fixture('d-floating.ics'))
    if (!result.ok) throw new Error(result.message)
    expect(result.plan.preview.calendarName).toBeNull()
    expect(result.plan.preview.fileName).toBe('Calendar file')
  })

  it('shows at most the first five titles', async () => {
    const text = crlf([
      'BEGIN:VCALENDAR',
      ...Array.from({ length: 12 }, (_, i) => event(`UID:e${i}`, `SUMMARY:Event ${i}`)).flat(),
      'END:VCALENDAR',
    ])
    const result = await planImport('x.ics', text)
    if (!result.ok) throw new Error(result.message)
    expect(result.plan.preview.events).toBe(12)
    expect(result.plan.preview.sample).toEqual([
      'Event 0',
      'Event 1',
      'Event 2',
      'Event 3',
      'Event 4',
    ])
  })

  it('refuses text that is no calendar, and an old format, with words', async () => {
    expect(await planImport('x.ics', fixture('garbage.ics'))).toEqual({
      ok: false,
      message: 'This is not an iCalendar (.ics) file.',
    })
    const old = crlf(['BEGIN:VCALENDAR', 'VERSION:1.0', ...event('UID:a'), 'END:VCALENDAR'])
    expect(await planImport('x.ics', old)).toEqual({
      ok: false,
      message: 'This file is in an old calendar format (vCalendar 1.0), which cannot be imported.',
    })
  })
})
