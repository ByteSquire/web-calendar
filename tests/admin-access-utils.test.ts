import { describe, expect, it } from 'vitest'
import {
  calendarLabel,
  describeSaveProblem,
  levelLabel,
  linkedCalendar,
  matchUsers,
  userLabel,
  withRule,
  withoutRule,
  type AccessRule,
  type AccessUser,
} from '../app/utils/admin/access'

const rule = (id: number, extra: Partial<AccessRule> = {}): AccessRule => ({
  id,
  principalType: 'user',
  principal: `u${id}`,
  label: `Person ${id}`,
  permission: 'read',
  applied: true,
  appliedAt: '2026-11-01T10:00:00.000Z',
  ...extra,
})

describe('rule lists', () => {
  it('adds a rule and sends only the fields the server takes', () => {
    expect(
      withRule([rule(1)], { principalType: 'group', principal: 'staff', permission: 'write' }),
    ).toEqual([
      { principalType: 'user', principal: 'u1', permission: 'read' },
      { principalType: 'group', principal: 'staff', permission: 'write' },
    ])
  })

  it('changes the level of someone who has a rule already instead of adding a second', () => {
    expect(
      withRule([rule(1), rule(2)], { principalType: 'user', principal: 'u2', permission: 'write' }),
    ).toEqual([
      { principalType: 'user', principal: 'u1', permission: 'read' },
      { principalType: 'user', principal: 'u2', permission: 'write' },
    ])
  })

  it('treats everyone signed in as one principal', () => {
    const everyone = rule(3, { principalType: 'authenticated', principal: null })
    expect(
      withRule([everyone], {
        principalType: 'authenticated',
        principal: null,
        permission: 'free_busy',
      }),
    ).toEqual([{ principalType: 'authenticated', principal: null, permission: 'free_busy' }])
  })

  it('removes a rule by id', () => {
    expect(withoutRule([rule(1), rule(2)], 1)).toEqual([
      { principalType: 'user', principal: 'u2', permission: 'read' },
    ])
  })
})

describe('people and groups', () => {
  const users: AccessUser[] = [
    { sub: 'a', name: 'Alice Smith', username: 'alice' },
    { sub: 'b', name: null, username: 'bob' },
    { sub: 'c', name: null, username: null },
  ]

  it('words a person by name and username', () => {
    expect(users.map(userLabel)).toEqual(['Alice Smith (alice)', 'bob', 'Unnamed person'])
  })

  it('finds people in the name or the username, ignoring case, and caps the list', () => {
    expect(matchUsers(users, 'SMITH').map((u) => u.sub)).toEqual(['a'])
    expect(matchUsers(users, 'bo').map((u) => u.sub)).toEqual(['b'])
    expect(matchUsers(users, '  ').map((u) => u.sub)).toEqual(['a', 'b', 'c'])
    expect(matchUsers(users, '', 2)).toHaveLength(2)
  })

  it('has plain words for the levels', () => {
    expect(levelLabel('free_busy')).toBe('Busy times only')
    expect(levelLabel('read')).toBe('Can view')
    expect(levelLabel('write')).toBe('Can edit')
  })
})

describe('describeSaveProblem', () => {
  const sent = [
    { principalType: 'user' as const, principal: 'u1', permission: 'read' as const },
    { principalType: 'group' as const, principal: 'nope', permission: 'read' as const },
  ]
  const labelOf = (r: { principal: string | null }) => `<${r.principal}>`
  const failure = (statusCode: number, data: unknown, message = 'x') => ({
    statusCode,
    data: { statusCode, message, data },
  })

  it('names the rule the server rejected', () => {
    const cause = failure(400, {
      fields: [
        {
          field: 'rules[1].principal',
          message: 'is not a known group; an administrator can import it on the Groups page',
        },
      ],
    })
    expect(describeSaveProblem(cause, sent, labelOf)).toBe(
      'Nothing was changed. <nope> is not a known group; an administrator can import it on the Groups page.',
    )
  })

  it('words a refusal, a missing calendar and a lost connection', () => {
    expect(describeSaveProblem(failure(403, undefined), sent, labelOf)).toBe(
      'You are not allowed to manage access.',
    )
    expect(describeSaveProblem(failure(404, undefined), sent, labelOf)).toContain(
      'no longer exists',
    )
    expect(describeSaveProblem(new TypeError('Failed to fetch'), sent, labelOf)).toContain(
      'could not be reached',
    )
  })
})

describe('calendarLabel', () => {
  it('names the owner of a personal calendar, so the ones that share a name can be told apart', () => {
    expect(
      calendarLabel({ name: 'Personal Calendar', kind: 'personal', owner: 'Bob Builder' }),
    ).toBe('Personal Calendar (Bob Builder)')
    expect(calendarLabel({ name: 'Personal Calendar', kind: 'personal', owner: 'Alice' })).toBe(
      'Personal Calendar (Alice)',
    )
  })

  it('leaves the name of an organization calendar or a resource as it is', () => {
    expect(calendarLabel({ name: 'Team', kind: 'shared', owner: null })).toBe('Team')
    expect(calendarLabel({ name: 'Room 1', kind: 'resource', owner: null })).toBe('Room 1')
  })

  it('keeps the name when the owner has no name to show', () => {
    expect(calendarLabel({ name: 'Personal Calendar', kind: 'personal', owner: null })).toBe(
      'Personal Calendar',
    )
  })
})

describe('the calendar a link names', () => {
  const calendars = [
    {
      id: 6,
      name: 'Mine',
      kind: 'personal' as const,
      color: null,
      owner: 'Bob',
      collectionPath: '/u-bob/Mine/',
      rules: [],
    },
    {
      id: 7,
      name: 'Rota',
      kind: 'shared' as const,
      color: null,
      owner: null,
      collectionPath: '/_group-3/r/',
      rules: [],
    },
  ]

  it('is found by its id or by its path in Radicale', () => {
    expect(linkedCalendar(calendars, { open: '7' })?.name).toBe('Rota')
    expect(linkedCalendar(calendars, { path: '/u-bob/Mine/' })?.name).toBe('Mine')
  })

  it('is none for an unknown id or path, or a query that is no text', () => {
    expect(linkedCalendar(calendars, { open: '9' })).toBeUndefined()
    expect(linkedCalendar(calendars, { path: '/u-bob/Other/' })).toBeUndefined()
    expect(linkedCalendar(calendars, { open: ['7'] })).toBeUndefined()
    expect(linkedCalendar(calendars, {})).toBeUndefined()
  })
})
