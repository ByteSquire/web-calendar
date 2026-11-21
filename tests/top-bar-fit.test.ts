// "Add" in the top bar shows only its plus when the one-row bar runs short, and its label again
// once there is room for it (app/utils/top-bar-fit.ts).
import { describe, expect, it } from 'vitest'
import { ADD_LABEL_SHOWN, contentWidth, fitAddLabel } from '../app/utils/top-bar-fit'

const oneRow = (slack: number, buttonWidth: number) => ({ oneRow: true, slack, buttonWidth })

describe('fitAddLabel', () => {
  it('keeps the label while the strip fits, counting a part of a pixel as fitting', () => {
    expect(fitAddLabel(ADD_LABEL_SHOWN, oneRow(0, 73))).toBe(ADD_LABEL_SHOWN)
    expect(fitAddLabel(ADD_LABEL_SHOWN, oneRow(-0.4, 73))).toBe(ADD_LABEL_SHOWN)
  })

  it('drops the label when the strip would scroll, and remembers how wide "Add" was', () => {
    expect(fitAddLabel(ADD_LABEL_SHOWN, oneRow(-4, 126))).toEqual({
      compact: true,
      labeledWidth: 126,
    })
  })

  it('takes the label back only when the strip still fits beside it', () => {
    const compact = { compact: true, labeledWidth: 126 }
    // the label needs 82 px more than the plus (126 - 44)
    expect(fitAddLabel(compact, oneRow(81, 44))).toBe(compact)
    expect(fitAddLabel(compact, oneRow(82, 44))).toEqual(ADD_LABEL_SHOWN)
    // still short with the plus alone: it stays a plus, and the strip scrolls
    expect(fitAddLabel(compact, oneRow(-5, 44))).toBe(compact)
  })

  it('shows the label in two rows, where the strip scrolls on its own row', () => {
    const compact = { compact: true, labeledWidth: 126 }
    expect(fitAddLabel(compact, { oneRow: false, slack: -200, buttonWidth: 44 })).toEqual(
      ADD_LABEL_SHOWN,
    )
    expect(fitAddLabel(ADD_LABEL_SHOWN, { oneRow: false, slack: -200, buttonWidth: 73 })).toBe(
      ADD_LABEL_SHOWN,
    )
  })
})

describe('contentWidth', () => {
  const box = (left: number, right: number) =>
    ({ getBoundingClientRect: () => ({ left, right }) }) as unknown as Element

  it('spans the children from the leftmost edge to the rightmost, gaps included', () => {
    const strip = { children: [box(10, 200), box(212, 640)] } as unknown as HTMLElement
    expect(contentWidth(strip)).toBe(630)
  })

  it('is nothing for a strip without children', () => {
    expect(contentWidth({ children: [] } as unknown as HTMLElement)).toBe(0)
  })
})
