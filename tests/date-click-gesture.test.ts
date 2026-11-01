import { describe, expect, it, vi } from 'vitest'
import { useDateClickGesture } from '../app/composables/useDateClickGesture'

// FullCalendar reports a date hit after the click it belongs to, and an event or a day number from
// the click itself; a tap next to a card can arrive as a click on the card. Nothing may open twice.

function click(target: Element) {
  return { target } as unknown as MouseEvent
}

function cell() {
  return document.createElement('div')
}

function card() {
  const element = document.createElement('div')
  element.setAttribute('role', 'button')
  const inner = document.createElement('span')
  element.append(inner)
  return inner
}

describe('useDateClickGesture', () => {
  it('opens a date hit once the click has arrived, whichever comes first', () => {
    const open = vi.fn()
    const gesture = useDateClickGesture<string>(open)

    gesture.start()
    gesture.click(click(cell()))
    expect(open).not.toHaveBeenCalled()
    gesture.hit('first')
    expect(open).toHaveBeenCalledWith('first')

    gesture.start()
    gesture.hit('second')
    expect(open).toHaveBeenCalledTimes(1)
    gesture.click(click(cell()))
    expect(open).toHaveBeenCalledWith('second')
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('opens a hit only once', () => {
    const open = vi.fn()
    const gesture = useDateClickGesture<string>(open)
    gesture.start()
    gesture.hit('hit')
    gesture.click(click(cell()))
    gesture.click(click(cell()))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('opens nothing when an event or a day number claimed the click', () => {
    const open = vi.fn()
    const gesture = useDateClickGesture<string>(open)

    // The touch began in the cell, the click went to the card, the date hit came later.
    gesture.start()
    gesture.claim()
    gesture.click(click(cell()))
    gesture.hit('late')

    // The date hit came first, then the click was claimed.
    gesture.start()
    gesture.hit('early')
    gesture.claim()
    gesture.click(click(cell()))

    expect(open).not.toHaveBeenCalled()
  })

  it('opens nothing when the click is on a button, a link or inside one', () => {
    const open = vi.fn()
    const gesture = useDateClickGesture<string>(open)
    gesture.start()
    gesture.hit('hit')
    gesture.click(click(card()))
    expect(open).not.toHaveBeenCalled()
  })

  it('does not carry a hit or a claim into the next gesture', () => {
    const open = vi.fn()
    const gesture = useDateClickGesture<string>(open)
    gesture.start()
    gesture.claim()
    gesture.hit('old')
    gesture.start()
    gesture.click(click(cell()))
    expect(open).not.toHaveBeenCalled()
    gesture.hit('new')
    expect(open).toHaveBeenCalledWith('new')
  })

  it('opens nothing for a click without a date hit', () => {
    const open = vi.fn()
    const gesture = useDateClickGesture<string>(open)
    gesture.start()
    gesture.click(click(cell()))
    expect(open).not.toHaveBeenCalled()
  })
})
