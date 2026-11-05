import { USERS_GROUP } from '../groups/config'
import { isGroupName } from '../groups/htgroup'
import type { CalendarAclRow, CalendarRow, Permission } from '../../db/types'
import { groupShareName, splitCollectionPath, userShareName } from './names'
import {
  AVAILABILITY_PATH,
  AVAILABILITY_SHARE_NAME,
  RESOURCES_PRINCIPAL,
  type RadicaleShare,
} from './types'
import { isActingPrincipal } from './radicale-client'

// What Radicale should hold, computed from calendar_acl alone (pure; the reconcile compares it with
// Radicale's list). Closed permission table: `admin` and `public` never reach Radicale.

export const PERMISSION_STRINGS = { free_busy: 'f', read: 'r', write: 'rw' } as const
const RANK: Record<string, number> = { f: 1, r: 2, rw: 3 }

export interface DesiredShare {
  owner: string
  pathMapped: string
  pathOrToken: string
  /** The member, or `:group` for a group share. */
  user: string
  permissions: string
  kind: 'user' | 'group'
  /** Null for the built-in availability share. */
  calendarId: number | null
}

export type RowStatus =
  | { kind: 'share'; key: string }
  /** `admin` and `public`: nothing to send to Radicale. */
  | { kind: 'none'; owner: string }
  | { kind: 'invalid' }

export interface DesiredState {
  shares: DesiredShare[]
  /** What each ACL row turned into. */
  rows: Map<number, RowStatus>
  /** Rows (with a reason) that cannot be turned into a share. */
  invalid: string[]
}

/** Two shares are the same one when source and recipient match (Radicale allows one per pair). */
export function shareKey(owner: string, pathMapped: string, user: string): string {
  return `${owner}\u0000${pathMapped}\u0000${user}`
}

export function desiredKey(share: DesiredShare): string {
  return shareKey(share.owner, share.pathMapped, share.user)
}

export function actualKey(owner: string, share: RadicaleShare): string {
  return shareKey(owner, share.pathMapped, share.user)
}

/** Group shares get `epu` appended by Radicale; the comparison ignores them and the order. */
export function normalizePermissions(permissions: string, isGroup: boolean): string {
  const kept = isGroup ? permissions.replace(/[epu]/g, '') : permissions
  return [...kept].sort().join('')
}

export function availabilityShare(): DesiredShare {
  return {
    owner: RESOURCES_PRINCIPAL,
    pathMapped: AVAILABILITY_PATH,
    pathOrToken: `/{user}/${AVAILABILITY_SHARE_NAME}/`,
    user: `:${USERS_GROUP}`,
    permissions: PERMISSION_STRINGS.free_busy,
    kind: 'group',
    calendarId: null,
  }
}

function target(
  row: CalendarAclRow,
): { user: string; kind: 'user' | 'group'; name: string } | 'none' | null {
  switch (row.principal_type) {
    case 'user':
      if (!isActingPrincipal(row.principal)) return null
      return { user: row.principal, kind: 'user', name: row.principal }
    case 'group':
      if (row.principal === null || !isGroupName(row.principal)) return null
      return { user: `:${row.principal}`, kind: 'group', name: row.principal }
    case 'authenticated':
      return { user: `:${USERS_GROUP}`, kind: 'group', name: USERS_GROUP }
    default:
      return 'none'
  }
}

export function computeDesiredShares(
  rows: readonly CalendarAclRow[],
  calendars: ReadonlyMap<number, CalendarRow>,
  options: { withAvailability?: boolean } = {},
): DesiredState {
  const merged = new Map<string, DesiredShare>()
  const statuses = new Map<number, RowStatus>()
  const invalid: string[] = []

  for (const row of rows) {
    const calendar = calendars.get(row.calendar_id)
    const path = calendar ? splitCollectionPath(calendar.collection_path) : null
    if (!path || !isActingPrincipal(path.owner)) {
      statuses.set(row.id, { kind: 'invalid' })
      invalid.push(`rule ${row.id}: calendar ${row.calendar_id} has no usable collection path`)
      continue
    }
    const wanted = target(row)
    // The owner needs no share of their own calendar; `admin` is an app-level right.
    const ownerRule = row.principal_type === 'user' && row.principal === path.owner
    if (wanted === 'none' || ownerRule || row.permission === 'admin') {
      statuses.set(row.id, { kind: 'none', owner: path.owner })
      continue
    }
    if (wanted === null) {
      statuses.set(row.id, { kind: 'invalid' })
      invalid.push(`rule ${row.id}: the ${row.principal_type} principal is not usable`)
      continue
    }
    const permission = row.permission as Exclude<Permission, 'admin'>
    const permissions = PERMISSION_STRINGS[permission]
    const share: DesiredShare = {
      owner: path.owner,
      pathMapped: calendar!.collection_path,
      pathOrToken: `/${wanted.kind === 'user' ? wanted.name : '{user}'}/${
        wanted.kind === 'user'
          ? userShareName(calendar!.id)
          : groupShareName(calendar!.id, wanted.name)
      }/`,
      user: wanted.user,
      permissions,
      kind: wanted.kind,
      calendarId: calendar!.id,
    }
    const key = desiredKey(share)
    const before = merged.get(key)
    if (!before || (RANK[permissions] ?? 0) > (RANK[before.permissions] ?? 0))
      merged.set(key, share)
    statuses.set(row.id, { kind: 'share', key })
  }

  if (options.withAvailability) {
    const share = availabilityShare()
    merged.set(desiredKey(share), share)
  }
  const shares = [...merged.values()].sort((a, b) =>
    desiredKey(a) < desiredKey(b) ? -1 : desiredKey(a) > desiredKey(b) ? 1 : 0,
  )
  return { shares, rows: statuses, invalid }
}

/** Whether a Radicale share is exactly the desired one (path, recipient kind, permissions). */
export function sameShare(desired: DesiredShare, actual: RadicaleShare): boolean {
  return (
    desired.pathOrToken === actual.pathOrToken &&
    desired.user === actual.user &&
    desired.permissions === normalizePermissions(actual.permissions, desired.kind === 'group')
  )
}
