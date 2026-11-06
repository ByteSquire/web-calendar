// The calendars of the organization: an admin makes them on Admin › Calendars, in the home of the
// organization's principal (`/_organization/<uuid>/`). They belong to no person and no group, so
// nobody sees one until an access rule shares it; the page opens its access tab after making one.
import { randomUUID } from 'node:crypto'
import { countOrganizationCalendars, upsertOrganizationCalendar } from '../../db/calendars'
import type { CalendarRow } from '../../db/types'
import { conflict, upstreamFailed } from '../api/errors'
import { ORGANIZATION_PRINCIPAL } from '../sharing/types'
import { RADICALE_DOWN, type CalendarContext } from './manage'

/** Not in the spec; keeps one page of the admin list readable and the discovery run short. */
export const MAX_ORGANIZATION_CALENDARS = 200

function refuseAtLimit(ctx: CalendarContext): void {
  if (countOrganizationCalendars(ctx.db, ORGANIZATION_PRINCIPAL) >= MAX_ORGANIZATION_CALENDARS) {
    throw conflict(
      'limit_reached',
      `The organization has at most ${MAX_ORGANIZATION_CALENDARS} calendars`,
    )
  }
}

/** Makes the collection in Radicale, then the row; a failure of the row removes the collection. */
export async function createOrganizationCalendar(
  ctx: CalendarContext,
  input: { name: string; color?: string },
): Promise<CalendarRow> {
  refuseAtLimit(ctx)
  const path = `/${ORGANIZATION_PRINCIPAL}/${randomUUID()}/`
  const made = await ctx.radicale.makeCalendar(
    ORGANIZATION_PRINCIPAL,
    path,
    input.name,
    input.color,
  )
  if (!made.ok) throw upstreamFailed(RADICALE_DOWN)
  try {
    return ctx.atomic(() => {
      // Checked again inside the transaction: two requests cannot both take the last slot.
      refuseAtLimit(ctx)
      const row = upsertOrganizationCalendar(ctx.db, {
        name: input.name,
        color: input.color ?? null,
        collectionPath: path,
      })
      ctx.audit('calendar.created', `calendar:${row.id}`, { name: row.name, kind: 'organization' })
      return row
    })
  } catch (error) {
    // The rows did not change, so the new collection must not stay behind.
    await ctx.radicale.deleteCollection(ORGANIZATION_PRINCIPAL, path)
    throw error
  }
}
