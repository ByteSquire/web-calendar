// Errors of the JSON API (`/api/**`). Plain classes without h3, so the logic modules and their
// tests need no Nitro; `handler.ts` turns them into HTTP errors.

/** One rejected input value; `field` is a path such as `name` or `calendars[3].ref`. */
export interface FieldError {
  field: string
  message: string
}

export type ApiErrorStatus = 400 | 403 | 404 | 409 | 502

export const API_STATUS_TEXT: Record<ApiErrorStatus, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  502: 'Bad Gateway',
}

export class ApiError extends Error {
  constructor(
    readonly statusCode: ApiErrorStatus,
    message: string,
    /** Machine-readable details for the client, sent as `data` of the error response. */
    readonly data?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 400 with the list of rejected fields in `data.fields`. */
export function toBadRequest(fields: FieldError[]): ApiError {
  return new ApiError(400, 'The request is not valid', { fields })
}

/** 403: the caller is signed in but may not do this (admin routes). */
export function forbidden(): ApiError {
  return new ApiError(403, 'Forbidden')
}

/** 404 for "not found" and "not yours" alike, so ids of other users are not revealed. */
export function notFound(): ApiError {
  return new ApiError(404, 'Not found')
}

/** 409: a limit is reached (`limit_reached`), the name is taken (`duplicate`) or the state forbids it. */
export function conflict(
  code: 'limit_reached' | 'duplicate' | 'has_calendars',
  message: string,
): ApiError {
  return new ApiError(409, message, { code })
}

/** 502: the calendar server (Radicale) did not do what was asked; nothing was changed here. */
export function upstreamFailed(message: string): ApiError {
  return new ApiError(502, message, { code: 'upstream_unavailable' })
}

/** The 404 of a lookup that found nothing. */
export function found<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw notFound()
  return value
}
