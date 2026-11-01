// Bookings of resources (FR-16/17/19): the rules in one place, over the frozen DB modules. Every
// state change is one transaction with its audit entry; the availability block is written after
// the commit, so a store that is down never loses a booking - `syncBlock` can run again, and
// `repairBlocks` does that for every booking that may still matter.
import type { Database } from 'better-sqlite3'
import { recordAudit } from '../../db/audit-log'
import {
  approveBooking,
  createBooking,
  getBooking,
  listBookingsByRequester,
  listBookingsByResource,
  listBookingsInRange,
  transitionBooking,
  type BookingErrorCode,
  type BookingLimits,
} from '../../db/bookings'
import { getResource, listResources } from '../../db/resources'
import { effectiveResourceRight } from '../../db/resource-acl'
import type { BookingRow, ResourceRight, ResourceRow } from '../../db/types'
import { blockPath, buildAvailabilityBlock, type BlockStore } from './block'

export interface Actor {
  id: number
  /** The Kanidm `sub`; recorded as the actor of every audit entry. */
  sub: string
  /** Short group names (see `callerGroups`). */
  groups: readonly string[]
}

export interface ServiceDeps {
  db: Database
  store: BlockStore
  now?: () => Date
  limits?: Partial<BookingLimits>
  log?: (message: string) => void
  requestId?: string
}

export type ServiceErrorCode = BookingErrorCode | 'forbidden' | 'invalid_event'
export type ServiceResult<T> = ({ ok: true } & T) | { ok: false; code: ServiceErrorCode }

export interface NewBookingRequest {
  resourceId: number
  startAt: string
  endAt: string
  /** The booker's own calendar holding the event; null when the event is not saved yet. */
  eventCalendarId: number | null
  eventUid: string
}

const RANK: Record<ResourceRight, number> = { read: 1, book: 2, manage: 3 }
const SYSTEM_ACTOR = 'system:resources'
/** A booking that ended earlier than this no longer needs its block repaired. */
const REPAIR_WINDOW_MS = 24 * 60 * 60 * 1000

const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({
  ok: false,
  code,
})

export function rightAtLeast(right: ResourceRight | null, wanted: ResourceRight): boolean {
  return right !== null && RANK[right] >= RANK[wanted]
}

function audit(
  deps: ServiceDeps,
  actorSub: string,
  action: string,
  booking: BookingRow,
  extra: Record<string, unknown> = {},
): void {
  recordAudit(deps.db, {
    actorSub,
    action,
    target: `booking:${booking.id}`,
    details: { bookingId: booking.id, resourceId: booking.resource_id, ...extra },
    requestId: deps.requestId,
  })
}

/** Puts or removes the block so it matches the booking. Never throws; false when the store failed. */
export async function syncBlock(
  deps: ServiceDeps,
  booking: BookingRow,
  options: { actorSub?: string; auditFailure?: boolean } = {},
): Promise<boolean> {
  const log = deps.log ?? ((message: string) => console.warn(message))
  const ics = buildAvailabilityBlock(booking)
  try {
    const path = blockPath(booking.block_ref)
    if (ics === null) await deps.store.delete(path)
    else await deps.store.put(path, ics)
    return true
  } catch (error) {
    // The error text may hold a URL or a response body: only its type is logged.
    const kind = error instanceof Error ? error.name : 'error'
    log(`[resources] block of booking ${booking.id} not synced (${kind}); it will be retried`)
    if (options.auditFailure !== false) {
      try {
        audit(deps, options.actorSub ?? SYSTEM_ACTOR, 'resource_booking.block_failed', booking, {
          status: booking.status,
        })
      } catch {
        log(`[resources] audit of the block failure of booking ${booking.id} failed`)
      }
    }
    return false
  }
}

/**
 * Makes the blocks of the bookings that may still matter match the database again (a scheduler
 * or a start-up hook calls this). Bookings that ended long ago are left alone.
 */
export async function repairBlocks(deps: ServiceDeps): Promise<{ synced: number; failed: number }> {
  const now = (deps.now ?? (() => new Date()))()
  const from = new Date(now.getTime() - REPAIR_WINDOW_MS).toISOString()
  let synced = 0
  let failed = 0
  for (const booking of listBookingsInRange(deps.db, { from })) {
    // Failures are logged, not audited again on every run.
    if (await syncBlock(deps, booking, { auditFailure: false })) synced++
    else failed++
  }
  return { synced, failed }
}

function ownsCalendar(db: Database, actor: Actor, calendarId: number): boolean {
  return (
    db
      .prepare<[number, number], { found: 1 }>(
        'SELECT 1 AS found FROM calendars WHERE id = ? AND owner_id = ?',
      )
      .get(calendarId, actor.id) !== undefined
  )
}

