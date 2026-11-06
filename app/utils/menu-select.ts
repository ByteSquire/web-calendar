// A menu item that opens a dialog, chosen by touch. The menu (Reka UI) takes the item when the
// finger lifts (pointerup) and closes; the browser then still sends the mouse events and the click
// of that tap, at the same place, so they land on whatever is there now: a colour or a button of the
// dialog that just opened, or a row of the sidebar behind the closed menu. Found by
// e2e/sidebar-menus.spec.ts (the colour under the finger was chosen; a Delete under it would have
// been pressed). So an item chosen by a pointer runs after that click, which is swallowed; one chosen
// by a mouse click or the keyboard runs at once.
import type { DropdownMenuItem } from '@nuxt/ui'

/** Longest wait for the click of the tap; a browser that sends none opens the dialog after it. */
const TAP_CLICK_WAIT_MS = 500

let lastInput: 'pointer' | 'keyboard' = 'keyboard'
let listening = false

function listen(): void {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('pointerdown', () => (lastInput = 'pointer'), true)
  document.addEventListener('keydown', () => (lastInput = 'keyboard'), true)
}

/** Runs `work` once the gesture that chose a menu item is over (see the top of this file). */
export function afterMenuGesture(work: () => void): void {
  listen()
  const current = typeof window === 'undefined' ? undefined : window.event
  // Chosen by a real click (a mouse), or by the keyboard: nothing of the gesture is left to come.
  if (lastInput !== 'pointer' || (current?.type === 'click' && current.isTrusted)) {
    work()
    return
  }
  const swallowed = ['mousedown', 'mouseup', 'click'] as const
  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    for (const type of swallowed) document.removeEventListener(type, swallow, true)
    work()
  }
  const swallow = (event: Event) => {
    if (!event.isTrusted) return
    event.preventDefault()
    event.stopPropagation()
    // After the click has been dealt with, so the dialog never sees it.
    if (event.type === 'click') setTimeout(finish, 0)
  }
  const timer = setTimeout(finish, TAP_CLICK_WAIT_MS)
  for (const type of swallowed) document.addEventListener(type, swallow, true)
}

/**
 * The items with every `onSelect` run after the gesture that chose it (`afterMenuGesture`). Called
 * while the menu renders, which also starts telling a pointer from the keyboard: that has to be
 * known from the pointerdown of the tap on, before the item is chosen.
 */
export function settledMenuItems(groups: DropdownMenuItem[][]): DropdownMenuItem[][] {
  listen()
  return groups.map((group) =>
    group.map((item) => {
      const select = item.onSelect
      return select
        ? { ...item, onSelect: (event: Event) => afterMenuGesture(() => select(event)) }
        : item
    }),
  )
}
