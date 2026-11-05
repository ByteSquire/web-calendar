// @vitest-environment node
// The parts of calendar links without HTTP: what a link shows of an event (the allow-list), the
// password hash, the session token and the path rule.
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword, passwordProblem } from '../../server/utils/links/password'
import { sanitizeCalendarObject } from '../../server/utils/links/sanitize'
import {
  SESSION_LIFETIME_MS,
  createLinkSession,
  readLinkSession,
} from '../../server/utils/links/session'
import { ownCalendarPath, parseRange } from '../../server/utils/links/service'
import { readCalendarObject } from '../../app/utils/ical/read'

const SUB = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'

const FULL = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Radicale//EN',
  'X-WR-CALNAME:Secret name',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'X-LIC-LOCATION:Europe/Berlin',
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
  'BEGIN:VEVENT',
  'UID:one@example.org',
  'DTSTAMP:20261101T080000Z',
  'DTSTART;TZID=Europe/Berlin:20261110T090000',
  'DTEND;TZID=Europe/Berlin:20261110T100000',
  'SUMMARY:Planning',
  'LOCATION:Room 4',
  'DESCRIPTION:The budget numbers',
  'ORGANIZER:mailto:boss@example.org',
  'ATTENDEE;CN="Anna: QA":mailto:anna@example.org',
  'ATTACH:https://files.example.org/secret.pdf',
  'URL:https://intranet.example.org/x',
  'CATEGORIES:Finance',
  'X-WEB-CALENDAR-BOOKING:block-ref-123',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder text',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const PRIVATE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:two@example.org',
  'DTSTAMP:20261101T080000Z',
  'DTSTART:20261111T090000Z',
  'DTEND:20261111T100000Z',
  'SUMMARY:Doctor',
  'LOCATION:Clinic',
  'CLASS:PRIVATE',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

