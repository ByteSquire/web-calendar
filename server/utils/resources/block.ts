// The availability block of a booking (design §5): an opaque busy entry that third-party clients
// see in the derived `_resources` calendar. It carries the slot and a random back-reference and
// nothing else: no title, no requester, no resource, and nothing of the booker's calendar.
import type { BookingRow } from '../../db/types'

/** The collection of the `_resources` service principal that holds every block. */
export const AVAILABILITY_COLLECTION = '/_resources/availability/'

const BLOCK_REF = /^[0-9a-f]{32}$/

/** The place for blocks. The real one acts as the service principal `_resources`. */
export interface BlockStore {
  put(path: string, ics: string): Promise<void>
  /** Deleting a block that is not there is not an error. */
  delete(path: string): Promise<void>
}

export type BlockSource = Pick<BookingRow, 'block_ref' | 'start_at' | 'end_at' | 'status'>

/** Where the block of a booking lives. Throws for a `block_ref` that is not ours (a bug). */
export function blockPath(blockRef: string): string {
  if (!BLOCK_REF.test(blockRef)) throw new Error('Invalid block_ref')
  return `${AVAILABILITY_COLLECTION}${blockRef}.ics`
}

const compact = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/**
 * The `.ics` of the block, or null when there should be none (declined, cancelled). An approved
 * block is plain busy; a pending one has STATUS:TENTATIVE, which free-busy reports as
 * BUSY-TENTATIVE. DTSTAMP is the time of the booking's last change, so the text is the same on
 * every call for the same booking state.
 */
export function buildAvailabilityBlock(
  booking: BlockSource & { updated_at: string },
): string | null {
  if (booking.status !== 'pending' && booking.status !== 'approved') return null
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//web-calendar//Resource availability//EN',
    'BEGIN:VEVENT',
    `UID:${booking.block_ref}@resources.web-calendar.invalid`,
    `DTSTAMP:${compact(booking.updated_at)}`,
    `DTSTART:${compact(booking.start_at)}`,
    `DTEND:${compact(booking.end_at)}`,
    'SUMMARY:Reserved',
    'TRANSP:OPAQUE',
    'CLASS:CONFIDENTIAL',
    ...(booking.status === 'pending' ? ['STATUS:TENTATIVE'] : []),
    `X-WEB-CALENDAR-BLOCK:${booking.block_ref}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return `${lines.join('\r\n')}\r\n`
}

/** The default until the integration wires the real store: keeps nothing, says so in the log. */
export function createLoggingBlockStore(
  log: (message: string) => void = (message) => console.warn(message),
): BlockStore {
  return {
    async put(path) {
      log(`[resources] no block store wired; not writing ${path}`)
    },
    async delete(path) {
      log(`[resources] no block store wired; not deleting ${path}`)
    },
  }
}
