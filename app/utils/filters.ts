// Saved filters (FR-5): what each kind matches, how filters combine, and the checks and texts of
// the filter dialog (FilterDialog.vue). Pure, so it runs in plain Vitest (tests/filters.test.ts).
import type {
  CalendarEvent,
  CalendarFilter,
  Category,
  EventPerson,
  EventStatus,
  FilterKind,
  FilterMode,
} from '../../shared/types/calendar'
import { STATUS_LABELS } from './event-display'
import { N_, t, tv } from './i18n'

/**
 * The longest name and value the server accepts (server/utils/api/filters.ts); for a person filter
 * the longest name or address of each person, and how many people it may name.
 */
export const FILTER_NAME_MAX = 80
export const FILTER_VALUE_MAX = 200
export const FILTER_PEOPLE_MAX = 20

/** What the filter dialog edits: a filter without its id. */
export type FilterDraft = Omit<CalendarFilter, 'id'>

export const FILTER_KINDS: readonly { value: FilterKind; label: string; icon: string }[] = [
  { value: 'text', label: N_('Text'), icon: 'i-lucide-text-search' },
  { value: 'category', label: N_('Category'), icon: 'i-lucide-tag' },
  { value: 'status', label: N_('Status'), icon: 'i-lucide-circle-check' },
  { value: 'person', label: N_('Person'), icon: 'i-lucide-user' },
]

export const FILTER_MODES: readonly { value: FilterMode; label: string }[] = [
  { value: 'only', label: N_('Show only matching events') },
  { value: 'hide', label: N_('Hide matching events') },
]

export const EVENT_STATUSES = Object.keys(STATUS_LABELS) as EventStatus[]

/** The icon of a filter's row: what kind of thing it looks at. */
export function filterIcon(kind: FilterKind): string {
  return FILTER_KINDS.find((item) => item.value === kind)?.icon ?? 'i-lucide-filter'
}

/**
 * The mode of a filter. One made before filters had a mode has none (the demo's data, an old
 * server): a status filter hid its status then, the others showed only what they matched.
 */
export function modeOf(filter: { kind: FilterKind; mode?: FilterMode }): FilterMode {
  return filter.mode ?? (filter.kind === 'status' ? 'hide' : 'only')
}

export interface FilterContext {
  /** The categories, to find a category filter's by its name (or the id an older filter holds). */
  categories?: readonly Category[]
  /** The name of each calendar's owner (`Calendar.ownerName`) by calendar id. */
  calendarOwners?: ReadonlyMap<string, string>
}

const lower = (text: string) => text.trim().toLowerCase()

/** The texts trimmed, without empty ones and without repeats (letter case aside), in order. */
function uniqueTexts(texts: readonly string[]): string[] {
  const seen = new Set<string>()
  const list: string[] = []
  for (const text of texts) {
    const trimmed = text.trim()
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue
    seen.add(trimmed.toLowerCase())
    list.push(trimmed)
  }
  return list
}

/**
 * The people a person filter names. Its value is a JSON list of them; each is a name, an address,
 * or a name with its address (`Sam Lee <sam@example.org>`, what the dialog's list offers). A
 * plain text is one person.
 */
export function filterPeople(value: string): string[] {
  let list: unknown
  try {
    list = JSON.parse(value)
  } catch {
    list = [value]
  }
  if (!Array.isArray(list)) list = [value]
  return uniqueTexts((list as unknown[]).filter((item): item is string => typeof item === 'string'))
}

/** The value of a person filter for these people. */
export function peopleValue(people: readonly string[]): string {
  return JSON.stringify(uniqueTexts(people))
}

const WITH_ADDRESS = /^(.*?)\s*<([^<>]+)>$/

/** One person of a filter: the name and the address it holds, either of which may be missing. */
export function splitPerson(entry: string): { name?: string; email?: string } {
  const text = entry.trim()
  const match = WITH_ADDRESS.exec(text)
  if (!match) return text.includes('@') ? { email: text } : text ? { name: text } : {}
  const name = match[1]!.trim()
  const email = match[2]!.trim()
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) }
}

/** How a person of a filter is shown: the name, else the address. */
export function personLabel(entry: string): string {
  const { name, email } = splitPerson(entry)
  return name ?? email ?? entry.trim()
}

/**
 * Whether a person of a filter is `person`: the same address, or a name or an address that
 * contains what the filter holds (without regard to case).
 */
