import { makeScrollersFocusable } from '~/utils/scroll-a11y'

/**
 * Keeps the scrolling regions inside `root` reachable by keyboard, also after FullCalendar
 * re-renders them (a new view, or a change between narrow and wide). Runs once per frame at most.
 */
export function useKeyboardScrollers(root: Ref<HTMLElement | null>) {
  let observer: MutationObserver | undefined
  let frame = 0

  const run = () => {
    frame = 0
    if (root.value) makeScrollersFocusable(root.value)
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(run)
  }

  onMounted(() => {
    if (!root.value) return
    observer = new MutationObserver(schedule)
    // Child changes only: setting the attributes above must not trigger another run.
    observer.observe(root.value, { childList: true, subtree: true })
    schedule()
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    if (frame) cancelAnimationFrame(frame)
  })
}
