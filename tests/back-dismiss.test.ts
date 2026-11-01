// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref, type Ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'

// The back gesture as a history step of every open dialog or sheet (composables/useBackDismiss.ts),
// against the history of happy-dom, which fires `popstate` after `go()` like a browser.

const MARK = '__webCalendarBackDismiss'
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

interface TestOverlay {
  open: Ref<boolean>
  /** How often the back gesture closed it. */
  dismissed: number
}

let useBackDismiss: typeof import('~/composables/useBackDismiss').useBackDismiss
let hosts: VueWrapper[] = []

beforeEach(async () => {
  // The module keeps the state of the stack: every test starts with a fresh one.
  vi.resetModules()
  ;({ useBackDismiss } = await import('~/composables/useBackDismiss'))
})

afterEach(async () => {
  vi.useRealTimers()
  hosts.forEach((host) => host.unmount())
  hosts = []
  await settle()
  vi.restoreAllMocks()
})

function addOverlay(): TestOverlay {
  const overlay: TestOverlay = { open: ref(false), dismissed: 0 }
  const host = mount(
    defineComponent({
      setup() {
        useBackDismiss(overlay.open, () => {
          overlay.dismissed += 1
          overlay.open.value = false
        })
      },
      render: () => null,
    }),
  )
  hosts.push(host)
  return overlay
}

const markOfCurrentEntry = () => (history.state as Record<string, unknown> | null)?.[MARK]
const depthOfCurrentEntry = () => (markOfCurrentEntry() as { depth: number } | undefined)?.depth

describe('one overlay', () => {
  it('takes a history step while it is open and gives it back when it closes', async () => {
    const sheet = addOverlay()
    const before = history.length

    sheet.open.value = true
    await settle()
    expect(history.length).toBe(before + 1)
    expect(depthOfCurrentEntry()).toBe(1)

    sheet.open.value = false
    await settle()
    expect(markOfCurrentEntry()).toBeUndefined()
    expect(sheet.dismissed).toBe(0)
  })

  it('closes on Back, stays on the page and takes no second step back', async () => {
    const sheet = addOverlay()
    sheet.open.value = true
    await settle()
    const href = location.href
    const go = vi.spyOn(history, 'go')

    history.back()
    await settle()

    expect(sheet.dismissed).toBe(1)
    expect(sheet.open.value).toBe(false)
    expect(markOfCurrentEntry()).toBeUndefined()
    expect(location.href).toBe(href)
    expect(go).not.toHaveBeenCalled()
  })

  it('opens again after it was closed by Back', async () => {
    const sheet = addOverlay()
    for (let round = 0; round < 3; round += 1) {
      sheet.open.value = true
      await settle()
      expect(depthOfCurrentEntry()).toBe(1)
      history.back()
      await settle()
      expect(sheet.open.value).toBe(false)
    }
    expect(sheet.dismissed).toBe(3)
  })

  it('steps back once when the timer of an earlier step runs out during the next one', async () => {
    // The timer that gives up on a pop that never comes must not outlive the pop that did come:
    // it would find the next step under way and send a second `go(-1)`, out of the page.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sheet = addOverlay()
    const realGo = history.go.bind(history)
    const held: number[] = []
    const go = vi.spyOn(history, 'go').mockImplementation((delta) => void held.push(delta ?? 0))
    const deliver = async () => {
      realGo(held.shift())
      await vi.advanceTimersByTimeAsync(10)
    }

    sheet.open.value = true
    await vi.advanceTimersByTimeAsync(10)
    sheet.open.value = false
    await vi.advanceTimersByTimeAsync(10)
    await deliver()
    sheet.open.value = true
    await vi.advanceTimersByTimeAsync(970)
    // The first step's timer has 10 ms left when the second step is made, and its pop is late.
    sheet.open.value = false
    await vi.advanceTimersByTimeAsync(20)

    expect(go).toHaveBeenCalledTimes(2)
    await deliver()
    expect(go).toHaveBeenCalledTimes(2)
    expect(markOfCurrentEntry()).toBeUndefined()
  })

  it('removes its step when the component goes away while open', async () => {
    const sheet = addOverlay()
    sheet.open.value = true
    await settle()

    hosts.pop()?.unmount()
    await settle()

    expect(markOfCurrentEntry()).toBeUndefined()
  })
})

