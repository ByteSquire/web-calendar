// @vitest-environment node
// FR-7, importing a file: how much one import may take, and the files that are refused before
// anything is read. The file is untrusted; the limits keep the browser's work and the number of
// requests bounded.
import { describe, expect, it, vi } from 'vitest'
import {
  checkFile,
  CONCURRENCY,
  looksBinary,
  MAX_CONSECUTIVE_FAILURES,
  MAX_EVENTS,
  MAX_FILE_BYTES,
  SNIFF_BYTES,
} from '../app/utils/import/limits'
import { prepareImport } from '../app/utils/import/preview'
import { fixture } from './ical-read-helpers'

const file = (parts: BlobPart[], name = 'calendar.ics', type = 'text/calendar') =>
  new File(parts, name, { type })

/** A file that reports a size and fails the test if anything reads it. */
function unreadable(size: number, type = 'text/calendar', name = 'calendar.ics') {
  const picked = file(['BEGIN:VCALENDAR'], name, type)
  Object.defineProperty(picked, 'size', { value: size })
  return {
    picked,
    text: vi.spyOn(picked, 'text').mockRejectedValue(new Error('read')),
    slice: vi.spyOn(picked, 'slice').mockImplementation(() => {
      throw new Error('read')
    }),
  }
}

const events = (count: number): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...Array.from({ length: count }, (_, i) =>
      ['BEGIN:VEVENT', `UID:e-${i}`, 'DTSTART:20261110T100000Z', 'END:VEVENT'].join('\r\n'),
    ),
    'END:VCALENDAR',
  ].join('\r\n')

describe('the limits', () => {
  it('are 5 MiB, 2000 events, 4 requests at a time and 5 failures in a row', () => {
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024)
    expect(MAX_EVENTS).toBe(2000)
    expect(CONCURRENCY).toBe(4)
    expect(MAX_CONSECUTIVE_FAILURES).toBe(5)
    // The gateway and Radicale cap a body at 10 MB each: the file cannot reach it by itself.
    expect(MAX_FILE_BYTES).toBeLessThan(10 * 1000 * 1000)
  })
})

describe('checkFile', () => {
  it.each([
    ['a calendar', 'text/calendar', 'x.ics'],
    ['plain text', 'text/plain', 'x.txt'],
    ['a type with a charset', 'text/calendar; charset=utf-8', 'x.ics'],
    ['no type (Windows, Linux without a registered type)', '', 'x.ics'],
    ['an unspecific type', 'application/octet-stream', 'x.ics'],
    ['application/ics', 'application/ics', 'x.ics'],
    ['an odd type for a calendar name', 'application/x-vendor', 'work.ICS'],
  ])('lets %s through', (_name, type, name) => {
    expect(checkFile({ name, size: 1000, type })).toBeNull()
  })

  it.each([
    ['an image', 'image/png', 'x.png'],
    ['a PDF', 'application/pdf', 'x.pdf'],
    ['an archive', 'application/zip', 'calendar.zip'],
    ['a type with the extension of nothing', 'application/json', 'x.json'],
  ])('refuses %s', (_name, type, name) => {
    expect(checkFile({ name, size: 1000, type })).toBe(
      'This does not look like a calendar file. Choose an .ics file.',
    )
  })

  it('refuses an empty file and a file over the limit, and takes the limit itself', () => {
    expect(checkFile({ name: 'x.ics', size: 0, type: '' })).toBe('The file is empty.')
    expect(checkFile({ name: 'x.ics', size: MAX_FILE_BYTES, type: '' })).toBeNull()
    const refusal = checkFile({ name: 'x.ics', size: MAX_FILE_BYTES + 1, type: '' })
    expect(refusal).toBe(
      'The file is too large (5 MB). Files up to 5 MB can be imported; split the calendar into smaller files.',
    )
    expect(checkFile({ name: 'x.ics', size: 40 * 1024 * 1024, type: '' })).toContain('40 MB')
  })
})

describe('looksBinary', () => {
  it('is true for a NUL character and false for text', () => {
    expect(looksBinary('BEGIN:VCALENDAR' + String.fromCharCode(0))).toBe(true)
    expect(looksBinary('BEGIN:VCALENDAR\r\nSUMMARY:Ünïcode 日本語\r\n')).toBe(false)
  })
})

