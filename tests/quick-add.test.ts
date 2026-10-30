import { describe, expect, it } from 'vitest'
import { ref, type Ref } from 'vue'
import { Temporal } from 'temporal-polyfill'
import { createMockData } from '../app/data/mock'
import { createCalendarState, type StateFactory } from '../app/utils/calendar-state'
import {
  defaultQuickAddCalendarId,
  initialQuickAddForm,
  setQuickAddAllDay,
  setQuickAddStart,
  toNewEventInput,
  validateQuickAdd,
  type QuickAddDefaults,
  type QuickAddForm,
} from '../app/utils/quick-add'

const anchor = Temporal.PlainDate.from('2026-10-28')
const calendars = [{ id: 'cal-a' }, { id: 'cal-b' }, { id: 'cal-c' }]
const calendarIds = calendars.map((calendar) => calendar.id)

function defaults(overrides: Partial<QuickAddDefaults> = {}): QuickAddDefaults {
  return { preset: null, anchor, calendars, visibleCalendarIds: ['cal-b', 'cal-c'], ...overrides }
}

function form(overrides: Partial<QuickAddForm> = {}): QuickAddForm {
  return {
    title: 'Planning',
    calendarId: 'cal-a',
    allDay: false,
    start: '2026-10-28T09:00',
    end: '2026-10-28T10:00',
    ...overrides,
  }
}

describe('defaultQuickAddCalendarId', () => {
  it('prefers the requested calendar if it exists', () => {
    expect(defaultQuickAddCalendarId(calendars, ['cal-b'], 'cal-c')).toBe('cal-c')
  })

  it('ignores a requested calendar that does not exist', () => {
    expect(defaultQuickAddCalendarId(calendars, ['cal-b'], 'cal-x')).toBe('cal-b')
  })

  it('takes the first visible calendar in calendar order, not in visibility order', () => {
    expect(defaultQuickAddCalendarId(calendars, ['cal-c', 'cal-b'])).toBe('cal-b')
  })

  it('falls back to the first calendar, or to nothing', () => {
    expect(defaultQuickAddCalendarId(calendars, [])).toBe('cal-a')
    expect(defaultQuickAddCalendarId([], [])).toBe('')
  })
})

describe('initialQuickAddForm', () => {
  it('defaults to the anchor date, 09:00 to 10:00, in the first visible calendar', () => {
    expect(initialQuickAddForm(defaults())).toEqual({
      title: '',
      calendarId: 'cal-b',
      allDay: false,
      start: '2026-10-28T09:00',
      end: '2026-10-28T10:00',
    })
  })

  it('uses a timed preset as is and lasts one hour when it has no end', () => {
    const result = initialQuickAddForm(defaults({ preset: { start: '2026-11-02T14:30:00' } }))
    expect(result).toMatchObject({ start: '2026-11-02T14:30', end: '2026-11-02T15:30' })
  })

  it('crosses midnight when the default hour does', () => {
    const result = initialQuickAddForm(defaults({ preset: { start: '2026-11-02T23:30' } }))
    expect(result).toMatchObject({ start: '2026-11-02T23:30', end: '2026-11-03T00:30' })
  })

  it('keeps the end of a timed preset when it is after the start', () => {
    const result = initialQuickAddForm(
      defaults({ preset: { start: '2026-11-02T14:00', end: '2026-11-02T17:15' } }),
    )
    expect(result).toMatchObject({ start: '2026-11-02T14:00', end: '2026-11-02T17:15' })
  })

  it('repairs a timed preset whose end is not after its start', () => {
    const result = initialQuickAddForm(
      defaults({ preset: { start: '2026-11-02T14:00', end: '2026-11-02T13:00' } }),
    )
    expect(result).toMatchObject({ start: '2026-11-02T14:00', end: '2026-11-02T15:00' })
  })

  it('puts a clicked date (no time) at 09:00', () => {
    const result = initialQuickAddForm(defaults({ preset: { start: '2026-11-02' } }))
    expect(result).toMatchObject({
      allDay: false,
      start: '2026-11-02T09:00',
      end: '2026-11-02T10:00',
    })
  })

  it('shows the last day, not the exclusive end, of an all-day preset', () => {
    const result = initialQuickAddForm(
      defaults({ preset: { allDay: true, start: '2026-11-02', end: '2026-11-05' } }),
    )
    expect(result).toMatchObject({ allDay: true, start: '2026-11-02', end: '2026-11-04' })
  })

  it('makes an all-day preset without an end last one day', () => {
    const result = initialQuickAddForm(defaults({ preset: { allDay: true, start: '2026-11-02' } }))
    expect(result).toMatchObject({ start: '2026-11-02', end: '2026-11-02' })
  })

  it('accepts an all-day preset with a timed start and anchors one without a start', () => {
    expect(
      initialQuickAddForm(defaults({ preset: { allDay: true, start: '2026-11-02T08:00' } })),
    ).toMatchObject({ start: '2026-11-02', end: '2026-11-02' })
    expect(initialQuickAddForm(defaults({ preset: { allDay: true } }))).toMatchObject({
      start: '2026-10-28',
      end: '2026-10-28',
    })
  })

  it('ignores unusable preset dates', () => {
    const result = initialQuickAddForm(defaults({ preset: { start: 'tomorrow', end: '??' } }))
    expect(result).toMatchObject({ start: '2026-10-28T09:00', end: '2026-10-28T10:00' })
  })

  it('takes title and calendar from the preset', () => {
    const result = initialQuickAddForm(
      defaults({ preset: { title: 'Lunch', calendarId: 'cal-c' } }),
    )
    expect(result).toMatchObject({ title: 'Lunch', calendarId: 'cal-c' })
  })
})

