import { expect, test, type Page } from '@playwright/test'
import { TODAY, expectOpenFocus, openApp, press, switchView } from './helpers'

// "Add" in the top bar, the one way to add an event besides a click on a date (demo: the mock
// resources Room A and Van, rights for everything): it adds, refuses what it cannot add, returns
// the focus, and offers the resources to book with the event. The folding Details (location, description) need live data and are checked in e2e/live and in
// tests/writes-ui.test.ts.
// A frozen Date.now() makes Vue skip the pointerdown handler that opens a select (see
// e2e/dark-mode-switch.spec.ts): the specs that open the list of resources let the time run.
async function openWithRunningClock(page: Page) {
  const opened = await openApp(page)
  await page.clock.setSystemTime(TODAY)
  return opened
}

test.describe('add event', () => {
  test('adds an event that shows in the current view, and returns focus', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Week')
    const opener = page.getByRole('button', { name: 'Add', exact: true })
    await press(opener)

    const dialog = page.getByRole('dialog', { name: 'Add event' })
    await expect(dialog).toBeVisible()
    await expectOpenFocus(dialog, dialog.getByLabel('Title'))
    await dialog.getByLabel('Title').fill('E2E planning')
    await press(dialog.getByRole('button', { name: 'Add event' }))

    await expect(dialog).toBeHidden()
    await expect(
      page.locator('[data-calendar-main]').getByText('E2E planning').first(),
    ).toBeVisible()
    await expect(opener).toBeFocused()
  })

  test('refuses an empty title and keeps the dialog open', async ({ page }) => {
    await openApp(page)
    await press(page.getByRole('button', { name: 'Add', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Add event' })
    await press(dialog.getByRole('button', { name: 'Add event' }))
    await expect(dialog.getByText('Enter a title.')).toBeVisible()
    await expect(dialog).toBeVisible()
  })

  test('Escape closes it and focus returns to the button', async ({ page }) => {
    await openApp(page)
    const opener = page.getByRole('button', { name: 'Add', exact: true })
    await press(opener)
    const dialog = page.getByRole('dialog', { name: 'Add event' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test('the top bar has one button for adding, and its dialog offers the resources', async ({
    page,
  }) => {
    await openApp(page)
    await expect(page.getByRole('button', { name: 'Quick add' })).toHaveCount(0)
    await press(page.getByRole('button', { name: 'Add', exact: true }))
    const add = page.getByRole('dialog', { name: 'Add event' })
    await expect(add).toBeVisible()
    await expect(add.getByLabel('Add a resource')).toBeVisible()
  })

  test('books a resource with the event, right there in the form', async ({ page }) => {
    const { errors } = await openWithRunningClock(page)
    await switchView(page, 'Week')
    const opener = page.getByRole('button', { name: 'Add', exact: true })
    await press(opener)
    const dialog = page.getByRole('dialog', { name: 'Add event' })
    // The dialog moves the focus into the title when it has opened; a select opened before that
    // is closed again by it.
    await expectOpenFocus(dialog, dialog.getByLabel('Title'))
    await dialog.getByLabel('Title').fill('Kick-off with a room')

    // no resource chosen: nothing to book, so no "Book right away" yet
    await expect(dialog.getByRole('checkbox', { name: 'Book right away' })).toHaveCount(0)
    await dialog.getByLabel('Add a resource').click()
    await page.getByRole('option', { name: 'Room A' }).click()
    await expect(dialog.locator('[data-chosen-resources]')).toContainText('Room A')
    await expect(dialog.getByRole('checkbox', { name: 'Book right away' })).toBeChecked()

    await press(dialog.getByRole('button', { name: 'Add event' }))
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Room A requested, waiting for approval.').first()).toBeVisible()
    await expect(
      page.locator('[data-calendar-main]').getByText('Kick-off with a room').first(),
    ).toBeVisible()
    expect(errors).toEqual([])
  })

  test('saves a draft when "Book right away" is unchecked', async ({ page }) => {
    await openWithRunningClock(page)
    await press(page.getByRole('button', { name: 'Add', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Add event' })
    await expectOpenFocus(dialog, dialog.getByLabel('Title'))
    await dialog.getByLabel('Title').fill('Maybe a van')
    await dialog.getByLabel('Add a resource').click()
    await page.getByRole('option', { name: 'Van' }).click()
    await dialog.getByRole('checkbox', { name: 'Book right away' }).uncheck()
    await press(dialog.getByRole('button', { name: 'Add event' }))
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Saved as a draft: nothing is booked yet.').first()).toBeVisible()
  })

  test('the start and end fold away and tell what is in them', async ({ page }) => {
    await openApp(page)
    await press(page.getByRole('button', { name: 'Add', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Add event' })
    const region = dialog.getByRole('button', { name: /^Start and end/ })
    await expect(region).toHaveAttribute('aria-expanded', 'true')
    await expect(dialog.getByLabel('Start', { exact: true })).toBeVisible()
    await press(region)
    await expect(region).toHaveAttribute('aria-expanded', 'false')
    await expect(dialog.getByLabel('Start', { exact: true })).toBeHidden()
    // Chromium writes "Thu, 29 Oct", Node "Thu 29 Oct": the comma comes from the browser.
    await expect(region).toContainText(/Thu,? 29 Oct, 09:00–10:00/)
    await press(region)
    await expect(dialog.getByLabel('Start', { exact: true })).toBeVisible()
  })
})
