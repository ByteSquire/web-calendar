// Checks of the settings forms in the browser. They only spare a round trip: the server checks
// again (server/utils/ical-proxy/subscription-input.ts, server/utils/api/app-tokens.ts) and its
// answer wins. The limits and the URL rules therefore mirror the server's; the messages are
// complete sentences for the field they appear under.

/** Label of an app token (FR-31). */
import { t } from '~/utils/i18n'

export const MAX_TOKEN_LABEL_LENGTH = 64
export const MAX_SUBSCRIPTION_NAME_LENGTH = 80
export const MAX_URL_LENGTH = 2000
const MAX_HOSTNAME_LENGTH = 253

export function validateTokenLabel(value: string): string | undefined {
  const label = value.trim()
  if (label === '') return t('Enter a label, for example the name of the app.')
  if (label.length > MAX_TOKEN_LABEL_LENGTH) {
    return t('The label can have at most {max} characters.', { max: MAX_TOKEN_LABEL_LENGTH })
  }
  return undefined
}

export function validateSubscriptionName(value: string): string | undefined {
  const name = value.trim()
  if (name === '') return t('Enter a name for the calendar.')
  if (name.length > MAX_SUBSCRIPTION_NAME_LENGTH) {
    return t('The name can have at most {max} characters.', { max: MAX_SUBSCRIPTION_NAME_LENGTH })
  }
  return undefined
}

/**
 * The address of an .ics file. `webcal://` is only a hint for calendar apps, the file is fetched
 * over https, so it is read as https here as on the server. Whether the host is a public one is
 * for the server to decide.
 */
export function validateSubscriptionUrl(value: string): string | undefined {
  const text = value.trim()
  if (text === '') return t('Enter the address of the calendar.')
  if (text.length > MAX_URL_LENGTH) {
    return t('The address can have at most {max} characters.', { max: MAX_URL_LENGTH })
  }
  let url: URL
  try {
    url = new URL(text.replace(/^webcal:/i, 'https:'))
  } catch {
    return t('Enter a valid address, for example https://example.org/calendar.ics.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return t('The address must start with http://, https:// or webcal://.')
  }
  if (url.username !== '' || url.password !== '') {
    return t('The address must not contain a user name or password.')
  }
  if (url.hostname === '' || url.hostname.length > MAX_HOSTNAME_LENGTH) {
    return t('The address needs a valid host name.')
  }
  return undefined
}

export interface SubscriptionFormValues {
  name: string
  url: string
}

export type SubscriptionFormErrors = Partial<Record<keyof SubscriptionFormValues, string>>

export function validateSubscriptionForm(values: SubscriptionFormValues): SubscriptionFormErrors {
  const errors: SubscriptionFormErrors = {}
  const name = validateSubscriptionName(values.name)
  const url = validateSubscriptionUrl(values.url)
  if (name) errors.name = name
  if (url) errors.url = url
  return errors
}
