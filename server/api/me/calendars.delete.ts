import { getQuery } from 'h3'
import { findCalendarByPath } from '../../db/calendars'
import { defineMemberHandler } from '../../utils/api/member-handler'
import { toBadRequest } from '../../utils/api/errors'
import { calendarContextOf, deleteCalendar } from '../../utils/calendars/manage'
import { ownCalendarPath } from '../../utils/links/service'
import { isShareName } from '../../utils/sharing/names'

const MAX_HREF = 500

// Deletes one of the caller's own calendars (`?href=` as the app addresses it, `/caldav/<sub>/<name>/`)
// with its shares, rules and links. A calendar made minutes ago may have no row yet (discovery adds
// it), so the path is what is checked: it must be in the caller's own home and not a share there.
export default defineMemberHandler(async (event, ctx) => {
  const href = getQuery(event).href
  const path =
    typeof href === 'string' && href.length <= MAX_HREF
      ? ownCalendarPath(href, ctx.identity.sub)
      : null
  const name = path?.split('/')[2] ?? ''
  if (!path || isShareName(name)) {
    throw toBadRequest([{ field: 'href', message: 'is not one of your own calendars' }])
  }
  const row = findCalendarByPath(ctx.db, path)
  await deleteCalendar(calendarContextOf(ctx), path, row, (links) =>
    ctx.audit('calendar.deleted', row ? `calendar:${row.id}` : 'calendar', {
      name: row?.name ?? null,
      kind: 'personal',
      byOwner: true,
      links,
    }),
  )
  return {}
})
