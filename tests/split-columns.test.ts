import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { Temporal } from 'temporal-polyfill'
import SplitColumns from '../app/components/SplitColumns.vue'
import type { SplitBand } from '../app/utils/calendar-state'
import { themeClass } from '../app/utils/fc-theme'
import { buildSplitColumns, daysOccupied, entryTimeText } from '../app/utils/split-columns'
import type { Calendar, CalendarEvent } from '../shared/types/calendar'

// The split view with calendars as columns and a row per day (utils/split-columns.ts).

const day = (value: string) => Temporal.PlainDate.from(value)
const week = { start: day('2026-10-26'), end: day('2026-11-02') }

const calendar = (id: string, name = id): Calendar => ({
  id,
  name,
  type: 'caldav',
  color: '#1d4ed8',
  defaultVisible: true,
})

let next = 0
function event(fields: Partial<CalendarEvent> & Pick<CalendarEvent, 'start' | 'end'>) {
  next += 1
  return {
    id: `e${next}`,
    uid: `e${next}`,
    calendarId: 'a',
    title: `Entry ${next}`,
    allDay: !fields.start.includes('T'),
    status: 'confirmed',
    categoryIds: [],
    ...fields,
  } satisfies CalendarEvent
}

describe('daysOccupied', () => {
  it('counts the days an entry takes, with exclusive ends', () => {
    expect(daysOccupied(event({ start: '2026-10-27', end: '2026-10-30' }))).toEqual({
      first: day('2026-10-27'),
      last: day('2026-10-29'),
    })
    // A timed entry that ends at midnight does not take the next day; one that runs past it does.
    expect(
      daysOccupied(event({ start: '2026-10-27T20:00:00', end: '2026-10-28T00:00:00' })).last,
    ).toEqual(day('2026-10-27'))
    expect(
      daysOccupied(event({ start: '2026-10-27T22:00:00', end: '2026-10-28T02:00:00' })).last,
    ).toEqual(day('2026-10-28'))
    // No length at all: the day it starts.
    expect(
      daysOccupied(event({ start: '2026-10-27T09:00:00', end: '2026-10-27T09:00:00' })),
    ).toEqual({ first: day('2026-10-27'), last: day('2026-10-27') })
  })
})

describe('entryTimeText', () => {
  it('shows the time of a timed entry and nothing for whole days', () => {
    expect(entryTimeText(event({ start: '2026-10-27T09:00:00', end: '2026-10-27T09:15:00' }))).toBe(
      '09:00–09:15',
    )
    expect(entryTimeText(event({ start: '2026-10-27', end: '2026-10-28' }))).toBe('')
  })
})

