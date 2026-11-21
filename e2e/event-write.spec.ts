import { expect, test } from '@playwright/test'
import { openApp, press, switchView } from './helpers'

// The demo (NUXT_DEMO=true, which this config runs) has no calendar service: events live in memory.
// These tests pin what stays as it was in Phase 1. The real create / edit / delete flows, with the
// "which events?" question for repeating events, are in e2e/live/event-write.spec.ts.
test.describe('event writes in the demo', () => {
  test('Delete says that editing arrives with the real service and opens no dialog', async ({
    page,
  }) => {
    await openApp(page)
    await switchView(page, 'Week')
    await press(page.locator('[data-calendar-main]').getByText('Sprint planning').first())
    const sheet = page.getByRole('dialog', { name: 'Sprint planning' })
    await expect(sheet).toBeVisible()

    await press(sheet.getByRole('button', { name: 'Delete' }))
    await expect(
      page.getByText('Editing arrives with the real calendar service', { exact: true }),
    ).toBeVisible()
    // The sheet is the only dialog: no confirmation, no question.
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(sheet.getByRole('button', { name: 'Delete' })).toBeEnabled()
    await expect(sheet.getByRole('button', { name: 'Edit' })).toBeEnabled()
  })

  test('in the demo, Add has the five fields and the details, without a repeat rule', async ({
    page,
  }) => {
    await openApp(page)
    await press(page.getByRole('button', { name: 'Add', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Add event' })
    await expect(dialog).toBeVisible()
    for (const label of ['Title', 'Calendar', 'Start', 'End']) {
      await expect(dialog.getByLabel(label, { exact: true })).toBeVisible()
    }
    await expect(dialog.getByRole('switch', { name: 'All day' })).toBeVisible()
    await expect(dialog.getByLabel('Repeat')).toHaveCount(0)
    // the details are folded away, with the location and the description in them
    const details = dialog.getByRole('button', { name: /^Details/ })
    await expect(details).toHaveAttribute('aria-expanded', 'false')
    await press(details)
    await expect(dialog.getByLabel('Location')).toBeVisible()
    await expect(dialog.getByLabel('Description')).toBeVisible()
  })

  test('in the demo, the description and the place are kept and shown in the sheet', async ({
    page,
  }) => {
    await openApp(page)
    await switchView(page, 'Week')
    await press(page.getByRole('button', { name: 'Add', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Add event' })
    await dialog.getByLabel('Title').fill('Demo with details')
    await press(dialog.getByRole('button', { name: /^Details/ }))
    await dialog.getByLabel('Location').fill('Room 42')
    await dialog.getByLabel('Description').fill('Bring the slides')
    await press(dialog.getByRole('button', { name: 'Add event' }))
    await expect(dialog).toBeHidden()

    await press(page.locator('[data-calendar-main]').getByText('Demo with details').first())
    const sheet = page.getByRole('dialog', { name: 'Demo with details' })
    await expect(sheet).toContainText('Room 42')
    await expect(sheet).toContainText('Bring the slides')
  })

  test('in the demo, Add still adds to the shown calendar without asking the network', async ({
    page,
  }) => {
    const calls: string[] = []
    page.on('request', (request) => {
      if (/\/caldav\//.test(request.url())) calls.push(request.method())
    })
    await openApp(page)
    await switchView(page, 'Week')
    await press(page.getByRole('button', { name: 'Add', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Add event' })
    await dialog.getByLabel('Title').fill('Demo write')
    await press(dialog.getByRole('button', { name: 'Add event' }))
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-calendar-main]').getByText('Demo write').first()).toBeVisible()
    expect(calls).toEqual([])
  })
})
