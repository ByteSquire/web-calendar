// Who is booked when (design §5): approved and pending bookings per resource. A booking is shown
// as blocked, without who or why, unless it is the caller's own or the caller can read the
// calendar of its event; that decision is the gateway pre-check's, so both agree.
import type { Database } from 'better-sqlite3'
import type {
  AvailabilityEntry,
  AvailabilityResponse,
  ResourceAvailability,
} from '../../../shared/types/resources-api'
import { MAX_AVAILABILITY_RANGE_DAYS } from '../../../shared/types/resources-api'
import { FieldErrors, finish, type Parsed } from '../api/validation'
import { eventCalendarReader } from './event-calendar'
import { listResourcesFor, type Actor } from './service'

export const MAX_RESOURCE_IDS = 50
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/
const DAY_MS = 86_400_000

/** An ISO 8601 date-time with a zone as UTC text with milliseconds, or null. */
export function normalizeInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

export function readInstantParam(value: unknown, field: string, errors: FieldErrors) {
  const instant = normalizeInstant(value)
  if (instant === null) {
    errors.add(field, 'must be an ISO 8601 date-time with a zone, like 2026-11-05T09:00:00Z')
  }
  return instant ?? undefined
}

export interface AvailabilityQuery {
  from: string
  to: string
  /** Empty: every resource the caller may read. */
  resourceIds: number[]
}

export function parseAvailabilityQuery(query: Record<string, unknown>): Parsed<AvailabilityQuery> {
  const errors = new FieldErrors()
  const from = readInstantParam(query.from, 'from', errors)
  const to = readInstantParam(query.to, 'to', errors)
  if (from && to) {
    if (Date.parse(to) <= Date.parse(from)) errors.add('to', 'must be after from')
    else if (Date.parse(to) - Date.parse(from) > MAX_AVAILABILITY_RANGE_DAYS * DAY_MS) {
      errors.add('to', `must be at most ${MAX_AVAILABILITY_RANGE_DAYS} days after from`)
    }
  }
  const ids = new Set<number>()
  const raw = query.resource
  if (raw !== undefined) {
    if (typeof raw !== 'string') errors.add('resource', 'must be a comma-separated list of ids')
    else {
      for (const part of raw.split(',')) {
        if (!/^[1-9][0-9]{0,14}$/.test(part)) {
          errors.add('resource', 'must be a comma-separated list of ids')
          break
        }
        ids.add(Number(part))
      }
      if (ids.size > MAX_RESOURCE_IDS) {
        errors.add('resource', `must have at most ${MAX_RESOURCE_IDS} ids`)
      }
    }
  }
  return finish(errors, () => ({
    from: from!,
    to: to!,
    resourceIds: [...ids].sort((a, b) => a - b),
  }))
}

interface Row {
  id: number
  resource_id: number
  requester_id: number
  start_at: string
  end_at: string
  status: 'approved' | 'pending'
  event_uid: string
  event_calendar_path: string
  requester_name: string
}

export async function listAvailability(
  db: Database,
  actor: Actor,
  query: AvailabilityQuery,
): Promise<AvailabilityResponse> {
  const wanted = new Set(query.resourceIds)
  const ids = listResourcesFor(db, actor)
    .map((view) => view.resource.id)
    .filter((id) => wanted.size === 0 || wanted.has(id))
  const byResource = new Map<number, AvailabilityEntry[]>(ids.map((id) => [id, []]))
  if (ids.length > 0) {
    const rows = db
      .prepare<unknown[], Row>(
        `SELECT b.id, b.resource_id, b.requester_id, b.start_at, b.end_at, b.status, b.event_uid,
                b.event_calendar_path,
                COALESCE(NULLIF(u.name, ''), u.username) AS requester_name
         FROM calendar_bookings b
         JOIN users u ON u.id = b.requester_id
         WHERE b.resource_id IN (${ids.map(() => '?').join(',')})
           AND b.status IN ('approved', 'pending') AND b.start_at < ? AND b.end_at > ?
         ORDER BY b.start_at, b.id`,
      )
      .all(...ids, query.to, query.from)
    const canRead = eventCalendarReader(db, actor)
    for (const row of rows) {
      const mine = row.requester_id === actor.id
      const detailed = mine || (await canRead(row.event_calendar_path))
      const entry: AvailabilityEntry = {
        bookingId: row.id,
        start: row.start_at,
        end: row.end_at,
        status: row.status,
        blocked: !detailed,
        mine,
        ...(detailed ? { requesterName: row.requester_name, eventUid: row.event_uid } : {}),
      }
      byResource.get(row.resource_id)?.push(entry)
    }
  }
  const resources: ResourceAvailability[] = ids.map((resourceId) => ({
    resourceId,
    entries: byResource.get(resourceId) ?? [],
  }))
  return { from: query.from, to: query.to, resources }
}
