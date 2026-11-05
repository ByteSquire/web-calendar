// The access administration of the browser (FR-14): the shapes of server/api/admin/access/**, the
// words for the permissions and the plain helpers the page uses. The shapes are written out here
// instead of imported from the server so the browser bundle stays free of server code.
import { N_, t, tv } from '~/utils/i18n'
import { parseApiError } from '~/utils/settings/api-errors'

export type AccessPermission = 'free_busy' | 'read' | 'write'
export type AccessPrincipalType = 'user' | 'group' | 'authenticated'

export interface AccessRule {
  id: number
  principalType: AccessPrincipalType
  principal: string | null
  label: string
  permission: AccessPermission
  /** Radicale has the share; false means the change is saved but not in force yet. */
  applied: boolean
  appliedAt: string | null
}

export interface AccessCalendar {
  id: number
  name: string
  kind: 'personal' | 'shared' | 'resource'
  color: string | null
  owner: string | null
  rules: AccessRule[]
}

/**
 * How a calendar is named in a drop-down. Every person's own calendar has the name Radicale gave it
 * ("Personal Calendar"), so a personal calendar carries its owner: "Personal Calendar (Bob Builder)".
 * The name of an organization's calendar is enough. Without an owner's name the calendar keeps its own.
 */
export function calendarLabel(calendar: Pick<AccessCalendar, 'name' | 'kind' | 'owner'>): string {
  return calendar.kind === 'personal' && calendar.owner
    ? `${calendar.name} (${calendar.owner})`
    : calendar.name
}

export interface AccessCalendarsResponse {
  calendars: AccessCalendar[]
}

export interface AccessUser {
  sub: string
  name: string | null
  username: string | null
}

/** A rule as the PUT takes it. */
export interface AccessRuleInput {
  principalType: AccessPrincipalType
  principal: string | null
  permission: AccessPermission
}

export const ACCESS_LEVELS: readonly { value: AccessPermission; label: string; help: string }[] = [
  {
    value: 'free_busy',
    label: N_('Busy times only'),
    help: N_('Sees when the calendar is busy, but no titles or details.'),
  },
  {
    value: 'read',
    label: N_('Can view'),
    help: N_('Sees all events and their details. Cannot change them.'),
  },
  {
    value: 'write',
    label: N_('Can edit'),
    help: N_('Sees, adds, changes and deletes events.'),
  },
]

export const PRINCIPAL_CHOICES: readonly { value: AccessPrincipalType; label: string }[] = [
  { value: 'user', label: N_('A person') },
  { value: 'group', label: N_('A group') },
  { value: 'authenticated', label: N_('Everyone signed in') },
]

export function levelLabel(permission: AccessPermission): string {
  const label = ACCESS_LEVELS.find((level) => level.value === permission)?.label
  return label ? tv(label) : permission
}

export function principalKind(type: AccessPrincipalType): string {
  return type === 'user' ? t('Person') : type === 'group' ? t('Group') : t('Everyone')
}

const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** The same shape the server accepts; the server still decides. */
export function isGroupName(text: string): boolean {
  return GROUP_NAME.test(text)
}

export function userLabel(user: AccessUser): string {
  const name = user.name?.trim()
  if (name && user.username) return `${name} (${user.username})`
  return name || user.username || t('Unnamed person')
}

export function toInput(rule: AccessRule | AccessRuleInput): AccessRuleInput {
  return {
    principalType: rule.principalType,
    principal: rule.principal,
    permission: rule.permission,
  }
}

const sameWho = (a: AccessRuleInput, b: AccessRuleInput) =>
  a.principalType === b.principalType && a.principal === b.principal

/** The rules with this one added, or with the permission of the existing rule for that principal changed. */
export function withRule(rules: readonly AccessRule[], rule: AccessRuleInput): AccessRuleInput[] {
  const inputs = rules.map(toInput)
  return inputs.some((existing) => sameWho(existing, rule))
    ? inputs.map((existing) => (sameWho(existing, rule) ? rule : existing))
    : [...inputs, rule]
}

export function withoutRule(rules: readonly AccessRule[], id: number): AccessRuleInput[] {
  return rules.filter((rule) => rule.id !== id).map(toInput)
}

/** At most `limit` people matching the text in name or username, for the picker. */
export function matchUsers(users: readonly AccessUser[], text: string, limit = 50): AccessUser[] {
  const needle = text.trim().toLowerCase()
  const found = needle
    ? users.filter((user) => userLabel(user).toLowerCase().includes(needle))
    : users
  return found.slice(0, limit)
}

/**
 * Words for a failed save. The server names the rejected rule by its position (`rules[2].principal`);
 * `sent` is the list that was sent, so the message can name who it is about.
 */
export function describeSaveProblem(
  cause: unknown,
  sent: readonly AccessRuleInput[],
  labelOf: (rule: AccessRuleInput) => string,
): string {
  const info = parseApiError(cause)
  if (info.kind === 'signed-out') return t('You are signed out. Reload the page to sign in again.')
  if (info.kind === 'network') return t('The server could not be reached. Nothing was changed.')
  if (info.kind === 'not-found') return t('This calendar no longer exists. Reload the page.')
  if (info.status === 403) return t('You are not allowed to manage access.')
  if (info.fields.length > 0) {
    const parts = info.fields.map(({ field, message }) => {
      const match = /^rules\[(\d+)\]/.exec(field)
      const rule = match ? sent[Number(match[1])] : undefined
      return rule ? `${labelOf(rule)} ${message}.` : `${message}.`
    })
    return t('Nothing was changed. {details}', { details: parts.join(' ') })
  }
  return info.message
    ? t('Nothing was changed. {details}', { details: `${info.message}.` })
    : t('Nothing was changed. Try again.')
}
