// Shared (admin) views: the requests of `/api/admin/views` and the wording of their failures.
// Hiding the controls from non-admins is a convenience; the server decides (403).
import type { CalendarView, ViewIcon } from '../../../shared/types/calendar'
import type { ApiMe, ApiView } from './api-types'
import { toViews } from './views'

/** The part of `$fetch` used here. */
export type AdminViewsApi = (
  path: string,
  init?: { method?: 'POST' | 'PUT' | 'DELETE'; body?: unknown },
) => Promise<unknown>

/** External calendars (`ext:`) are refused in shared views, so they are left out of a selection. */
export const isSharedViewRef = (ref: string): boolean => !ref.startsWith('ext:')

export interface SharedViewBody {
  name: string
  icon: ViewIcon
  calendars: { ref: string; color: null }[]
}

/** The request body for a selection of calendar refs: no `ext:` refs, no repeats. */
export function sharedViewBody(
  name: string,
  icon: ViewIcon,
  calendarIds: readonly string[],
): SharedViewBody {
  const refs = [...new Set(calendarIds.filter(isSharedViewRef))]
  return { name, icon, calendars: refs.map((ref) => ({ ref, color: null })) }
}

export async function fetchIsAdmin(api: AdminViewsApi): Promise<boolean> {
  const me = (await api('/api/me')) as Partial<ApiMe> | null
  return me?.isAdmin === true
}

export function oneView(answer: unknown): CalendarView {
  const [view] = toViews([answer as ApiView])
  if (!view) throw new Error('The server sent no view')
  return view
}

export async function createSharedView(
  api: AdminViewsApi,
  body: SharedViewBody,
): Promise<CalendarView> {
  return oneView(await api('/api/admin/views', { method: 'POST', body }))
}

export async function updateSharedView(
  api: AdminViewsApi,
  id: string,
  body: SharedViewBody,
): Promise<CalendarView> {
  return oneView(await api(`/api/admin/views/${encodeURIComponent(id)}`, { method: 'PUT', body }))
}

export async function deleteSharedView(api: AdminViewsApi, id: string): Promise<void> {
  await api(`/api/admin/views/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** A sentence for people from a failed request (an ofetch error or anything else). */
export function describeSharedViewError(error: unknown): string {
  const status = (error as { statusCode?: unknown; status?: unknown } | null) ?? {}
  const code = status.statusCode ?? status.status
  if (code === 403) return 'Only administrators can change shared views.'
  if (code === 404) return 'This shared view no longer exists. Reload the page.'
  if (code === 409) return 'There are too many shared views.'
  if (code === 429) return 'Too many changes in a short time. Try again in a moment.'
  if (code === 400) return 'The server did not accept this shared view.'
  return 'The shared view could not be saved. Check your connection and try again.'
}