describe('buildSplitColumns', () => {
  it('has a row per day and keeps the order of the bands', () => {
    const model = buildSplitColumns(
      [
        { calendar: calendar('b'), events: [] },
        { calendar: calendar('a'), events: [] },
      ],
      week,
      'light',
    )
    expect(model.days.map(String)).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ])
    expect(model.calendars.map((column) => column.calendar.id)).toEqual(['b', 'a'])
    expect(model.calendars[0]!.lanes).toBe(0)
  })

  it('lists an entry of one day in its day and runs one over several days down its rows, a piece in each', () => {
    const standup = event({
      title: 'Standup',
      start: '2026-10-26T09:00:00',
      end: '2026-10-26T09:15:00',
    })
    const offsite = event({ title: 'Offsite', start: '2026-10-27', end: '2026-10-30' })
    const holiday = event({ title: 'Holiday', start: '2026-10-30', end: '2026-10-31' })
    const [column] = buildSplitColumns(
      [{ calendar: calendar('a', 'Team'), events: [standup, offsite, holiday] }],
      week,
      'light',
    ).calendars
    expect(column!.lanes).toBe(1)
    expect(column!.dayEntries.map((list) => list.map((item) => item.entry.title))).toEqual([
      ['Standup'],
      [],
      [],
      [],
      ['Holiday'],
      [],
      [],
    ])
    expect(column!.laneCells.map((cells) => cells[0]!.kind)).toEqual([
      'empty',
      'start',
      'continued',
      'continued',
      'empty',
      'empty',
      'empty',
    ])
    const start = column!.laneCells[1]![0]!
    if (start.kind !== 'start') throw new Error('no block')
    expect(start.span).toMatchObject({
      row: 1,
      rows: 3,
      continuesBefore: false,
      continuesAfter: false,
      timeText: '',
    })
    expect(start.span.entry.title).toBe('Offsite')
    // Only the piece in the last row closes the block.
    expect(
      column!.laneCells.slice(1, 4).map((cells) => (cells[0] as { last: boolean }).last),
    ).toEqual([false, false, true])
    // The name for assistive technology says what, when and where.
    expect(start.span.label).toContain('Offsite')
    expect(start.span.label).toContain('Calendar Team')
  })

  it('puts overlapping blocks side by side and reuses a lane once it is free', () => {
    const trip = event({ start: '2026-10-26', end: '2026-10-29' })
    const conference = event({ start: '2026-10-28', end: '2026-10-31' })
    const weekend = event({ start: '2026-10-31', end: '2026-11-02' })
    const [column] = buildSplitColumns(
      [{ calendar: calendar('a'), events: [trip, conference, weekend] }],
      week,
      'light',
    ).calendars
    expect(column!.lanes).toBe(2)
    const lane = (id: string) =>
      column!.laneCells.flat().find((cell) => cell.kind === 'start' && cell.span.entry.id === id)
    expect(lane(trip.id)).toMatchObject({ span: { lane: 0, row: 0, rows: 3 } })
    expect(lane(conference.id)).toMatchObject({ span: { lane: 1, row: 2, rows: 3 } })
    expect(lane(weekend.id)).toMatchObject({ span: { lane: 0, row: 5, rows: 2 } })
    // Lanes only on the days a block runs through, up to the last one taken that day: on Friday
    // only lane 1 is taken, so lane 0 stays (empty) to keep the block in line.
    expect(column!.rowLanes).toEqual([1, 1, 2, 2, 2, 1, 1])
  })

  it('draws no lane on a day no block runs through', () => {
    const offsite = event({ start: '2026-10-27', end: '2026-10-30' })
    const [column] = buildSplitColumns(
      [{ calendar: calendar('a'), events: [offsite] }],
      week,
      'light',
    ).calendars
    expect(column!.lanes).toBe(1)
    expect(column!.rowLanes).toEqual([0, 1, 1, 1, 0, 0, 0])
  })

  it('cuts a block at the edges of the period and says that it goes on', () => {
    const long = event({ start: '2026-10-20', end: '2026-11-05' })
    const tail = event({ start: '2026-10-25', end: '2026-10-27' })
    const [column] = buildSplitColumns(
      [{ calendar: calendar('a'), events: [long, tail] }],
      week,
      'light',
    ).calendars
    const start = column!.laneCells[0]![0]!
    if (start.kind !== 'start') throw new Error('no block')
    expect(start.span).toMatchObject({ rows: 7, continuesBefore: true, continuesAfter: true })
    // Only one day of `tail` is in the period: it is listed in that day.
    expect(column!.dayEntries[0]!.map((item) => item.entry.id)).toEqual([tail.id])
  })

  it('shows the times of a timed entry that runs over midnight', () => {
    const night = event({ start: '2026-10-27T22:00:00', end: '2026-10-28T02:00:00' })
    const [column] = buildSplitColumns(
      [{ calendar: calendar('a'), events: [night] }],
      week,
      'dark',
    ).calendars
    const start = column!.laneCells[1]![0]!
    if (start.kind !== 'start') throw new Error('no block')
    expect(start.span).toMatchObject({ rows: 2, timeText: '22:00–02:00' })
  })

  it('lists whole days before timed entries of the same day', () => {
    const meeting = event({ start: '2026-10-26T09:00:00', end: '2026-10-26T10:00:00' })
    const holiday = event({ start: '2026-10-26', end: '2026-10-27' })
    const [column] = buildSplitColumns(
      [{ calendar: calendar('a'), events: [meeting, holiday] }],
      week,
      'light',
    ).calendars
    expect(column!.dayEntries[0]!.map((item) => item.entry.id)).toEqual([holiday.id, meeting.id])
  })

  it('names a busy time Busy and tells nothing about it', () => {
    const busy = event({
      title: 'Secret',
      start: '2026-10-26',
      end: '2026-10-27',
      isBlocked: true,
    })
    const [column] = buildSplitColumns(
      [{ calendar: calendar('a'), events: [busy] }],
      week,
      'light',
    ).calendars
    const item = column!.dayEntries[0]![0]!
    expect(item.entry.title).toBe('Busy')
    expect(item.label).not.toContain('Secret')
  })
})

