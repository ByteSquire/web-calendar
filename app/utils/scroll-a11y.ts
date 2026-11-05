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

/** Marks a tab stop this module set, so that it can take it away again. */
const MARK = 'data-scroll-tab-stop'

/**
 * Make every scrolling region below `root` reachable by keyboard; returns how many it changed. A tab
 * stop it set earlier goes again once the region no longer needs one: it holds something focusable
 * by now (events that arrived after the grid was drawn) or no longer scrolls. Otherwise the grid of
 * a day keeps a second tab stop, inside FullCalendar's rows where its markup allows none.
 */
export function makeScrollersFocusable(root: HTMLElement): number {
  let changed = 0
  for (const element of root.querySelectorAll<HTMLElement>(`[${MARK}]`)) {
    if (!element.querySelector(FOCUSABLE) && scrollsByItself(element)) continue
    element.removeAttribute('tabindex')
    element.removeAttribute(MARK)
    changed += 1
  }
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.hasAttribute('tabindex') || element.querySelector(FOCUSABLE)) continue
    if (!scrollsByItself(element)) continue
    element.setAttribute('tabindex', '0')
    element.setAttribute(MARK, '')
    changed += 1
  }
  return changed
}
