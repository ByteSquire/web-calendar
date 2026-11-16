// The content of entries and row labels, made as DOM nodes so FullCalendar draws it at once.
import { describe, expect, it } from 'vitest'
import type { EventDisplayInfo } from '@fullcalendar/vue3'
import type { ResourceCellInfo } from '@fullcalendar/vue3-scheduler'
import {
  calendarEntryContent,
  splitEntryContent,
  splitLabelContent,
} from '../app/utils/entry-content'

function entry(extendedProps: Record<string, unknown>, timeText = '09:00–09:15') {
  return {
    event: { title: 'Standup', extendedProps },
    timeText,
    timeClass: 'time',
    titleClass: 'title',
  } as unknown as EventDisplayInfo
}

const html = (nodes: Node[]) => nodes.map((node) => (node as HTMLElement).outerHTML).join('')

describe('calendarEntryContent', () => {
  it('shows time and title to the eye and the label to assistive technology', () => {
    const { domNodes } = calendarEntryContent(
      entry({ kind: 'confirmed', label: 'Standup, 09:00 to 09:15, Personal', categoryColors: [] }),
      false,
    )
    expect(html(domNodes)).toBe(
      '<div class="time" aria-hidden="true">09:00–09:15</div>' +
        '<div class="title app-evt-title" aria-hidden="true">Standup</div>' +
        '<span class="sr-only">Standup, 09:00 to 09:15, Personal</span>',
    )
  })

  it('strikes out a cancelled entry, slants a tentative one and puts the category dots first', () => {
    const cancelled = calendarEntryContent(entry({ kind: 'cancelled' }, ''), false).domNodes
    expect((cancelled[0] as HTMLElement).className).toBe('title app-evt-title line-through')

    const tentative = calendarEntryContent(
      entry({ kind: 'tentative', categoryColors: ['#ff0000'] }),
      false,
    ).domNodes
    const title = tentative[1] as HTMLElement
    expect(title.className).toBe('title app-evt-title italic')
    expect(title.firstElementChild?.className).toBe('app-evt-tag')
    expect((title.firstElementChild as HTMLElement).style.backgroundColor).toBeTruthy()
    expect(title.textContent).toBe('Standup')
  })

  it('keeps only the label in the year overview, where an entry is a dot', () => {
    const { domNodes } = calendarEntryContent(entry({ kind: 'confirmed', label: 'Standup' }), true)
    expect(html(domNodes)).toBe('<span class="sr-only">Standup</span>')
  })

  it('falls back to the title without a label', () => {
    const { domNodes } = calendarEntryContent(entry({}), true)
    expect(domNodes[0]?.textContent).toBe('Standup')
  })
})

describe('splitEntryContent', () => {
  it('shows time and title, with the calendar and the status for assistive technology', () => {
    const { domNodes } = splitEntryContent(
      entry({
        status: 'cancelled',
        blocked: false,
        calendarName: 'Team',
        categoryColors: ['#00ff00'],
      }),
    )
    const [time, title, note] = domNodes as HTMLElement[]
    expect(time!.outerHTML).toBe('<div class="time">09:00–09:15</div>')
    expect(title!.className).toBe('title split-event__title')
    expect(title!.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(title!.textContent).toBe('Standup')
    expect(note!.outerHTML).toBe('<span class="sr-only">, Team, cancelled</span>')
  })
})

describe('splitLabelContent', () => {
  it('names the calendar after a dot in its colour', () => {
    const { domNodes } = splitLabelContent({
      resource: { title: 'Team', extendedProps: { color: '#123456' } },
    } as unknown as ResourceCellInfo)
    const label = domNodes[0] as HTMLElement
    expect(label.className).toBe('split-label')
    expect(label.title).toBe('Team')
    expect(label.textContent).toBe('Team')
    const dot = label.firstElementChild as HTMLElement
    expect(dot.className).toBe('split-label__dot')
    expect(dot.getAttribute('aria-hidden')).toBe('true')
    expect(dot.style.backgroundColor).toBeTruthy()
  })

  it('draws nothing without a resource', () => {
    expect(splitLabelContent({} as ResourceCellInfo).domNodes).toEqual([])
  })
})
