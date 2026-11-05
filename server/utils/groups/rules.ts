// Input of the group routes: every field is read and checked here, so a route sees either typed
// values or a 400 with the list of rejected fields. Limits that are about the size of the input are
// checked here (400); limits that depend on what is stored (groups, calendars per group) are 409 in
// the service.
import { isValidSubject } from '../auth/subject'
import { isGroupName } from '../group-sync/format'
import {
  FieldErrors,
  finish,
  isRecord,
  readChoice,
  readObject,
  readOptionalColor,
  readText,
  type Parsed,
} from '../api/validation'
import type { Permission } from '../../db/types'

export const MAX_GROUPS = 200
export const MAX_MEMBERS = 500
export const MAX_CALENDARS_PER_GROUP = 50
export const MAX_SHARES_PER_CALENDAR = 100
export const MAX_CALENDAR_NAME = 100
export const MAX_GROUP_NAME = 64
export const MAX_PEOPLE = 2000

/** Control characters have no place in a name that Radicale shows in clients. */
const CONTROL = /\p{Cc}/u

export interface CalendarInput {
  name?: string
  /** undefined: unchanged; null: no colour; `#rrggbb`: set. */
  color?: string | null
}

export interface ShareInput {
  principalType: 'user' | 'group'
  principal: string
  permission: Extract<Permission, 'read' | 'write'>
}

function readCalendarName(value: unknown, field: string, errors: FieldErrors): string | undefined {
  const name = readText(value, field, MAX_CALENDAR_NAME, errors)
  if (name !== undefined && CONTROL.test(name)) {
    errors.add(field, 'must not contain control characters')
    return undefined
  }
  return name
}

/** `{ name }`: a custom group's name, checked for shape only (reserved and taken names are the service's). */
export function parseGroupCreate(body: unknown): Parsed<{ name: string }> {
  const errors = new FieldErrors()
  const object = readObject(body, errors)
  const name = readText(object.name, 'name', MAX_GROUP_NAME, errors)
  if (name !== undefined && !isGroupName(name)) {
    errors.add(
      'name',
      `must start with a letter or digit and use only letters, digits, "-", "_" and "."`,
    )
  }
  return finish(errors, () => ({ name: name! }))
}

/** `{ members }`: the complete list of `sub` ids as given (case matters), unique, at most MAX_MEMBERS. */
export function parseMembersBody(body: unknown): Parsed<string[]> {
  const errors = new FieldErrors()
  const object = readObject(body, errors)
  const members: string[] = []
  if (!Array.isArray(object.members)) {
    if (errors.ok) errors.add('members', 'must be a list')
  } else if (object.members.length > MAX_MEMBERS) {
    errors.add('members', `must have at most ${MAX_MEMBERS} people`)
  } else {
    const seen = new Set<string>()
    object.members.forEach((raw: unknown, index) => {
      const sub = typeof raw === 'string' ? raw : ''
      if (!isValidSubject(sub)) {
        errors.add(`members[${index}]`, 'must be the id of a person')
      } else if (seen.has(sub)) {
        errors.add(`members[${index}]`, 'is listed twice')
      } else {
        seen.add(sub)
        members.push(sub)
      }
    })
  }
  return finish(errors, () => members)
}

/** `{ name, color? }` for a new calendar; an omitted or `null` colour means none. */
export function parseCalendarCreate(body: unknown): Parsed<{ name: string; color?: string }> {
  const errors = new FieldErrors()
  const object = readObject(body, errors)
  const name = readCalendarName(object.name, 'name', errors)
  const color = readOptionalColor(object.color, 'color', errors)
  return finish(errors, () => ({
    name: name!,
    ...(color ? { color } : {}),
  }))
}

/**
 * `{ name?, color? }` for a change. `color: null` clears the colour (the edit form sends it for an
 * uncoloured calendar too), a `#rrggbb` sets it, and an omitted colour is left as it is.
 */
export function parseCalendarPatch(body: unknown): Parsed<CalendarInput> {
  const errors = new FieldErrors()
  const object = readObject(body, errors)
  const name = object.name === undefined ? undefined : readCalendarName(object.name, 'name', errors)
  const color = readOptionalColor(object.color, 'color', errors)
  if (errors.ok && name === undefined && color === undefined) {
    errors.add('body', 'gives a name or a colour to change')
  }
  return finish(errors, () => ({
    ...(name !== undefined ? { name } : {}),
    ...(color !== undefined ? { color } : {}),
  }))
}

/** `{ shares }`: the complete list of extra shares of one calendar. */
export function parseSharesBody(body: unknown): Parsed<ShareInput[]> {
  const errors = new FieldErrors()
  const object = readObject(body, errors)
  const shares: ShareInput[] = []
  if (!Array.isArray(object.shares)) {
    if (errors.ok) errors.add('shares', 'must be a list')
  } else if (object.shares.length > MAX_SHARES_PER_CALENDAR) {
    errors.add('shares', `must have at most ${MAX_SHARES_PER_CALENDAR} shares`)
  } else {
    const seen = new Set<string>()
    object.shares.forEach((raw: unknown, index) => {
      const at = `shares[${index}]`
      if (!isRecord(raw)) {
        errors.add(at, 'must be an object')
        return
      }
      const type = readChoice(
        raw.principalType,
        `${at}.principalType`,
        ['user', 'group'] as const,
        errors,
      )
      const permission = readChoice(
        raw.permission,
        `${at}.permission`,
        ['read', 'write'] as const,
        errors,
      )
      let principal: string | undefined
      if (type === 'user') {
        const sub = typeof raw.principal === 'string' ? raw.principal : ''
        if (isValidSubject(sub)) principal = sub
        else errors.add(`${at}.principal`, 'must be the id of a person')
      } else if (type === 'group') {
        if (typeof raw.principal === 'string' && isGroupName(raw.principal))
          principal = raw.principal
        else errors.add(`${at}.principal`, 'must be a group name')
      }
      if (type === undefined || permission === undefined || principal === undefined) return
      const key = `${type}\u0000${principal}`
      if (seen.has(key)) {
        errors.add(at, 'names the same principal as another share')
        return
      }
      seen.add(key)
      shares.push({ principalType: type, principal, permission })
    })
  }
  return finish(errors, () => shares)
}
