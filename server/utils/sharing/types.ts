// Shared shapes of the sharing writer (security review §7.1).

export type SharingFailureKind =
  /** Network error, timeout or a 5xx answer: worth a retry. */
  | 'unreachable'
  /** Radicale answered 4xx or a redirect: the request itself is wrong or refused. */
  | 'rejected'
  /** An answer that is not what the API documents; nothing is done on its basis. */
  | 'malformed'
  | 'too-large'
  | 'invalid-principal'

export interface SharingFailure {
  kind: SharingFailureKind
  message: string
  status?: number
}

export type SharingResult<T> = { ok: true; value: T } | { ok: false; failure: SharingFailure }

export function sharingFail(
  kind: SharingFailureKind,
  message: string,
  status?: number,
): SharingResult<never> {
  return {
    ok: false,
    failure: status === undefined ? { kind, message } : { kind, message, status },
  }
}

export interface SharingLogger {
  warn(message: string): void
  error(message: string): void
}

/** The audit actor of everything the sharing jobs record. */
export const SHARING_ACTOR = 'system:sharing-writer'
/** The principal that owns the resource availability blocks; it is not a Kanidm user. */
export const RESOURCES_PRINCIPAL = '_resources'
/**
 * The principal that owns the calendars of the organization (made by admins on Admin › Calendars):
 * they belong to no person and no group, and reach people through their access rules only.
 */
export const ORGANIZATION_PRINCIPAL = '_organization'
/** The collection of resource blocks, shared with `f` to everyone. */
export const AVAILABILITY_PATH = '/_resources/availability/'
/** The name under which a member sees the availability collection in their home. */
export const AVAILABILITY_SHARE_NAME = 'resource-availability'

/** One Radicale map share as the API lists it. */
export interface RadicaleShare {
  pathMapped: string
  pathOrToken: string
  /** A user id, or `:group` for a group share. */
  user: string
  permissions: string
  enabled: boolean
  hidden: boolean
}
