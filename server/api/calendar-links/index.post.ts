import { readBody, setResponseStatus } from 'h3'
import { ApiError } from '../../utils/api/errors'
import { defineMemberHandler } from '../../utils/api/member-handler'
import { expectValid } from '../../utils/api/validation'
import { hashPassword, PasswordBusyError } from '../../utils/links/password'
import { getLinkReader } from '../../utils/links/ports'
import { createCalendarLink, parseLinkCreate } from '../../utils/links/service'

// Makes a read-only, password-protected link to one of the caller's calendars. The answer holds the
// address's secret part (`slug`) once; afterwards only its hash exists.
export default defineMemberHandler(async (event, ctx) => {
  const input = expectValid(parseLinkCreate(await readBody(event)))
  try {
    const created = await createCalendarLink(
      {
        db: ctx.db,
        reader: getLinkReader(),
        sub: ctx.identity.sub,
        userId: ctx.user.id,
        hashPassword,
        audit: ctx.audit,
        atomic: ctx.atomic,
      },
      input,
    )
    setResponseStatus(event, 201)
    return created
  } catch (error) {
    if (error instanceof PasswordBusyError) {
      throw new ApiError(409, 'The server is busy; try again in a moment', { code: 'busy' })
    }
    throw error
  }
})
