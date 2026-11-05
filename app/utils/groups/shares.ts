// The share list of a group calendar. The owning group's own rule is fixed on the server (its
// write rule makes the calendar a group calendar), so it is shown but never sent or removed. The
// rest is the complete list the PUT takes: a person or a group, read or write.
import { t } from '~/utils/i18n'
import { principalLabel } from '~/utils/principal-label'
import {
  permissionLabel,
  type CalendarShare,
  type GroupCalendar,
  type SharePermission,
  type SharePrincipalType,
} from './model'

export interface ShareInput {
  principalType: SharePrincipalType
  principal: string
  permission: SharePermission
}

/** The rule that makes the calendar a group calendar: the owning group, with write. */
export function isOwnerShare(share: CalendarShare, groupName: string): boolean {
  return share.principalType === 'group' && share.principal === groupName
}

/** The shares that can be changed here (without the owning group's). */
export function extraShares(calendar: GroupCalendar, groupName: string): CalendarShare[] {
  return calendar.shares.filter((share) => !isOwnerShare(share, groupName))
}

export function toShareInput(shares: readonly CalendarShare[]): ShareInput[] {
  return shares.map(({ principalType, principal, permission }) => ({
    principalType,
    principal,
    permission,
  }))
}

/** Adds the share, or changes the permission of the one for the same principal. */
export function withShare(shares: readonly CalendarShare[], share: CalendarShare): CalendarShare[] {
  const same = (item: CalendarShare) =>
    item.principalType === share.principalType && item.principal === share.principal
  return shares.some(same) ? shares.map((item) => (same(item) ? share : item)) : [...shares, share]
}

export function withoutShare(
  shares: readonly CalendarShare[],
  principalType: SharePrincipalType,
  principal: string,
): CalendarShare[] {
  return shares.filter(
    (item) => !(item.principalType === principalType && item.principal === principal),
  )
}

/** A sentence about the shares for the list of calendars: "Shared with Anna: Can edit." */
export function shareSummary(shares: readonly CalendarShare[], groupName: string): string {
  const extra = shares.filter((share) => !isOwnerShare(share, groupName))
  if (extra.length === 0) return t('Not shared with anybody else.')
  const names = extra.map(
    (share) =>
      `${principalLabel(share.principalType, share.label)}: ${permissionLabel(share.permission)}`,
  )
  return t('Shared with {names}.', { names: names.join(', ') })
}
