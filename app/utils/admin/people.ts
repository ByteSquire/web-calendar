// What Admin › People shows (server/utils/access/people.ts): no e-mail address, no link secret.
import type { GroupSource } from '~/utils/groups/model'

export interface AdminPerson {
  id: number
  sub: string
  name: string | null
  username: string | null
  /** In the admin group at their last sign-in; may be out of date, and decides nothing. */
  adminAtLastSignIn: boolean
  lastSeenAt: string | null
}

export interface AdminPersonDetail extends AdminPerson {
  groups: { id: number; name: string; source: GroupSource; manager: boolean }[]
  calendars: { id: number; name: string }[]
  shared: {
    id: number
    name: string
    kind: 'personal' | 'shared' | 'resource'
    owner: string | null
  }[]
  links: {
    id: number
    label: string
    calendarName: string
    level: 'read' | 'free_busy'
    createdAt: string
    lastUsedAt: string | null
  }[]
}
