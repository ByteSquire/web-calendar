import { describe, expect, it } from 'vitest'
import {
  checkFilterDraft,
  cleanFilterDraft,
  describeFilter,
  filterMatches,
  filterPeople,
  isEmptyFilterValue,
  knownPeople,
  modeOf,
  passesFilters,
  peopleValue,
  personLabel,
  splitPerson,
  suggestedFilterName,
  type FilterDraft,
} from '../app/utils/filters'
import type { CalendarEvent, CalendarFilter, Category } from '../shared/types/calendar'

// Saved filters (FR-5): what each kind matches, how "show only" and "hide" combine, and the checks
// and texts of the filter dialog.

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e',
    uid: 'e',
    calendarId: 'cal-a',
    title: 'Planning',
    start: '2026-10-28T10:00:00',
    end: '2026-10-28T11:00:00',
    allDay: false,
    status: 'confirmed',
    categoryIds: [],
    ...overrides,
  }
}

const filter = (
  kind: CalendarFilter['kind'],
  value: string,
  mode: CalendarFilter['mode'] = 'only',
): CalendarFilter => ({ id: `${kind}-${value}-${mode}`, name: value, kind, value, mode })

const categories: Category[] = [
  { id: '4', name: 'Work', color: '#112233' },
  { id: 'auto:Travel', name: 'Travel', color: '#445566' },
]
const calendarOwners = new Map([['cal-a', 'Alice Example']])
const context = { categories, calendarOwners }

describe('filterMatches', () => {
  it('finds a text in the title, the place and the notes, ignoring case', () => {
    const text = filter('text', 'LAKE')
    expect(filterMatches(text, event({ title: 'At the lake' }))).toBe(true)
    expect(filterMatches(text, event({ location: 'Lakeside' }))).toBe(true)
    expect(filterMatches(text, event({ description: 'by the lake' }))).toBe(true)
    expect(filterMatches(text, event())).toBe(false)
    // a busy time has no text of its own
    expect(filterMatches(text, event({ title: 'Lake', isBlocked: true }))).toBe(false)
  })

  it('finds a category by its name, also one only events carry, and by an older id', () => {
    expect(filterMatches(filter('category', 'work'), event({ categoryIds: ['4'] }), context)).toBe(
      true,
    )
    expect(
      filterMatches(filter('category', 'Travel'), event({ categoryIds: ['auto:Travel'] }), context),
    ).toBe(true)
    expect(
      filterMatches(filter('category', 'travel'), event({ categoryNames: ['Travel'] }), context),
    ).toBe(true)
    const byId = filter('category', '4')
    expect(filterMatches(byId, event({ categoryIds: ['4'] }), context)).toBe(true)
    expect(filterMatches(filter('category', 'Work'), event({ categoryIds: [] }), context)).toBe(
      false,
    )
  })

  it('compares the status exactly', () => {
    expect(filterMatches(filter('status', 'tentative'), event({ status: 'tentative' }))).toBe(true)
    expect(filterMatches(filter('status', 'tentative'), event())).toBe(false)
  })

  it('finds a person among the organiser and the creator, by name or address', () => {
    const met = event({ organizer: { name: 'Sam Lee', email: 'sam@example.org' } })
    const made = event({ creator: { name: 'Bob Builder' } })
    expect(filterMatches(filter('person', 'sam'), met, context)).toBe(true)
    expect(filterMatches(filter('person', 'SAM@EXAMPLE.ORG'), met, context)).toBe(true)
    expect(filterMatches(filter('person', 'bob'), made, context)).toBe(true)
    // the event names somebody: its calendar's owner does not count
    expect(filterMatches(filter('person', 'alice'), met, context)).toBe(false)
  })

  it('takes any of several people, and a person by the address after the name', () => {
    const people = filter('person', peopleValue(['Bob', 'Sam Lee <sam@example.org>']))
    const bySam = event({ organizer: { name: 'Lee, Sam', email: 'SAM@example.org' } })
    expect(filterMatches(people, bySam, context)).toBe(true)
    expect(filterMatches(people, event({ creator: { name: 'Bob Builder' } }), context)).toBe(true)
    expect(filterMatches(people, event({ organizer: { name: 'Amy' } }), context)).toBe(false)
    // the owner of a calendar is known by the name only
    expect(filterMatches(filter('person', peopleValue(['Alice'])), event(), context)).toBe(true)
  })

  it('falls back on the calendar’s owner when the event names nobody', () => {
    expect(filterMatches(filter('person', 'alice'), event(), context)).toBe(true)
    expect(filterMatches(filter('person', 'alice'), event({ calendarId: 'cal-b' }), context)).toBe(
      false,
    )
    expect(filterMatches(filter('person', 'alice'), event())).toBe(false)
  })

  it('matches nothing with an empty value', () => {
    expect(filterMatches(filter('text', '  '), event())).toBe(false)
    expect(filterMatches(filter('person', ''), event(), context)).toBe(false)
    expect(filterMatches(filter('person', '[]'), event(), context)).toBe(false)
  })
})

