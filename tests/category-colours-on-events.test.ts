// "Category colours on events": which categories an entry shows as dots and says in its label, in
// the main calendar and the split view; never on a busy time, and nothing when the option is off.
import { describe, expect, it } from 'vitest'
import { shownCategories, toFullCalendarEvent } from '../app/utils/fullcalendar'
import { timelineEventSrText, toTimelineEvent } from '../app/utils/split-view'
import type { Calendar, CalendarEvent, Category } from '../shared/types/calendar'

const calendar: Calendar = {
  id: 'cal',
  name: 'Team',
  type: 'caldav',
  color: '#1d4ed8',
  defaultVisible: true,
}
const categories = new Map<string, Category>([
  ['1', { id: '1', name: 'Work', color: '#b91c1c' }],
  ['auto:travel', { id: 'auto:travel', name: 'Travel', color: '#047857' }],
])
const event = (extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'e1',
  uid: 'e1',
  calendarId: 'cal',
  title: 'Trip',
  start: '2026-10-28T10:00:00',
  end: '2026-10-28T11:00:00',
  allDay: false,
  status: 'confirmed',
  categoryIds: ['1', 'auto:travel', 'gone'],
  ...extra,
})
const context = { calendarById: new Map([['cal', calendar]]), scheme: 'light' as const }

describe('the categories an entry shows', () => {
  it('are its saved categories and the names it carries, in order; unknown ids are left out', () => {
    expect(shownCategories(event(), categories).map((c) => c.name)).toEqual(['Work', 'Travel'])
  })

  it('are none for a busy time, and none when the option is off', () => {
    expect(shownCategories(event({ isBlocked: true }), categories)).toEqual([])
    expect(shownCategories(event(), undefined)).toEqual([])
  })
})

describe('the main calendar', () => {
  it('gives the colours to the entry and the names to its label', () => {
    const mapped = toFullCalendarEvent(event(), { ...context, categoryById: categories })
    expect(mapped.extendedProps!.categoryColors).toEqual(['#b91c1c', '#047857'])
    expect(mapped.extendedProps!.label).toMatch(/, categories Work, Travel$/)
    const one = toFullCalendarEvent(event({ categoryIds: ['1'] }), {
      ...context,
      categoryById: categories,
    })
    expect(one.extendedProps!.label).toMatch(/, category Work$/)
  })

  it('shows nothing when the option is off, or for a busy time', () => {
    const off = toFullCalendarEvent(event(), context)
    expect(off.extendedProps!.categoryColors).toEqual([])
    expect(off.extendedProps!.label).not.toContain('Work')
    const busy = toFullCalendarEvent(event({ isBlocked: true }), {
      ...context,
      categoryById: categories,
    })
    expect(busy.extendedProps!.categoryColors).toEqual([])
    expect(busy.extendedProps!.label).not.toContain('Work')
  })
})

describe('the split view', () => {
  it('gives the colours and names to the entry, and says the names to a screen reader', () => {
    const mapped = toTimelineEvent(event(), calendar, 'light', categories)
    expect(mapped.extendedProps.categoryColors).toEqual(['#b91c1c', '#047857'])
    expect(timelineEventSrText(mapped.extendedProps)).toBe('Team, categories Work, Travel')
    const busy = toTimelineEvent(event({ isBlocked: true }), calendar, 'light', categories)
    expect(busy.extendedProps.categoryColors).toEqual([])
    expect(toTimelineEvent(event(), calendar, 'light').extendedProps.categoryColors).toEqual([])
  })
})
