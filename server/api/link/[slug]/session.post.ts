import { createError, getRouterParam, readBody } from 'h3'
import { apiConfig } from '../../../utils/api/config'
import { isRecord } from '../../../utils/api/validation'
import { getDb } from '../../../utils/db'
import { MAX_PASSWORD_LENGTH } from '../../../utils/links/password'
import { getLinkLimits, linkClientKey } from '../../../utils/links/ports'
import { definePublicLinkHandler, tooMany } from '../../../utils/links/public-handler'
import {
  LinkUnavailableError,
  WrongPasswordError,
  openCalendarLink,
  slugHashOf,
} from '../../../utils/links/service'

// Opens a calendar link with its password (no sign-in): a session for the page, and the calendar's
// name and colour. Only wrong passwords count against the limits, per client address and per link
// from everywhere, so a right password is never refused for what others did; but once a limit is
// used up, every try is refused before the password is checked, which is costly on purpose.
export default definePublicLinkHandler(async (event) => {
  const slug = getRouterParam(event, 'slug') ?? ''
  const limits = getLinkLimits()
  const address = linkClientKey(event)
  const linkKey = slugHashOf(slug)
  const wait = limits.attemptsPerAddress.peek(address) ?? limits.attemptsPerLink.peek(linkKey)
  if (wait !== null) tooMany(event, wait)

  const body: unknown = await readBody(event)
  const password = isRecord(body) ? body.password : undefined
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Enter the password',
    })
  }
  const { tokenHashKey, signinWindowMs } = apiConfig()
  try {
    const { opened } = await openCalendarLink(
      { db: getDb(), keyring: tokenHashKey, windowMs: signinWindowMs },
      slug,
      password,
    )
    return opened
  } catch (error) {
    // A wrong password, or an address that is no link (someone trying addresses), is a failure.
    if (error instanceof WrongPasswordError || error instanceof LinkUnavailableError) {
      limits.attemptsPerAddress.take(address)
      limits.attemptsPerLink.take(linkKey)
    }
    throw error
  }
})
