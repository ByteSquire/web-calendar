import { expect, test } from '@playwright/test'
import { closeDialogs, openApp, pointAt, settledDialogs, switchView } from './helpers'

test.describe('split view', () => {
  test('gives each calendar with events its own band and hides the empty ones', async ({
    page,
  }) => {
    await openApp(page)
    await switchView(page, 'Split')
    const rows = page.getByRole('rowheader')
    await expect(rows.first()).toBeVisible()
    await expect(rows).toHaveText([
      'Personal',
      'Team',
      'Engineering',
      'Public holidays',
      'Room A',
      'Van',
    ])
    // Sales, Office and Marketing are off in the default selection, so they get no band.
    await expect(page.getByRole('rowheader', { name: 'Sales' })).toHaveCount(0)
  })

  test('follows the date buttons', async ({ page }) => {
    await openApp(page)
    await switchView(page, 'Split')
    const title = page.locator('[aria-live="polite"]:visible').first()
    const before = await title.innerText()
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(title).not.toHaveText(before)
  })

  test("a tap on an empty cell starts a new event in that row's calendar, an event opens its sheet", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'the touch is sent through the Chromium protocol')
    await openApp(page)
    await switchView(page, 'Split')
    const header = page.getByRole('rowheader', { name: 'Team' })
    await expect(header).toBeVisible()
    const row = await header.boundingBox()
    if (!row) throw new Error('no row')
    const y = row.y + row.height / 2

    // An empty point of the row, away from its events and from the label column.
    const x = await page.evaluate(
      ({ from, y }) => {
        for (let x = from; x < window.innerWidth - 4; x += 6) {
          const element = document.elementFromPoint(x, y)
          // A cell of the timeline lane, not a card in it and not the divider before it.
          if (
            element?.closest('.split-timeline [role="cell"]') &&
            !element.closest('.split-event, [role="button"], a, button')
          )
            return x
        }
        return null
      },
      { from: row.x + row.width + 24, y },
    )
    if (x === null) throw new Error('no empty cell in the row')

    await pointAt(page, x, y)
    const dialog = page.getByRole('dialog', { name: 'Quick add' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Team')
    expect(await settledDialogs(page)).toHaveLength(1)
    await closeDialogs(page)

    // An event of the row opens its sheet and nothing else.
    const event = page.locator('.split-event').filter({ hasText: 'Sprint' }).first()
    await event.scrollIntoViewIfNeeded()
    const box = await event.boundingBox()
    if (!box) throw new Error('no event')
    await pointAt(page, box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.getByRole('dialog', { name: /Sprint/ })).toBeVisible()
    expect(await settledDialogs(page)).toHaveLength(1)
  })
})
