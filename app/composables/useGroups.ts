// The calls of the groups page (server/api/groups/** and /api/people). The lists load through
// createResource like the settings sections; the calls for changes return what the server saved
// and throw on failure, so the page can say why.
import { useAuthFetch } from '~/composables/useAuthFetch'
import { N_ } from '~/utils/i18n'
import type {
  GroupCalendar,
  GroupDetail,
  GroupPerson,
  GroupSummary,
  OidcCandidate,
  SharePermission,
  SharePrincipalType,
} from '~/utils/groups/model'
import { createResource } from '~/utils/settings/resource'

export interface CalendarBody {
  name?: string
  /** `#rrggbb`; null for no colour. */
  color?: string | null
}

export function useGroups() {
  const api = useAuthFetch()

  const groups = createResource(
    async () => (await api<{ groups: GroupSummary[] }>('/api/groups')).groups,
    N_('load the groups'),
  )
  // `truncated`: more people signed in than the server lists (MAX_PEOPLE), so the pickers lack some.
  const people = createResource(
    () => api<{ people: GroupPerson[]; truncated?: boolean }>('/api/people'),
    N_('load the people'),
  )

  // Admins only: the server answers 403 to anybody else, so the page loads it for admins alone.
  const candidates = createResource(
    () => api<{ candidates: OidcCandidate[]; truncated: boolean }>('/api/groups/oidc'),
    N_('load the groups of your identity provider'),
  )

  return {
    groups,
    people,
    candidates,
    importGroup: async (externalId: string) =>
      (
        await api<{ group: GroupSummary }>('/api/groups/oidc', {
          method: 'POST',
          body: { externalId },
        })
      ).group,
    stopImporting: (groupId: number) =>
      api<unknown>(`/api/groups/oidc/${groupId}`, { method: 'DELETE' }),
    loadGroup: (id: number) => api<GroupDetail>(`/api/groups/${id}`),
    createGroup: async (name: string) =>
      (await api<{ group: GroupSummary }>('/api/groups', { method: 'POST', body: { name } })).group,
    deleteGroup: (id: number) => api<unknown>(`/api/groups/${id}`, { method: 'DELETE' }),
    saveMembers: async (id: number, members: string[]) =>
      (
        await api<{ members: GroupPerson[] }>(`/api/groups/${id}/members`, {
          method: 'PUT',
          body: { members },
        })
      ).members,
    createCalendar: async (id: number, body: { name: string; color?: string }) =>
      (
        await api<{ calendar: GroupCalendar }>(`/api/groups/${id}/calendars`, {
          method: 'POST',
          body,
        })
      ).calendar,
    updateCalendar: async (id: number, calendarId: number, body: CalendarBody) =>
      (
        await api<{ calendar: GroupCalendar }>(`/api/groups/${id}/calendars/${calendarId}`, {
          method: 'PATCH',
          body,
        })
      ).calendar,
    deleteCalendar: (id: number, calendarId: number) =>
      api<unknown>(`/api/groups/${id}/calendars/${calendarId}`, { method: 'DELETE' }),
    saveShares: async (
      id: number,
      calendarId: number,
      shares: {
        principalType: SharePrincipalType
        principal: string
        permission: SharePermission
      }[],
    ) =>
      (
        await api<{ calendar: GroupCalendar }>(`/api/groups/${id}/calendars/${calendarId}/shares`, {
          method: 'PUT',
          body: { shares },
        })
      ).calendar,
  }
}
