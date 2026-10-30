// How much one import may take (FR-7, importing a file) and which files are refused before they are
// read. The file is untrusted: the limits keep the browser's work, and the number of requests to the
// calendar service, bounded. The gateway and Radicale cap a request body at 10 MB each by default,
// which a file of at most 5 MB cannot reach; with a lower cap an event can still be refused as too
// large, and the import reports that for the event.
import { formatBytes } from '../settings/format'

/** The largest file that is read. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024
/** The most events (resources, one per UID) one import writes; a larger file is refused, not cut. */
export const MAX_EVENTS = 2000
/** Requests to the calendar service running at the same time. */
export const CONCURRENCY = 4
/** The import stops after this many failed requests in a row that look like an outage. */
export const MAX_CONSECUTIVE_FAILURES = 5
/** The part of a file looked at for binary content before the rest is read. */
export const SNIFF_BYTES = 4096

export interface PickedFile {
  name: string
  size: number
  type: string
}

const CALENDAR_NAME = /\.(?:ics|ical|icalendar|ifb)$/i
// Windows gives files it has no type for `''` or `application/octet-stream`.
const UNSPECIFIC_TYPES = new Set(['', 'application/octet-stream', 'application/ics'])

/**
 * Why a file is not read, in words, or null when it may be. Looks at the size and the type the
 * browser reports, never at the content, so a refused file is not read at all.
 */
export function checkFile(file: PickedFile): string | null {
  if (file.size === 0) return 'The file is empty.'
  if (file.size > MAX_FILE_BYTES) {
    return (
      `The file is too large (${formatBytes(file.size)}). Files up to ` +
      `${formatBytes(MAX_FILE_BYTES)} can be imported; split the calendar into smaller files.`
    )
  }
  const type = file.type.toLowerCase().split(';')[0]!.trim()
  if (!type.startsWith('text/') && !UNSPECIFIC_TYPES.has(type) && !CALENDAR_NAME.test(file.name)) {
    return 'This does not look like a calendar file. Choose an .ics file.'
  }
  return null
}

/** True when the beginning of a file holds a NUL character: a binary file, or UTF-16 text. */
export function looksBinary(head: string): boolean {
  return head.includes('\u0000')
}
