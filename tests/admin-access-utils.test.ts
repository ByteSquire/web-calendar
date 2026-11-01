import { describe, expect, it } from 'vitest'
import {
  describeSaveProblem,
  isGroupName,
  levelLabel,
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

  it.each([
    ['staff', true],
    ['team.a-b_c', true],
    ['', false],
    ['-staff', false],
    ['a/b', false],
    ['staff@idm.example.org', false],
    ['x'.repeat(65), false],
  ])('checks the group name %j', (name, ok) => {
    expect(isGroupName(name)).toBe(ok)
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
      fields: [{ field: 'rules[1].principal', message: 'is not a Kanidm group' }],
    })
    expect(describeSaveProblem(cause, sent, labelOf)).toBe(
      'Nothing was changed. <nope> is not a Kanidm group.',
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