describe('the people of a person filter', () => {
  it('reads the JSON list, each person once, and a plain text as one person', () => {
    expect(filterPeople('[" Sam ", "sam", "", "Bob", 3]')).toEqual(['Sam', 'Bob'])
    expect(filterPeople('Sam Lee')).toEqual(['Sam Lee'])
    expect(filterPeople('"Sam"')).toEqual(['"Sam"'])
    expect(filterPeople(' ')).toEqual([])
    expect(peopleValue([' Sam ', 'SAM', 'Bob'])).toBe('["Sam","Bob"]')
  })

  it('tells a name from an address, and shows a person by the name', () => {
    expect(splitPerson('Sam Lee <sam@example.org>')).toEqual({
      name: 'Sam Lee',
      email: 'sam@example.org',
    })
    expect(splitPerson('<sam@example.org>')).toEqual({ email: 'sam@example.org' })
    expect(splitPerson('sam@example.org')).toEqual({ email: 'sam@example.org' })
    expect(splitPerson('Sam')).toEqual({ name: 'Sam' })
    expect(personLabel('Sam Lee <sam@example.org>')).toBe('Sam Lee')
    expect(personLabel('sam@example.org')).toBe('sam@example.org')
  })

  it('is empty without a person, and is saved as a clean list', () => {
    expect(isEmptyFilterValue({ kind: 'person', value: '[]' })).toBe(true)
    expect(isEmptyFilterValue({ kind: 'person', value: '["Sam"]' })).toBe(false)
    expect(isEmptyFilterValue({ kind: 'text', value: ' ' })).toBe(true)
    expect(
      cleanFilterDraft({ name: ' P ', kind: 'person', value: '[" Sam ","sam"]', mode: 'only' }),
    ).toEqual({ name: 'P', kind: 'person', value: '["Sam"]', mode: 'only' })
  })
})

describe('passesFilters', () => {
  const work = event({ id: 'work', categoryIds: ['4'] })
  const cancelled = event({ id: 'cancelled', status: 'cancelled', categoryIds: ['4'] })
  const trip = event({ id: 'trip', title: 'Trip', categoryIds: ['auto:Travel'] })
  const all = [work, cancelled, trip]
  const shown = (filters: CalendarFilter[]) =>
    all.filter((item) => passesFilters(item, filters, context)).map((item) => item.id)

  it('passes everything without filters', () => {
    expect(shown([])).toEqual(['work', 'cancelled', 'trip'])
  })

  it('shows only what a "show only" filter matches, and hides what a "hide" filter matches', () => {
    expect(shown([filter('category', 'Work')])).toEqual(['work', 'cancelled'])
    expect(shown([filter('category', 'Work', 'hide')])).toEqual(['trip'])
    expect(shown([filter('status', 'cancelled')])).toEqual(['cancelled'])
    expect(shown([filter('status', 'cancelled', 'hide')])).toEqual(['work', 'trip'])
  })

  it('takes either "show only" filter of one kind, and all kinds and hides together', () => {
    expect(shown([filter('category', 'Work'), filter('category', 'Travel')])).toEqual([
      'work',
      'cancelled',
      'trip',
    ])
    expect(shown([filter('category', 'Work'), filter('text', 'trip')])).toEqual([])
    expect(shown([filter('category', 'Work'), filter('status', 'cancelled', 'hide')])).toEqual([
      'work',
    ])
    expect(
      shown([filter('status', 'cancelled', 'hide'), filter('category', 'Travel', 'hide')]),
    ).toEqual(['work'])
  })
})

describe('modeOf', () => {
  it('reads a filter without a mode as filters worked before they had one', () => {
    expect(modeOf({ kind: 'status' })).toBe('hide')
    expect(modeOf({ kind: 'text' })).toBe('only')
    expect(modeOf({ kind: 'status', mode: 'only' })).toBe('only')
  })
})

