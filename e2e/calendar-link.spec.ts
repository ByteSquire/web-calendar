import { expect, test, type Page } from '@playwright/test'
import { scan } from './axe-scan'
import { TODAY, press } from './helpers'

// The page of a calendar link on every screen size, with the public API answered by the test (the
// demo has no Radicale; e2e/live/calendar-link.spec.ts runs it against the real stack). Checks the
// password page, the read-only calendar without sidebar or adding, the reduced menu, no sideways
// scrolling, and axe on both states.

const SLUG = 'A'.repeat(43)
const PASSWORD = 'correct horse'

function vcalendar(uid: string, start: string, end: string, extra: string[] = []): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261001T080000Z',
    `DTSTART:${start}`,
    `DTEND:${end}`,
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
}

async function answerApi(page: Page): Promise<void> {
  await page.route(`**/api/link/${SLUG}/session`, async (route) => {
    const body = route.request().postDataJSON() as { password?: string }
    if (body.password !== PASSWORD) {
      return route.fulfill({
        status: 401,
        json: {
          statusCode: 401,
          message: 'The password is not right',
          data: { code: 'wrong_password' },
        },
      })
    }
    return route.fulfill({
      json: {
        token: 'cls1.1.1.9999999999999.' + 'x'.repeat(43),
        expiresAt: '2099-01-01T00:00:00.000Z',
        calendar: { name: 'Family', color: '#047857' },
      },
    })
  })
  await page.route(`**/api/link/${SLUG}/events?**`, (route) =>
    route.fulfill({
      json: {
        objects: [
          {
            data: vcalendar('one', '20261029T090000Z', '20261029T100000Z', [
              'SUMMARY:School run',
              'LOCATION:Main gate',
            ]),
            blocked: false,
          },
          { data: vcalendar('two', '20261029T130000Z', '20261029T140000Z'), blocked: true },
        ],
      },
    }),
  )
}

async function openLinkPage(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await answerApi(page)
  await page.clock.setFixedTime(TODAY)
  await page.goto(`/link/${SLUG}`)
  await expect(page.getByRole('heading', { name: 'A shared calendar' })).toBeVisible()
  return errors
}

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test.describe('the page of a calendar link', () => {
  test('asks for the password, says when it is wrong, and passes axe', async ({ page }) => {
    const errors = await openLinkPage(page)
    expect(await noSidewaysScroll(page)).toBe(true)
    expect(await scan(page)).toEqual([])
    await page.getByRole('textbox', { name: /^Password/ }).fill('wrong one!')
    await press(page.getByRole('button', { name: 'Open calendar' }))
    await expect(page.getByRole('alert')).toContainText('The password is not right.')
    await expect(page.getByRole('textbox', { name: /^Password/ })).toBeFocused()
    expect(errors).toEqual([])
  })

  test('shows the calendar alone and read-only, with a menu of looks only', async ({ page }) => {
    const errors = await openLinkPage(page)
    await page.getByRole('textbox', { name: /^Password/ }).fill(PASSWORD)
    await press(page.getByRole('button', { name: 'Open calendar' }))
    const main = page.locator('[data-calendar-main]')
    await expect(main).toBeVisible()
    await press(page.getByRole('button', { name: 'Day', exact: true }))
    await expect(main).toContainText('School run')
    // the object the server marked private is there, as busy
    await expect(main).toContainText('Busy')
    await expect(page.getByRole('button', { name: /sidebar/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Quick add' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0)
    expect(await noSidewaysScroll(page)).toBe(true)
    // FullCalendar's own grid has known gaps (e2e/axe-scan.ts); everything else must pass.
    expect(await scan(page)).toEqual([])

    await press(page.getByRole('button', { name: 'More options' }))
    await expect(page.getByRole('menuitemcheckbox', { name: /Dark mode/ })).toBeVisible()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Deutsch' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0)
    // the language changes at once
    await page.getByRole('menuitemcheckbox', { name: 'Deutsch' }).click()
    await expect(page.getByRole('button', { name: 'Tag', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('a click on a date adds nothing, and an event opens without Edit or Delete', async ({
    page,
  }) => {
    await openLinkPage(page)
    await page.getByRole('textbox', { name: /^Password/ }).fill(PASSWORD)
    await press(page.getByRole('button', { name: 'Open calendar' }))
    await press(page.getByRole('button', { name: 'Day', exact: true }))
    const main = page.locator('[data-calendar-main]')
    await expect(main).toContainText('School run')
    await press(main.getByText('School run').first())
    const sheet = page.getByRole('dialog')
    await expect(sheet).toContainText('Main gate')
    await expect(sheet.getByRole('button', { name: 'Edit' })).toHaveCount(0)
    await expect(sheet.getByRole('button', { name: 'Delete' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