describe('stacked overlays', () => {
  it('lets Back close the topmost one first', async () => {
    const sheet = addOverlay()
    const confirm = addOverlay()
    sheet.open.value = true
    confirm.open.value = true
    await settle()
    expect(depthOfCurrentEntry()).toBe(2)

    history.back()
    await settle()
    expect([sheet.dismissed, confirm.dismissed]).toEqual([0, 1])
    expect(sheet.open.value).toBe(true)
    expect(depthOfCurrentEntry()).toBe(1)

    history.back()
    await settle()
    expect([sheet.dismissed, confirm.dismissed]).toEqual([1, 1])
    expect(markOfCurrentEntry()).toBeUndefined()
  })

  it('leaves no step behind when the overlays of a flow close together', async () => {
    // A confirmed delete closes the confirmation and the sheet in one go.
    const sheet = addOverlay()
    const confirm = addOverlay()
    sheet.open.value = true
    confirm.open.value = true
    await settle()
    const go = vi.spyOn(history, 'go')

    confirm.open.value = false
    sheet.open.value = false
    await settle()

    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(markOfCurrentEntry()).toBeUndefined()
  })

  it('leaves no step behind when the lower overlay closes first', async () => {
    const sheet = addOverlay()
    const confirm = addOverlay()
    sheet.open.value = true
    confirm.open.value = true
    await settle()

    sheet.open.value = false
    await settle()
    expect(depthOfCurrentEntry()).toBe(1)
    expect(confirm.open.value).toBe(true)

    history.back()
    await settle()
    expect(confirm.dismissed).toBe(1)
    expect(markOfCurrentEntry()).toBeUndefined()
  })

  it('leaves the history alone when one overlay closes as the next one opens', async () => {
    // The steps of the edit flow: the scope question closes, the form opens.
    const scope = addOverlay()
    const form = addOverlay()
    scope.open.value = true
    await settle()
    const push = vi.spyOn(history, 'pushState')
    const go = vi.spyOn(history, 'go')

    scope.open.value = false
    form.open.value = true
    await settle()

    expect(push).not.toHaveBeenCalled()
    expect(go).not.toHaveBeenCalled()
    expect(depthOfCurrentEntry()).toBe(1)

    history.back()
    await settle()
    expect(form.dismissed).toBe(1)
    expect(scope.dismissed).toBe(0)
  })
})

describe('the router and other pages', () => {
  it('does not make the router navigate when a dialog closes', async () => {
    const router = useRouter()
    const navigations = vi.fn()
    const stop = router.beforeEach(navigations)
    const sheet = addOverlay()

    sheet.open.value = true
    await settle()
    sheet.open.value = false
    await settle()
    sheet.open.value = true
    sheet.open.value = false
    await settle()

    expect(markOfCurrentEntry()).toBeUndefined()
    expect(navigations).not.toHaveBeenCalled()
    stop()
  })

  it('passes a pop onto another entry on to the router and closes the overlays', async () => {
    const sheet = addOverlay()
    sheet.open.value = true
    await settle()
    const seen = vi.fn()
    window.addEventListener('popstate', seen)

    window.dispatchEvent(
      new PopStateEvent('popstate', { state: { position: 99, current: '/elsewhere' } }),
    )

    expect(seen).toHaveBeenCalledTimes(1)
    expect(sheet.dismissed).toBe(1)
    window.removeEventListener('popstate', seen)
  })

  it('does not walk the history back when the page moved on while it was open', async () => {
    const sheet = addOverlay()
    sheet.open.value = true
    await settle()
    // What the router does for a navigation: a new entry that is none of ours.
    history.pushState({ position: 5, current: '/elsewhere' }, '', location.href)
    const go = vi.spyOn(history, 'go')

    sheet.open.value = false
    await settle()

    expect(go).not.toHaveBeenCalled()
    expect((history.state as { position: number }).position).toBe(5)
  })
})