describe('setQuickAddAllDay', () => {
  it('converts a timed event to dates and keeps the end on or after the start', () => {
    const result = setQuickAddAllDay(
      form({ start: '2026-10-28T09:00', end: '2026-10-30T10:00' }),
      true,
    )
    expect(result).toMatchObject({ allDay: true, start: '2026-10-28', end: '2026-10-30' })
  })

  it('converts all-day dates back to 09:00 and 10:00', () => {
    const result = setQuickAddAllDay(
      form({ allDay: true, start: '2026-10-28', end: '2026-10-30' }),
      false,
    )
    expect(result).toMatchObject({
      allDay: false,
      start: '2026-10-28T09:00',
      end: '2026-10-30T10:00',
    })
  })

  it('keeps empty fields empty and repairs an empty end', () => {
    expect(setQuickAddAllDay(form({ allDay: true, start: '', end: '' }), false)).toMatchObject({
      start: '',
      end: '',
    })
    expect(setQuickAddAllDay(form({ end: '' }), true)).toMatchObject({
      start: '2026-10-28',
      end: '2026-10-28',
    })
  })

  it('returns the form unchanged when the mode is the same', () => {
    const current = form()
    expect(setQuickAddAllDay(current, false)).toBe(current)
  })
})

describe('setQuickAddStart', () => {
  it('moves the end with the start and keeps the duration', () => {
    const result = setQuickAddStart(
      form({ start: '2026-10-28T09:00', end: '2026-10-28T10:30' }),
      '2026-11-03T16:00',
    )
    expect(result).toMatchObject({ start: '2026-11-03T16:00', end: '2026-11-03T17:30' })
  })

  it('keeps the number of days of an all-day event', () => {
    const result = setQuickAddStart(
      form({ allDay: true, start: '2026-10-28', end: '2026-10-30' }),
      '2026-12-30',
    )
    expect(result).toMatchObject({ start: '2026-12-30', end: '2027-01-01' })
  })

  it('leaves the end alone when it was before the start or either is incomplete', () => {
    expect(
      setQuickAddStart(
        form({ start: '2026-10-28T09:00', end: '2026-10-27T10:00' }),
        '2026-11-03T16:00',
      ).end,
    ).toBe('2026-10-27T10:00')
    expect(setQuickAddStart(form({ end: '' }), '2026-11-03T16:00').end).toBe('')
    expect(setQuickAddStart(form(), '').end).toBe('2026-10-28T10:00')
  })
})

describe('validateQuickAdd', () => {
  it('accepts a complete form', () => {
    expect(validateQuickAdd(form(), calendarIds)).toEqual({})
  })

  it('requires a title that is not blank', () => {
    expect(validateQuickAdd(form({ title: '   ' }), calendarIds).title).toBeDefined()
    expect(validateQuickAdd(form({ title: '' }), calendarIds).title).toBeDefined()
  })

  it('requires a calendar the user may add to', () => {
    expect(validateQuickAdd(form({ calendarId: '' }), calendarIds).calendarId).toBeDefined()
    expect(validateQuickAdd(form({ calendarId: 'cal-x' }), calendarIds).calendarId).toBeDefined()
    expect(validateQuickAdd(form(), []).calendarId).toBeDefined()
  })

  it('requires start and end, and reports them separately', () => {
    const errors = validateQuickAdd(form({ start: '', end: '' }), calendarIds)
    expect(errors.start).toBe('Enter a start date and time.')
    expect(errors.end).toBe('Enter an end date and time.')
    expect(validateQuickAdd(form({ allDay: true, start: '' }), calendarIds).start).toBe(
      'Enter a start date.',
    )
  })

  it('rejects dates that do not exist and values of the wrong format', () => {
    expect(validateQuickAdd(form({ start: '2026-02-30T09:00' }), calendarIds).start).toBeDefined()
    expect(validateQuickAdd(form({ start: '2026-10-28' }), calendarIds).start).toBeDefined()
    expect(
      validateQuickAdd(
        form({ allDay: true, start: '2026-10-28T09:00', end: '2026-10-28' }),
        calendarIds,
      ).start,
    ).toBeDefined()
  })

  it('needs a timed end strictly after the start', () => {
    expect(validateQuickAdd(form({ end: '2026-10-28T09:00' }), calendarIds).end).toBe(
      'The end must be after the start.',
    )
    expect(validateQuickAdd(form({ end: '2026-10-28T08:59' }), calendarIds).end).toBeDefined()
    expect(validateQuickAdd(form({ end: '2026-10-28T09:01' }), calendarIds)).toEqual({})
  })

  it('allows an all-day event to end on its start date but not before it', () => {
    const allDay = { allDay: true, start: '2026-10-28' }
    expect(validateQuickAdd(form({ ...allDay, end: '2026-10-28' }), calendarIds)).toEqual({})
    expect(validateQuickAdd(form({ ...allDay, end: '2026-10-27' }), calendarIds).end).toBe(
      'The end date must not be before the start date.',
    )
  })

  it('reports every problem at once', () => {
    const errors = validateQuickAdd(
      form({ title: '', calendarId: '', start: '', end: '' }),
      calendarIds,
    )
    expect(Object.keys(errors).sort()).toEqual(['calendarId', 'end', 'start', 'title'])
  })
})

