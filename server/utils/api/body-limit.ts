// Request body limits for /api/** (design §6 security): h3 reads a JSON body completely before
// a handler sees it, so the size is checked from the headers first. Every body the SPA sends has
// a Content-Length; a chunked body is refused instead of buffered without a bound.

/** Larger than any legitimate body (a view with 200 refs of 500 characters is about 100 KB). */
export const API_MAX_BODY_BYTES = 256 * 1024

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

export interface BodyProblem {
  status: 400 | 411 | 413
  message: string
}

/** What is wrong with the body announced by these headers, or null. */
export function apiBodyProblem(method: string, headers: Headers): BodyProblem | null {
  if (!BODY_METHODS.has(method.toUpperCase())) return null
  const encoding = headers.get('transfer-encoding')
  if (encoding && encoding.toLowerCase() !== 'identity') {
    return { status: 411, message: 'Length Required' }
  }
  const length = headers.get('content-length')
  if (length === null) return null
  if (!/^\d{1,12}$/.test(length.trim())) return { status: 400, message: 'Bad Content-Length' }
  return Number(length) > API_MAX_BODY_BYTES ? { status: 413, message: 'Payload Too Large' } : null
}
