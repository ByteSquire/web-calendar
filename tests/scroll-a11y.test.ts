import { describe, expect, it } from 'vitest'
import { makeScrollersFocusable } from '../app/utils/scroll-a11y'

function box(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}

function sizes(element: Element, size: { scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(element, 'scrollWidth', { value: size.scrollWidth, configurable: true })
  Object.defineProperty(element, 'clientWidth', { value: size.clientWidth, configurable: true })
}

describe('makeScrollersFocusable', () => {
  it('gives a sideways scrolling region a tab stop', () => {
    const root = box('<div id="s" style="overflow-x: auto"><span>text</span></div>')
    sizes(root.querySelector('#s')!, { scrollWidth: 500, clientWidth: 300 })

    expect(makeScrollersFocusable(root)).toBe(1)
    const scroller = root.querySelector('#s')!
    expect(scroller.getAttribute('tabindex')).toBe('0')
    expect(scroller.hasAttribute('role')).toBe(false)
  })

  it('leaves alone a region that does not overflow, one that is focusable, and one with focusable content', () => {
    const root = box(`
      <div id="fits" style="overflow-x: auto"></div>
      <div id="own" tabindex="-1" style="overflow-x: auto"></div>
      <div id="inner" style="overflow-x: auto"><button>go</button></div>
      <div id="visible"></div>`)
    sizes(root.querySelector('#fits')!, { scrollWidth: 300, clientWidth: 300 })
    sizes(root.querySelector('#own')!, { scrollWidth: 500, clientWidth: 300 })
    sizes(root.querySelector('#inner')!, { scrollWidth: 500, clientWidth: 300 })
    sizes(root.querySelector('#visible')!, { scrollWidth: 500, clientWidth: 300 })

    expect(makeScrollersFocusable(root)).toBe(0)
    expect(root.querySelector('#fits')!.hasAttribute('tabindex')).toBe(false)
    expect(root.querySelector('#own')!.getAttribute('tabindex')).toBe('-1')
    expect(root.querySelector('#inner')!.hasAttribute('tabindex')).toBe(false)
    expect(root.querySelector('#visible')!.hasAttribute('tabindex')).toBe(false)
  })

  it('takes its tab stop back once the region holds something focusable, or stops scrolling', () => {
    const root = box(`
      <div id="late" style="overflow-y: auto"><div id="slot"></div></div>
      <div id="shrinks" style="overflow-x: auto"></div>
      <div id="own" tabindex="0" style="overflow-x: auto"><button>go</button></div>`)
    const late = root.querySelector<HTMLElement>('#late')!
    Object.defineProperty(late, 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(late, 'clientHeight', { value: 300, configurable: true })
    sizes(root.querySelector('#shrinks')!, { scrollWidth: 500, clientWidth: 300 })
    expect(makeScrollersFocusable(root)).toBe(2)
    expect(late.getAttribute('tabindex')).toBe('0')

    // the events arrive after the grid was drawn
    root.querySelector('#slot')!.innerHTML = '<a href="#e">Planning</a>'
    sizes(root.querySelector('#shrinks')!, { scrollWidth: 300, clientWidth: 300 })
    expect(makeScrollersFocusable(root)).toBe(2)
    expect(late.hasAttribute('tabindex')).toBe(false)
    expect(root.querySelector('#shrinks')!.hasAttribute('tabindex')).toBe(false)
    // a tab stop it did not set stays
    expect(root.querySelector('#own')!.getAttribute('tabindex')).toBe('0')
  })

  it('does nothing twice', () => {
    const root = box('<div id="s" style="overflow-x: scroll"></div>')
    sizes(root.querySelector('#s')!, { scrollWidth: 500, clientWidth: 300 })
    expect(makeScrollersFocusable(root)).toBe(1)
    expect(makeScrollersFocusable(root)).toBe(0)
  })
})
