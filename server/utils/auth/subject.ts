import { GROUP_PRINCIPAL_PREFIX } from '../sharing/names'
import { RESOURCES_PRINCIPAL } from '../sharing/types'

/**
 * The user id that becomes Radicale's user name (a path component), the `X-Remote-User` value and a
 * member in an htgroup line. The identity provider chooses it, so the shape is the one Radicale 3.9
 * and the htgroup format accept (probed against Radicale 3.9.0 with its `deploy/radicale/config`):
 *
 * - printable ASCII without a space, 1 to 255 characters;
 * - none of `/ \ : ' " * ? ,`: a path separator, the htgroup separator, or refused by Radicale's
 *   user blacklist with a confusing 400;
 * - at most one `@`, and not as the first or last character (Radicale answers 403);
 * - not starting with `.` (a dot name) and not ending with `~` (Radicale answers 500).
 *
 * Case is kept: Radicale tells `Ab` and `ab` apart everywhere. The app's own service principals
 * (`_resources`, `_group-<id>`, the shared owners) have this shape too, because the app acts as
 * them; `isUserSubject` is the check for an id that names a person.
 */
export function isValidSubject(sub: unknown): sub is string {
  if (typeof sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(sub)) return false
  if (/[/\\:'"*?,]/.test(sub) || sub.startsWith('.') || sub.endsWith('~')) return false
  const at = sub.indexOf('@')
  return at === -1 || (at > 0 && at < sub.length - 1 && sub.indexOf('@', at + 1) === -1)
}

/**
 * Whether a name belongs to one of the app's own Radicale principals: the owner of the resource
 * availability blocks, every group principal (the whole `_group-` prefix) and the configured shared
 * owners (`NUXT_SHARING_SHARED_OWNERS`). Radicale treats them like any user, so an identity provider
 * id equal to one would own that principal's calendars; no person may have such an id.
 *
 * Every principal the app creates must be covered here; `tests/server/auth-subject.test.ts` lists them.
 */
export function isReservedPrincipal(sub: string, sharedOwners: readonly string[] = []): boolean {
  return (
    sub === RESOURCES_PRINCIPAL ||
    sub.startsWith(GROUP_PRINCIPAL_PREFIX) ||
    sharedOwners.includes(sub)
  )
}

/** A valid id that names a person: the shape of `isValidSubject` and no reserved principal. */
export function isUserSubject(sub: unknown, sharedOwners: readonly string[] = []): sub is string {
  return isValidSubject(sub) && !isReservedPrincipal(sub, sharedOwners)
}
