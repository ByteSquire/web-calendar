import { ALLOWED_METHODS, isAllowedMethod } from '../../utils/gateway/headers'

// RFC 6764 service discovery. 301, like Radicale's own redirect; clients repeat PROPFIND at the
// new address. No authentication: the redirect reveals nothing.
export default defineEventHandler((event) => {
  if (!isAllowedMethod(event.method)) {
    setResponseHeader(event, 'allow', ALLOWED_METHODS.join(', '))
    throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  }
  return sendRedirect(event, '/caldav/', 301)
})
