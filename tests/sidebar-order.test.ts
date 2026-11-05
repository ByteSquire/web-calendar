import { describe, expect, it } from 'vitest'
import { dropIndex, reorderTo, sameOrder } from '../app/utils/sidebar-drag'
import {
  SIDEBAR_SECTION_IDS,
  completeSidebarOrder,
  moveSidebarSection,
} from '../shared/utils/sidebar-sections'

describe('completeSidebarOrder', () => {
  it('gives the default order for nothing, for something that is no list and for no known section', () => {
    for (const input of [undefined, null, 'views', {}, [], ['inbox', 3]]) {
      expect(completeSidebarOrder(input)).toEqual([...SIDEBAR_SECTION_IDS])
    }
  })

  it('keeps the order given and appends the missing sections in their default order', () => {
    expect(completeSidebarOrder(['filters', 'views'])).toEqual([
      'filters',
      'views',
      'calendars',
      'resources',
      'categories',
    ])
  })

  it('drops unknown entries and repeats', () => {
    expect(completeSidebarOrder(['views', 'gone', 'views', 'filters'])).toEqual([
      'views',
      'filters',
      'calendars',
      'resources',
      'categories',
    ])
  })
})

describe('moveSidebarSection', () => {
  const order = [...SIDEBAR_SECTION_IDS]

  it('moves a section one place up or down', () => {
    expect(moveSidebarSection(order, 'calendars', -1).slice(0, 2)).toEqual(['calendars', 'views'])
    expect(moveSidebarSection(order, 'views', 1).slice(0, 2)).toEqual(['calendars', 'views'])
  })

  it('leaves the order as it is at either end', () => {
    expect(moveSidebarSection(order, 'views', -1)).toEqual(order)
    expect(moveSidebarSection(order, 'filters', 1)).toEqual(order)
  })

  it('does not change the list it is given', () => {
    moveSidebarSection(order, 'calendars', -1)
    expect(order).toEqual([...SIDEBAR_SECTION_IDS])
  })
})

describe('dropIndex', () => {
  // Five headings of 44 px with a gap of 12 px, from y = 0.
  const boxes = Array.from({ length: 5 }, (_, index) => ({
    top: index * 56,
    bottom: index * 56 + 44,
  }))

  it('is the place whose heading the pointer is over', () => {
    expect(dropIndex(boxes, 0, 10)).toBe(0)
    expect(dropIndex(boxes, 0, 60)).toBe(1)
    expect(dropIndex(boxes, 3, 130)).toBe(2)
    expect(dropIndex(boxes, 0, 56 * 4 + 20)).toBe(4)
  })

  it('is the first place above the list and the last below it', () => {
    expect(dropIndex(boxes, 2, -30)).toBe(0)
    expect(dropIndex(boxes, 2, 500)).toBe(4)
  })

  it('changes nothing in the gap between two headings', () => {
    expect(dropIndex(boxes, 3, 50)).toBe(3)
  })

  it('changes nothing when there are no sections', () => {
    expect(dropIndex([], 0, 10)).toBe(0)
  })
})

describe('reorderTo', () => {
  const order = [...SIDEBAR_SECTION_IDS]

  it('takes a section out and puts it at the place', () => {
    expect(reorderTo(order, 'filters', 0)).toEqual([
      'filters',
      'views',
      'calendars',
      'resources',
      'categories',
    ])
    expect(reorderTo(order, 'views', 4)).toEqual([
      'calendars',
      'resources',
      'categories',
      'filters',
      'views',
    ])
  })

  it('keeps the place inside the list', () => {
    expect(reorderTo(order, 'views', 99).at(-1)).toBe('views')
    expect(reorderTo(order, 'filters', -3)[0]).toBe('filters')
  })

  it('is told by sameOrder to be the same when nothing moved', () => {
    expect(sameOrder(reorderTo(order, 'calendars', 1), order)).toBe(true)
    expect(sameOrder(reorderTo(order, 'calendars', 0), order)).toBe(false)
  })
})
