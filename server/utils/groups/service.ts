// Groups without HTTP: the rules of creating, deleting and filling a group, what a group looks like
// to the API, and the one authorization decision of the group routes. Every function that changes
// rows is called inside the route's transaction, so its audit entry is written with the change.
import type { Database } from 'better-sqlite3'
import {
  countGroupCalendars,
  countGroups as countAllGroups,
  countRulesNamingGroup,
  deleteGroupRow,
  deleteRulesNamingGroup,
  findGroupByName,
  groupNameTaken,
  insertCustomGroup,
  isGroupManager,
  isGroupMember,
  listGroupCalendars,
  listGroupManagerSubs,
  listGroupMembers,
  personExists,
  replaceGroupManagers,
  replaceGroupMembers,
  type GroupMemberRow,
  type GroupMemberView,
  type GroupSummaryRow,
} from '../../db/groups'
import { listCalendarAcl } from '../../db/calendar-acl'
import type { CalendarRow, GroupRow } from '../../db/types'
import { reservedGroupNames } from './claim'
import { ApiError, conflict, toBadRequest, type FieldError } from '../api/errors'
import type { CalendarAclInput } from '../../db/calendar-acl'
import { MAX_GROUPS, type ShareInput } from './rules'

/** A new app group: the name must be free of every source and of the reserved names. */
export function createCustomGroup(db: Database, name: string, adminGroup: string): GroupRow {
  if (reservedGroupNames(adminGroup).includes(name.toLowerCase()) || groupNameTaken(db, name)) {
    throw conflict('duplicate', 'A group with this name already exists or the name is reserved')
  }
  if (countAllGroups(db) >= MAX_GROUPS) {
    throw conflict('limit_reached', `There are at most ${MAX_GROUPS} groups`)
  }
  return insertCustomGroup(db, name)
}

/**
 * Deletes an app group that owns no calendar, with the rules that name it (calendar and resource
 * rules; the sharing writer removes the shares). Imported groups and the group of everyone are
 * not deleted here.
 */
export function deleteCustomGroup(
  db: Database,
  group: GroupRow,
): { calendarRules: number; resourceRules: number } {
  refuseImported(group)
  if (countGroupCalendars(db, group.id) > 0) {
    throw conflict('has_calendars', 'The group still owns calendars; delete them first')
  }
  const rules = countRulesNamingGroup(db, group.name)
  deleteRulesNamingGroup(db, group.name)
  deleteGroupRow(db, group.id)
  return { calendarRules: rules.calendar, resourceRules: rules.resource }
}

/**
 * Makes the members of an app group exactly `subs` (validated to UUIDs by the route). Each must be
 * a person who has signed in once: a member is referred to by `sub`, and the app knows nothing else
 * about a person who has never signed in. Only an admin names managers, so only an admin may remove
 * one (`byAdmin`); a manager who removed another would take their role away.
 */
export function replaceMembers(
  db: Database,
  group: GroupRow,
  subs: readonly string[],
  byAdmin: boolean,
): { added: number; removed: number; total: number } {
  refuseImported(group)
  const fields: FieldError[] = []
  subs.forEach((sub, index) => {
    if (!personExists(db, sub)) {
      fields.push({
        field: `members[${index}]`,
        message: 'is not a known person (they must have signed in once)',
      })
    }
  })
  if (fields.length > 0) throw toBadRequest(fields)
  if (!byAdmin) {
    const kept = new Set(subs)
    if (listGroupManagerSubs(db, group.id).some((sub) => !kept.has(sub))) {
      throw new ApiError(403, 'Only an administrator can remove a manager of the group', {
        code: 'manager',
      })
    }
  }
  const counts = replaceGroupMembers(db, group.id, subs)
  return { ...counts, total: subs.length }
}

/**
 * Makes exactly `subs` the managers of a group (admins only, checked by the route). Each must be a
 * stored member; the group of everyone has none, so it has no managers. A group from the identity
 * provider may have managers: its members follow the provider, the role is the app's.
 */
