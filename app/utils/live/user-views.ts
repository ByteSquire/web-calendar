// A user's own views (FR-2, FR-21): the requests of `/api/views` and the wording of their failures.
// Shared views have their own routes (admin-views.ts). The server decides who owns what: another
// user's view, and a shared one, answer 404 on these routes.
import type { CalendarView, ViewIcon } from '../../../shared/types/calendar'
import { createSharedView, oneView, sharedViewBody, type AdminViewsApi } from './admin-views'

/** The longest view name the server accepts (`MAX_VIEW_NAME_LENGTH` in server/utils/api/views.ts). */
export const VIEW_NAME_MAX = 80

export interface OwnViewBody {
  name: string
  icon: ViewIcon
  calendars: { ref: string; color: null }[]
}

/** The request body for a selection of calendar refs; own views may hold `ext:` refs. No repeats. */
export function ownViewBody(
  name: string,
  icon: ViewIcon,
  calendarIds: readonly string[],
): OwnViewBody {
  return { name, icon, calendars: [...new Set(calendarIds)].map((ref) => ({ ref, color: null })) }
}

/** "Team (copy)", or "Team (copy 2)" and so on when that name is taken; kept within the limit. */
export function copyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let number = 1; ; number += 1) {
    const suffix = number === 1 ? ' (copy)' : ` (copy ${number})`
    const candidate = `${name.slice(0, VIEW_NAME_MAX - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

export async function createOwnView(api: AdminViewsApi, body: OwnViewBody): Promise<CalendarView> {
  return oneView(await api('/api/views', { method: 'POST', body }))
}

export async function updateOwnView(
  api: AdminViewsApi,
  id: string,
  body: OwnViewBody,
): Promise<CalendarView> {
  return oneView(await api(`/api/views/${encodeURIComponent(id)}`, { method: 'PUT', body }))
}

export async function deleteOwnView(api: AdminViewsApi, id: string): Promise<void> {
  await api(`/api/views/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface SharedOwnView {
  /** The shared view that now exists. */
  shared: CalendarView
  /** How many of the view's calendars a shared view cannot hold (`ext:` ones) and left out. */
  leftOut: number
  /** Set when the own view could not be deleted after sharing: both exist then. */
  removeError?: unknown
}

/**
 * Shares an own view of an administrator with everybody: a shared view with the same name, icon
 * and calendars is made first (it throws when that fails, and nothing has changed), then the own
 * view is deleted. A failing delete does not throw: the own view stays, `removeError` says why, so
 * a view is never lost. `ext:` refs are left out, as shared views refuse them.
 */
export async function shareOwnView(api: AdminViewsApi, view: CalendarView): Promise<SharedOwnView> {
  const body = sharedViewBody(view.name, view.icon, view.calendarIds)
  const leftOut = new Set(view.calendarIds).size - body.calendars.length
  const shared = await createSharedView(api, body)
  try {
    await deleteOwnView(api, view.id)
  } catch (removeError) {
    return { shared, leftOut, removeError }
  }
  return { shared, leftOut }
}

/** A sentence for people from a failed request (an ofetch error or anything else). */
export function describeOwnViewError(error: unknown): string {
  const status = (error as { statusCode?: unknown; status?: unknown } | null) ?? {}
  const code = status.statusCode ?? status.status
  if (code === 404) return 'This view no longer exists. Reload the page.'
  if (code === 409) return 'You have too many views. Delete one first.'
  if (code === 429) return 'Too many changes in a short time. Try again in a moment.'
  if (code === 400) return 'The server did not accept this view.'
  return 'The view could not be saved. Try again.'
}
