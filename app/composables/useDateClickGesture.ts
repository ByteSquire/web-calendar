/** An element FullCalendar or the browser treats as its own click target, not as an empty cell. */
const OWN_CLICK_TARGET = 'a, button, [role="button"], [role="link"]'

/**
 * A tap or click in an empty cell opens quick-add. FullCalendar reports the date hit on its own
 * schedule: after the click, because it ends its pointer tracking in a timeout, but the order is
 * not guaranteed. An event or a day number is reported from the click itself. On a touch screen the
 * browser sends the click to a clickable element near the tap, such as an event card, while the
 * touch started in the cell, so a date hit alone must not open quick-add: the sheet would open
 * as well. The hit is opened once the click has arrived, in whichever order, and nothing else
 * claimed it. Opening it from the click also keeps the dialog from appearing under the finger
 * before the click arrives and landing on its controls.
 *
 * Wiring: `start` on the capture of `pointerdown` and `click` on the bubbling `click` of the
 * element around the calendar, `claim` from every FullCalendar callback that handles a click
 * itself (an event, a day number), and `hit` from `dateClick`.
 */
export function useDateClickGesture<Hit>(open: (hit: Hit) => void) {
  interface Gesture {
    clicked: boolean
    /** An event, day number or other control took the click. */
    claimed: boolean
    hit: Hit | null
  }
  let gesture: Gesture = { clicked: false, claimed: false, hit: null }

  function openForUnclaimedClick() {
    const { clicked, claimed, hit } = gesture
    if (hit === null || !clicked || claimed) return
    gesture.hit = null
    open(hit)
  }

  /** A new pointer gesture begins. */
  function start() {
    gesture = { clicked: false, claimed: false, hit: null }
  }

  /** Something other than an empty cell handles this click. */
  function claim() {
    gesture.claimed = true
  }

  /** FullCalendar reports a date hit. */
  function hit(value: Hit) {
    gesture.hit = value
    openForUnclaimedClick()
  }

  // The click bubbles up to the calendar's element after FullCalendar's handlers inside it have
  // run, so the callbacks that call `claim` have already claimed it.
  function click(event: MouseEvent) {
    gesture.clicked = true
    if (event.target instanceof Element && event.target.closest(OWN_CLICK_TARGET)) {
      gesture.claimed = true
    }
    openForUnclaimedClick()
  }

  return { start, claim, hit, click }
}
