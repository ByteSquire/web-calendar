import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'
import {
  rangeKindOf,
  VIEW_TYPES,
  visibleRangeFor,
  type ViewType,
} from '../app/utils/calendar-state'
import { fixture, lines, range, read } from './ical-read-helpers'

// Recurrence in every view type (FR-28: "in every view type"). The reader gets the range a view
// asks for, so this runs the weekly series of `a-weekly.ics` (Mondays 09:00 Berlin; 2 Nov is an
// EXDATE, 26 Oct is moved to 14:00) through the range of each of the seven view types.

const ics = fixture('a-weekly.ics')

/** The instants a view type asks the reader for, as the loader derives them from the date range. */
function rangeOf(viewType: ViewType, anchor: string, splitSpan: 'week' | 'month' = 'week') {
  const { start, end } = visibleRangeFor(
    rangeKindOf(viewType, splitSpan),
    Temporal.PlainDate.from(anchor),
  )
  return range(`${start.toString()}T00:00:00Z`, `${end.toString()}T00:00:00Z`)
}

const shown = (viewType: ViewType, anchor: string, splitSpan: 'week' | 'month' = 'week') =>
  lines(read(ics, { range: rangeOf(viewType, anchor, splitSpan) }).events)

describe('a recurring series in each view type', () => {
  it('covers all seven view types', () => {
    expect([...VIEW_TYPES].sort()).toEqual([
      '5day',
      'day',
      'list',
      'month',
      'split',
      'week',
      'year',
    ])
  })

  it('day: the occurrence on its day, the moved one on its new day, nothing on a plain day', () => {
    expect(shown('day', '2026-10-19')).toEqual([
      '2026-10-19T09:00:00 - 2026-10-19T10:00:00 A weekly',
    ])
    expect(shown('day', '2026-10-26')).toEqual([
      '2026-10-26T14:00:00 - 2026-10-26T15:00:00 A weekly (moved)',
    ])
    expect(shown('day', '2026-10-28')).toEqual([])
  })

  it('day: a cancelled occurrence (EXDATE) is not shown', () => {
    expect(shown('day', '2026-11-02')).toEqual([])
    expect(shown('day', '2026-11-09')).toHaveLength(1)
  })

  it('5day: starts at the anchor and takes the Monday it reaches, the moved one included', () => {
    expect(shown('5day', '2026-10-23')).toEqual([
      '2026-10-26T14:00:00 - 2026-10-26T15:00:00 A weekly (moved)',
    ])
    // 29 Oct to 2 Nov: 2 Nov is the cancelled Monday and falls outside the five days anyway.
    expect(shown('5day', '2026-10-29')).toEqual([])
  })

  it('week and list (the list shows a week): Monday to Sunday around the anchor', () => {
    const week = ['2026-10-26T14:00:00 - 2026-10-26T15:00:00 A weekly (moved)']
    expect(shown('week', '2026-10-28')).toEqual(week)
    expect(shown('list', '2026-10-28')).toEqual(week)
    expect(shown('week', '2026-11-04')).toEqual([]) // the week of the cancelled 2 Nov: none
  })

  it('month: every occurrence of the month, moved ones moved, cancelled ones absent', () => {
    expect(shown('month', '2026-10-28')).toEqual([
      '2026-10-12T09:00:00 - 2026-10-12T10:00:00 A weekly',
      '2026-10-19T09:00:00 - 2026-10-19T10:00:00 A weekly',
      '2026-10-26T14:00:00 - 2026-10-26T15:00:00 A weekly (moved)',
    ])
    expect(shown('month', '2026-11-15')).toEqual([
      '2026-11-09T09:00:00 - 2026-11-09T10:00:00 A weekly',
      '2026-11-16T09:00:00 - 2026-11-16T10:00:00 A weekly',
      '2026-11-23T09:00:00 - 2026-11-23T10:00:00 A weekly',
      '2026-11-30T09:00:00 - 2026-11-30T10:00:00 A weekly',
    ])
  })

  it('year: the whole series in one range, with its exception and its cancellation', () => {
    const year = shown('year', '2026-06-01')
    expect(year).toHaveLength(7)
    expect(year).toContain('2026-10-26T14:00:00 - 2026-10-26T15:00:00 A weekly (moved)')
    expect(year.join('\n')).not.toContain('2026-11-02')
    expect(year.join('\n')).not.toContain('2026-10-26T09:00:00')
  })

  it('split: the band of a week and of a month show the same occurrences as week and month', () => {
    expect(shown('split', '2026-10-28', 'week')).toEqual(shown('week', '2026-10-28'))
    expect(shown('split', '2026-10-28', 'month')).toEqual(shown('month', '2026-10-28'))
  })
})