describe('toNewEventInput', () => {
  it('passes timed values through and trims the title', () => {
    expect(toNewEventInput(form({ title: '  Planning ' }))).toEqual({
      title: 'Planning',
      calendarId: 'cal-a',
      allDay: false,
      start: '2026-10-28T09:00',
      end: '2026-10-28T10:00',
    })
  })

  it('makes the all-day end exclusive', () => {
    const input = toNewEventInput(form({ allDay: true, start: '2026-10-30', end: '2026-10-31' }))
    expect(input).toMatchObject({ allDay: true, start: '2026-10-30', end: '2026-11-01' })
    expect(
      toNewEventInput(form({ allDay: true, start: '2026-12-31', end: '2026-12-31' })).end,
    ).toBe('2027-01-01')
  })
})

describe('quick-add with the calendar state', () => {
  function makeStore() {
    const store = new Map<string, Ref<unknown>>()
    const state: StateFactory = <T>(key: string, init: () => T) => {
      if (!store.has(key)) store.set(key, ref(init()))
      return store.get(key) as Ref<T>
    }
    return createCalendarState(state, {
      seed: () => createMockData(anchor),
      today: () => anchor,
      sidebarOpen: () => true,
    })
  }

  function open(
    store: ReturnType<typeof makeStore>,
    preset?: Parameters<typeof store.openQuickAdd>[0],
  ) {
    store.openQuickAdd(preset)
    return initialQuickAddForm({
      preset: store.quickAddPreset.value,
      anchor: store.anchorDate.value,
      calendars: store.calendars.value,
      visibleCalendarIds: store.visibleCalendarIds.value,
    })
  }

  it('shows an event added with the default form in the current range', () => {
    const store = makeStore()
    const created = { ...open(store), title: 'Quick-add test' }
    expect(
      validateQuickAdd(
        created,
        store.calendars.value.map((c) => c.id),
      ),
    ).toEqual({})

    const event = store.addEvent(toNewEventInput(created))

    expect(store.visibleCalendarIds.value).toContain(event.calendarId)
    expect(store.visibleEventsInRange.value.map((e) => e.id)).toContain(event.id)
  })

  it('shows an all-day event added from a preset on every day it covers', () => {
    const store = makeStore()
    const created = {
      ...open(store, { allDay: true, start: '2026-10-28', end: '2026-10-30' }),
      title: 'Offsite',
    }
    expect(created).toMatchObject({ start: '2026-10-28', end: '2026-10-29' })

    const event = store.addEvent(toNewEventInput(created))

    expect(event).toMatchObject({ allDay: true, end: '2026-10-30' })
    store.viewType.value = 'day'
    store.anchorDate.value = Temporal.PlainDate.from('2026-10-29')
    expect(store.visibleEventsInRange.value.map((e) => e.id)).toContain(event.id)
    store.anchorDate.value = Temporal.PlainDate.from('2026-10-30')
    expect(store.visibleEventsInRange.value.map((e) => e.id)).not.toContain(event.id)
  })

  it('does not show an event added to a hidden calendar', () => {
    const store = makeStore()
    const hidden = store.calendars.value.find(
      (c) => !store.visibleCalendarIds.value.includes(c.id),
    )!
    const event = store.addEvent(
      toNewEventInput({ ...open(store), title: 'Hidden', calendarId: hidden.id }),
    )
    expect(store.visibleEventsInRange.value.map((e) => e.id)).not.toContain(event.id)
  })
})

describe('quick-add helpers on a form with more fields', () => {
  // The live dialogs (writes/event-form.ts) extend the form; switching to all-day or moving the
  // start must not drop what the extension added.
  const extended = { ...form(), description: 'Agenda', repeat: 'weekly' as const }

  it('keeps the extra fields when switching between all-day and timed', () => {
    const allDay = setQuickAddAllDay(extended, true)
    expect(allDay).toMatchObject({ allDay: true, description: 'Agenda', repeat: 'weekly' })
    expect(setQuickAddAllDay(allDay, false)).toMatchObject({
      allDay: false,
      description: 'Agenda',
      repeat: 'weekly',
    })
  })

  it('keeps the extra fields when the start moves the end', () => {
    expect(setQuickAddStart(extended, '2026-10-29T09:00')).toMatchObject({
      start: '2026-10-29T09:00',
      end: '2026-10-29T10:00',
      description: 'Agenda',
      repeat: 'weekly',
    })
  })
})
