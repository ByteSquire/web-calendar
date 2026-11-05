// Calendar links on the Settings page: the shapes of /api/calendar-links, the address of a link and
// how a refusal is worded. The page itself is app/pages/link/[slug].vue.
import { N_, t } from '~/utils/i18n'
import { describeError, fieldProblems, parseApiError } from '~/utils/settings/api-errors'

export const MIN_LINK_PASSWORD_LENGTH = 8
export const MAX_LINK_PASSWORD_LENGTH = 200
export const MAX_LINK_LABEL_LENGTH = 100

export interface CalendarLinkItem {
  id: number
  label: string
  calendarName: string
  calendarColor: string | null
  collectionPath: string
  createdAt: string
  lastUsedAt: string | null
}

export interface CreatedCalendarLink {
  link: CalendarLinkItem
  slug: string
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
