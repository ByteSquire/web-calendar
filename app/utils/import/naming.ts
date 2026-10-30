// Names for imported resources (FR-7, importing a file). A UID comes from the file and is untrusted:
// it may hold `/`, `..`, `%2F`, control characters or ten thousand characters, and it must not decide
// a path. The resource is named after a hash of the UID instead. The same UID always lands on the
// same name, so a second import finds its events again (`If-None-Match: *` answers 412), and
// nothing in a name can leave the calendar collection.
import { ensureTrailingSlash } from '../caldav/urls'

/** SHA-256 of the text (as UTF-8) in 64 lower-case hex digits. Needs a secure context, as the sign-in does. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * `<32 hex digits>.ics`: 128 bits of the UID's hash. Two UIDs sharing a name would make the second
 * event look "already there" and be dropped, so the name is not shortened any further.
 */
export async function resourceName(uid: string): Promise<string> {
  return `${(await sha256Hex(uid)).slice(0, 32)}.ics`
}

/** The URL of the resource `name` in the calendar collection. */
export function resourceHref(calendarHref: string, name: string): string {
  return `${ensureTrailingSlash(calendarHref)}${name}`
}
