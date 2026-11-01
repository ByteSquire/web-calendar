// Validation of the bodies of the resource routes, in the style of server/utils/api/validation.ts.
import type { ResourceAclInput } from '../../db/resource-acl'
import type { ResourceFields } from '../../db/resources'
import type { ResourceAclPrincipalType, ResourceRight, ResourceType } from '../../db/types'
import {
  FieldErrors,
  finish,
  isRecord,
  readChoice,
  readObject,
  readOptionalBoolean,
  readText,
  type Parsed,
} from '../api/validation'
import { PathRejection, resolvePublicPath } from '../gateway/paths'
import { isGroupName } from '../group-sync/format'
import { splitCollectionPath } from '../sharing/names'
import type { NewBookingRequest } from './service'

export const RESOURCE_TYPES = ['room', 'car', 'equipment'] as const satisfies ResourceType[]
/** `write`-style rights do not exist for resources; these are all there is. */
export const RESOURCE_RIGHTS = ['read', 'book', 'manage'] as const satisfies ResourceRight[]
const PRINCIPAL_TYPES = [
  'user',
  'group',
  'authenticated',
] as const satisfies ResourceAclPrincipalType[]

const MAX_ACL_RULES = 200
const MAX_UID_LENGTH = 255
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function readInstant(value: unknown, field: string, errors: FieldErrors): string | undefined {
  if (typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value))) {
    return value
  }
  errors.add(field, 'must be an ISO 8601 date-time with a zone, like 2026-11-05T09:00:00Z')
  return undefined
}

/** Optional text: omitted keeps (`undefined`), `null` or blank clears, else 1..max characters. */
function readOptionalText(
  value: unknown,
  field: string,
  max: number,
  errors: FieldErrors,
): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    errors.add(field, 'must be a string or null')
    return undefined
  }
  const text = value.trim()
  if (text.length > max) {
    errors.add(field, `must have at most ${max} characters`)
    return undefined
  }
  return text === '' ? null : text
}

function readCapacity(value: unknown, errors: FieldErrors): { value: number | null | undefined } {
  if (value === undefined || value === null) return { value }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100_000) {
    return { value }
  }
  errors.add('capacity', 'must be a whole number from 1 to 100000, or null')
  return { value: undefined }
}

/** `/caldav/<owner>/<name>/` as the stored `/owner/name/`, or null when it is no calendar path. */
function storedCollectionPath(value: string): string | null {
  try {
    const { upstreamPath } = resolvePublicPath(value.endsWith('/') ? value : `${value}/`, {
      allowQuery: false,
    })
    const path = decodeURIComponent(upstreamPath)
    return splitCollectionPath(path) ? path : null
  } catch (error) {
    if (error instanceof PathRejection) return null
    throw error
  }
}

export function parseBookingInput(body: unknown, resourceId: number): Parsed<NewBookingRequest> {
  const errors = new FieldErrors()
  const input = readObject(body, errors)
  const startAt = readInstant(input.startAt, 'startAt', errors)
  const endAt = readInstant(input.endAt, 'endAt', errors)
  const eventUid = readText(input.eventUid, 'eventUid', MAX_UID_LENGTH, errors)
  let eventCalendarId: number | null = null
  if (input.eventCalendarId !== undefined && input.eventCalendarId !== null) {
    const id = input.eventCalendarId
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) eventCalendarId = id
    else errors.add('eventCalendarId', 'must be a calendar id or null')
  }
  let eventCalendarPath: string | null = null
  if (input.eventCalendarPath !== undefined && input.eventCalendarPath !== null) {
    const path =
      typeof input.eventCalendarPath === 'string' && input.eventCalendarPath.length <= 500
        ? storedCollectionPath(input.eventCalendarPath)
        : null
    if (path === null) {
      errors.add('eventCalendarPath', 'must be a calendar path like /caldav/<owner>/<name>/')
    } else if (eventCalendarId !== null) {
      errors.add('eventCalendarPath', 'give the calendar by id or by path, not both')
    } else {
      eventCalendarPath = path
    }
  }
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) {
    errors.add('endAt', 'must be after startAt')
  }
  return finish(errors, () => ({
    resourceId,
    startAt: startAt!,
    endAt: endAt!,
    eventCalendarId,
    eventCalendarPath,
    eventUid: eventUid!,
  }))
}