export function replaceManagers(
  db: Database,
  group: GroupRow,
  subs: readonly string[],
): { added: number; removed: number; total: number } {
  if (group.source === 'everyone') {
    throw new ApiError(403, 'The group of everyone who signed in has no managers', {
      code: 'imported',
    })
  }
  const members = new Set(listGroupMembers(db, group.id).map((member) => member.sub))
  const fields: FieldError[] = []
  subs.forEach((sub, index) => {
    if (!members.has(sub)) fields.push({ field: `managers[${index}]`, message: 'is not a member' })
  })
  if (fields.length > 0) throw toBadRequest(fields)
  const counts = replaceGroupManagers(db, group.id, subs)
  return { ...counts, total: subs.length }
}

function refuseImported(group: GroupRow): void {
  if (group.source === 'oidc') {
    throw new ApiError(403, 'A group from the identity provider is read-only here', {
      code: 'imported',
    })
  }
  if (group.source === 'everyone') {
    throw new ApiError(403, 'The group of everyone who signed in cannot be changed', {
      code: 'imported',
    })
  }
}

/**
 * The one decision of the group routes that reads: a member of the group, or an admin (who may do
 * everything in every group). The member test is the database's; the admin test is asked only when
 * the caller is not a member. Returns false rather than throwing: the route answers 403. `since` is
 * `signinCutoff(...)`: the group of everyone holds the people seen since then.
 */
export async function mayActForGroup(
  db: Database,
  group: GroupRow,
  sub: string,
  isAdmin: () => Promise<boolean>,
  since: string,
): Promise<boolean> {
  if (isGroupMember(db, group.id, sub, since)) return true
  return isAdmin()
}

/**
 * The decision of the routes that change a group's members or calendars: a manager of the group,
 * or an admin. Like `mayActForGroup`, the admin test is asked only when the database says no.
 */
export async function mayManageGroup(
  db: Database,
  group: GroupRow,
  sub: string,
  isAdmin: () => Promise<boolean>,
): Promise<boolean> {
  if (isGroupManager(db, group.id, sub)) return true
  return isAdmin()
}

/** The group as a list row. `member` and `manager` are about the caller; `sub` is theirs. */
export function groupSummary(row: GroupSummaryRow): {
  id: number
  name: string
  source: GroupSummaryRow['source']
  memberCount: number
  member: boolean
  manager: boolean
} {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    memberCount: row.memberCount,
    member: row.member,
    manager: row.manager,
  }
}

export function personView(member: GroupMemberView) {
  return { sub: member.sub, name: member.name, username: member.username }
}

/** A member as the group page shows them: the person and whether they manage the group. */
export function memberView(member: GroupMemberRow) {
  return { ...personView(member), manager: member.manager }
}

/** A share as the API shows it: the extra user and group rules, read or write. */
export interface CalendarShareView {
  principalType: 'user' | 'group'
  principal: string
  label: string
  permission: 'read' | 'write'
}

/** The shares of a group calendar as the API shows them (the owning group's own rule is not one). */
export function calendarView(db: Database, group: GroupRow, row: CalendarRow) {
  const shares: CalendarShareView[] = []
  const rules = listCalendarAcl(db, row.id)
  const labels = personLabels(
    db,
    rules
      .filter((rule) => rule.principal_type === 'user' && rule.principal !== null)
      .map((rule) => rule.principal!),
  )
  for (const rule of rules) {
    if (rule.permission !== 'read' && rule.permission !== 'write') continue
    if (rule.principal === null) continue
    if (rule.principal_type === 'group') {
      if (rule.principal === group.name) continue
      shares.push({
        principalType: 'group',
        principal: rule.principal,
        label: rule.principal,
        permission: rule.permission,
      })
    } else if (rule.principal_type === 'user') {
      shares.push({
        principalType: 'user',
        principal: rule.principal,
        label: labels.get(rule.principal) ?? UNKNOWN_PERSON,
        permission: rule.permission,
      })
    }
  }
  return { id: row.id, name: row.name, color: row.color, shares }
}

const UNKNOWN_PERSON = 'Unknown person'

/**
 * The name to show for each of `subs`, in one query (a calendar has at most
 * MAX_SHARES_PER_CALENDAR shares): the name, else the username. A sub without a user row is left out.
 */
