// The rules of one calendar as the admin API takes them: closed sets, never free text.
import type { Database } from 'better-sqlite3'
import { findGroupByName } from '../../db/groups'
import type { CalendarAclInput } from '../../db/calendar-acl'
import type { Permission } from '../../db/types'
import type { FieldError } from '../api/errors'
import { FieldErrors, isRecord, readObject, type Parsed } from '../api/validation'
import { isValidSubject } from '../auth/subject'
import { isGroupName } from '../groups/htgroup'

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
        // Case matters: Radicale tells `Ab` and `ab` apart, so an id is taken as it is.
        const sub = typeof raw.principal === 'string' ? raw.principal : ''
        if (isValidSubject(sub)) principal = sub
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

export interface PrincipalCheck {
  fields: FieldError[]
}

/**
 * Checks the principals that are new to the calendar: a person must have signed in once (the
 * `users` table), a group must exist in the app's `groups` table (made here, imported from the
 * identity provider, or the group of everyone), and the owner needs no rule. A group that only
 * the provider has is imported by an admin on the Groups page first. Principals already in the
 * calendar's rules are kept as they are, so an old rule never blocks an edit of another.
 */
export function checkPrincipals(
  db: Database,
  calendarId: number,
  rules: readonly CalendarAclInput[],
  existing: readonly CalendarAclInput[],
): PrincipalCheck {
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
      if (!findGroupByName(db, rule.principal)) {
        fields.push({ field: at, message: GROUP_UNKNOWN })
      }
    }
  })
  return { fields }
}

export const GROUP_UNKNOWN =
  'is not a known group; an administrator can import it on the Groups page'
