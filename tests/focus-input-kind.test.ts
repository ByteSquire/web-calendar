import { beforeEach, describe, expect, it, vi } from 'vitest'

// Whether a dialog focuses a control follows how the page was last used (utils/focus.ts), with the
// device's media query only as the answer before any input.

let touchFirst = false
let keepFocusOffControlsOnTouch: (event: Event) => boolean

beforeEach(async () => {
  vi.resetModules()
  touchFirst = false
  window.matchMedia = ((query: string) => ({
    matches: query.includes('pointer: coarse') ? touchFirst : false,
  })) as typeof window.matchMedia
  const focus = await import('../app/utils/focus')
  focus.trackInputKind()
  keepFocusOffControlsOnTouch = focus.keepFocusOffControlsOnTouch
})

function pointer(pointerType: string) {
  window.dispatchEvent(new PointerEvent('pointerdown', { pointerType, bubbles: true }))
}

/** Opens a dialog the way Reka UI does: an event on its content element. */
function open() {
  const content = document.createElement('div')
  content.tabIndex = -1
  document.body.append(content)
  const event = new Event('focusScope.autoFocusOnMount', { cancelable: true })
  let handled = false
  content.addEventListener(event.type, (e) => {
    handled = keepFocusOffControlsOnTouch(e)
  })
  content.dispatchEvent(event)
  const result = {
    handled,
    prevented: event.defaultPrevented,
    focused: document.activeElement === content,
  }
  content.remove()
  return result
}

describe('keepFocusOffControlsOnTouch', () => {
  it('asks the device before any input', () => {
    expect(open().handled).toBe(false)
    touchFirst = true
    expect(open()).toEqual({ handled: true, prevented: true, focused: true })
  })

  it('keeps focus off the controls after a touch, even if the media query says otherwise', () => {
    pointer('touch')
    expect(open()).toEqual({ handled: true, prevented: true, focused: true })
  })

  it('leaves the focus to the dialog after a mouse click, even on a touch device', () => {
    touchFirst = true
    pointer('mouse')
    expect(open()).toEqual({ handled: false, prevented: false, focused: false })
  })

  it('leaves the focus to the dialog after the keyboard', () => {
    pointer('touch')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(open().handled).toBe(false)
  })

  it('follows the latest input', () => {
    pointer('mouse')
    expect(open().handled).toBe(false)
    pointer('touch')
    expect(open().handled).toBe(true)
  })
})
