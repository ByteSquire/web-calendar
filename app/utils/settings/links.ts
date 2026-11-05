// Calendar links in the browser: the shapes of /api/calendar-links (the caller's own links, in
// Settings) and /api/admin/access/**/links (the links to a calendar of the access page), the address
// of a link and how a refusal is worded. The page a visitor opens is app/pages/link/[slug].vue.
import { ACCESS_LEVELS, type AccessPermission } from '~/utils/admin/access'
import { N_, t } from '~/utils/i18n'
import { describeError, fieldProblems, parseApiError } from '~/utils/settings/api-errors'

export const MIN_LINK_PASSWORD_LENGTH = 8
export const MAX_LINK_PASSWORD_LENGTH = 200
export const MAX_LINK_LABEL_LENGTH = 100

/** A link shows what a share at the same level shows; links cannot write. */
export type LinkLevel = Exclude<AccessPermission, 'write'>

export const LINK_LEVELS = ACCESS_LEVELS.filter(
  (level): level is (typeof ACCESS_LEVELS)[number] & { value: LinkLevel } =>
    level.value !== 'write',
)

export interface CalendarLinkItem {
  id: number
  label: string
  calendarName: string
  calendarColor: string | null
  /** The calendar of the access page, when the link is to one. */
  calendarId: number | null
  level: LinkLevel
  /** `maker`: reads as the person who made it (Settings); `owner`: as the calendar's owner. */
  readsAs: 'maker' | 'owner'
  maker: string
  createdAt: string
  lastUsedAt: string | null
  /** The random part of the address; null when the server cannot show it (make a new link). */
  slug: string | null
}

/** Where the links of a list are: one calendar's (admins) or the caller's own. */
export interface LinkEndpoints {
  list: string
  create: string
  item: (id: number) => string
  reveal: (id: number) => string
}

export function linkEndpoints(calendarId?: number): LinkEndpoints {
  if (calendarId === undefined) {
    return {
      list: '/api/calendar-links',
      create: '/api/calendar-links',
      item: (id) => `/api/calendar-links/${id}`,
      reveal: (id) => `/api/calendar-links/${id}/reveal`,
    }
  }
  return {
    list: `/api/admin/access/calendars/${calendarId}/links`,
    create: `/api/admin/access/calendars/${calendarId}/links`,
    item: (id) => `/api/admin/access/links/${id}`,
    reveal: (id) => `/api/admin/access/links/${id}/reveal`,
  }
}

/** The address a visitor opens: the page of the link on this server. */
export function calendarLinkAddress(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, '')}/link/${slug}`
}

export function validateLinkPassword(value: string): string | undefined {
  if (value.length < MIN_LINK_PASSWORD_LENGTH) {
    return t('Choose a password of at least {min} characters.', { min: MIN_LINK_PASSWORD_LENGTH })
  }
  if (value.length > MAX_LINK_PASSWORD_LENGTH) {
    return t('The password can have at most {max} characters.', { max: MAX_LINK_PASSWORD_LENGTH })
  }
  return undefined
}

export function validateLinkLabel(value: string): string | undefined {
  if (value.trim().length > MAX_LINK_LABEL_LENGTH) {
    return t('The label can have at most {max} characters.', { max: MAX_LINK_LABEL_LENGTH })
  }
  return undefined
}

const LINK_FIELDS = {
  calendarHref: N_('The calendar'),
  label: N_('The label'),
  level: N_('The access level'),
  password: N_('The password'),
}

export interface LinkFailure {
  byField: Record<string, string>
  alert?: string
}

export function describeLinkCreateError(error: unknown): LinkFailure {
  const info = parseApiError(error)
  if (info.kind === 'validation') {
    const { byField, other } = fieldProblems(info, LINK_FIELDS)
    return {
      byField,
      ...(other.length > 0
        ? { alert: t('The link was not made: {problems}.', { problems: other.join('; ') }) }
        : {}),
    }
  }
  if (info.kind === 'conflict') {
    return { byField: {}, alert: info.message ?? t('The link was not made.') }
  }
  return { byField: {}, alert: describeError(error, N_('make the link')) }
}

/** Why a password was not shown: the server cannot show it, the link is gone, or another problem. */
export type RevealFailure =
  { kind: 'not_available' } | { kind: 'gone' } | { kind: 'other'; message: string }

export function describeRevealError(error: unknown): RevealFailure {
  const info = parseApiError(error)
  if (info.kind === 'not-found') return { kind: 'gone' }
  if (info.kind === 'conflict' && info.code === 'not_available') return { kind: 'not_available' }
  return { kind: 'other', message: describeError(error, N_('show the password')) }
}
