// The admin flag (to show the menu entry and guard the page) and the calls of the access page.
// The flag only decides what is shown; every admin route checks the caller on the server.
import { useAuthFetch } from '~/composables/useAuthFetch'
import {
  describeSaveProblem,
  type AccessCalendar,
  type AccessCalendarsResponse,
  type AccessRuleInput,
  type AccessUser,
} from '~/utils/admin/access'
import { N_ } from '~/utils/i18n'
import { createResource } from '~/utils/settings/resource'
import type { MeResponse } from '~/utils/settings/types'

/** True or false once `/api/me` has answered; null before, and after a call that failed. */
export function useAdminFlag() {
  const admin = useState<boolean | null>('admin-flag', () => null)
  const api = useAuthFetch()

  async function ensure(): Promise<boolean | null> {
    if (admin.value !== null) return admin.value
    try {
      const me = await api<MeResponse>('/api/me')
      admin.value = me.isAdmin === true
    } catch {
      // Unknown, not "no": the page offers a retry.
    }
    return admin.value
  }

  return { admin, ensure }
}

export type SaveResult = { ok: true } | { ok: false; message: string }

export function useAdminAccess() {
  const api = useAuthFetch()
  const calendars = createResource(
    () => api<AccessCalendarsResponse>('/api/admin/access/calendars'),
    N_('load the calendars'),
  )
  const users = createResource(
    async () => (await api<{ users: AccessUser[] }>('/api/admin/access/users')).users,
    N_('load the people'),
  )
  // The groups a rule can name: every group of the Groups page (any signed-in person may list them).
  const groups = createResource(
    async () => (await api<{ groups: { name: string }[] }>('/api/groups')).groups,
    N_('load the groups'),
  )

  /** Sets the complete rule list of a calendar and shows the server's answer. */
  async function saveRules(
    calendarId: number,
    rules: readonly AccessRuleInput[],
    labelOf: (rule: AccessRuleInput) => string,
  ): Promise<SaveResult> {
    try {
      const saved = await api<{ calendar: AccessCalendar }>(
        `/api/admin/access/calendars/${calendarId}`,
        { method: 'PUT', body: { rules } },
      )
      calendars.update((current) => ({
        ...current,
        calendars: current.calendars.map((item) =>
          item.id === saved.calendar.id ? saved.calendar : item,
        ),
      }))
      return { ok: true }
    } catch (cause) {
      return { ok: false, message: describeSaveProblem(cause, rules, labelOf) }
    }
  }

  return { calendars, users, groups, saveRules }
}
