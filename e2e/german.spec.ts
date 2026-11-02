import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { TODAY, openApp, press } from './helpers'

// FR-33: the app speaks English and German. A browser that prefers German gets German; Settings →
// Language switches at once and the choice stays in the browser. The demo's sample names
// (calendars, views, filters) are not translated, so the texts below are the app's own.

const calendar = (page: Page) => page.locator('[data-calendar-main]')
const openMenu = (page: Page) => page.locator('header button').last()

// Where the sidebar is a drawer (a phone) it starts closed.
async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: /^(Open sidebar|Seitenleiste öffnen)$/ })
  if (await open.isVisible()) await press(open)
}

// A frozen Date.now() makes Vue skip the pointerdown handler that opens a select (see
// e2e/dark-mode-switch.spec.ts): the specs that open one let the time run.
// In the demo the menu item "Settings" only shows a notice, so the page is opened by its address.
async function openSettings(page: Page): Promise<void> {
  await openApp(page)
  await page.goto('/settings')
  await page.clock.setSystemTime(TODAY)
}

// Texts of the app that must not show on a German screen. Only words that differ in German.
const ENGLISH = [
  'Quick add',
  'Settings',
  'Cancel',
  'Save',
  'Today',
  'Week',
  'Month',
  'Sign out',
  'Back to calendar',
  'Add event',
  'Start and end',
  'All day',
  'Dark mode',
  'Full screen',
  'Language',
  'Time zone',
  'Create token',
  'Retry',
]
async function expectNoEnglish(page: Page, text: string) {
  for (const word of ENGLISH) {
    expect(text, `"${word}" is still English`).not.toMatch(new RegExp(`\\b${word}\\b`))
  }
}

async function noSidewaysScroll(page: Page, what: string) {
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }))
  expect(overflow, `${what} scrolls sideways`).toEqual({ page: 0, body: 0 })
}

test.describe('German browser', () => {
  test.use({ locale: 'de-DE' })

  test('shows the calendar in German: top bar, period, grid', async ({ page }) => {
    const { errors } = await openApp(page)
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    const header = page.locator('header')
    await expect(header).toContainText('26. Okt – 1. Nov 2026')
    for (const word of ['Heute', 'Tag', 'Woche', 'Monat', 'Jahr', 'Liste']) {
      await expect(header.getByRole('button', { name: word, exact: true })).toBeVisible()
    }
    await expect(header.getByRole('button', { name: 'Schnell hinzufügen' })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Hinzufügen', exact: true })).toBeVisible()
    // FullCalendar's own words follow the language too: Thursday is "Do", not "Thu".
    await expect(calendar(page)).toContainText(/\bDo\b/)
    await expect(calendar(page)).not.toContainText(/\bThu\b/)
    await header.getByRole('button', { name: 'Monat', exact: true }).click()
    await expect(header).toContainText('Oktober 2026')
    expect(errors).toEqual([])
  })

  test('has no English left in the header, menu, sidebar and the two add dialogs', async ({
    page,
  }) => {
    await openApp(page)
    await expectNoEnglish(page, await page.locator('header').innerText())

    await press(openMenu(page))
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Einstellungen')
    await expectNoEnglish(page, await menu.innerText())
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    await showSidebar(page)
    const sidebar = page.getByRole('button', { name: 'Ansichten', exact: true })
    await expect(sidebar).toBeVisible()
    await expectNoEnglish(page, await page.locator('body').innerText())
    await page.keyboard.press('Escape')

    await press(page.getByRole('button', { name: 'Schnell hinzufügen' }))
    const quick = page.getByRole('dialog', { name: 'Schnell hinzufügen' })
    await expect(quick).toBeVisible()
    await expectNoEnglish(page, await quick.innerText())
    await expect(quick.getByLabel('Titel')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(quick).toBeHidden()

    await press(page.getByRole('button', { name: 'Hinzufügen', exact: true }))
    const add = page.getByRole('dialog', { name: 'Termin hinzufügen' })
    await expect(add).toBeVisible()
    await expectNoEnglish(page, await add.innerText())
    await expect(add.getByLabel('Ressource hinzufügen')).toBeVisible()
  })

  test('has no English left in Settings', async ({ page }) => {
    await openSettings(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Sprache' })).toBeVisible()
    await expectNoEnglish(page, await page.locator('main').innerText())
  })

  test('does not scroll sideways: calendar, sidebar, dialogs and Settings', async ({ page }) => {
    await openApp(page)
    await noSidewaysScroll(page, 'the calendar')
    await showSidebar(page)
    await noSidewaysScroll(page, 'the sidebar')
    await page.keyboard.press('Escape')
    await press(page.getByRole('button', { name: 'Hinzufügen', exact: true }))
    await expect(page.getByRole('dialog', { name: 'Termin hinzufügen' })).toBeVisible()
    await noSidewaysScroll(page, 'the Add dialog')
    await page.keyboard.press('Escape')
    // Leave only when the dialog is gone: a page.goto during its closing aborts (ERR_ABORTED).
    await expect(page.getByRole('dialog', { name: 'Termin hinzufügen' })).toBeHidden()
    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible()
    await noSidewaysScroll(page, 'Settings')
  })

  test('has no accessibility violations in the Add dialog and in Settings', async ({ page }) => {
    await openApp(page)
    await press(page.getByRole('button', { name: 'Hinzufügen', exact: true }))
    const add = page.getByRole('dialog', { name: 'Termin hinzufügen' })
    await expect(add).toBeVisible()
    // The dialog fades in; axe would measure the colours of a half-transparent dialog.
    await page.waitForTimeout(400)
    const inDialog = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(inDialog.violations.map((violation) => violation.id)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(add).toBeHidden()

    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 2, name: 'Sprache' })).toBeVisible()
    const settings = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(settings.violations.map((violation) => violation.id)).toEqual([])
  })
})

test.describe('English browser', () => {
  test.use({ locale: 'en-US' })

  test('stays English, and says so in lang', async ({ page }) => {
    await openApp(page)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('header')).toContainText('26 Oct – 1 Nov 2026')
    await expect(page.locator('header').getByRole('button', { name: 'Today' })).toBeVisible()
  })

  test('switches to German in Settings at once and keeps it after a reload', async ({ page }) => {
    await openSettings(page)
    await expect(page.getByRole('heading', { level: 2, name: 'Language' })).toBeVisible()
    const select = page.getByRole('combobox', { name: 'Language' })
    await expect(select).toContainText('Browser language (English)')

    await select.click()
    await page.getByRole('option', { name: 'Deutsch' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Sprache' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    expect(await page.evaluate(() => localStorage.getItem('web-calendar:language'))).toBe('de')

    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')

    // and back to the browser's language
    await page.clock.setSystemTime(TODAY)
    await page.getByRole('combobox', { name: 'Sprache' }).click()
    await page.getByRole('option', { name: /^Browsersprache/ }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect(await page.evaluate(() => localStorage.getItem('web-calendar:language'))).toBe('auto')
  })

  test('a chosen language beats the browser language', async ({ page }) => {
    await openApp(page)
    await page.evaluate(() => localStorage.setItem('web-calendar:language', 'de'))
    await page.reload()
    await expect(page.locator('header').getByRole('button', { name: 'Heute' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  })
})
