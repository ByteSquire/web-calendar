// The availability block of a booking (design §5): the entry that calendar apps see in the
// resource's own calendar (`/_resources/resource-<id>/`, shared read to everyone who may see the
// resource). It carries the slot, who booked ("Reserved by Alice", with the group when the
// booking's event is in a group's calendar) and a random back-reference, and nothing else: no title
// and nothing else of the booker's calendar. The text is English: it sits in Radicale once, the
// same for every reader, like the "Reserved" it replaced.
import { escapeText, foldLine } from '../../../app/utils/ical/write-lines'
import type { BookingRow } from '../../db/types'

/** The home of the `_resources` service principal, which holds the calendar of every resource. */
export const RESOURCES_HOME = '/_resources/'

const BLOCK_REF = /^[0-9a-f]{32}$/

/** The place for blocks. The real one acts as the service principal `_resources`. */
export interface BlockStore {
  put(path: string, ics: string): Promise<void>
  /** Deleting a block that is not there is not an error. */
  delete(path: string): Promise<void>
}

export type BlockSource = Pick<
  BookingRow,
  'block_ref' | 'start_at' | 'end_at' | 'status' | 'resource_id'
>

/**
 * Who a block names: the person who asked (null when the app knows no name for them), and the group
 * whose calendar holds the event.
 */
export interface BlockLabel {
  requester: string | null
  group: string | null
}

function checkedResourceId(resourceId: number): number {
  if (!Number.isSafeInteger(resourceId) || resourceId < 1) throw new Error('Invalid resource id')
  return resourceId
}

/** The calendar collection of a resource in the `_resources` home. */
export function resourceCollection(resourceId: number): string {
  return `${RESOURCES_HOME}resource-${checkedResourceId(resourceId)}/`
}

/** Where the block of a booking lives. Throws for a `block_ref` that is not ours (a bug). */
export function blockPath(resourceId: number, blockRef: string): string {
  if (!BLOCK_REF.test(blockRef)) throw new Error('Invalid block_ref')
  return `${resourceCollection(resourceId)}${blockRef}.ics`
}

/**
 * "Reserved by Alice", "Reserved by Alice (Team)" for an event in a group's calendar, "Reserved"
 * when the person has no name in the app.
 */
export function blockSummary(label: BlockLabel): string {
  const by = label.requester ? ` by ${label.requester}` : ''
  return `Reserved${by}${label.group ? ` (${label.group})` : ''}`
}

const compact = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/**
 * The `.ics` of the block, or null when there should be none (declined, cancelled). An approved
 * block is plain busy; a pending one has STATUS:TENTATIVE, which free-busy reports as
 * BUSY-TENTATIVE and calendar apps show as tentative. DTSTAMP is the time of the booking's last
 * change, so the text is the same on every call for the same booking state and names. The names
 * come from the identity provider: they are escaped as TEXT, so no line break or `;` can add a
 * property.
 */
export function buildAvailabilityBlock(
  booking: BlockSource & { updated_at: string },
  label: BlockLabel,
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
    foldLine(`SUMMARY:${escapeText(blockSummary(label))}`),
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
