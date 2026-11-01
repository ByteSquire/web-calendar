// The glue of the resource routes: service results become API errors, the store and the limiter
// are the process's own.
import { createError, setResponseHeader, type H3Event } from 'h3'
import type { Database } from 'better-sqlite3'
import { getBooking } from '../../db/bookings'
import { createAdminLimiter, type AdminLimiter } from '../api/admin-limit'
import { apiConfig } from '../api/config'
import { ApiError, notFound } from '../api/errors'
import { requestIdOf } from '../api/admin-handler'
import type { ServiceDeps, ServiceErrorCode, ServiceResult } from './service'
import { getBlockStore } from './store'

const MESSAGES: Record<ServiceErrorCode, [400 | 403 | 404 | 409, string]> = {
  not_found: [404, 'Not found'],
  forbidden: [403, 'Forbidden'],
  invalid_slot: [400, 'The time slot is not valid'],
  invalid_event: [400, 'The event calendar is not one of yours'],
  calendar_not_readable: [403, 'You cannot read the calendar of the event'],
  in_past: [400, 'The slot starts in the past'],
  too_long: [400, 'The booking is longer than allowed'],
  too_far_ahead: [400, 'The booking is too far ahead'],
  daily_limit: [409, 'Too many bookings for that day'],
  live_limit: [409, 'Too many bookings open at once'],
  overlap: [409, 'The resource is already booked then'],
  resource_unavailable: [409, 'The resource is not available'],
  invalid_transition: [409, 'The booking cannot change to that state'],
}

/** The success value of a service result, or the API error for its code. */
export function unwrap<T extends object>(result: ServiceResult<T>): T {
  if (result.ok) return result
  const [status, message] = MESSAGES[result.code]
  throw status === 404 ? notFound() : new ApiError(status, message, { code: result.code })
}

let bookingLimiter: AdminLimiter | undefined

/** Booking creation: a burst of 10, then one every 2 seconds, per user (per process). */
export function takeBookingToken(event: H3Event, sub: string): void {
  bookingLimiter ??= createAdminLimiter({ burst: 10, refillPerSec: 0.5 })
  const wait = bookingLimiter.take(sub)
  if (wait === null) return
  setResponseHeader(event, 'retry-after', wait)
  throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' })
}

export function depsOf(event: H3Event, db: Database): ServiceDeps {
  return {
    db,
    store: getBlockStore(),
    requestId: requestIdOf(event),
    managerCancel: apiConfig().managerCancel,
  }
}

/** The booking of the URL, 404 when it belongs to another resource (or does not exist). */
export function requireBookingOf(db: Database, resourceId: number, bookingId: number): void {
  if (getBooking(db, bookingId)?.resource_id !== resourceId) throw notFound()
}
