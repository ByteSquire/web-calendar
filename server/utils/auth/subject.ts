/**
 * The user id that becomes Radicale's user name (a path component) and the `X-Remote-User` value:
 * printable ASCII, no `/` or `\`. Kanidm's `sub` is a UUID.
 */
export function isValidSubject(sub: unknown): sub is string {
  return typeof sub === 'string' && /^[\x21-\x7e]{1,255}$/.test(sub) && !/[/\\]/.test(sub)
}