export function parseResourceCreate(body: unknown): Parsed<ResourceFields> {
  const errors = new FieldErrors()
  const input = readObject(body, errors)
  const name = readText(input.name, 'name', 100, errors)
  const type = readChoice(input.type, 'type', RESOURCE_TYPES, errors)
  const location = readOptionalText(input.location, 'location', 200, errors)
  const description = readOptionalText(input.description, 'description', 2000, errors)
  const capacity = readCapacity(input.capacity, errors)
  return finish(errors, () => ({
    name: name!,
    type: type!,
    location: location ?? null,
    description: description ?? null,
    capacity: capacity.value ?? null,
  }))
}

export type ResourcePatch = Partial<ResourceFields> & { active?: boolean }

export function parseResourceUpdate(body: unknown): Parsed<ResourcePatch> {
  const errors = new FieldErrors()
  const input = readObject(body, errors)
  const patch: ResourcePatch = {}
  if (input.name !== undefined) {
    const name = readText(input.name, 'name', 100, errors)
    if (name !== undefined) patch.name = name
  }
  if (input.type !== undefined) {
    const type = readChoice(input.type, 'type', RESOURCE_TYPES, errors)
    if (type !== undefined) patch.type = type
  }
  const location = readOptionalText(input.location, 'location', 200, errors)
  if (location !== undefined) patch.location = location
  const description = readOptionalText(input.description, 'description', 2000, errors)
  if (description !== undefined) patch.description = description
  const capacity = readCapacity(input.capacity, errors)
  if (capacity.value !== undefined) patch.capacity = capacity.value
  const active = readOptionalBoolean(input.active, 'active', errors)
  if (active !== undefined) patch.active = active
  if (errors.ok && Object.keys(patch).length === 0) errors.add('body', 'has nothing to change')
  return finish(errors, () => patch)
}

/**
 * The rules of `PUT .../acl`. `write`, `admin`, `public` and everything else that exists for
 * calendars is refused here (the DB module refuses `public` as well).
 */
export function parseResourceAcl(body: unknown): Parsed<ResourceAclInput[]> {
  const errors = new FieldErrors()
  const input = readObject(body, errors)
  const rules: ResourceAclInput[] = []
  if (!Array.isArray(input.rules)) {
    if (errors.ok) errors.add('rules', 'must be a list')
  } else if (input.rules.length > MAX_ACL_RULES) {
    errors.add('rules', `must have at most ${MAX_ACL_RULES} entries`)
  } else {
    input.rules.forEach((raw: unknown, index) => {
      const at = `rules[${index}]`
      if (!isRecord(raw)) {
        errors.add(at, 'must be an object')
        return
      }
      const principalType = readChoice(
        raw.principalType,
        `${at}.principalType`,
        PRINCIPAL_TYPES,
        errors,
      )
      const right = readChoice(raw.right, `${at}.right`, RESOURCE_RIGHTS, errors)
      let principal: string | null = null
      if (principalType === 'authenticated') {
        if (raw.principal !== undefined && raw.principal !== null) {
          errors.add(`${at}.principal`, 'must be empty for authenticated')
        }
      } else if (principalType !== undefined) {
        const text = typeof raw.principal === 'string' ? raw.principal : ''
        const isGroup = principalType === 'group'
        // Group names are case-sensitive; only user ids are folded.
        if (isGroup ? isGroupName(text) : UUID.test(text)) {
          principal = isGroup ? text : text.toLowerCase()
        } else {
          errors.add(
            `${at}.principal`,
            isGroup ? 'must be a group name' : 'must be a user id (UUID)',
          )
        }
      }
      if (principalType && right) rules.push({ principalType, principal, right })
    })
  }
  return finish(errors, () => rules)
}
