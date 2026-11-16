import { describe, expect, it } from 'vitest'
import {
  checkViewDraft,
  chosenViewCalendarIds,
  hiddenViewCalendarCount,
  offeredViewCalendars,
  takenViewNames,
} from '../app/utils/view-form'
import type { Calendar, CalendarView } from '../shared/types/calendar'

// The view dialog and "Update from selection" (FR-2, FR-21).

const calendar = (id: string, type: Calendar['type'] = 'caldav'): Calendar => ({
  id,
  name: id,
  type,
  color: '#112233',
  defaultVisible: true,
})

const calendars = [
  calendar('dav:/caldav/u/a/'),
  calendar('ics:3', 'ical'),
  calendar('ext:1:https://example.org/cal/'),
  calendar('res:4', 'resource'),
]

describe('offeredViewCalendars', () => {
  it('offers no resource, and in a shared view no external calendar', () => {
    expect(offeredViewCalendars(calendars, false).map((c) => c.id)).toEqual([
      'dav:/caldav/u/a/',
      'ics:3',
      'ext:1:https://example.org/cal/',
    ])
    expect(offeredViewCalendars(calendars, true).map((c) => c.id)).toEqual([
      'dav:/caldav/u/a/',
      'ics:3',
    ])
  })
})

describe('chosenViewCalendarIds', () => {
  const offered = offeredViewCalendars(calendars, true)

  it('keeps the chosen ones in the listed order, and the ones the dialog did not offer', () => {
    expect(
      chosenViewCalendarIds(['dav:/caldav/u/gone/', 'dav:/caldav/u/a/'], offered, [
        'ics:3',
        'dav:/caldav/u/a/',
      ]),
    ).toEqual(['dav:/caldav/u/a/', 'ics:3', 'dav:/caldav/u/gone/'])
  })

  it('drops an offered calendar that is no longer chosen', () => {
    expect(chosenViewCalendarIds(['dav:/caldav/u/a/', 'ics:3'], offered, ['ics:3'])).toEqual([
      'ics:3',
    ])
  })

  it('counts the calendars it keeps without offering them', () => {
    expect(hiddenViewCalendarCount(['dav:/caldav/u/gone/', 'ics:3', 'res:4'], offered)).toBe(2)
  })
})

describe('takenViewNames', () => {
  const views: CalendarView[] = [
    { id: '1', name: 'Mine', icon: 'calendar', calendarIds: [], isAdmin: false },
    { id: '2', name: 'Team', icon: 'users', calendarIds: [], isAdmin: true },
    { id: '3', name: 'Other', icon: 'star', calendarIds: [], isAdmin: false },
  ]

  it('names the other views of the same kind', () => {
    expect(takenViewNames(views, false)).toEqual(['Mine', 'Other'])
    expect(takenViewNames(views, false, '1')).toEqual(['Other'])
    expect(takenViewNames(views, true)).toEqual(['Team'])
  })
})

describe('checkViewDraft', () => {
  it('wants a free name and at least one calendar', () => {
    expect(checkViewDraft(' Mine ', 1, ['Other'])).toEqual({})
    expect(checkViewDraft(' ', 1, [])).toEqual({ name: 'Enter a name.' })
    expect(checkViewDraft('other', 1, ['Other'])).toEqual({
      name: 'A view with this name already exists.',
    })
    expect(checkViewDraft('x'.repeat(81), 1, [])).toEqual({ name: 'Use at most 80 characters.' })
    expect(checkViewDraft('Mine', 0, [])).toEqual({ calendars: 'Choose at least one calendar.' })
  })
})