function personLabels(db: Database, subs: readonly string[]): Map<string, string> {
  const unique = [...new Set(subs)]
  if (unique.length === 0) return new Map()
  const rows = db
    .prepare<string[], { sub: string; name: string | null; username: string | null }>(
      `SELECT oidc_sub AS sub, name, username FROM users WHERE oidc_sub IN (${unique.map(() => '?').join(', ')})`,
    )
    .all(...unique)
  return new Map(rows.map((row) => [row.sub, row.name || row.username || UNKNOWN_PERSON]))
}

/** What the caller may do in a group (the routes check again): see `groupRights`. */
export interface GroupRights {
  /** Add and remove members: managers and admins, in an app group. */
  canManageMembers: boolean
  /** Create, rename, share and delete the group's calendars: managers and admins. */
  canManageCalendars: boolean
  /** Name and remove managers: admins, in any group with stored members. */
  canNameManagers: boolean
}

/** The rights of a caller who is a manager of the group, an admin, both or neither. */
export function groupRights(group: GroupRow, manager: boolean, admin: boolean): GroupRights {
  const manages = manager || admin
  return {
    canManageMembers: group.source === 'app' && manages,
    canManageCalendars: group.source !== 'everyone' && manages,
    canNameManagers: group.source !== 'everyone' && admin,
  }
}

/** The full group for a member or an admin: members with their role, calendars, and the caller's rights. */
export function groupDetail(db: Database, group: GroupRow, rights: GroupRights) {
  return {
    id: group.id,
    name: group.name,
    source: group.source,
    ...rights,
    members: listGroupMembers(db, group.id).map(memberView),
    calendars: listGroupCalendars(db, group.id).map((row) => calendarView(db, group, row)),
  }
}

/**
 * The extra shares as calendar_acl rules, checked against the database: a person has to have
 * signed in, a group has to exist (either source), and the owning group is not listed again (its
 * write rule is fixed). Returns the errors, empty when fine.
 */
export function shareFieldErrors(
  db: Database,
  group: GroupRow,
  shares: readonly ShareInput[],
): FieldError[] {
  const fields: FieldError[] = []
  shares.forEach((share, index) => {
    const at = `shares[${index}].principal`
    if (share.principalType === 'user') {
      if (!personExists(db, share.principal)) {
        fields.push({ field: at, message: 'is not a known person (they must have signed in once)' })
      }
    } else if (share.principal === group.name) {
      fields.push({ field: at, message: 'is the owning group, which has write access already' })
    } else if (!findGroupByName(db, share.principal)) {
      fields.push({ field: at, message: 'is not a group' })
    }
  })
  return fields
}

/**
 * The complete rule list of a group calendar: the owning group's write rule, the extra shares, and
 * the rules of other kinds (everyone signed in, and so on), which these routes do not touch.
 */
export function groupCalendarRules(
  db: Database,
  group: GroupRow,
  calendarId: number,
  shares: readonly ShareInput[],
): CalendarAclInput[] {
  const kept = listCalendarAcl(db, calendarId)
    .filter((rule) => rule.principal_type !== 'user' && rule.principal_type !== 'group')
    .map((rule) => ({
      principalType: rule.principal_type,
      principal: rule.principal,
      permission: rule.permission,
    }))
  return [
    { principalType: 'group', principal: group.name, permission: 'write' },
    ...shares.map((share) => ({
      principalType: share.principalType,
      principal: share.principal,
      permission: share.permission,
    })),
    ...kept,
  ]
}

/**
 * The owning group's write rule must stay in a calendar's rule list (the admin route checks it, so
 * the Radicale share of the group's own calendar cannot be taken away). Null when it is there.
 */
export function owningRuleProblem(
  group: GroupRow,
  rules: readonly { principalType: string; principal: string | null; permission: string }[],
): FieldError | null {
  const kept = rules.some(
    (rule) =>
      rule.principalType === 'group' &&
      rule.principal === group.name &&
      rule.permission === 'write',
  )
  return kept
    ? null
    : { field: 'rules', message: `must keep the write rule of the owning group "${group.name}"` }
}
