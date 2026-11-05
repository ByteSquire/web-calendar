// The sections of the sidebar (FR-21) and the order a user keeps them in. The order is stored per
// user (`users.sidebar_order`, served in `/api/me`, set with `PUT /api/me/sidebar-order`), so it
// follows the person to every browser. The ids are what is stored and sent; the titles the
// sidebar shows belong to the app (app/utils/sidebar-sections.ts).

/** The sections in their default order. */
export const SIDEBAR_SECTION_IDS = [
  'views',
  'calendars',
  'resources',
  'categories',
  'filters',
] as const

export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number]

export function isSidebarSectionId(value: unknown): value is SidebarSectionId {
  return typeof value === 'string' && (SIDEBAR_SECTION_IDS as readonly string[]).includes(value)
}

/**
 * The full order for whatever was stored or sent: the known sections once each, in the given
 * order, then the ones that are missing in their default order. Anything that is not a list, or
 * names no section, gives the default order, so a section added later simply appears at the end
 * for people who had arranged the others.
 */
export function completeSidebarOrder(order: unknown): SidebarSectionId[] {
  const chosen = Array.isArray(order) ? [...new Set(order.filter(isSidebarSectionId))] : []
  return [...chosen, ...SIDEBAR_SECTION_IDS.filter((id) => !chosen.includes(id))]
}

/** The order with `id` moved one place up (`-1`) or down (`1`); at either end it stays as it is. */
export function moveSidebarSection(
  order: readonly SidebarSectionId[],
  id: SidebarSectionId,
  delta: -1 | 1,
): SidebarSectionId[] {
  const from = order.indexOf(id)
  const to = from + delta
  const next = [...order]
  if (from === -1 || to < 0 || to >= next.length) return next
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}