describe('the texts of the dialog', () => {
  it('suggests a name from what the filter looks for', () => {
    expect(suggestedFilterName({ kind: 'category', value: ' Work ', mode: 'only' })).toBe('Work')
    expect(suggestedFilterName({ kind: 'status', value: 'cancelled', mode: 'hide' })).toBe(
      'Hide: Cancelled',
    )
    expect(suggestedFilterName({ kind: 'text', value: '', mode: 'hide' })).toBe('')
    const long = suggestedFilterName({ kind: 'text', value: 'x'.repeat(200), mode: 'only' })
    expect(long).toHaveLength(80)
  })

  it('says what the filter does', () => {
    const people = peopleValue(['Sam Lee <sam@example.org>', 'bob@example.org'])
    expect(describeFilter({ kind: 'person', value: people, mode: 'only' })).toBe(
      'Shows only the events of Sam Lee, bob@example.org.',
    )
    expect(suggestedFilterName({ kind: 'person', value: people, mode: 'hide' })).toBe(
      'Hide: Sam Lee, bob@example.org',
    )
    expect(describeFilter({ kind: 'status', value: 'tentative', mode: 'hide' })).toBe(
      'Hides the events with the status Tentative.',
    )
  })
})

describe('checkFilterDraft', () => {
  const existing = [filter('text', 'Lunch')]
  const draft = (change: Partial<FilterDraft> = {}): FilterDraft => ({
    name: 'Mine',
    kind: 'text',
    value: 'standup',
    mode: 'only',
    ...change,
  })

  it('accepts a complete draft', () => {
    expect(checkFilterDraft(draft(), existing)).toEqual({})
    expect(checkFilterDraft(draft({ kind: 'status', value: 'cancelled' }), existing)).toEqual({})
  })

  it('wants a name that is not taken, ignoring case, except by the filter itself', () => {
    expect(checkFilterDraft(draft({ name: ' ' }), existing).name).toBe('Enter a name.')
    expect(checkFilterDraft(draft({ name: 'LUNCH' }), existing).name).toBe(
      'A filter with this name already exists.',
    )
    expect(checkFilterDraft(draft({ name: 'lunch' }), existing, existing[0]!.id)).toEqual({})
    expect(checkFilterDraft(draft({ name: 'x'.repeat(81) }), existing).name).toBe(
      'Use at most 80 characters.',
    )
  })

  it('wants a value that fits the kind', () => {
    expect(checkFilterDraft(draft({ value: ' ' }), existing).value).toBe(
      'Enter the text to look for.',
    )
    expect(checkFilterDraft(draft({ kind: 'category', value: '' }), existing).value).toBe(
      'Choose a category.',
    )
    expect(checkFilterDraft(draft({ kind: 'status', value: 'busy' }), existing).value).toBe(
      'Choose a status.',
    )
    expect(checkFilterDraft(draft({ kind: 'person', value: '[]' }), existing).value).toBe(
      'Choose or enter at least one person.',
    )
    const many = peopleValue(Array.from({ length: 21 }, (_, index) => `p${index}`))
    expect(checkFilterDraft(draft({ kind: 'person', value: many }), existing).value).toBe(
      'Choose at most 20 people.',
    )
    expect(checkFilterDraft(draft({ kind: 'person', value: '["Sam"]' }), existing)).toEqual({})
    expect(checkFilterDraft(draft({ value: 'x'.repeat(201) }), existing).value).toBe(
      'Use at most 200 characters.',
    )
  })
})

describe('knownPeople', () => {
  it('lists the owners and the people events name, each once with an address, sorted', () => {
    const events = [
      event({ organizer: { name: 'Sam Lee', email: 'lee@example.org' } }),
      event({ creator: { name: 'alice example' } }),
      // an address alone of somebody whose name is known is that person
      event({ organizer: { email: 'lee@example.org' } }),
      event({ organizer: { email: 'amy@example.org' } }),
    ]
    expect(knownPeople(events, ['Alice Example', ' '])).toEqual([
      { label: 'Alice Example', value: 'Alice Example' },
      { label: 'amy@example.org', value: 'amy@example.org' },
      { label: 'Sam Lee', email: 'lee@example.org', value: 'Sam Lee <lee@example.org>' },
    ])
  })
})