function isPerson(entry: string, person: EventPerson): boolean {
  const { name, email } = splitPerson(entry)
  const theirs = [person.name, person.email].flatMap((text) => (text ? [lower(text)] : []))
  if (email && person.email && lower(person.email) === lower(email)) return true
  const needle = lower(name ?? email ?? '')
  return needle !== '' && theirs.some((text) => text.includes(needle))
}

/** Whether `event` is one that `filter` is about (before its mode is applied). */
export function filterMatches(
  filter: Pick<CalendarFilter, 'kind' | 'value'>,
  event: CalendarEvent,
  context: FilterContext = {},
): boolean {
  if (filter.kind === 'person') {
    return personFilterMatches(filterPeople(filter.value), event, context)
  }
  const needle = lower(filter.value)
  if (!needle) return false
  switch (filter.kind) {
    case 'text': {
      // A blocked entry has no text of its own ("Busy" is only how it is drawn): no text matches.
      if (event.isBlocked) return false
      return `${event.title} ${event.location ?? ''} ${event.description ?? ''}`
        .toLowerCase()
        .includes(needle)
    }
    case 'category': {
      // Events carry categories by name; the filter names one (an older one holds its id).
      const ids = new Set(
        (context.categories ?? [])
          .filter((category) => category.id === filter.value || lower(category.name) === needle)
          .map((category) => category.id),
      )
      ids.add(filter.value)
      return (
        event.categoryIds.some((id) => ids.has(id)) ||
        (event.categoryNames ?? []).some((name) => lower(name) === needle)
      )
    }
    case 'status':
      return event.status === filter.value
  }
}

/**
 * Whether one of `wanted` organised or made the event; an event that names nobody belongs to its
 * calendar's owner, of whom only the name is known.
 */
function personFilterMatches(
  wanted: readonly string[],
  event: CalendarEvent,
  context: FilterContext,
): boolean {
  const people = [event.organizer, event.creator].filter(
    (person): person is EventPerson => person !== undefined,
  )
  if (people.length > 0) {
    return wanted.some((entry) => people.some((person) => isPerson(entry, person)))
  }
  const owner = context.calendarOwners?.get(event.calendarId)
  return owner !== undefined && wanted.some((entry) => isPerson(entry, { name: owner }))
}

/**
 * Whether `event` passes the active `filters`. "Show only" filters of one kind are alternatives
 * (either one), different kinds all have to pass; every "hide" filter applies on its own.
 */
export function passesFilters(
  event: CalendarEvent,
  filters: readonly CalendarFilter[],
  context: FilterContext = {},
): boolean {
  const onlyByKind = new Map<FilterKind, CalendarFilter[]>()
  for (const filter of filters) {
    if (modeOf(filter) === 'hide') {
      if (filterMatches(filter, event, context)) return false
      continue
    }
    const list = onlyByKind.get(filter.kind)
    if (list) list.push(filter)
    else onlyByKind.set(filter.kind, [filter])
  }
  for (const list of onlyByKind.values()) {
    if (!list.some((filter) => filterMatches(filter, event, context))) return false
  }
  return true
}

/**
 * What the value of a filter is shown as: a status in words, the people by their names, anything
 * else as it is.
 */
export function filterValueLabel(filter: Pick<CalendarFilter, 'kind' | 'value'>): string {
  if (filter.kind === 'status' && filter.value in STATUS_LABELS) {
    return tv(STATUS_LABELS[filter.value as EventStatus])
  }
  if (filter.kind === 'person') return filterPeople(filter.value).map(personLabel).join(', ')
  return filter.value.trim()
}

/** The name the dialog offers until the person types one: "Work", or "Hide: Cancelled". */
export function suggestedFilterName(draft: Pick<FilterDraft, 'kind' | 'value' | 'mode'>): string {
  const what = filterValueLabel(draft)
  if (!what) return ''
  const name = draft.mode === 'hide' ? t('Hide: {what}', { what }) : what
  return name.slice(0, FILTER_NAME_MAX)
}

/** What a filter of this kind and mode does, in a sentence for the dialog and the row's menu. */
export function describeFilter(draft: Pick<FilterDraft, 'kind' | 'value' | 'mode'>): string {
  const what = filterValueLabel(draft)
  const hide = draft.mode === 'hide'
  switch (draft.kind) {
    case 'text':
      return hide
        ? t('Hides the events whose title, place or notes contain "{what}".', { what })
        : t('Shows only the events whose title, place or notes contain "{what}".', { what })
    case 'category':
      return hide
        ? t('Hides the events in the category {what}.', { what })
        : t('Shows only the events in the category {what}.', { what })
    case 'status':
      return hide
        ? t('Hides the events with the status {what}.', { what })
        : t('Shows only the events with the status {what}.', { what })
    case 'person':
      return hide
        ? t('Hides the events of {what}.', { what })
        : t('Shows only the events of {what}.', { what })
  }
}

