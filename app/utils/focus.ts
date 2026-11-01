// Focus restoration for dialogs that are opened without a trigger element. Reka UI only restores
// focus to a DialogTrigger, so the event sheet remembers the element that was active when it opened.

/** The opener while it is still in the document, else the fallback (for example a container). */
export function pickFocusTarget<T extends { isConnected: boolean }>(
  opener: T | null | undefined,
  fallback: T | null | undefined,
): T | null {
  if (opener?.isConnected) return opener
  return fallback?.isConnected ? fallback : null
}

/** A touch screen as the main input: no hover and a coarse pointer, as on a phone. */
const TOUCH_FIRST = '(hover: none) and (pointer: coarse)'

type InputKind = 'touch' | 'other'
let lastInput: InputKind | null = null

/**
 * Remembers how the person last used the page, touch or something else (mouse, pen, keyboard).
 * Browsers differ in what the media query above says, so the input that opened a dialog is the
 * better evidence. Called once at start (plugins/input-kind.client.ts).
 */
export function trackInputKind(): void {
  window.addEventListener(
    'pointerdown',
    (event) => {
      lastInput = event.pointerType === 'touch' ? 'touch' : 'other'
    },
    { capture: true, passive: true },
  )
  window.addEventListener(
    'keydown',
    () => {
      lastInput = 'other'
    },
    { capture: true, passive: true },
  )
}

/** Whether the person is using touch: the last input, or before any input the device's own say. */
function usingTouch(): boolean {
  if (lastInput !== null) return lastInput === 'touch'
  return window.matchMedia(TOUCH_FIRST).matches
}

/**
 * For Reka UI's `onOpenAutoFocus`: on a touch screen a dialog does not put the focus on one of its
 * controls. A text field would open the on-screen keyboard, and a button or radio would show a
 * focus ring under the finger. The dialog itself takes the focus instead, so the focus trap and a
 * connected keyboard still work: Tab goes to the first control. Returns true when it did, and the
 * caller then leaves its own choice of control alone.
 */
export function keepFocusOffControlsOnTouch(event: Event): boolean {
  if (typeof window === 'undefined' || !usingTouch()) return false
  event.preventDefault()
  if (event.target instanceof HTMLElement) event.target.focus({ preventScroll: true })
  return true
}
