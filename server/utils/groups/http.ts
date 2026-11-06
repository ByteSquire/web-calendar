// The part of the group routes that every route shares: finding the group (404), the member-or-admin
// check of the reads and the manager-or-admin check of the changes (403), and the calendar context of
// a member route. Routes call these after the body is
// validated and before anything is changed.
import type { Database } from 'better-sqlite3'
import { findGroupById } from '../../db/groups'
import type { GroupRow } from '../../db/types'
import type { MemberContext } from '../api/member-handler'
import { apiConfig } from '../api/config'
import { signinCutoff } from '../auth/window'
import { forbidden, notFound } from '../api/errors'
import { calendarContextOf, type CalendarContext } from '../calendars/manage'
import { mayActForGroup, mayManageGroup } from './service'

export function loadGroup(db: Database, id: number): GroupRow {
  const group = findGroupById(db, id)
  if (!group) throw notFound()
  return group
}

/** The member-or-admin decision of the group routes. Throws 403 when neither holds. */
export async function requireMemberOrAdmin(ctx: MemberContext, group: GroupRow): Promise<void> {
  const since = signinCutoff(apiConfig().signinWindowMs, new Date())
  if (!(await mayActForGroup(ctx.db, group, ctx.identity.sub, () => ctx.isAdmin(), since))) {
    throw forbidden()
  }
}

/** The manager-or-admin decision of the routes that change a group. Throws 403 when neither holds. */
export async function requireManagerOrAdmin(ctx: MemberContext, group: GroupRow): Promise<void> {
  if (!(await mayManageGroup(ctx.db, group, ctx.identity.sub, () => ctx.isAdmin()))) {
    throw forbidden()
  }
}

/** The calendar context of a route: the Radicale client is built only after the access check. */
export function calendarContext(ctx: MemberContext): CalendarContext {
  return calendarContextOf(ctx)
}
