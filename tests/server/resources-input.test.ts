// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { shortGroupNames } from '../../server/utils/resources/caller'
import {
  parseBookingInput,
  parseResourceAcl,
  parseResourceCreate,
  parseResourceUpdate,
} from '../../server/utils/resources/input'

const UUID = '3f2b8c1e-8a7d-4c1b-9d55-0a1b2c3d4e5f'

describe('parseBookingInput', () => {
  const ok = {
    startAt: '2026-11-05T09:00:00Z',
    endAt: '2026-11-05T10:00:00+01:00',
    eventUid: 'abc',
  }

  it('accepts a slot and defaults the calendar to null', () => {
    expect(parseBookingInput({ ...ok, endAt: '2026-11-05T10:00:00Z' }, 3)).toEqual({
      ok: true,
      value: {
        resourceId: 3,
        startAt: ok.startAt,
        endAt: '2026-11-05T10:00:00Z',
        eventCalendarId: null,
        eventUid: 'abc',
      },
    })
  })

  it.each([
    ['not an object', 'x'],
    ['a date without a zone', { ...ok, startAt: '2026-11-05T09:00:00' }],
    ['an end before the start', { ...ok, endAt: '2026-11-05T07:00:00Z' }],
    ['no uid', { ...ok, eventUid: ' ' }],
    ['a calendar id that is a string', { ...ok, eventCalendarId: '3' }],
  ])('refuses %s', (_name, body) => {
    expect(parseBookingInput(body, 3).ok).toBe(false)
  })
})

describe('resource bodies', () => {
  it('validates a new resource', () => {
    expect(parseResourceCreate({ name: ' Room ', type: 'room', capacity: 6 })).toEqual({
      ok: true,
      value: { name: 'Room', type: 'room', capacity: 6, location: null, description: null },
    })
    expect(parseResourceCreate({ name: '', type: 'boat' }).ok).toBe(false)
    expect(parseResourceCreate({ name: 'x', type: 'car', capacity: 0 }).ok).toBe(false)
  })

  it('needs something to change and keeps omitted fields out', () => {
    expect(parseResourceUpdate({}).ok).toBe(false)
    expect(parseResourceUpdate({ location: null, active: false })).toEqual({
      ok: true,
      value: { location: null, active: false },
    })
  })
})

describe('parseResourceAcl', () => {
  it('accepts read, book and manage for users, groups and authenticated', () => {
    const parsed = parseResourceAcl({
      rules: [
        { principalType: 'user', principal: UUID.toUpperCase(), right: 'manage' },
        { principalType: 'group', principal: 'Facility_Team', right: 'book' },
        { principalType: 'authenticated', right: 'read' },
      ],
    })
    expect(parsed).toEqual({
      ok: true,
      value: [
        { principalType: 'user', principal: UUID, right: 'manage' },
        { principalType: 'group', principal: 'Facility_Team', right: 'book' },
        { principalType: 'authenticated', principal: null, right: 'read' },
      ],
    })
  })

  it.each([
    ['write', { principalType: 'authenticated', right: 'write' }],
    ['admin', { principalType: 'authenticated', right: 'admin' }],
    ['public', { principalType: 'public', right: 'read' }],
    ['a user that is not a UUID', { principalType: 'user', principal: 'alice', right: 'read' }],
    ['a group with a slash', { principalType: 'group', principal: 'a/b', right: 'read' }],
    [
      'authenticated with a principal',
      { principalType: 'authenticated', principal: 'x', right: 'read' },
    ],
  ])('refuses %s', (_name, rule) => {
    expect(parseResourceAcl({ rules: [rule] }).ok).toBe(false)
  })

  it('refuses a body without a list', () => {
    expect(parseResourceAcl({}).ok).toBe(false)
  })
})

describe('shortGroupNames', () => {
  it('strips the domain, drops what is no group name and sorts', () => {
    expect(shortGroupNames(['b@idm.example', 'a', 'bad name', 'a@other', ''])).toEqual(['a', 'b'])
  })
})
