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

  test('quick add keeps its five fields, without repeat, location or description', async ({
    page,
  }) => {
    await openApp(page)
    await press(page.getByRole('button', { name: 'Quick add' }))
    const dialog = page.getByRole('dialog', { name: 'Quick add' })
    await expect(dialog).toBeVisible()
    for (const label of ['Title', 'Calendar', 'Start', 'End']) {
      await expect(dialog.getByLabel(label, { exact: true })).toBeVisible()
    }
    await expect(dialog.getByRole('switch', { name: 'All day' })).toBeVisible()
    for (const label of ['Repeat', 'Location', 'Description']) {
      await expect(dialog.getByLabel(label)).toHaveCount(0)
    }
  })

  test('quick add still adds to the shown calendar without asking the network', async ({
    page,
  }) => {
    const calls: string[] = []
    page.on('request', (request) => {
      if (/\/caldav\//.test(request.url())) calls.push(request.method())
    })
    await openApp(page)
    await switchView(page, 'Week')
    await press(page.getByRole('button', { name: 'Quick add' }))
    const dialog = page.getByRole('dialog', { name: 'Quick add' })
    await dialog.getByLabel('Title').fill('Demo write')
    await press(dialog.getByRole('button', { name: 'Add event' }))
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-calendar-main]').getByText('Demo write').first()).toBeVisible()
    expect(calls).toEqual([])
  })
})
