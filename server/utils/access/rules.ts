// The rules of one calendar as the admin API takes them: closed sets, never free text.
import type { Database } from 'better-sqlite3'
import type { CalendarAclInput } from '../../db/calendar-acl'
import type { Permission } from '../../db/types'
import type { FieldError } from '../api/errors'
import { FieldErrors, isRecord, readObject, type Parsed } from '../api/validation'
import { isGroupName, isUuid } from '../group-sync/format'
import type { GroupLookup } from './groups'

/** `admin` never reaches Radicale (design §8), `public` belongs to the public view (FR-27). */
export const ACCESS_PERMISSIONS = [
  'free_busy',
  'read',
  'write',
] as const satisfies readonly Permission[]
export const ACCESS_PRINCIPAL_TYPES = ['user', 'group', 'authenticated'] as const

export const MAX_RULES_PER_CALENDAR = 200

export function parseRulesBody(body: unknown): Parsed<CalendarAclInput[]> {
  const errors = new FieldErrors()
  const object = readObject(body, errors)
  const rules: CalendarAclInput[] = []
  if (!Array.isArray(object.rules)) {
    if (errors.ok) errors.add('rules', 'must be a list')
  } else if (object.rules.length > MAX_RULES_PER_CALENDAR) {
    errors.add('rules', `must have at most ${MAX_RULES_PER_CALENDAR} rules`)
  } else {
    const seen = new Set<string>()
    object.rules.forEach((raw: unknown, index) => {
      const at = `rules[${index}]`
      if (!isRecord(raw)) {
        errors.add(at, 'must be an object')
        return
      }
      const type = raw.principalType
      const permission = raw.permission
      let ok = true
      if (!(ACCESS_PRINCIPAL_TYPES as readonly unknown[]).includes(type)) {
        errors.add(`${at}.principalType`, `must be one of: ${ACCESS_PRINCIPAL_TYPES.join(', ')}`)
        ok = false
      }
      if (!(ACCESS_PERMISSIONS as readonly unknown[]).includes(permission)) {
        errors.add(`${at}.permission`, `must be one of: ${ACCESS_PERMISSIONS.join(', ')}`)
        ok = false
      }
      let principal: string | null = null
      if (type === 'authenticated') {
        if (raw.principal !== undefined && raw.principal !== null) {
          errors.add(`${at}.principal`, 'must be empty for everyone signed in')
          ok = false
        }
      } else if (type === 'user') {
        const sub = typeof raw.principal === 'string' ? raw.principal.toLowerCase() : ''
        if (isUuid(sub)) principal = sub
        else {
          errors.add(`${at}.principal`, 'must be the id of a person')
          ok = false
        }
      } else if (type === 'group') {
        if (typeof raw.principal === 'string' && isGroupName(raw.principal)) {
          principal = raw.principal
        } else {
          errors.add(`${at}.principal`, 'must be a group name')
          ok = false
        }
      }
      if (!ok) return
      const key = `${type as string}\u0000${principal ?? ''}`
      if (seen.has(key)) {
        errors.add(at, 'names the same principal as another rule')
        return
      }
      seen.add(key)
      rules.push({
        principalType: type as CalendarAclInput['principalType'],
        principal,
        permission: permission as Permission,
      })
    })
  }
  return errors.ok ? { ok: true, value: rules } : { ok: false, fields: errors.toArray() }
}

export const GROUPS_UNCONFIGURED =
  'Groups cannot be checked because the Kanidm sync token is not configured'
export const GROUPS_UNAVAILABLE = 'Kanidm could not be reached to check this group; try again'

export interface PrincipalCheck {
  fields: FieldError[]
  /** True when a group could not be looked up (not that it is missing). */
  unavailable: boolean
}

/**
 * Checks the principals that are new to the calendar: a person must have signed in once (the
 * `users` table), a group must exist in Kanidm, and the owner needs no rule. Principals already
 * in the calendar's rules are kept as they are, so an old rule never blocks an edit of another.
 * `groups` is null when no sync token is configured: then no group rule is accepted.
 */
export async function checkPrincipals(
  db: Database,
  calendarId: number,
  rules: readonly CalendarAclInput[],
  existing: readonly CalendarAclInput[],
  groups: GroupLookup | null,
): Promise<PrincipalCheck> {
  const known = new Set(existing.map((rule) => `${rule.principalType}\u0000${rule.principal}`))
  const owner = db
    .prepare<[number], { sub: string }>(
      `SELECT u.oidc_sub AS sub FROM calendars c JOIN users u ON u.id = c.owner_id WHERE c.id = ?`,
    )
    .get(calendarId)
  const userExists = db.prepare<[string], { one: number }>(
    'SELECT 1 AS one FROM users WHERE oidc_sub = ?',
  )
  const fields: FieldError[] = []
  let unavailable = false
  const pending: Promise<void>[] = []
  rules.forEach((rule, index) => {
    const at = `rules[${index}].principal`
    if (known.has(`${rule.principalType}\u0000${rule.principal}`)) return
    if (rule.principalType === 'user' && rule.principal !== null) {
      if (rule.principal === owner?.sub)
        fields.push({ field: at, message: 'is the owner, who has full access already' })
      else if (!userExists.get(rule.principal)) {
        fields.push({ field: at, message: 'is not a known person (they must have signed in once)' })
      }
    } else if (rule.principalType === 'group' && rule.principal !== null) {
      const name = rule.principal
      if (!groups) {
        fields.push({ field: at, message: GROUPS_UNCONFIGURED })
        return
      }
      pending.push(
        groups(name).then((answer) => {
          if (answer === 'missing') fields.push({ field: at, message: 'is not a Kanidm group' })
          else if (answer === 'unavailable') {
            unavailable = true
            fields.push({ field: at, message: GROUPS_UNAVAILABLE })
          }
        }),
      )
    }
  })
  await Promise.all(pending)
  fields.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
  return { fields, unavailable }
}
