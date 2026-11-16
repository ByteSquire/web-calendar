// What the calendars draw inside an entry and a row label, as DOM nodes for FullCalendar's content
// injection (`{ domNodes }`). FullCalendar puts them in while it renders. Vue slots were drawn a
// microtask later, and Firefox prints the page before that: the entries came out empty
// (composables/usePrinting.ts). Tests: tests/entry-content.test.ts.
import type { EventDisplayInfo } from '@fullcalendar/vue3'
import type { ResourceCellInfo } from '@fullcalendar/vue3-scheduler'
import type { EventExtendedProps } from './fullcalendar'
import { timelineEventSrText, type TimelineEvent } from './split-view'

interface DomContent {
  domNodes: Node[]
}

function element(
  tag: string,
  className: string,
  children: (Node | string)[],
  attributes: Record<string, string> = {},
): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  node.append(...children)
  return node
}

/** A dot per category before the title ("Category colours on events"); main.css styles them. */
function categoryDots(colors: readonly string[] | undefined, hidden: boolean): HTMLElement[] {
  return (colors ?? []).map((color) => {
    const dot = element('span', 'app-evt-tag', [], hidden ? { 'aria-hidden': 'true' } : {})
    dot.style.backgroundColor = color
    return dot
  })
}

const join = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ')

/**
 * An entry of the standard views. Its visible text is hidden from assistive technology; the label
 * after it names the entry. The year overview draws entries as dots and bars only (`dotsOnly`).
 */
export function calendarEntryContent(arg: EventDisplayInfo, dotsOnly: boolean): DomContent {
  const props = arg.event.extendedProps as Partial<EventExtendedProps>
  const nodes: Node[] = []
  if (!dotsOnly) {
    if (arg.timeText) {
      nodes.push(element('div', arg.timeClass, [arg.timeText], { 'aria-hidden': 'true' }))
    }
    const style =
      props.kind === 'cancelled' ? 'line-through' : props.kind === 'tentative' && 'italic'
    nodes.push(
      element(
        'div',
        join(arg.titleClass, 'app-evt-title', style),
        [...categoryDots(props.categoryColors, false), arg.event.title],
        { 'aria-hidden': 'true' },
      ),
    )
  }
  nodes.push(element('span', 'sr-only', [props.label ?? arg.event.title]))
  return { domNodes: nodes }
}

/** An entry of the split view's timeline, with what it is for assistive technology after it. */
export function splitEntryContent(arg: EventDisplayInfo): DomContent {
  const props = arg.event.extendedProps as TimelineEvent['extendedProps']
  const nodes: Node[] = []
  if (arg.timeText) nodes.push(element('div', arg.timeClass, [arg.timeText]))
  nodes.push(
    element('div', join(arg.titleClass, 'split-event__title'), [
      ...categoryDots(props.categoryColors, true),
      arg.event.title,
    ]),
    element('span', 'sr-only', [`, ${timelineEventSrText(props)}`]),
  )
  return { domNodes: nodes }
}

/** The label of a split view row: the calendar's colour and name (SplitTimeline.vue styles it). */
export function splitLabelContent({ resource }: ResourceCellInfo): DomContent {
  if (!resource) return { domNodes: [] }
  const dot = element('span', 'split-label__dot', [], { 'aria-hidden': 'true' })
  dot.style.backgroundColor = String(resource.extendedProps.color ?? '')
  return {
    domNodes: [element('span', 'split-label', [dot, resource.title], { title: resource.title })],
  }
}
