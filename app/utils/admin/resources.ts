// The resources administration of the browser: the shapes of server/api/admin/resources/**, the
// words for types and rights and the plain helpers the page uses. Written out here instead of
// imported from the server so the browser bundle stays free of server code.
import type { AccessPrincipalType } from '~/utils/admin/access'
import { N_, t, tv } from '~/utils/i18n'
import { describeKnownCode, parseApiError } from '~/utils/settings/api-errors'

export type ResourceType = 'room' | 'car' | 'equipment'
export type ResourceRight = 'read' | 'book' | 'manage'

export interface AdminResource {
  id: number
  name: string
  type: ResourceType
  location: string | null
  capacity: number | null
  description: string | null
  active: boolean
}

export interface ResourceRule {
  principalType: AccessPrincipalType
  principal: string | null
  right: ResourceRight
}

/** The form's fields as text; `capacity` is empty for "no limit". */
export interface ResourceDraft {
  name: string
  type: ResourceType
  location: string
  capacity: string
  description: string
}

export const RESOURCE_TYPES: readonly { value: ResourceType; label: string }[] = [
  { value: 'room', label: N_('Room') },
  { value: 'car', label: N_('Car') },
  { value: 'equipment', label: N_('Equipment') },
]

export const RESOURCE_RIGHTS: readonly { value: ResourceRight; label: string; help: string }[] = [
  { value: 'read', label: N_('Can see'), help: N_('Sees the resource and when it is busy.') },
  { value: 'book', label: N_('Can book'), help: N_('Sees it and asks to book it.') },
  {
    value: 'manage',
    label: N_('Can manage'),
    help: N_(
      'Also accepts or declines booking requests. Administrators are not managers by default.',
    ),
  },
]

export function typeLabel(type: ResourceType): string {
  const label = RESOURCE_TYPES.find((item) => item.value === type)?.label
  return label ? tv(label) : type
}

export function rightLabel(right: ResourceRight): string {
  const label = RESOURCE_RIGHTS.find((item) => item.value === right)?.label
  return label ? tv(label) : right
}

export function emptyDraft(): ResourceDraft {
  return { name: '', type: 'room', location: '', capacity: '', description: '' }
}

export function draftOf(resource: AdminResource): ResourceDraft {
  return {
    name: resource.name,
    type: resource.type,
    location: resource.location ?? '',
    capacity: resource.capacity === null ? '' : String(resource.capacity),
    description: resource.description ?? '',
  }
}

/** The body of POST and PUT; blank text clears. Null when the capacity is not a whole number. */
export function toBody(draft: ResourceDraft) {
  const capacityText = draft.capacity.trim()
  const capacity = capacityText === '' ? null : Number(capacityText)
  if (capacity !== null && !Number.isInteger(capacity)) return null
  return {
    name: draft.name.trim(),
    type: draft.type,
    location: draft.location.trim() || null,
    capacity,
    description: draft.description.trim() || null,
  }
}

const sameWho = (a: ResourceRule, b: ResourceRule) =>
  a.principalType === b.principalType && a.principal === b.principal

/** The rules with this one added, or with the right of the existing rule for that principal changed. */
export function withRule(rules: readonly ResourceRule[], rule: ResourceRule): ResourceRule[] {
  return rules.some((item) => sameWho(item, rule))
    ? rules.map((item) => (sameWho(item, rule) ? rule : item))
    : [...rules, rule]
}

export function withoutRule(rules: readonly ResourceRule[], rule: ResourceRule): ResourceRule[] {
  return rules.filter((item) => !sameWho(item, rule))
}

/** Field messages of a 400 by field name, and words for everything else. */
export function describeResourceProblem(cause: unknown): {
  message: string
  fields: Record<string, string>
} {
  const info = parseApiError(cause)
  const fields: Record<string, string> = {}
  for (const { field, message } of info.fields) fields[field] ??= message
  let message: string
  if (info.kind === 'signed-out')
    message = t('You are signed out. Reload the page to sign in again.')
  else if (info.kind === 'network')
    message = t('The server could not be reached. Nothing was changed.')
  else if (info.kind === 'not-found')
    message = t('This resource no longer exists. Reload the page.')
  else if (describeKnownCode(info)) message = describeKnownCode(info)!
  else if (info.status === 403) message = t('You are not allowed to manage resources.')
  else if (info.fields.length > 0) {
    message = t('Nothing was changed. {details}', {
      details: info.fields.map((item) => `${item.field} ${item.message}.`).join(' '),
    })
  } else
    message = info.message
      ? t('Nothing was changed. {details}', { details: `${info.message}.` })
      : t('Nothing was changed. Try again.')
  return { message, fields }
}
