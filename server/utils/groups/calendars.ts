// The calendars a group owns: create, rename or recolour, delete, and the shares of each. The
// calendar lives in Radicale under the group's principal (`/_group-<id>/<uuid>/`), so each step
// first asks Radicale and only then writes the rows; a Radicale failure leaves nothing changed, and
// a failure of the rows after a created collection removes the collection again. Renaming and
// deleting are the ones of every calendar (server/utils/calendars/manage.ts).
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { countGroupCalendars, findGroupCalendar, upsertGroupCalendar } from '../../db/groups'
import { addCalendarAcl } from '../../db/calendar-acl'
import type { CalendarRow, GroupRow } from '../../db/types'
import { applyRules } from '../access/service'
import { USERS_GROUP } from './config'
import { conflict, notFound, toBadRequest, upstreamFailed } from '../api/errors'
import { groupPrincipal } from '../sharing/names'
import { groupCalendarRules, shareFieldErrors, calendarView } from './service'
import { MAX_CALENDARS_PER_GROUP, type ShareInput } from './rules'
import { getGroupsPorts } from './ports'
import {
  changeCalendar,
  deleteCalendar,
  RADICALE_DOWN,
  type CalendarContext,
} from '../calendars/manage'

function requireCalendar(db: Database, group: GroupRow, calendarId: number): CalendarRow {
  const row = findGroupCalendar(db, group.id, calendarId)
  if (!row) throw notFound()
  return row
}

export async function createGroupCalendar(
  ctx: CalendarContext,
  group: GroupRow,
  input: { name: string; color?: string },
): Promise<ReturnType<typeof calendarView>> {
  // Everybody who signed in is in the group of everyone, so every person could create and delete
  // the calendars it owns. It stays a group to share WITH.
  if (group.source === 'everyone' || group.name === USERS_GROUP) {
    throw toBadRequest([
      {
        field: 'group',
        message:
          'The group of all users cannot own calendars. Ask an administrator for a group of the people who manage this calendar',
      },
    ])
  }
  if (countGroupCalendars(ctx.db, group.id) >= MAX_CALENDARS_PER_GROUP) {
    throw conflict('limit_reached', `A group has at most ${MAX_CALENDARS_PER_GROUP} calendars`)
  }
  const principal = groupPrincipal(group.id)
  const path = `/${principal}/${randomUUID()}/`
  const made = await ctx.radicale.makeCalendar(principal, path, input.name, input.color)
  if (!made.ok) throw upstreamFailed(RADICALE_DOWN)
  let row: CalendarRow
  try {
    row = ctx.atomic(() => {
      // Checked again inside the transaction: two requests cannot both take the last slot.
      if (countGroupCalendars(ctx.db, group.id) >= MAX_CALENDARS_PER_GROUP) {
        throw conflict('limit_reached', `A group has at most ${MAX_CALENDARS_PER_GROUP} calendars`)
      }
      const created = upsertGroupCalendar(ctx.db, {
        groupId: group.id,
        name: input.name,
        color: input.color ?? null,
        collectionPath: path,
      })
      addCalendarAcl(ctx.db, created.id, {
        principalType: 'group',
        principal: group.name,
        permission: 'write',
      })
      ctx.audit('group_calendar.created', `calendar:${created.id}`, {
        groupId: group.id,
        name: created.name,
      })
      return created
    })
  } catch (error) {
    // The rows did not change, so the new collection must not stay behind.
    await ctx.radicale.deleteCollection(principal, path)
    throw error
  }
  getGroupsPorts().onSharesChanged()
  return calendarView(ctx.db, group, row)
}

export async function updateGroupCalendar(
  ctx: CalendarContext,
  group: GroupRow,
  calendarId: number,
  input: { name?: string; color?: string | null },
): Promise<ReturnType<typeof calendarView>> {
  const current = requireCalendar(ctx.db, group, calendarId)
  const row = await changeCalendar(ctx, current, input, (updated, colorCleared) =>
    ctx.audit('group_calendar.renamed', `calendar:${calendarId}`, {
      groupId: group.id,
      name: updated.name,
      colorCleared,
    }),
  )
  return calendarView(ctx.db, group, row)
}

export async function deleteGroupCalendar(
  ctx: CalendarContext,
  group: GroupRow,
  calendarId: number,
): Promise<void> {
  const current = requireCalendar(ctx.db, group, calendarId)
  await deleteCalendar(ctx, current.collection_path, current, (links) =>
    ctx.audit('group_calendar.deleted', `calendar:${calendarId}`, {
      groupId: group.id,
      name: current.name,
      links,
    }),
  )
}

export function replaceGroupCalendarShares(
  ctx: CalendarContext,
  group: GroupRow,
  calendarId: number,
  shares: readonly ShareInput[],
): ReturnType<typeof calendarView> {
  const current = requireCalendar(ctx.db, group, calendarId)
  const fields = shareFieldErrors(ctx.db, group, shares)
  if (fields.length > 0) throw toBadRequest(fields)
  const rules = groupCalendarRules(ctx.db, group, calendarId, shares)
  const outcome = ctx.atomic(() => {
    const applied = applyRules(ctx.db, calendarId, rules)
    if (applied.changed) {
      ctx.audit('group_calendar.shares_replaced', `calendar:${calendarId}`, {
        groupId: group.id,
        ...applied.details,
      })
    }
    return applied
  })
  if (outcome.changed) getGroupsPorts().onSharesChanged()
  return calendarView(ctx.db, group, current)
}
