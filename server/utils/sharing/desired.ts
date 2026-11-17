import { USERS_GROUP } from '../groups/config'
import { isGroupName } from '../groups/htgroup'
import type {
  CalendarAclRow,
  CalendarRow,
  Permission,
  ResourceAclRow,
  ResourceRow,
} from '../../db/types'
import { resourceCollection } from '../resources/block'
import { groupShareName, splitCollectionPath, userShareName } from './names'
import { RESOURCES_PRINCIPAL, type RadicaleShare } from './types'
import { isActingPrincipal } from './radicale-client'

// What Radicale should hold, computed from calendar_acl and resource_acl alone (pure; the reconcile
// compares it with Radicale's list). Closed permission table: `admin` and `public` never reach
// Radicale.

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
  /** The calendar of the access page; null for the calendar of a resource. */
  calendarId: number | null
  /** The resource whose calendar this shares; absent for the calendar of the access page. */
  resourceId?: number
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

/**
 * The shares of the resources' calendars (design §5): each active resource's calendar, read-only,
 * to everyone its rules let see, book or manage it, as `resource-<id>` (a person) or
 * `resource-<id>-<group>` (a group) in their home. A rule for everyone signed in reaches every
 * person through `web_calendar_users`, so the other rules of that resource add nothing and give no
 * second copy. A deactivated resource has no shares (it leaves the calendar apps as it leaves the
 * web app); its calendar stays, so reactivating it brings everything back.
 */
export function resourceShares(
  resources: readonly Pick<ResourceRow, 'id' | 'active'>[],
  rules: readonly Pick<ResourceAclRow, 'resource_id' | 'principal_type' | 'principal'>[],
): DesiredShare[] {
  const shares: DesiredShare[] = []
  for (const resource of resources) {
    if (resource.active !== 1) continue
    const own = rules.filter((rule) => rule.resource_id === resource.id)
    const everyone = own.some((rule) => rule.principal_type === 'authenticated')
    const targets = new Map<string, { user: string; kind: 'user' | 'group'; name: string }>()
    for (const rule of everyone ? own.filter((r) => r.principal_type === 'authenticated') : own) {
      const wanted = target(rule)
      if (wanted === null || wanted === 'none') continue
      targets.set(wanted.user, wanted)
    }
    for (const wanted of targets.values()) {
      shares.push({
        owner: RESOURCES_PRINCIPAL,
        pathMapped: resourceCollection(resource.id),
        pathOrToken:
          wanted.kind === 'user'
            ? `/${wanted.name}/resource-${resource.id}/`
            : `/{user}/resource-${resource.id}-${wanted.name}/`,
        user: wanted.user,
        permissions: PERMISSION_STRINGS.read,
        kind: wanted.kind,
        calendarId: null,
        resourceId: resource.id,
      })
    }
  }
  return shares
}

function target(
  row: Pick<CalendarAclRow, 'principal_type' | 'principal'>,
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
  options: {
    /** The resources and their rules, for the calendars of the resources (`resourceShares`). */
    resources?: {
      resources: readonly Pick<ResourceRow, 'id' | 'active'>[]
      rules: readonly Pick<ResourceAclRow, 'resource_id' | 'principal_type' | 'principal'>[]
    }
  } = {},
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

  if (options.resources) {
    for (const share of resourceShares(options.resources.resources, options.resources.rules)) {
      merged.set(desiredKey(share), share)
    }
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