describe('what a link shows of an event', () => {
  it('keeps the times, the title, the place and the time zone, and nothing else', () => {
    const clean = sanitizeCalendarObject(FULL)!
    expect(clean.blocked).toBe(false)
    for (const kept of [
      'SUMMARY:Planning',
      'LOCATION:Room 4',
      'TZID:Europe/Berlin',
      'UID:one@example.org',
    ]) {
      expect(clean.data).toContain(kept)
    }
    for (const dropped of [
      'DESCRIPTION',
      'ORGANIZER',
      'ATTENDEE',
      'ATTACH',
      'URL:',
      'CATEGORIES',
      'X-',
      'VALARM',
      'Reminder',
      'budget',
      'Secret name',
    ]) {
      expect(clean.data, dropped).not.toContain(dropped)
    }
  })

  it('shows a private event as busy: its time only', () => {
    const clean = sanitizeCalendarObject(PRIVATE)!
    expect(clean.blocked).toBe(true)
    expect(clean.data).not.toContain('Doctor')
    expect(clean.data).not.toContain('Clinic')
    expect(clean.data).toContain('DTSTART:20261111T090000Z')
  })

  it('leaves out what is not a calendar with events', () => {
    expect(sanitizeCalendarObject('not ical')).toBeNull()
    expect(sanitizeCalendarObject('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR')).toBeNull()
    expect(
      sanitizeCalendarObject(
        'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:x\r\nSUMMARY:Task\r\nEND:VTODO\r\nEND:VCALENDAR',
      ),
    ).toBeNull()
  })

  it('is read by the app’s own reader as the event it was, in the display zone', () => {
    const clean = sanitizeCalendarObject(FULL)!
    const read = readCalendarObject(clean.data, {
      calendarId: 'link',
      href: '',
      displayTimeZone: 'Europe/Berlin',
      orgTimeZone: 'Europe/Berlin',
      range: { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') },
      expandRecurrence: false,
    })
    expect(read.errors).toEqual([])
    expect(read.events).toHaveLength(1)
    expect(read.events[0]).toMatchObject({ title: 'Planning', location: 'Room 4', allDay: false })
    expect(read.events[0]!.start).toContain('2026-11-10T09:00')
    expect(read.events[0]!.description ?? '').toBe('')
  })
})

describe('the password of a link', () => {
  it('needs 8 to 200 characters', () => {
    expect(passwordProblem('short')).toMatch(/at least 8/)
    expect(passwordProblem('x'.repeat(201))).toMatch(/at most 200/)
    expect(passwordProblem(42)).toMatch(/string/)
    expect(passwordProblem('correct horse')).toBeNull()
  })

  it('is stored as a salted scrypt hash and checked against it', async () => {
    const stored = await hashPassword('correct horse')
    expect(stored).toMatch(/^scrypt\$15\$8\$1\$/)
    expect(stored).not.toContain('correct horse')
    expect(await hashPassword('correct horse')).not.toBe(stored)
    expect(await verifyPassword('correct horse', stored)).toBe(true)
    expect(await verifyPassword('correct horsf', stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
  })

  it('never matches a damaged hash, and refuses one that would ask for huge memory', async () => {
    const stored = await hashPassword('correct horse')
    expect(await verifyPassword('correct horse', stored.replace(/.$/, 'A'))).toBe(false)
    expect(await verifyPassword('correct horse', stored.replace('scrypt$15$', 'scrypt$30$'))).toBe(
      false,
    )
    expect(await verifyPassword('correct horse', 'plain')).toBe(false)
  })
})

describe('the session of a link page', () => {
  const now = new Date('2026-11-05T10:00:00Z')
  const keyring = {
    current: { version: 2, key: 'new-key' },
    keys: [
      { version: 2, key: 'new-key' },
      { version: 1, key: 'old-key' },
    ],
  }

  it('names its link and works until it ends', () => {
    const { token, expiresAt } = createLinkSession(keyring, 7, now)
    expect(readLinkSession(keyring, token, now)).toBe(7)
    expect(Date.parse(expiresAt) - now.getTime()).toBe(SESSION_LIFETIME_MS)
    expect(
      readLinkSession(keyring, token, new Date(now.getTime() + SESSION_LIFETIME_MS)),
    ).toBeNull()
  })

  it('cannot be changed to another link or a later end, or made with another key', () => {
    const { token } = createLinkSession(keyring, 7, now)
    const parts = token.split('.')
    expect(
      readLinkSession(keyring, [parts[0], parts[1], '8', parts[3], parts[4]].join('.'), now),
    ).toBeNull()
    expect(
      readLinkSession(
        keyring,
        [parts[0], parts[1], parts[2], String(Number(parts[3]) + 1), parts[4]].join('.'),
        now,
      ),
    ).toBeNull()
    const other = createLinkSession({ current: { version: 2, key: 'other' }, keys: [] }, 7, now)
    expect(readLinkSession(keyring, other.token, now)).toBeNull()
    expect(readLinkSession(keyring, undefined, now)).toBeNull()
    expect(readLinkSession(keyring, 'garbage', now)).toBeNull()
  })

  it('made with a key that is still listed works after a rotation', () => {
    const old = createLinkSession('old-key', 7, now)
    expect(readLinkSession(keyring, old.token, now)).toBe(7)
    expect(
      readLinkSession(
        { current: { version: 2, key: 'new-key' }, keys: [{ version: 2, key: 'new-key' }] },
        old.token,
        now,
      ),
    ).toBeNull()
  })
})

describe('which calendar a link may name', () => {
  it('is one calendar in the caller’s own home, as the app addresses it', () => {
    expect(ownCalendarPath(`/caldav/${SUB}/work/`, SUB)).toBe(`/${SUB}/work/`)
    expect(ownCalendarPath(`/caldav/${SUB}/Team%20plan/`, SUB)).toBe(`/${SUB}/Team plan/`)
  })

  it('is not another person’s home, a home, an event or a path that tries to leave', () => {
    for (const href of [
      `/caldav/other/work/`,
      `/caldav/${SUB}/`,
      `/caldav/${SUB}/work/event.ics`,
      `/caldav/${SUB}/work`,
      `/caldav/${SUB}/../other/work/`,
      `/caldav/${SUB}/%2e%2e/work/`,
      `/${SUB}/work/`,
      `/caldav/.sharing/x/`,
      `/caldav/${SUB}/work/?a=1`,
      'https://evil.example/caldav/x/y/',
    ]) {
      expect(ownCalendarPath(href, SUB), href).toBeNull()
    }
  })
})

describe('the time range of a read', () => {
  it('takes date-times up to 400 days apart, end after start', () => {
    expect(parseRange('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z').ok).toBe(true)
    expect(parseRange('2026-01-01T00:00:00Z', '2027-02-04T00:00:00Z').ok).toBe(true)
    for (const [from, to] of [
      ['2026-12-01T00:00:00Z', '2026-11-01T00:00:00Z'],
      ['2026-01-01T00:00:00Z', '2027-03-01T00:00:00Z'],
      ['nope', '2026-11-01T00:00:00Z'],
      [undefined, '2026-11-01T00:00:00Z'],
      ['x'.repeat(50), 'y'],
    ]) {
      expect(parseRange(from, to).ok, `${from} ${to}`).toBe(false)
    }
  })
})