export async function requestBooking(
  deps: ServiceDeps,
  actor: Actor,
  input: NewBookingRequest,
): Promise<ServiceResult<{ booking: BookingRow }>> {
  const { db } = deps
  const create = db.transaction((): ServiceResult<{ booking: BookingRow }> => {
    // A resource the caller may not even read does not exist for them.
    const right = effectiveResourceRight(db, input.resourceId, actor)
    if (!getResource(db, input.resourceId) || right === null) return fail('not_found')
    if (!rightAtLeast(right, 'book')) return fail('forbidden')
    // Only the booker's own calendar may be named, so a booking cannot point into a stranger's.
    if (input.eventCalendarId !== null && !ownsCalendar(db, actor, input.eventCalendarId)) {
      return fail('invalid_event')
    }
    const result = createBooking(
      db,
      { ...input, requesterId: actor.id },
      { now: deps.now?.(), limits: deps.limits },
    )
    if (!result.ok) return result
    audit(deps, actor.sub, 'resource_booking.created', result.booking)
    return result
  })
  const result = create.immediate()
  if (result.ok) await syncBlock(deps, result.booking, { actorSub: actor.sub })
  return result
}

interface Loaded {
  booking: BookingRow
  right: ResourceRight | null
  isRequester: boolean
}

/** The booking if the caller may know of it: its requester, or a manager of its resource. */
function load(deps: ServiceDeps, actor: Actor, id: number): Loaded | null {
  const booking = getBooking(deps.db, id)
  if (!booking) return null
  const right = effectiveResourceRight(deps.db, booking.resource_id, actor)
  const isRequester = booking.requester_id === actor.id
  if (!isRequester && right !== 'manage') return null
  return { booking, right, isRequester }
}

export async function acceptBooking(
  deps: ServiceDeps,
  actor: Actor,
  id: number,
): Promise<ServiceResult<{ booking: BookingRow; declined: BookingRow[] }>> {
  const approve = deps.db.transaction(
    (): ServiceResult<{ booking: BookingRow; declined: BookingRow[] }> => {
      const loaded = load(deps, actor, id)
      if (!loaded) return fail('not_found')
      if (loaded.right !== 'manage') return fail('forbidden')
      const result = approveBooking(deps.db, id, actor.id, deps.now?.())
      if (!result.ok) return result
      const declined = result.declinedIds.map((declinedId) => getBooking(deps.db, declinedId)!)
      audit(deps, actor.sub, 'resource_booking.approved', result.booking)
      for (const other of declined) {
        audit(deps, actor.sub, 'resource_booking.declined', other, {
          automatic: true,
          reason: 'overlap',
          becauseOfBookingId: id,
        })
      }
      return { ok: true, booking: result.booking, declined }
    },
  )
  const result = approve.immediate()
  if (result.ok) {
    for (const booking of [result.booking, ...result.declined]) {
      await syncBlock(deps, booking, { actorSub: actor.sub })
    }
  }
  return result
}

export async function declineBooking(
  deps: ServiceDeps,
  actor: Actor,
  id: number,
): Promise<ServiceResult<{ booking: BookingRow }>> {
  return move(deps, actor, id, 'declined')
}

export async function cancelBooking(
  deps: ServiceDeps,
  actor: Actor,
  id: number,
): Promise<ServiceResult<{ booking: BookingRow }>> {
  return move(deps, actor, id, 'cancelled')
}

async function move(
  deps: ServiceDeps,
  actor: Actor,
  id: number,
  to: 'declined' | 'cancelled',
): Promise<ServiceResult<{ booking: BookingRow }>> {
  const run = deps.db.transaction((): ServiceResult<{ booking: BookingRow }> => {
    const loaded = load(deps, actor, id)
    if (!loaded) return fail('not_found')
    // Declining is the manager's decision; cancelling also belongs to the one who asked.
    const allowed = loaded.right === 'manage' || (to === 'cancelled' && loaded.isRequester)
    if (!allowed) return fail('forbidden')
    const result = transitionBooking(deps.db, id, to, actor.id, deps.now?.())
    if (!result.ok) return result
    audit(deps, actor.sub, `resource_booking.${to}`, result.booking)
    return result
  })
  const result = run.immediate()
  if (result.ok) await syncBlock(deps, result.booking, { actorSub: actor.sub })
  return result
}

export interface ResourceView {
  resource: ResourceRow
  right: ResourceRight
}

/** Active resources the caller may at least read. */
export function listResourcesFor(db: Database, actor: Actor): ResourceView[] {
  const views: ResourceView[] = []
  for (const resource of listResources(db)) {
    const right = effectiveResourceRight(db, resource.id, actor)
    if (right !== null) views.push({ resource, right })
  }
  return views
}

/** The resource if it is active and the caller may read it. */
export function getResourceFor(db: Database, actor: Actor, id: number): ResourceView | null {
  const resource = getResource(db, id)
  if (!resource || resource.active !== 1) return null
  const right = effectiveResourceRight(db, id, actor)
  return right === null ? null : { resource, right }
}

/** A manager sees every booking of the resource, anybody else only their own. */
export function listBookingsFor(
  db: Database,
  actor: Actor,
  resourceId: number,
): { bookings: BookingRow[]; manager: boolean } | null {
  const view = getResourceFor(db, actor, resourceId)
  if (!view) return null
  if (view.right === 'manage') {
    return { bookings: listBookingsByResource(db, resourceId), manager: true }
  }
  const own = listBookingsByRequester(db, actor.id).filter((b) => b.resource_id === resourceId)
  return { bookings: own, manager: false }
}
