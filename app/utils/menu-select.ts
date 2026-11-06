// One choice per click or tap in a dropdown menu. The menu (Reka UI) takes an item when the button
// or the finger lifts (pointerup, with a click of its own), and the browser then still sends the
// rest of that gesture to the same place: the click, and on a touch screen the mouse events before
// it. Found by the browser tests:
// - the click chose the item a second time, so an on/off item ("Category colours on events")
//   switched on and straight off again (e2e/category-colours.spec.ts);
// - on a touch screen the rest landed on whatever was there once the menu had closed: a colour of
//   the dialog that had just opened was chosen, and a Delete under the finger would have been
//   pressed (e2e/sidebar-menus.spec.ts).
// So when an item is chosen by a pointer and not by that click itself, its action runs at once (an
// item may still keep the menu open with `preventDefault`) and what is left of the gesture is
// swallowed. An item chosen by the click itself or by the keyboard has nothing left to come.
import type { DropdownMenuItem } from '@nuxt/ui'

/** Longest wait for the rest of the gesture; a browser that sends none is not waited for longer. */
const GESTURE_REST_MS = 500

let lastInput: 'pointer' | 'keyboard' = 'keyboard'
let listening = false

function listen(): void {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('pointerdown', () => (lastInput = 'pointer'), true)
  document.addEventListener('keydown', () => (lastInput = 'keyboard'), true)
}

/** Swallows the rest of the gesture that chose a menu item, if any is to come (see above). */
export function endMenuGesture(): void {
  listen()
  const current = typeof window === 'undefined' ? undefined : window.event
  // Chosen by a real click, or by the keyboard: nothing of the gesture is left to come.
  if (lastInput !== 'pointer' || (current?.type === 'click' && current.isTrusted)) return
  const swallowed = ['mousedown', 'mouseup', 'click'] as const
  let done = false
  const stop = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    for (const type of swallowed) document.removeEventListener(type, swallow, true)
    document.removeEventListener('pointerdown', stop, true)
  }
  const swallow = (event: Event) => {
    if (!event.isTrusted) return
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'click') stop()
  }
  // Not every browser sends the rest (WebKit may not, a removed target gets no click): the next
  // pointerdown is a new gesture, never part of this one, so it ends the wait and is not touched.
  const timer = setTimeout(stop, GESTURE_REST_MS)
  for (const type of swallowed) document.addEventListener(type, swallow, true)
  document.addEventListener('pointerdown', stop, true)
}

/**
 * The items, each chosen once per click or tap (`endMenuGesture`), links included. Called while the
 * menu renders, which also starts telling a pointer from the keyboard: that has to be known from
 * the pointerdown of the gesture on, before the item is chosen.
 */
export function settledMenuItems(groups: DropdownMenuItem[][]): DropdownMenuItem[][] {
  listen()
  return groups.map((group) =>
    group.map((item) => {
      // A heading is never chosen; a link is, and its new page must not take the rest either.
      if (item.type === 'label') return item
      const select = item.onSelect
      return {
        ...item,
        onSelect: (event: Event) => {
          endMenuGesture()
          select?.(event)
        },
      }
    }),
  )
}
