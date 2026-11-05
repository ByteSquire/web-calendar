// Validation of PUT /api/me/sidebar-order (FR-21): the order the caller keeps the sidebar's
// sections in.
import {
  SIDEBAR_SECTION_IDS,
  isSidebarSectionId,
  type SidebarSectionId,
} from '../../../shared/utils/sidebar-sections'
import { FieldErrors, finish, readObject, type Parsed } from './validation'

/**
 * `{ order }`: a list of section ids (`views`, `calendars`, ...), each at most once. It may leave
 * sections out; they follow in their default order when the sidebar is drawn. The messages never
 * repeat what was sent.
 */
export function parseSidebarOrderInput(body: unknown): Parsed<{ order: SidebarSectionId[] }> {
  const errors = new FieldErrors()
  const value = readObject(body, errors).order
  const order: SidebarSectionId[] = []
  if (value === undefined) {
    errors.add('order', 'is required')
  } else if (!Array.isArray(value)) {
    errors.add('order', 'must be a list of sections')
  } else if (value.length === 0 || value.length > SIDEBAR_SECTION_IDS.length) {
    errors.add('order', `must list between 1 and ${SIDEBAR_SECTION_IDS.length} sections`)
  } else if (!value.every(isSidebarSectionId)) {
    errors.add('order', 'must name sections of the sidebar only')
  } else if (new Set(value).size !== value.length) {
    errors.add('order', 'must name each section once')
  } else {
    order.push(...value)
  }
  return finish(errors, () => ({ order }))
}
