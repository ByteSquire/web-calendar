/**
 * Dragging the sections of the sidebar into the order a person likes (FR-21). Called by
 * SidebarContent, which puts `onPointerDown` on its root; the sections are found by
 * `data-section-id` and grabbed by their heading (the `h2`), so the plus next to it still works.
 *
 *  - Mouse and pen: press the heading and move more than a few pixels.
 *  - Touch: press the heading and hold still for a moment (a long press), then drag. Moving
 *    before that is the page scrolling, and nothing happens.
 *
 * While a section is dragged every section folds down to its heading (the content is only hidden,
 * `SidebarSection`), so the whole list fits and any place can be reached. The dragged heading
 * follows the pointer, the others make room as it passes them (the order changes live), and
 * letting go keeps the order and saves it. Escape or a cancelled touch puts everything back. The
 * click that ends a drag does not fold the section. The way to reorder without dragging is the
 * list with arrow buttons (SidebarArrange.vue).
 */
import { dropIndex, reorderTo, sameOrder, type Box } from '~/utils/sidebar-drag'
import { isSidebarSectionId, type SidebarSectionId } from '../../shared/utils/sidebar-sections'

/** The section being dragged, or null. Sections fold to their headings while it is set. */
export function useSidebarDragState() {
  return useState<SidebarSectionId | null>('sidebar-dragging', () => null)
}

/** How long a finger rests on a heading before the drag begins. */
const LONG_PRESS_MS = 450
/** How far a pointer may move and still count as resting (touch) or as not yet dragging (mouse). */
const SLOP_PX = 6
/** A click that follows the end of a drag is swallowed for this long. */
const CLICK_GUARD_MS = 100

interface Press {
  id: SidebarSectionId
  element: HTMLElement
  pointerId: number
  touch: boolean
  startX: number
  startY: number
  timer: number
}

interface Drag {
  id: SidebarSectionId
  element: HTMLElement
  before: SidebarSectionId[]
  /** How far the dragged heading is drawn from where it sits in the list. */
  shift: number
  frame: number
  measuring: boolean
  again: boolean
}

export function useSidebarDrag(root: Readonly<Ref<HTMLElement | null>>) {
  const { order, commit } = useSidebarOrder()
  const dragging = useSidebarDragState()
  let press: Press | null = null
  let drag: Drag | null = null
  let lastY = 0

  function onPointerDown(event: PointerEvent) {
    if (press || drag || !event.isPrimary) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    const element = target?.closest('h2')?.closest<HTMLElement>('[data-section-id]')
    const id = element?.dataset.sectionId
    if (!element || !isSidebarSectionId(id)) return

    const touch = event.pointerType === 'touch'
    lastY = event.clientY
    press = {
      id,
      element,
      pointerId: event.pointerId,
      touch,
      startX: event.clientX,
      startY: event.clientY,
      timer: touch ? window.setTimeout(begin, LONG_PRESS_MS) : 0,
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
  }

  function onPointerMove(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointerId) return
    lastY = event.clientY
    if (drag) {
      schedule()
      return
    }
    const moved = Math.hypot(event.clientX - press.startX, event.clientY - press.startY)
    if (moved <= SLOP_PX) return
    // A finger that moves before the long press is over is scrolling the sidebar.
    if (press.touch) endPress()
    else begin()
  }

  function onPointerUp(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointerId) return
    if (drag) finish(true)
    else endPress()
  }

  function onPointerCancel(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointerId) return
    if (drag) finish(false)
    else endPress()
  }

  function endPress() {
    if (!press) return
    window.clearTimeout(press.timer)
    press = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerCancel)
  }

  // ---- The drag ---------------------------------------------------------------------------------

  /**
   * Stops the sidebar from scrolling under a finger that is dragging. The listener is put on the
   * root when it is mounted and is not passive: a browser decides at the start of a touch whether
   * a later move can be cancelled, so a listener added when the long press fires would be too late.
   */
  const blockScroll = (event: TouchEvent) => {
    if (drag && event.cancelable) event.preventDefault()
  }
  const swallowClick = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    // Not for the slideover or a dialog around the sidebar: Escape puts the section back.
    event.preventDefault()
    event.stopPropagation()
    finish(false)
  }

  function begin() {
    if (!press || drag) return
    window.clearTimeout(press.timer)
    drag = {
      id: press.id,
      element: press.element,
      before: [...order.value],
      shift: 0,
      frame: 0,
      measuring: false,
      again: false,
    }
    dragging.value = press.id
    press.element.dataset.dragging = 'true'
    window.addEventListener('keydown', onKeyDown, true)
    if (press.touch) navigator.vibrate?.(20)
    schedule()
  }

  function schedule() {
    if (!drag || drag.frame) return
    drag.frame = window.requestAnimationFrame(() => {
      if (drag) drag.frame = 0
      void update()
    })
  }

  /** The sections in the order they are on the screen, with where each sits in the list. */
  function measure(current: Drag): { ids: string[]; boxes: Box[]; self: number } {
    const elements = [...(root.value?.querySelectorAll<HTMLElement>('[data-section-id]') ?? [])]
    const boxes = elements.map((element) => {
      const rect = element.getBoundingClientRect()
      // The dragged heading is drawn away from its place: take that back out.
      const shift = element === current.element ? current.shift : 0
      return { top: rect.top - shift, bottom: rect.bottom - shift }
    })
    return {
      ids: elements.map((element) => element.dataset.sectionId ?? ''),
      boxes,
      self: elements.indexOf(current.element),
    }
  }

  /** Puts the dragged section where the pointer is and draws it under the pointer. */
  async function update() {
    const current = drag
    if (!current) return
    if (current.measuring) {
      current.again = true
      return
    }
    current.measuring = true
    try {
      // The first time, the sections have yet to fold to their headings.
      await nextTick()
      do {
        current.again = false
        if (drag !== current) return
        let measured = measure(current)
        const to = dropIndex(measured.boxes, measured.self, lastY)
        if (measured.self !== -1 && to !== measured.self) {
          order.value = reorderTo(order.value, current.id, to)
          await nextTick()
          if (drag !== current) return
          measured = measure(current)
        }
        const own = measured.boxes[measured.self]
        if (own) {
          current.shift = lastY - (own.top + own.bottom) / 2
          current.element.style.transform = `translateY(${current.shift}px)`
        }
      } while (current.again)
    } finally {
      current.measuring = false
    }
  }

  /** Ends the drag: `keep` saves the new order, otherwise the old one comes back. */
  function finish(keep: boolean) {
    const current = drag
    if (!current) return
    window.cancelAnimationFrame(current.frame)
    drag = null
    current.element.style.transform = ''
    delete current.element.dataset.dragging
    dragging.value = null
    window.removeEventListener('keydown', onKeyDown, true)
    endPress()
    // The release is followed by a click on the heading, which would fold the section.
    window.addEventListener('click', swallowClick, true)
    window.setTimeout(() => window.removeEventListener('click', swallowClick, true), CLICK_GUARD_MS)
    if (keep && !sameOrder(order.value, current.before)) commit([...order.value])
    else order.value = current.before
  }

  /** A long press on a touch screen would open the browser's menu on the heading. */
  function onContextMenu(event: Event) {
    if (press?.touch || drag) event.preventDefault()
  }

  onMounted(() => root.value?.addEventListener('touchmove', blockScroll, { passive: false }))
  onBeforeUnmount(() => {
    root.value?.removeEventListener('touchmove', blockScroll)
    if (drag) finish(false)
    else endPress()
  })

  return { onPointerDown, onContextMenu }
}
