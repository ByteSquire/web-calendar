// Input validation shared by the API modules. Readers take one untrusted value and add a message
// to `FieldErrors` when it is not usable; each `parse*` function of a resource reads all of its
// fields first, so a client sees every problem at once. Unknown fields of a body are ignored.
import { notFound, toBadRequest, type FieldError } from './errors'

/** A client cannot do anything with more messages than this; a huge array must not make a huge reply. */
const MAX_REPORTED_ERRORS = 20
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
const REF_PATTERN = /^(?:dav|ics|ext):(.+)$/s
/** Longest id the API accepts: 15 digits always fit in a safe integer. */
const ID_PATTERN = /^[1-9][0-9]{0,14}$/

export const MAX_REF_LENGTH = 500

export class FieldErrors {
  private readonly list: FieldError[] = []

  add(field: string, message: string): void {
    if (this.list.length < MAX_REPORTED_ERRORS) this.list.push({ field, message })
  }

  get ok(): boolean {
    return this.list.length === 0
  }

  toArray(): FieldError[] {
    return [...this.list]
  }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; fields: FieldError[] }

/** The value, or the 400 error the route should throw. */
export function expectValid<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw toBadRequest(parsed.fields)
  return parsed.value
}

export function finish<T>(errors: FieldErrors, value: () => T): Parsed<T> {
  return errors.ok ? { ok: true, value: value() } : { ok: false, fields: errors.toArray() }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The body as an object. Anything else (null, a list, a string, no body) is one error on `body`. */
export function readObject(body: unknown, errors: FieldErrors): Record<string, unknown> {
  if (isRecord(body)) return body
  errors.add('body', 'must be a JSON object')
  return {}
}

/** A required string, trimmed, with 1 to `max` UTF-16 units left. */
export function readText(
  value: unknown,
  field: string,
  max: number,
  errors: FieldErrors,
): string | undefined {
  if (value === undefined || value === null) {
    errors.add(field, 'is required')
    return undefined
  }
  if (typeof value !== 'string') {
    errors.add(field, 'must be a string')
    return undefined
  }
  const text = value.trim()
  if (text.length === 0) {
    errors.add(field, 'must not be empty')
    return undefined
  }
  if (text.length > max) {
    errors.add(field, `must have at most ${max} characters`)
    return undefined
  }
  return text
}

/** One of `allowed`. An omitted value or `null` gives `fallback` when there is one. */
export function readChoice<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  errors: FieldErrors,
  fallback?: T,
): T | undefined {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback
  if (value === undefined || value === null) {
    errors.add(field, 'is required')
    return undefined
  }
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  errors.add(field, `must be one of: ${allowed.join(', ')}`)
  return undefined
}

/** `#rrggbb`, stored in lower case. */
export function readColor(value: unknown, field: string, errors: FieldErrors): string | undefined {
  if (typeof value === 'string' && COLOR_PATTERN.test(value)) return value.toLowerCase()
  errors.add(field, 'must be a color like #1a2b3c')
  return undefined
}

/**
 * An optional color: omitted gives `undefined`, `null` gives `null`, otherwise `#rrggbb`. The
 * caller decides what omitted and `null` mean (keep the stored value, clear it, or no color).
 */
export function readOptionalColor(
  value: unknown,
  field: string,
  errors: FieldErrors,
): string | null | undefined {
  if (value === undefined || value === null) return value
  return readColor(value, field, errors)
}

export function readOptionalBoolean(
  value: unknown,
  field: string,
  errors: FieldErrors,
): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  errors.add(field, 'must be true or false')
  return undefined
}

/**
 * A calendar ref: `dav:`, `ics:` or `ext:` and something after it. Only the shape is checked; the
 * calendar may not exist (a view can outlive a calendar, and the server does not know external ones).
 */
export function readCalendarRef(
  value: unknown,
  field: string,
  errors: FieldErrors,
): string | undefined {
  if (value === undefined || value === null) {
    errors.add(field, 'is required')
    return undefined
  }
  if (typeof value !== 'string') {
    errors.add(field, 'must be a string')
    return undefined
  }
  if (value.length > MAX_REF_LENGTH) {
    errors.add(field, `must have at most ${MAX_REF_LENGTH} characters`)
    return undefined
  }
  const match = REF_PATTERN.exec(value)
  // Control characters have no place in a path or URL and would only confuse logs and headers.
  if (!match || /\p{Cc}/u.test(match[1]!)) {
    errors.add(field, 'must look like dav:<path>, ics:<id> or ext:<account>:<url>')
    return undefined
  }
  return value
}

/** A numeric database id from the URL. Anything else cannot match a row, so it is a plain 404. */
export function parseId(raw: unknown): number {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw notFound()
  return Number(raw)
}
