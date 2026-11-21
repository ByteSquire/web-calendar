// Whether "Add" in the top bar shows its label or only its plus (design §9). From 1024 px the date
// navigation and the view switcher share one row with the buttons, and that row can run short:
// at a large zoom or display scaling, with a longer language, or with a long period label. Then
// "Add" gives up its label first, as it does on a phone, and only when the plus alone is still too
// wide does the strip scroll sideways. The label comes back once the room it needs is there.
// Pure functions without Vue; TopBar.vue measures and calls them.

export interface AddLabelFit {
  /** "Add" shows only its icon. */
  compact: boolean
  /** The width of "Add" with its label, measured when it was last made compact. */
  labeledWidth: number
}

export interface TopBarMeasure {
  /** The strip shares the row with the buttons (from 1024 px); below that it has a row of its own. */
  oneRow: boolean
  /** The strip's width less the width of its content: negative when it has to scroll. */
  slack: number
  /** The width of "Add" as it is drawn now. */
  buttonWidth: number
}

export const ADD_LABEL_SHOWN: AddLabelFit = { compact: false, labeledWidth: 0 }

/** Rounding of the layout: a strip that is short by less than this still counts as fitting. */
const TOLERANCE = 0.5

/** The next state of "Add" for what the top bar measures now. */
export function fitAddLabel(fit: AddLabelFit, measure: TopBarMeasure): AddLabelFit {
  // Two rows: the strip scrolls on its own row, and the label has its own rules (CSS).
  if (!measure.oneRow) return fit.compact ? ADD_LABEL_SHOWN : fit
  if (!fit.compact) {
    return measure.slack < -TOLERANCE ? { compact: true, labeledWidth: measure.buttonWidth } : fit
  }
  // The label takes back what it gave: only when the strip would still fit beside it, so it does
  // not show and hide by turns.
  return measure.slack >= fit.labeledWidth - measure.buttonWidth ? ADD_LABEL_SHOWN : fit
}

/** The width the children of `strip` take up, gaps included (they keep their own width). */
export function contentWidth(strip: HTMLElement): number {
  const boxes = [...strip.children].map((child) => child.getBoundingClientRect())
  if (boxes.length === 0) return 0
  return Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.left))
}
