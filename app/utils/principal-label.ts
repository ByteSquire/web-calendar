// The name of who a rule or a share is for, in the language of the page. The server names people
// and groups by their own names, but words the fixed kinds in English ("Everyone signed in",
// "Public", "Unknown person" for a rule whose person has no row); those are worded here instead.
import { t } from '~/utils/i18n'

/** What the server writes for a person it does not know (server/utils/access, server/utils/groups). */
export const SERVER_UNKNOWN_PERSON = 'Unknown person'

export function principalLabel(principalType: string, label: string): string {
  if (principalType === 'authenticated') return t('Everyone signed in')
  if (principalType === 'public') return t('Public')
  if (principalType === 'user' && label === SERVER_UNKNOWN_PERSON) return t('Unknown person')
  return label
}
