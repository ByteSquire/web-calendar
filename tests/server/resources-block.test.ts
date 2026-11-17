// @vitest-environment node
// The availability block of a booking in its resource's calendar (design §5): the text calendar
// apps show, who it names, and that a name from the identity provider cannot add a property.
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBlockLabels } from '../../server/utils/resources/block-label'
import {
  blockPath,
  blockSummary,
  buildAvailabilityBlock,
  resourceCollection,
} from '../../server/utils/resources/block'
import { openTestDb } from './api-fixtures'

const REF = '0123456789abcdef0123456789abcdef'
const booking = {
  block_ref: REF,
  resource_id: 5,
  start_at: '2026-11-05T09:00:00.000Z',
  end_at: '2026-11-05T10:00:00.000Z',
  updated_at: '2026-11-01T08:00:00.000Z',
  status: 'approved' as const,
}

function eventOf(ics: string): string[] {
  const lines = ics.split('\r\n').filter(Boolean)
  return lines.slice(lines.indexOf('BEGIN:VEVENT') + 1, lines.indexOf('END:VEVENT'))
}

describe('the block', () => {
  it('lives in the calendar of its resource', () => {
    expect(resourceCollection(5)).toBe('/_resources/resource-5/')
    expect(blockPath(5, REF)).toBe(`/_resources/resource-5/${REF}.ics`)
    expect(() => blockPath(0, REF)).toThrow()
    expect(() => blockPath(5, 'not-ours')).toThrow()
  })

  it('names who booked, and the group when the event is in a group calendar', () => {
    expect(blockSummary({ requester: 'Alice Example', group: null })).toBe(
      'Reserved by Alice Example',
    )
    expect(blockSummary({ requester: 'Alice Example', group: 'staff' })).toBe(
      'Reserved by Alice Example (staff)',
    )
    expect(blockSummary({ requester: null, group: null })).toBe('Reserved')
    const ics = buildAvailabilityBlock(booking, { requester: 'Alice Example', group: 'staff' })!
    expect(eventOf(ics)).toContain('SUMMARY:Reserved by Alice Example (staff)')
    expect(ics).not.toContain('STATUS')
  })

  it('is tentative while pending, and gone when declined or cancelled', () => {
    const label = { requester: 'Bob', group: null }
    expect(eventOf(buildAvailabilityBlock({ ...booking, status: 'pending' }, label)!)).toContain(
      'STATUS:TENTATIVE',
    )
    expect(buildAvailabilityBlock({ ...booking, status: 'declined' }, label)).toBeNull()
    expect(buildAvailabilityBlock({ ...booking, status: 'cancelled' }, label)).toBeNull()
  })

  it('escapes a name, so it cannot add a property or end the event', () => {
    const ics = buildAvailabilityBlock(booking, {
      requester: 'Eve\r\nATTENDEE:mailto:x@example.org\nEND:VEVENT;x,y\\',
      group: null,
    })!
    const event = eventOf(ics)
    expect(
      event.filter((line) => /^[A-Z-]+[:;]/.test(line)).map((l) => l.split(/[:;]/)[0]),
    ).toEqual([
      'UID',
      'DTSTAMP',
      'DTSTART',
      'DTEND',
      'SUMMARY',
      'TRANSP',
      'CLASS',
      'X-WEB-CALENDAR-BLOCK',
    ])
    const summary = ics.slice(ics.indexOf('SUMMARY:')).split('\r\nTRANSP')[0]!.replace(/\r\n /g, '')
    expect(summary).toBe(
      'SUMMARY:Reserved by Eve\\nATTENDEE:mailto:x@example.org\\nEND:VEVENT\\;x\\,y\\\\',
    )
    expect(ics.split('\r\n').filter((line) => line === 'END:VEVENT')).toHaveLength(1)
  })

  it('folds a long name at 75 octets', () => {
    const ics = buildAvailabilityBlock(booking, { requester: 'Ä'.repeat(80), group: 'staff' })!
    for (const line of ics.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    const unfolded = ics.replace(/\r\n /g, '')
    expect(unfolded).toContain(`SUMMARY:Reserved by ${'Ä'.repeat(80)} (staff)`)
  })
})

describe('who a block names', () => {
  let db: Database
  let label: ReturnType<typeof createBlockLabels>
  let alice: number
  let bob: number
  let nobody: number
  let groupCalendar: number
  let bobsCalendar: number

  beforeEach(() => {
    db = openTestDb()
    const user = (sub: string, username: string | null, name: string | null) =>
      Number(
        db
          .prepare('INSERT INTO users (oidc_sub, username, name) VALUES (?, ?, ?)')
          .run(sub, username, name).lastInsertRowid,
      )
    alice = user('sub-alice', 'alice', 'Alice Example')
    bob = user('sub-bob', 'bob', null)
    nobody = user('sub-nobody', null, '  ')
    const group = Number(
      db.prepare("INSERT INTO groups (name, source) VALUES ('staff', 'app')").run().lastInsertRowid,
    )
    const calendar = (path: string) =>
      Number(
        db
          .prepare("INSERT INTO calendars (name, kind, collection_path) VALUES ('c', 'shared', ?)")
          .run(path).lastInsertRowid,
      )
    groupCalendar = calendar(`/_group-${group}/plan/`)
    bobsCalendar = calendar('/sub-bob/work/')
    label = createBlockLabels(db)
  })

  afterEach(() => db.close())

  it("is the person's name, else their user name, else none", () => {
    const path = '/x/work/'
    expect(label({ requester_id: alice, event_calendar_path: path }).requester).toBe(
      'Alice Example',
    )
    expect(label({ requester_id: bob, event_calendar_path: path }).requester).toBe('bob')
    expect(label({ requester_id: nobody, event_calendar_path: path }).requester).toBeNull()
  })

  it("is the group that owns the event's calendar, never the group it was shared with", () => {
    const of = (path: string) => label({ requester_id: alice, event_calendar_path: path }).group
    // the group's own calendar, shared with its members
    expect(of(`/sub-alice/shared-${groupCalendar}-staff/`)).toBe('staff')
    expect(of(`/sub-alice/shared-${groupCalendar}/`)).toBe('staff')
    // bob's calendar, shared with the group staff: bob's, not the group's
    expect(of(`/sub-alice/shared-${bobsCalendar}-staff/`)).toBeNull()
    // her own calendar, and a share of a calendar that is gone
    expect(of('/sub-alice/work/')).toBeNull()
    expect(of('/sub-alice/shared-999/')).toBeNull()
  })
})
