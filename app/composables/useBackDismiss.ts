/**
 * Makes an open dialog or sheet a step of the browser history. Android's back gesture then closes
 * the topmost overlay before it navigates away from the page.
 *
 * The overlays form a stack; the history holds one entry of ours per open overlay, on top of the
 * entry the page was on. Opening and closing only change the stack. One deferred step then brings
 * the history in line: it pushes the missing entries, or removes the surplus with a single
 * `history.go(-n)`. An overlay that closes while another opens in the same moment, as the steps of
 * the edit flow do, therefore leaves the history alone.
 *
 * The router listens to the same pops. The steps we take ourselves are made through its history
 * with `triggerListeners` off, so closing a dialog is not a navigation. A Back press cannot be
 * hidden from it: the router handles that pop first, as a navigation to the location it is on.
 */
interface Overlay {
  dismiss: () => void
}

/** What an entry of ours records in `history.state`: the anchor and its depth above it. */
interface Mark {
  anchor: string
  depth: number
}

/** The entry the overlays sit on, as far as it can be recognised after a pop. */
interface Anchor {
  id: string
  href: string
  position: unknown
}

const MARK_KEY = '__webCalendarBackDismiss'

const stack: Overlay[] = []
let anchor: Anchor | null = null
/** History entries of ours that exist above the anchor. */
let pushed = 0
/** Our own `history.go(-n)` is under way; its pop is not a Back press. */
let waiting = false
let syncTimer = 0
let anchorCount = 0
let listening = false
/** The history of the router, which can step back without telling the router about it. */
let routerHistory: { go: (delta: number, triggerListeners?: boolean) => void } | null = null

function recordOf(state: unknown): Record<string, unknown> {
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {}
}

/**
 * How many of our entries lie below `state`'s entry: 0 for the anchor itself, null for an entry
 * that is neither the anchor nor one of ours.
 */
function depthOf(state: unknown): number | null {
  if (!anchor) return null
  const record = recordOf(state)
  const mark = record[MARK_KEY] as Mark | undefined
  if (mark) return mark.anchor === anchor.id ? mark.depth : null
  const samePage =
    window.location.href === anchor.href && (record.position ?? null) === anchor.position
  return samePage ? 0 : null
}

function onPopState(event: PopStateEvent) {
  const depth = depthOf(event.state)
  if (depth === null) {
    // Another page or position: the router deals with it. The overlays belonged to the old one.
    anchor = null
    pushed = 0
    waiting = false
    while (stack.length > 0) stack.pop()?.dismiss()
    return
  }

  const ownStep = waiting
  waiting = false
  // Set before anything is dismissed: the close that follows must find the history in line.
  pushed = depth
  if (!ownStep) {
    // A Back press took the entries of the topmost overlays; they close with them.
    while (stack.length > pushed) stack.pop()?.dismiss()
  }
  if (pushed === 0) anchor = null
  schedule()
}

function schedule() {
  if (!syncTimer) syncTimer = window.setTimeout(sync, 0)
}

function sync() {
  syncTimer = 0
  if (waiting) return
  const wanted = stack.length
  if (wanted === pushed) return

  // The router may have moved the page on while overlays were open: our count is void then.
  if (pushed > 0 && depthOf(window.history.state) !== pushed) {
    anchor = null
    pushed = 0
    schedule()
    return
  }

  if (wanted > pushed) {
    anchor ??= {
      id: `anchor-${++anchorCount}`,
      href: window.location.href,
      position: recordOf(window.history.state).position ?? null,
    }
    while (pushed < wanted) {
      pushed += 1
      const mark: Mark = { anchor: anchor.id, depth: pushed }
      window.history.pushState(
        { ...recordOf(window.history.state), [MARK_KEY]: mark },
        '',
        window.location.href,
      )
    }
    return
  }

  waiting = true
  if (routerHistory) routerHistory.go(wanted - pushed, false)
  else window.history.go(wanted - pushed)
  // A pop that never arrives must not switch the feature off.
  window.setTimeout(() => {
    if (!waiting) return
    waiting = false
    pushed = depthOf(window.history.state) ?? 0
    if (pushed === 0) anchor = null
    schedule()
  }, 1000)
}

export function useBackDismiss(open: Readonly<Ref<boolean>>, dismiss: () => void) {
  if (!import.meta.client) return

  if (!listening) {
    listening = true
    window.addEventListener('popstate', onPopState)
    routerHistory = useRouter().options.history
  }

  const overlay: Overlay = { dismiss }

  function setOpen(isOpen: boolean) {
    const index = stack.indexOf(overlay)
    if (isOpen === (index !== -1)) return
    if (isOpen) stack.push(overlay)
    else stack.splice(index, 1)
    schedule()
  }

  // Synchronous, so the stack keeps the order in which the overlays opened.
  const stopWatch = watch(open, setOpen, { immediate: true, flush: 'sync' })

  onBeforeUnmount(() => {
    stopWatch()
    setOpen(false)
  })
}
