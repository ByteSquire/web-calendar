// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { SidebarContent, UApp } from '#components'
import {
  SIDEBAR_CLOSED_KEY,
  readClosedSections,
  toggleSection,
  writeClosedSections,
} from '~/utils/sidebar-sections'

// The sections of the sidebar fold away (FR-21) and the browser remembers which.

function store(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[SIDEBAR_CLOSED_KEY, initial]])
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

describe('the stored list of closed sections', () => {
  it('is empty when nothing is stored, without a store, or when the value is not a list', () => {
    expect(readClosedSections(store())).toEqual([])
    expect(readClosedSections(null)).toEqual([])
    expect(readClosedSections(store('not json'))).toEqual([])
    expect(readClosedSections(store('{"a":1}'))).toEqual([])
  })

  it('keeps the text entries once each', () => {
    expect(readClosedSections(store('["Views", 3, null, "Views", "Filters"]'))).toEqual([
      'Views',
      'Filters',
    ])
  })

  it('writes the list, and does not throw when the store refuses', () => {
    const target = store()
    writeClosedSections(target, ['Views'])
    expect(target.data.get(SIDEBAR_CLOSED_KEY)).toBe('["Views"]')
    expect(() =>
      writeClosedSections(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error('full')
          },
        },
        ['Views'],
      ),
    ).not.toThrow()
  })

  it('closes an open section and opens a closed one', () => {
    expect(toggleSection([], 'Views')).toEqual(['Views'])
    expect(toggleSection(['Views', 'Filters'], 'Views')).toEqual(['Filters'])
  })
})

describe('SidebarContent', () => {
  const mounted: { unmount: () => void }[] = []
  const Shell = defineComponent({
    render: () => h(UApp, null, { default: () => h(SidebarContent) }),
  })

  beforeEach(() => window.localStorage.removeItem(SIDEBAR_CLOSED_KEY))
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    clearNuxtState((key) => key !== 'color-mode')
    window.localStorage.removeItem(SIDEBAR_CLOSED_KEY)
  })

  const headingButton = (title: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('h2 button')].find(
      (item) => item.textContent?.trim() === title,
    )!
  const body = (title: string) =>
    document.getElementById(headingButton(title).getAttribute('aria-controls')!)!
  const mount = async () => mounted.push(await mountSuspended(Shell, { attachTo: document.body }))

  it('gives every section a heading button, open to start with', async () => {
    await mount()
    for (const title of ['Views', 'Calendars', 'Resources', 'Categories', 'Filters']) {
      const button = headingButton(title)
      expect(button, title).toBeDefined()
      expect(button.getAttribute('aria-expanded')).toBe('true')
      expect(body(title).style.display).not.toBe('none')
    }
  })

  it('folds a section away and back, and the others stay as they are', async () => {
    await mount()
    headingButton('Categories').click()
    await vi.waitFor(() => expect(body('Categories').style.display).toBe('none'))
    expect(headingButton('Categories').getAttribute('aria-expanded')).toBe('false')
    expect(headingButton('Filters').getAttribute('aria-expanded')).toBe('true')
    // the content is hidden, not removed
    expect(body('Categories').querySelector('ul')).not.toBeNull()
    headingButton('Categories').click()
    await vi.waitFor(() => expect(body('Categories').style.display).not.toBe('none'))
    expect(headingButton('Categories').getAttribute('aria-expanded')).toBe('true')
  })

  it('remembers the closed sections for the next time the sidebar is shown', async () => {
    await mount()
    headingButton('Resources').click()
    headingButton('Views').click()
    await vi.waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(SIDEBAR_CLOSED_KEY)!)).toEqual([
        'Resources',
        'Views',
      ]),
    )
    mounted.pop()!.unmount()
    document.body.innerHTML = ''
    clearNuxtState((key) => key !== 'color-mode')
    await mount()
    expect(headingButton('Resources').getAttribute('aria-expanded')).toBe('false')
    expect(headingButton('Views').getAttribute('aria-expanded')).toBe('false')
    expect(headingButton('Calendars').getAttribute('aria-expanded')).toBe('true')
  })
})
