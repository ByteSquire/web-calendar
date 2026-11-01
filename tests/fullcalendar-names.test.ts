import { describe, expect, it } from 'vitest'
import { BASE_CALENDAR_OPTIONS, navLinkName, nameDayHeader } from '../app/utils/fullcalendar'

// Accessible names of date links (WCAG 2.5.3, Label in Name): the name holds the text on screen.

describe('navLinkName', () => {
  it('names a month title after the month on screen, not after its ISO date', () => {
    expect(navLinkName('2026-09')).toBe('Go to September 2026')
    expect(navLinkName('2026-01')).toBe('Go to January 2026')
    expect(navLinkName('2026-12')).toBe('Go to December 2026')
  })

  it('holds the short month a month title shows ("Sep")', () => {
    for (let month = 1; month <= 12; month += 1) {
      const name = navLinkName(`2026-${String(month).padStart(2, '0')}`)
      const short = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2026, month - 1, 1)),
      )
      // "Sept" in en-GB is longer than "Sep": the name starts with the three letters either way.
      expect(name.toLowerCase()).toContain(short.slice(0, 3).toLowerCase())
    }
  })

  it('does not depend on the time zone of the machine', () => {
    expect(navLinkName('2026-03')).toBe('Go to March 2026')
  })

  it('keeps FullCalendar\'s wording for everything else: "Go to <the text it gave>"', () => {
    expect(navLinkName('26 October 2026')).toBe('Go to 26 October 2026')
    expect(navLinkName('Week 44')).toBe('Go to Week 44')
  })

  it('is what the calendar uses', () => {
    expect(BASE_CALENDAR_OPTIONS.navLinkHint).toBe(navLinkName)
  })
})

describe('nameDayHeader', () => {
  function cell(html: string): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = html
    return host.firstElementChild as HTMLElement
  }

  it('starts the name of the link with the text on screen', () => {
    const header = cell('<div><div role="link" aria-label="26 October 2026">Mon 26</div></div>')
    nameDayHeader(header)
    expect(header.querySelector('[role=link]')!.getAttribute('aria-label')).toBe(
      'Mon 26, 26 October 2026',
    )
  })

  it('also names the cell itself when the label is on it', () => {
    const header = cell('<div role="link" aria-label="26 October 2026">Mon 26</div>')
    nameDayHeader(header)
    expect(header.getAttribute('aria-label')).toBe('Mon 26, 26 October 2026')
  })

  it('leaves a name alone that already holds the text on screen, and never repeats itself', () => {
    const header = cell(
      '<div><div role="link" aria-label="Mon 26, 26 October 2026">Mon 26</div></div>',
    )
    nameDayHeader(header)
    nameDayHeader(header)
    expect(header.querySelector('[role=link]')!.getAttribute('aria-label')).toBe(
      'Mon 26, 26 October 2026',
    )
  })

  it('uses the text on screen whatever its format, spaces collapsed', () => {
    const header = cell(
      '<div><div role="link" aria-label="26 octobre 2026">lun.\n   26</div></div>',
    )
    nameDayHeader(header)
    expect(header.querySelector('[role=link]')!.getAttribute('aria-label')).toBe(
      'lun. 26, 26 octobre 2026',
    )
  })

  it('does nothing without a link, without a name or without text', () => {
    const none = cell('<div><span>Mon 26</span></div>')
    expect(() => nameDayHeader(none)).not.toThrow()
    const unnamed = cell('<div><div role="link">Mon 26</div></div>')
    nameDayHeader(unnamed)
    expect(unnamed.querySelector('[role=link]')!.hasAttribute('aria-label')).toBe(false)
    const empty = cell('<div><div role="link" aria-label="26 October 2026"> </div></div>')
    nameDayHeader(empty)
    expect(empty.querySelector('[role=link]')!.getAttribute('aria-label')).toBe('26 October 2026')
  })

  it('is what the calendar calls when a day header is mounted', () => {
    const header = cell('<div><div role="link" aria-label="26 October 2026">Mon 26</div></div>')
    ;(BASE_CALENDAR_OPTIONS.dayHeaderDidMount as (arg: { el: HTMLElement }) => void)({ el: header })
    expect(header.querySelector('[role=link]')!.getAttribute('aria-label')).toBe(
      'Mon 26, 26 October 2026',
    )
  })
})
