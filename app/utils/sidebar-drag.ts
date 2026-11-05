// The arithmetic of dragging a section of the sidebar to another place (FR-21). Pure functions,
// so they run in plain Vitest; app/composables/useSidebarDrag.ts does the pointer and DOM work.
import type { SidebarSectionId } from '../../shared/utils/sidebar-sections'

/** The vertical extent of one section on the screen. */
export interface Box {
  top: number
  bottom: number
}

/**
 * The place the dragged section should have when the pointer is at `y`. `boxes` are the sections
 * in their current order, the dragged one included, measured where it sits in the list (not where
 * it is drawn under the pointer). Above the first section is the first place, below the last the
 * last; between two sections (the gap) nothing changes.
 */
export function dropIndex(boxes: readonly Box[], from: number, y: number): number {
  const first = boxes[0]
  const last = boxes[boxes.length - 1]
  if (!first || !last) return from
  if (y < first.top) return 0
  if (y >= last.bottom) return boxes.length - 1
  const hit = boxes.findIndex((box) => y >= box.top && y < box.bottom)
  return hit === -1 ? from : hit
}

/** The order with `id` taken out and put at place `index`. */
export function reorderTo(
  order: readonly SidebarSectionId[],
  id: SidebarSectionId,
  index: number,
): SidebarSectionId[] {
  const next = order.filter((item) => item !== id)
  next.splice(Math.max(0, Math.min(index, next.length)), 0, id)
  return next
}

export const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index])
