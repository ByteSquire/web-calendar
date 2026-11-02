import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openSignedIn } from './session'

// FR-9 with the real stack (design S8 setup: the production build with the login ON, Kanidm and
// Radicale): create a repeating event with the quick-add dialog, change one occurrence, read the
// change back, delete the series. It works in alice's first calendar and removes what it made; a
// run that fails half-way leaves an event titled "E2E write <number>" behind. The tests share one
// signed-in page, in order, as in login.spec.ts.
test.describe.configure({ mode: 'serial' })

const TITLE = `E2E write ${Date.now()}`
const EDITED = `${TITLE} (changed)`

let page: Page
let problems: string[] = []

test.beforeAll(async ({ browser }) => {
  const session = await openSignedIn(browser, 'alice')
  page = session.page
  problems = session.problems
})

test.afterAll(async () => {
  await page.context().close()
})

const area = () => page.locator('[data-calendar-main]')

/** WCAG 2.1 A and AA inside the open dialogs; the calendar behind them is not part of the check. */
async function scanDialogs(): Promise<string[]> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  )
  const { violations } = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  return violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  )
}

/**
 * Buttons, text fields and select buttons are at least 44 px high and wide. Radios, checkboxes and
 * the switch are left out: their row is the target (a pseudo-element spreads it), which a bounding
 * box of the small control does not show. Visually hidden form inputs are skipped as well.
 */
async function expectTargetsAtLeast44(scope: Locator): Promise<void> {
  const small = await scope
    .locator('button, input, textarea, [role="combobox"]')
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const role = element.getAttribute('role')
          const box = element.getBoundingClientRect()
          return (
            role !== 'radio' &&
            role !== 'checkbox' &&
            role !== 'switch' &&
            element.getAttribute('aria-hidden') !== 'true' &&
            box.width > 1 &&
            box.height > 1 &&
            (box.height < 43.5 || box.width < 43.5)
          )
        })
        .map((element) => {
          const box = element.getBoundingClientRect()
          const name =
            element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.id
          return `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`
        }),
    )
  expect(small).toEqual([])
}

test('adds a repeating event with a location and a description', async () => {
  // "Add" is the longer form: location and description are in its folding "Details".
  const opener = page.getByRole('button', { name: 'Add', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Add event' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Title')).toBeFocused()
  // Only calendars that can be written to; the first one is chosen.
  await expect(dialog.getByLabel('Calendar')).toContainText(/\S/)

  await dialog.getByLabel('Title').fill(TITLE)
  await expect(dialog.getByLabel('Location')).toBeHidden()
  await dialog.getByRole('button', { name: /^Details/ }).click()
  await dialog.getByLabel('Location').fill('Room 42')
  await dialog.getByLabel('Description').fill('Agenda: nothing')
  await dialog.getByLabel('Repeat').click()
  await page.getByRole('option', { name: 'Every week' }).click()
  await dialog.getByLabel('Ends').click()
  await page.getByRole('option', { name: 'After a number of times' }).click()
  await dialog.getByLabel('Number of times').fill('3')

  expect(await scanDialogs()).toEqual([])
  await expectTargetsAtLeast44(dialog)

  await dialog.getByRole('button', { name: 'Add event' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Event added', { exact: true })).toBeVisible()
  await expect(area().getByText(TITLE).first()).toBeVisible()
  await expect(opener).toBeFocused()
})

test('asks which events before editing one of a series, and changes only that one', async () => {
  await area().getByText(TITLE).first().click()
  const sheet = page.getByRole('dialog', { name: TITLE })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('Room 42')).toBeVisible()
  await expect(sheet.getByText('Agenda: nothing')).toBeVisible()
  const edit = sheet.getByRole('button', { name: 'Edit' })
  await expect(edit).toBeEnabled()
  await edit.click()

  // The question comes first, with "This event" chosen.
  const question = page.getByRole('dialog', { name: 'Edit repeating event' })
  await expect(question).toBeVisible()
  await expect(question.getByRole('radio', { name: 'This event' })).toBeChecked()
  await expect(question.getByRole('radio', { name: 'This event' })).toBeFocused()
  expect(await scanDialogs()).toEqual([])
  await expectTargetsAtLeast44(question)

  // Escape leaves everything as it was and the focus on the button that asked.
  await page.keyboard.press('Escape')
  await expect(question).toBeHidden()
  await expect(edit).toBeFocused()

  await edit.click()
  await question.getByRole('button', { name: 'Continue' }).click()
  const form = page.getByRole('dialog', { name: 'Edit event' })
  await expect(form).toBeVisible()
  await expect(form.getByText('Changing this event only.')).toBeVisible()
  await expect(form.getByLabel('Title')).toBeFocused()
  await expect(form.getByLabel('Calendar')).toHaveAttribute('readonly', '')
  expect(await scanDialogs()).toEqual([])

  await form.getByLabel('Title').fill(EDITED)
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form).toBeHidden()
  await expect(sheet).toBeHidden()
  await expect(page.getByText('Event updated', { exact: true })).toBeVisible()
  await expect(area().getByText(EDITED).first()).toBeVisible()
  // Focus is in the calendar, not lost to the page.
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-calendar-main]')))
    .toBe(true)
})

test('left the other occurrences alone', async () => {
  await page.getByRole('button', { name: 'Next week' }).click()
  await expect(area().getByText(TITLE, { exact: true }).first()).toBeVisible()
  await expect(area().getByText(EDITED)).toHaveCount(0)
  await page.getByRole('button', { name: 'Previous week' }).click()
})

test('deletes the whole series after asking which events and for confirmation', async () => {
  await area().getByText(EDITED).first().click()
  const sheet = page.getByRole('dialog', { name: EDITED })
  await expect(sheet).toBeVisible()
  const remove = sheet.getByRole('button', { name: 'Delete' })
  await remove.click()

  const question = page.getByRole('dialog', { name: 'Delete repeating event' })
  await expect(question).toBeVisible()
  await question.getByRole('radio', { name: 'All events' }).click()
  await question.getByRole('button', { name: 'Continue' }).click()

  const confirm = page.getByRole('dialog', { name: `Delete "${EDITED}"?` })
  await expect(confirm).toBeVisible()
  await expect(confirm.getByText('The whole series is deleted.')).toBeVisible()
  // The safe answer has the focus; Escape goes back to the button on the sheet.
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  expect(await scanDialogs()).toEqual([])
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(remove).toBeFocused()

  await remove.click()
  await page
    .getByRole('dialog', { name: 'Delete repeating event' })
    .getByRole('radio', { name: 'All events' })
    .click()
  await page
    .getByRole('dialog', { name: 'Delete repeating event' })
    .getByRole('button', { name: 'Continue' })
    .click()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(sheet).toBeHidden()
  await expect(page.getByText('Event deleted', { exact: true })).toBeVisible()
  await expect(area().getByText(EDITED)).toHaveCount(0)

  await page.getByRole('button', { name: 'Next week' }).click()
  await expect(area().getByText(TITLE)).toHaveCount(0)
  await page.getByRole('button', { name: 'Previous week' }).click()
})

test('no script or console errors came up', () => {
  expect(problems).toEqual([])
})
