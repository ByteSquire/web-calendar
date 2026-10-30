// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createFocusReturn } from '../app/utils/settings/focus-return'

// Where focus goes when a dialog without a trigger closes.
function setup() {
  document.body.innerHTML = '<button id="opener">Open</button><h2 id="heading" tabindex="-1">H</h2>'
  const opener = document.getElementById('opener')!
  const heading = document.getElementById('heading')!
  const back = createFocusReturn(() => heading)
  const close = () => {
    const event = new Event('focus-return', { cancelable: true })
    back.restore(event)
    return event
  }
  return { opener, heading, back, close }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('createFocusReturn', () => {
  it('puts focus back on the element that had it', () => {
    const { opener, back, close } = setup()
    opener.focus()
    back.remember()
    document.body.focus()
    const event = close()
    expect(document.activeElement).toBe(opener)
    // it replaces Reka UI's own handling, which would find no trigger
    expect(event.defaultPrevented).toBe(true)
  })

  it('uses the fallback when the element is gone', () => {
    const { opener, heading, back, close } = setup()
    opener.focus()
    back.remember()
    opener.remove()
    close()
    expect(document.activeElement).toBe(heading)
  })

  it('uses the fallback when nothing had focus, as after a tap in Safari (the body is active)', () => {
    const { heading, back, close } = setup()
    expect(document.activeElement).toBe(document.body)
    back.remember()
    close()
    expect(document.activeElement).toBe(heading)
  })

  it('forgets the element after one use', () => {
    const { opener, heading, back, close } = setup()
    opener.focus()
    back.remember()
    close()
    expect(document.activeElement).toBe(opener)
    // a second close without a new open goes to the fallback, not to a stale element
    close()
    expect(document.activeElement).toBe(heading)
  })

  it('does nothing when there is no fallback either', () => {
    document.body.innerHTML = ''
    const back = createFocusReturn(() => null)
    back.remember()
    expect(() => back.restore(new Event('x', { cancelable: true }))).not.toThrow()
  })
})