describe('SplitColumns', () => {
  const mounted: VueWrapper[] = []
  afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

  function mountTable(bands: SplitBand[]) {
    const wrapper = mount(SplitColumns, {
      props: { bands, range: week, scheme: 'light', today: day('2026-10-29') },
      attachTo: document.body,
    })
    mounted.push(wrapper)
    return wrapper
  }

  const bands = (): SplitBand[] => [
    {
      calendar: calendar('a', 'Team'),
      events: [
        event({
          id: 'standup',
          title: 'Standup',
          start: '2026-10-26T09:00:00',
          end: '2026-10-26T09:15:00',
        }),
        event({ id: 'offsite', title: 'Offsite', start: '2026-10-27', end: '2026-10-30' }),
      ],
    },
    {
      calendar: calendar('b', 'Personal'),
      events: [
        event({
          id: 'dentist',
          calendarId: 'b',
          title: 'Dentist',
          start: '2026-10-28T17:00:00',
          end: '2026-10-28T18:00:00',
        }),
      ],
    },
  ]

  it('has a column per calendar, a row header per day and spans the block over its days', () => {
    const wrapper = mountTable(bands())
    const headers = wrapper.findAll('thead th')
    expect(headers.map((cell) => cell.text())).toEqual(['Date', 'Team', 'Personal'])
    // Team has a lane for its block and its day cells; Personal only day cells.
    expect(headers.map((cell) => cell.attributes('colspan'))).toEqual([undefined, '2', '1'])
    expect(wrapper.findAll('tbody th[scope="row"]')).toHaveLength(7)
    expect(wrapper.find('tbody tr:nth-child(4) th').attributes('aria-current')).toBe('date')
    // A piece of the block in each of its days, Tuesday to Thursday; the first holds the title.
    const pieces = wrapper.findAll('td[data-event-id="offsite"]')
    expect(pieces).toHaveLength(3)
    expect(
      pieces.map((piece) => piece.element.parentElement?.querySelector('th')?.textContent),
    ).toEqual([
      expect.stringContaining('27'),
      expect.stringContaining('28'),
      expect.stringContaining('29'),
    ])
    expect(pieces[0]!.text()).toContain('Offsite')
    expect(pieces[1]!.text()).toBe('')
    expect(pieces[0]!.classes()).toContain('split-columns__span--start')
    expect(pieces[2]!.classes()).toContain('split-columns__span--end')
    expect(wrapper.find('td[rowspan]').exists()).toBe(false)
    // On the other days Team is not split: its day cell takes the lane's width too.
    const teamDay = (date: string) =>
      wrapper.find(`td.split-columns__day[data-calendar-id="a"][data-date="${date}"]`)
    expect(teamDay('2026-10-26').attributes('colspan')).toBe('2')
    expect(teamDay('2026-10-28').attributes('colspan')).toBe('1')
    expect(wrapper.findAll('td.split-columns__lane[data-calendar-id="a"]')).toHaveLength(0)
  })

  it("wears the theme's classes and the entry's colours", () => {
    const wrapper = mountTable(bands())
    const theme = themeClass('blockEventClass', {}).split(' ')[0]!
    expect(theme).toMatch(/^fc-/)
    const entry = wrapper.find('.split-columns__entry')
    expect(entry.classes()).toContain(theme)
    expect(entry.attributes('style')).toContain('--fc-event-color: #1d4ed8')
    expect(wrapper.find('.split-columns__span').classes()).toContain(theme)
    // The time is bold, as on the timeline: the theme's class for the time of a row event.
    const bold = themeClass('rowEventTimeClass', {})
    expect(bold).toMatch(/^fc-/)
    expect(entry.find('[aria-hidden="true"] > span').classes()).toEqual(
      expect.arrayContaining(bold.split(' ')),
    )
  })

  it('opens an entry and asks for a new one in an empty part of a day', async () => {
    const wrapper = mountTable(bands())
    const dentist = wrapper
      .findAll('.split-columns__entry')
      .find((item) => item.text().includes('Dentist'))!
    await dentist.trigger('click')
    await wrapper.find('.split-columns__span').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['dentist'], ['offsite']])

    await wrapper
      .find('td.split-columns__day[data-calendar-id="b"][data-date="2026-10-30"]')
      .trigger('click')
    expect(wrapper.emitted('create')).toEqual([
      [{ start: '2026-10-30', end: '2026-10-31', allDay: true, calendarId: 'b' }],
    ])
  })

  it('names every entry for assistive technology and hides the visible text from it', () => {
    const wrapper = mountTable(bands())
    for (const button of wrapper.findAll('button')) {
      expect(button.find('.sr-only').text().length).toBeGreaterThan(0)
      expect(button.find('[aria-hidden="true"]').exists()).toBe(true)
    }
  })
})
