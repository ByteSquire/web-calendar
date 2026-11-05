// The pure helpers of the groups page: name and colour rules, member lists and the share lists the
// dialog sends. The server checks the same rules; these only say what the page may send.
import { describe, expect, it } from 'vitest'
import {
  addMember,
  calendarNameProblem,
  groupNameProblem,
  isColor,
  removeMember,
  type CalendarShare,
  type GroupCalendar,
} from '../app/utils/groups/model'
import {
  extraShares,
  shareSummary,
  toShareInput,
  withShare,
  withoutShare,
} from '../app/utils/groups/shares'

const owner: CalendarShare = {
  principalType: 'group',
  principal: 'staff',
  label: 'staff',
  permission: 'write',
}
const anna: CalendarShare = {
  principalType: 'user',
  principal: 'sub-anna',
  label: 'Anna (anna)',
  permission: 'read',
}
const calendar: GroupCalendar = {
  id: 7,
  name: 'Team',
  color: '#1d4ed8',
  shares: [owner, anna],
}

describe('group names', () => {
  it.each(['staff', 'a', '1team', 'team_2.x-y', 'A'.repeat(64)])('accepts %s', (name) => {
    expect(groupNameProblem(name)).toBeNull()
  })

  it.each([
    ['empty', ''],
    ['starting with a dash', '-team'],
    ['starting with an underscore', '_team'],
    ['a space', 'the team'],
    ['too long', 'a'.repeat(65)],
    ['a slash', 'a/b'],
    ['a non-ASCII letter', 'Käse'],
  ])('refuses %s', (_label, name) => {
    expect(groupNameProblem(name)).not.toBeNull()
  })
})

describe('calendar names', () => {
  it('trims and accepts up to 100 characters', () => {
    expect(calendarNameProblem('  Team  ')).toBeNull()
    expect(calendarNameProblem('x'.repeat(100))).toBeNull()
  })

  it('refuses an empty name, one over 100 characters and control characters', () => {
    expect(calendarNameProblem('   ')).toBe('Enter a name.')
    expect(calendarNameProblem('x'.repeat(101))).toBe('Use at most 100 characters.')
    expect(calendarNameProblem('bad\u0007name')).toBe(
      'Remove the control characters from the name.',
    )
  })
})

describe('colours', () => {
  it('accepts #rrggbb and the empty choice', () => {
    expect(isColor('#1D4ED8')).toBe(true)
    expect(isColor('')).toBe(true)
  })

  it.each(['1d4ed8', '#1d4ed', '#zzzzzz', 'blue'])('refuses %s', (value) => {
    expect(isColor(value)).toBe(false)
  })
})

describe('member lists', () => {
  it('adds a person once and removes them', () => {
    const once = addMember(['a'], 'b')
    expect(once).toEqual(['a', 'b'])
    expect(addMember(once, 'b')).toEqual(['a', 'b'])
    expect(removeMember(once, 'a')).toEqual(['b'])
  })
})

describe('share lists', () => {
  it('leaves the owning group out of what can be changed', () => {
    expect(extraShares(calendar, 'staff')).toEqual([anna])
  })

  it('sends only the extra shares, without the label', () => {
    expect(toShareInput(extraShares(calendar, 'staff'))).toEqual([
      { principalType: 'user', principal: 'sub-anna', permission: 'read' },
    ])
  })

  it('adds a share, or changes the permission of the same principal', () => {
    const added = withShare([anna], { ...owner, principal: 'it', label: 'it', permission: 'read' })
    expect(added.map((item) => item.principal)).toEqual(['sub-anna', 'it'])
    const changed = withShare([anna], { ...anna, permission: 'write' })
    expect(changed).toEqual([{ ...anna, permission: 'write' }])
  })

  it('removes a share by type and principal', () => {
    expect(withoutShare([anna, owner], 'user', 'sub-anna')).toEqual([owner])
    // A group and a person with the same name are different principals.
    expect(withoutShare([owner], 'user', 'staff')).toEqual([owner])
  })

  it('summarises the shares without the owning group', () => {
    expect(shareSummary([owner], 'staff')).toBe('Not shared with anybody else.')
    expect(shareSummary([owner, anna], 'staff')).toBe('Shared with Anna (anna): Can view.')
    expect(
      shareSummary([owner, anna, { ...anna, label: 'it', permission: 'write' }], 'staff'),
    ).toBe('Shared with Anna (anna): Can view, it: Can edit.')
  })
})
