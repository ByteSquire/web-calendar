import { getRouterParam, readBody, setResponseStatus } from 'h3'
import type { CalendarRow } from '../../../../../db/types'
import { defineAdminHandler } from '../../../../../utils/api/admin-handler'
import { apiConfig } from '../../../../../utils/api/config'
import { ApiError, notFound } from '../../../../../utils/api/errors'
import { expectValid, parseId } from '../../../../../utils/api/validation'
import { hashPassword, PasswordBusyError } from '../../../../../utils/links/password'
import { getLinkReader } from '../../../../../utils/links/ports'
import {
  createAdminCalendarLink,
  linkView,
  parseAdminLinkCreate,
} from '../../../../../utils/links/service'

// Makes a link to a calendar of the access page, at a level of the access rules. It reads the
// calendar as the principal that owns it, like an access rule of the calendar.
export default defineAdminHandler(async (event, { db, user, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const calendar = db.prepare<[number], CalendarRow>('SELECT * FROM calendars WHERE id = ?').get(id)
  if (!calendar) throw notFound()
  const input = expectValid(parseAdminLinkCreate(await readBody(event)))
  const { tokenHashKey } = apiConfig()
  try {
    const created = await createAdminCalendarLink(
      {
        db,
        reader: getLinkReader(),
        keyring: tokenHashKey,
        userId: user.id,
        hashPassword,
        audit,
        atomic,
      },
      calendar,
      input,
    )
    setResponseStatus(event, 201)
    return { link: linkView(tokenHashKey, created.link) }
  } catch (error) {
    if (error instanceof PasswordBusyError) {
      throw new ApiError(409, 'The server is busy; try again in a moment', { code: 'busy' })
    }
    throw error
  }
})