export interface FilterProblems {
  name?: string
  value?: string
}

/**
 * What is wrong with a draft, by field; empty when it can be saved. `existing` are the person's
 * filters; `exceptId` is the one being edited, whose own name is not "taken".
 */
export function checkFilterDraft(
  draft: FilterDraft,
  existing: readonly CalendarFilter[],
  exceptId?: string,
): FilterProblems {
  const problems: FilterProblems = {}
  const name = draft.name.trim()
  if (!name) problems.name = t('Enter a name.')
  else if (name.length > FILTER_NAME_MAX) {
    problems.name = t('Use at most {count} characters.', { count: FILTER_NAME_MAX })
  } else if (
    existing.some((filter) => filter.id !== exceptId && lower(filter.name) === lower(name))
  ) {
    problems.name = t('A filter with this name already exists.')
  }
  const value = draft.value.trim()
  if (draft.kind === 'status') {
    if (!(EVENT_STATUSES as string[]).includes(value)) problems.value = t('Choose a status.')
  } else if (draft.kind === 'person') {
    const people = filterPeople(value)
    if (people.length === 0) problems.value = t('Choose or enter at least one person.')
    else if (people.length > FILTER_PEOPLE_MAX) {
      problems.value = t('Choose at most {count} people.', { count: FILTER_PEOPLE_MAX })
    } else if (people.some((person) => person.length > FILTER_VALUE_MAX)) {
      problems.value = t('Use at most {count} characters.', { count: FILTER_VALUE_MAX })
    }
  } else if (!value) {
    problems.value =
      draft.kind === 'category' ? t('Choose a category.') : t('Enter the text to look for.')
  } else if (value.length > FILTER_VALUE_MAX) {
    problems.value = t('Use at most {count} characters.', { count: FILTER_VALUE_MAX })
  }
  return problems
}

/** The draft with its texts trimmed (a person filter's people each once), as it is saved. */
export function cleanFilterDraft(draft: FilterDraft): FilterDraft {
  const value =
    draft.kind === 'person' ? peopleValue(filterPeople(draft.value)) : draft.value.trim()
  return { name: draft.name.trim(), kind: draft.kind, value, mode: draft.mode }
}

/** Whether a filter looks for nothing: no text, no category, no person. */
export function isEmptyFilterValue(filter: Pick<CalendarFilter, 'kind' | 'value'>): boolean {
  return filter.kind === 'person'
    ? filterPeople(filter.value).length === 0
    : filter.value.trim() === ''
}

/** A person the list of a person filter offers. `value` is what the filter then holds. */
export interface KnownPerson {
  /** The name, else the address. */
  label: string
  /** The address, when there is a name too. */
  email?: string
  /** `Name <address>` when both are known, else the label. */
  value: string
}

/**
 * The people the loaded events and calendars name, for the list of a person filter: each once (by
 * the name, else the address; an address alone that a named person has is that person), sorted.
 * Any other name or address can be typed.
 */
export function knownPeople(
  events: readonly CalendarEvent[],
  ownerNames: Iterable<string>,
): KnownPerson[] {
  const byLabel = new Map<string, { label: string; email?: string }>()
  const add = (person: EventPerson | undefined) => {
    const name = person?.name?.trim()
    const email = person?.email?.trim()
    const label = name || email
    if (!label) return
    const known = byLabel.get(label.toLowerCase())
    if (!known) byLabel.set(label.toLowerCase(), { label, ...(name && email ? { email } : {}) })
    else if (!known.email && name && email) known.email = email
  }
  for (const name of ownerNames) add({ name })
  for (const event of events) {
    add(event.organizer)
    add(event.creator)
  }
  const named = new Set(
    [...byLabel.values()].flatMap((person) => (person.email ? [person.email.toLowerCase()] : [])),
  )
  return [...byLabel.values()]
    .filter((person) => !named.has(person.label.toLowerCase()))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((person) => ({
      ...person,
      value: person.email ? `${person.label} <${person.email}>` : person.label,
    }))
}
