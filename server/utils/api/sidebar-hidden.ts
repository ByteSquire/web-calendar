// Validation of PUT /api/me/sidebar-hidden (FR-21): the items the caller has hidden from the
// sidebar.
import {
  SIDEBAR_HIDDEN_KEY_MAX,
  SIDEBAR_HIDDEN_KINDS,
  SIDEBAR_HIDDEN_MAX,
  isSidebarHiddenKey,
} from '../../../shared/utils/sidebar-hidden'
import { FieldErrors, finish, readObject, type Parsed } from './validation'

/**
 * `{ hidden }`: a list of keys (`calendar:<id>`, `resource:<id>`, `view:<id>`, `category:<id>`,
 * `filter:<id>`), each at most once, at most `SIDEBAR_HIDDEN_MAX` of them; an empty list shows
 * everything again. The messages never repeat what was sent.
 */
export function parseSidebarHiddenInput(body: unknown): Parsed<{ hidden: string[] }> {
  const errors = new FieldErrors()
  const value = readObject(body, errors).hidden
  const hidden: string[] = []
  if (value === undefined) {
    errors.add('hidden', 'is required')
  } else if (!Array.isArray(value)) {
    errors.add('hidden', 'must be a list of items')
  } else if (value.length > SIDEBAR_HIDDEN_MAX) {
    errors.add('hidden', `must list at most ${SIDEBAR_HIDDEN_MAX} items`)
  } else if (!value.every(isSidebarHiddenKey)) {
    errors.add(
      'hidden',
      `must name items as <kind>:<id>, with a kind of ${SIDEBAR_HIDDEN_KINDS.join(', ')}, at most ${SIDEBAR_HIDDEN_KEY_MAX} characters`,
    )
  } else if (new Set(value).size !== value.length) {
    errors.add('hidden', 'must name each item once')
  } else {
    hidden.push(...value)
  }
  return finish(errors, () => ({ hidden }))
}
