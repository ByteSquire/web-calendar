// Groups and their calendars (the groups page): the shapes of server/api/groups/**, the rules the
// browser checks before it sends (the server checks them again and decides), and the words for
// them. The shapes are written out here so the browser bundle stays free of server code.
import { N_, t, tv } from '~/utils/i18n'

export type GroupSource = 'app' | 'kanidm'
export type SharePrincipalType = 'user' | 'group'
export type SharePermission = 'read' | 'write'

export interface GroupSummary {
  id: number
  name: string
  source: GroupSource
  memberCount: number
  /** True when the signed-in person is a member. */
  member: boolean
}

/** A person as `/api/people` and the member lists name them. */
export interface GroupPerson {
  sub: string
  name: string | null
  username: string | null
}

export interface CalendarShare {
  principalType: SharePrincipalType
  /** The `sub` of a person, the name of a group. */
  principal: string
  label: string
  permission: SharePermission
}

export interface GroupCalendar {
  id: number
  name: string
  color: string | null
  shares: CalendarShare[]
}

export interface GroupDetail {
  id: number
  name: string
  source: GroupSource
  canManageMembers: boolean
  members: GroupPerson[]
  calendars: GroupCalendar[]
}

/** The same shape the server accepts for a group name: 1..64 characters, see isGroupName. */
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const CALENDAR_NAME_MAX = 100
const COLOR = /^#[0-9a-f]{6}$/i
const CONTROL = /\p{Cc}/u

export const GROUP_LIMITS = { groupName: 64, calendarName: CALENDAR_NAME_MAX, members: 500 }

/** The name of a custom group, or null when it is fine. */
export function groupNameProblem(name: string): string | null {
  if (name.trim() === '') return t('Enter a name.')
  if (!GROUP_NAME.test(name)) {
    return t(
      'Use up to 64 letters, digits, dots, dashes and underscores. Start with a letter or a digit.',
    )
  }
  return null
}

/** The name of a calendar, trimmed, or null when it is fine. */
export function calendarNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return t('Enter a name.')
  if (trimmed.length > CALENDAR_NAME_MAX) {
    return t('Use at most {max} characters.', { max: CALENDAR_NAME_MAX })
  }
  if (CONTROL.test(trimmed)) return t('Remove the control characters from the name.')
  return null
}

/** `#rrggbb`. The empty string means "no colour" and is valid. */
export function isColor(value: string): boolean {
  return value === '' || COLOR.test(value)
}

export function sourceLabel(source: GroupSource): string {
  return source === 'kanidm' ? t('From Kanidm') : t('Created in this app')
}

export const SHARE_PERMISSIONS: readonly { value: SharePermission; label: string; help: string }[] =
  [
    { value: 'read', label: N_('Can view'), help: N_('Sees all events and their details.') },
    { value: 'write', label: N_('Can edit'), help: N_('Sees, adds, changes and deletes events.') },
  ]

export function permissionLabel(permission: SharePermission): string {
  const found = SHARE_PERMISSIONS.find((item) => item.value === permission)
  return found ? tv(found.label) : permission
}

/** Adds a person to a member list, once. */
export function addMember(members: readonly string[], sub: string): string[] {
  return members.includes(sub) ? [...members] : [...members, sub]
}

export function removeMember(members: readonly string[], sub: string): string[] {
  return members.filter((item) => item !== sub)
}
