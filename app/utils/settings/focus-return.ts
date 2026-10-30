// Focus for dialogs without a trigger element (utils/focus.ts explains why): remember what had
// focus when the dialog opened and put it back when the dialog closes. When that element is gone
// (the row it belonged to was removed) the fallback takes it, so keyboard users do not land on
// the page body.
import { pickFocusTarget } from '../focus'

export interface FocusReturn {
  /** Call when the dialog opens. */
  remember: () => void
  /** For Reka UI's `onCloseAutoFocus`. */
  restore: (event: Event) => void
}

export function createFocusReturn(fallback: () => HTMLElement | null | undefined): FocusReturn {
  let opener: HTMLElement | null = null
  return {
    remember() {
      const active = document.activeElement
      // Safari does not focus a button when it is tapped, so the body is "active": that is no
      // place to return to, the fallback is better.
      opener =
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement
          ? active
          : null
    },
    restore(event) {
      event.preventDefault()
      const target = pickFocusTarget(opener, fallback())
      opener = null
      target?.focus()
    },
  }
}
