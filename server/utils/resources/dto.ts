// What the resource routes send: plain objects, never rows.
import type { Database } from 'better-sqlite3'
import type { BookingRow, ResourceAclRow, ResourceRight, ResourceRow } from '../../db/types'

export function resourceDto(resource: ResourceRow, right?: ResourceRight) {
  return {
    id: resource.id,
    name: resource.name,
    type: resource.type,
    location: resource.location,
    capacity: resource.capacity,
    description: resource.description,
    active: resource.active === 1,
    ...(right ? { right } : {}),
  }
}

/**
 * A booking as its requester sees it (with the event reference) or as a manager sees it (with the
 * requester's name instead: a manager has no business in the booker's calendar).
 */
export function bookingDto(db: Database, booking: BookingRow, manager: boolean) {
  const base = {
    id: booking.id,
    resourceId: booking.resource_id,
    startAt: booking.start_at,
    endAt: booking.end_at,
    status: booking.status,
    decidedAt: booking.decided_at,
  }
  if (!manager) {
    return { ...base, eventCalendarId: booking.event_calendar_id, eventUid: booking.event_uid }
  }
  const requester = db
    .prepare<[number], { id: number; username: string | null; name: string | null }>(
      'SELECT id, username, name FROM users WHERE id = ?',
    )
    .get(booking.requester_id)
  return {
    ...base,
    requester: requester ?? { id: booking.requester_id, username: null, name: null },
    orphaned: booking.orphaned_at !== null,
  }
}

export function aclDto(rule: ResourceAclRow) {
  return { principalType: rule.principal_type, principal: rule.principal, right: rule.right }
}
