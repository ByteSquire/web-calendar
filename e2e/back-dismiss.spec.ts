import { expect, test, type Page } from '@playwright/test'
import { openApp, press, switchView } from './helpers'

// The back gesture closes the topmost dialog or sheet and never leaves the page with it
// (composables/useBackDismiss.ts). `page.goBack()` is the browser's Back.

interface RouterProbe {
  beforeEach: (guard: () => void) => void
  push: (path: string) => Promise<unknown>
}
interface VueAppProbe {
  config: { globalProperties: { $router: RouterProbe } }
}
interface RouterProbeWindow {
  __navigations: number
  __router: RouterProbe
}

const quickAdd = (page: Page) => page.getByRole('dialog', { name: 'Quick add' })

async function openQuickAdd(page: Page): Promise<void> {
  await press(page.getByRole('button', { name: 'Quick add' }))
  await expect(quickAdd(page)).toBeVisible()
}

/** The history has taken in the closing of a dialog: the page is back on its own entry. */
async function expectSettled(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(history.state?.__webCalendarBackDismiss)))
    .toBe(false)
}

test.describe('back gesture', () => {
  test('closes quick-add and stays on the page', async ({ page }) => {
    await openApp(page)
    const url = page.url()
    await openQuickAdd(page)

    await page.goBack()

    await expect(quickAdd(page)).toBeHidden()
    expect(page.url()).toBe(url)
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
  })

  test('closes the event sheet and stays on the page', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Week')
    const url = page.url()
    await press(page.locator('[data-calendar-main]').getByText('Sprint planning').first())
    const sheet = page.getByRole('dialog', { name: 'Sprint planning' })
    await expect(sheet).toBeVisible()

    await page.goBack()

    await expect(sheet).toBeHidden()
    expect(page.url()).toBe(url)
  })

  test('a dialog closed another way leaves no step for Back to waste', async ({ page }) => {
    await openApp(page)
    await openQuickAdd(page)
    await page.keyboard.press('Escape')
    await expect(quickAdd(page)).toBeHidden()
    await expectSettled(page)

    // The first Back leaves the app: there is no stale step of the dialog in between.
    await page.goBack()
    await expect(page).toHaveURL('about:blank')
  })

  test('opening and closing a dialog again and again adds no steps', async ({ page }) => {
    await openApp(page)
    for (let round = 0; round < 3; round += 1) {
      await openQuickAdd(page)
      await page.keyboard.press('Escape')
      await expect(quickAdd(page)).toBeHidden()
      await expectSettled(page)
    }
    await page.goBack()
    await expect(page).toHaveURL('about:blank')
  })

  test('closing a dialog is not a navigation of the router', async ({ page }) => {
    await openApp(page)
    // The route guard (login) runs for every navigation of the router.
    await page.evaluate(() => {
      const app = document.querySelector<HTMLElement & { __vue_app__?: VueAppProbe }>('#__nuxt')
      const router = app?.__vue_app__?.config.globalProperties.$router
      if (!router) throw new Error('no router')
      const probe = window as unknown as RouterProbeWindow
      probe.__navigations = 0
      probe.__router = router
      router.beforeEach(() => {
        probe.__navigations += 1
      })
    })
    const navigations = () =>
      page.evaluate(() => (window as unknown as RouterProbeWindow).__navigations)

    for (let round = 0; round < 2; round += 1) {
      await openQuickAdd(page)
      await page.keyboard.press('Escape')
      await expect(quickAdd(page)).toBeHidden()
      await expectSettled(page)
    }
    expect(await navigations()).toBe(0)

    // The probe does see a real navigation.
    await page.evaluate(() => (window as unknown as RouterProbeWindow).__router.push('/settings'))
    await expect.poll(navigations).toBeGreaterThan(0)
  })
})