describe('a file that is too large or no text', () => {
  it('is refused without being read', async () => {
    const { picked, text, slice } = unreadable(MAX_FILE_BYTES + 1)
    expect(await prepareImport(picked)).toEqual({
      ok: false,
      message: expect.stringContaining('too large'),
    })
    expect(text).not.toHaveBeenCalled()
    expect(slice).not.toHaveBeenCalled()
  })

  it('is refused by its type without being read', async () => {
    const { picked, text, slice } = unreadable(1000, 'image/png', 'photo.png')
    expect((await prepareImport(picked)).ok).toBe(false)
    expect(text).not.toHaveBeenCalled()
    expect(slice).not.toHaveBeenCalled()
  })

  it('is refused after its first bytes when it holds a NUL (binary, UTF-16)', async () => {
    const utf16 = new Uint8Array(200)
    'BEGIN:VCALENDAR'.split('').forEach((char, i) => (utf16[i * 2] = char.charCodeAt(0)))
    for (const content of [utf16, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])]) {
      const picked = file([content], 'x.ics', '')
      const text = vi.spyOn(picked, 'text')
      expect(await prepareImport(picked)).toEqual({
        ok: false,
        message: 'This is not a text file. Choose an .ics file saved as UTF-8 text.',
      })
      // Only the first bytes were read: `text` is the file's, the head comes from `slice`.
      expect(text).not.toHaveBeenCalled()
    }
  })

  it('looks only at the first SNIFF_BYTES for binary content', async () => {
    const head = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-JUNK:' + 'x'.repeat(SNIFF_BYTES) + '\r\n'
    const picked = file([head, String.fromCharCode(0), '\r\nEND:VCALENDAR\r\n'])
    // A NUL further in is not looked for: the content is judged when it is split.
    expect((await prepareImport(picked)).ok).toBe(true)
  })

  it('is refused when it is no calendar after all', async () => {
    expect(await prepareImport(file([fixture('garbage.ics')], 'page.ics'))).toEqual({
      ok: false,
      message: 'This is not an iCalendar (.ics) file.',
    })
  })

  it('does not throw when the file cannot be read', async () => {
    const picked = file(['BEGIN:VCALENDAR'])
    vi.spyOn(picked, 'slice').mockImplementation(() => {
      throw new Error('gone')
    })
    expect(await prepareImport(picked)).toEqual({
      ok: false,
      message: 'The file could not be read.',
    })
  })
})

describe('the number of events', () => {
  it('takes 2000 and refuses 2001, saying how many the file has', async () => {
    const accepted = await prepareImport(file([events(MAX_EVENTS)]))
    expect(accepted.ok && accepted.plan.preview.events).toBe(2000)

    expect(await prepareImport(file([events(MAX_EVENTS + 1)]))).toEqual({
      ok: false,
      message:
        'The file has 2001 events, more than the 2000 that can be imported at once. ' +
        'Split the calendar into smaller files.',
    })
  })

  it('counts a series with its changed occurrences once', async () => {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0']
    for (let i = 0; i < 2500; i++) {
      lines.push(
        'BEGIN:VEVENT',
        'UID:series',
        `RECURRENCE-ID:2026${String(i).padStart(4, '0')}T100000Z`,
      )
      lines.push('DTSTART:20261110T100000Z', 'END:VEVENT')
    }
    lines.push('END:VCALENDAR')
    const result = await prepareImport(file([lines.join('\r\n')]))
    expect(result.ok && result.plan.preview.events).toBe(1)
  })
})

describe('a file of the largest size', () => {
  it('is read and split: one event with a very large description', async () => {
    const padding = 'x'.repeat(MAX_FILE_BYTES - 200)
    const text = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:big\r\nDTSTART:20261110T100000Z\r\nDESCRIPTION:${padding}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
    expect(text.length).toBeLessThanOrEqual(MAX_FILE_BYTES)
    const result = await prepareImport(file([text]))
    expect(result.ok && result.plan.preview.events).toBe(1)
  })

  it('is refused one byte over, though it is only padding', async () => {
    const text = 'x'.repeat(MAX_FILE_BYTES + 1)
    const result = await prepareImport(file([text]))
    expect(result.ok).toBe(false)
  })
})
