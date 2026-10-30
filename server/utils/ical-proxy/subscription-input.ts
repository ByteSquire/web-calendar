import {
  FieldErrors,
  finish,
  readObject,
  readOptionalColor,
  readText,
  type Parsed,
} from '../api/validation'
import { parseSourceUrl } from './source-url'

// The body of POST / PUT /api/ical-subscriptions, checked field by field so the form can show
// every problem at once.

export const MAX_SUBSCRIPTION_NAME_LENGTH = 80

export interface SubscriptionInput {
  name: string
  /** Normalised: https for webcal, no fragment, host in canonical form. */
  url: string
  /** `#rrggbb` in lower case, or null. */
  color: string | null
}

export function parseSubscriptionInput(body: unknown): Parsed<SubscriptionInput> {
  const errors = new FieldErrors()
  const source = readObject(body, errors)
  const name = readText(source.name, 'name', MAX_SUBSCRIPTION_NAME_LENGTH, errors)
  const color = readOptionalColor(source.color, 'color', errors)

  let url: string | undefined
  if (source.url === undefined || source.url === null) {
    errors.add('url', 'is required')
  } else if (typeof source.url !== 'string') {
    errors.add('url', 'must be a string')
  } else {
    const parsed = parseSourceUrl(source.url)
    if (parsed.ok) url = parsed.url.href
    else errors.add('url', parsed.error)
  }

  return finish(errors, () => ({ name: name!, url: url!, color: color ?? null }))
}
