import { createError, defineEventHandler, setResponseHeader } from 'h3'
import { apiBodyProblem } from '../utils/api/body-limit'
import { isApiPath, isNonCanonicalApiPath } from '../utils/api/not-found'

// Guards in front of every /api/** handler: a URL no route has (trailing slash, empty segment) is
// a JSON 404 whatever the method, and the request body limit. Methods a route does not implement
// and unknown paths are answered by the `render:before` hook of server/plugins/api-fallback.ts.
export default defineEventHandler((event) => {
  if (!isApiPath(event.path)) return
  if (isNonCanonicalApiPath(event.path)) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const problem = apiBodyProblem(event.method, event.headers)
  if (problem) {
    // The body that is refused is not read to its end, so the answer ends the connection.
    if (problem.status === 413 || problem.status === 411) {
      setResponseHeader(event, 'connection', 'close')
    }
    throw createError({ statusCode: problem.status, statusMessage: problem.message })
  }
})
