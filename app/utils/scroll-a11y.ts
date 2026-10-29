// A region that scrolls needs a way in for keyboard users (WCAG 2.1.1; axe rule
// scrollable-region-focusable). FullCalendar's panning day columns scroll sideways without one, so
// they get `tabindex="0"` once they exist. No role or name is added: FullCalendar's grid markup
// does not allow an extra group between its rows and cells.

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]'

/** Whether the element scrolls on its own (an overflow of `auto` or `scroll` that is used). */
export function scrollsByItself(element: HTMLElement): boolean {
  const style = getComputedStyle(element)
  const x =
    (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
    element.scrollWidth > element.clientWidth + 1
  const y =
    (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
    element.scrollHeight > element.clientHeight + 1
  return x || y
}

/** Make every scrolling region below `root` reachable by keyboard; returns how many it changed. */
export function makeScrollersFocusable(root: HTMLElement): number {
  let changed = 0
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.hasAttribute('tabindex') || element.querySelector(FOCUSABLE)) continue
    if (!scrollsByItself(element)) continue
    element.setAttribute('tabindex', '0')
    changed += 1
  }
  return changed
}
