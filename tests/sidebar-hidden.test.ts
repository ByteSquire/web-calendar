// The keys of the items hidden from the sidebar (shared/utils/sidebar-hidden.ts).
import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_HIDDEN_KEY_MAX,
  SIDEBAR_HIDDEN_MAX,
  isSidebarHiddenKey,
  readSidebarHidden,
  sidebarHiddenKey,
  withSidebarHidden,
} from '../shared/utils/sidebar-hidden'

describe('sidebar hidden keys', () => {
  it('name an item by its kind and its id, which may hold colons and slashes', () => {
    const key = sidebarHiddenKey('calendar', 'dav:/caldav/sub/work/')
    expect(key).toBe('calendar:dav:/caldav/sub/work/')
    expect(isSidebarHiddenKey(key)).toBe(true)
  })

  it.each([
    ['an unknown kind', 'inbox:1'],
    ['no id', 'view:'],
    ['no kind', ':1'],
    ['no colon', 'view'],
    ['a control character', 'view:1\u0000'],
    ['too long', `view:${'x'.repeat(SIDEBAR_HIDDEN_KEY_MAX)}`],
    ['not a string', 1],
  ])('refuse %s', (_label, value) => {
    expect(isSidebarHiddenKey(value)).toBe(false)
  })

  it('read a stored list as its valid keys, once each, the newest at most', () => {
    expect(readSidebarHidden(['view:1', 'x', 'view:1', 'filter:2'])).toEqual(['view:1', 'filter:2'])
    expect(readSidebarHidden('view:1')).toEqual([])
    const many = Array.from({ length: SIDEBAR_HIDDEN_MAX + 2 }, (_, index) => `view:${index}`)
    const read = readSidebarHidden(many)
    expect(read).toHaveLength(SIDEBAR_HIDDEN_MAX)
    expect(read[0]).toBe('view:2')
  })

  it('hide at the end and show again by removing', () => {
    expect(withSidebarHidden(['view:1'], 'filter:2', true)).toEqual(['view:1', 'filter:2'])
    expect(withSidebarHidden(['view:1', 'filter:2'], 'view:1', true)).toEqual([
      'filter:2',
      'view:1',
    ])
    expect(withSidebarHidden(['view:1', 'filter:2'], 'view:1', false)).toEqual(['filter:2'])
  })
})
