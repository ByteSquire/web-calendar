import { expect, test, type Page } from '@playwright/test'
import { openApp, press, switchView } from './helpers'

// FR-29: the server's time zone (Europe/Berlin here) is the organization's. A viewer sees times in
// the zone of their own browser. The mock times are organization time: Sprint planning is Mon
// 26 Oct 10:00-11:30 and the Dentist Wed 28 Oct 17:00-18:00 in Berlin (CET, UTC+1), the trip to the
// coast is an all-day event on Sat 31 Oct and Sun 1 Nov. Sydney is on summer time (AEDT, UTC+11).

// 23:30 on Thu 29 Oct in Berlin is 09:30 on Fri 30 Oct in Sydney.
const LATE = new Date('2026-10-29T23:30:00+01:00')

const calendar = (page: Page) => page.locator('[data-calendar-main]')
const entry = (page: Page, title: string) =>
  calendar(page).locator('.app-evt', { hasText: title }).first()

test.describe('viewer in Sydney, organization in Berlin', () => {
  test.use({ timezoneId: 'Australia/Sydney' })

  test('"today" is the viewer\'s date, not the server\'s', async ({ page }) => {
    await openApp(page, LATE)
    await switchView(page, 'Day')
    await expect(page.locator('[aria-live="polite"]:visible').first()).toContainText(
      'Fri, 30 Oct 2026',
    )
  })

  test("FullCalendar's own today column and now line follow the viewer's zone", async ({
    page,
  }) => {
    await openApp(page, LATE)
    await switchView(page, 'Week')
    // The highlighted day is FullCalendar's own reading of "today" in its `timeZone`.
    const today = page.locator('[role="columnheader"][aria-current="date"]')
    await expect(today).toHaveAttribute('data-date', '2026-10-30')

    // Now is 09:30 in Sydney and the Standup (Mon, 09:00 Berlin) starts at 19:00 there. An hour is
    // 64 px (two 32 px slots), so the now line is 9.5 h = 608 px above the Standup's top edge. The
    // line is the only thin element of the day column below the all-day row.
    const gaps = await page.evaluate(() => {
      const standup = Array.from(document.querySelectorAll('.app-evt')).find((el) =>
        (el.textContent ?? '').includes('Standup'),
      )
      const header = document.querySelector('[role="columnheader"][aria-current="date"]')
      if (!standup || !header) return []
      const column = header.getBoundingClientRect()
      const standupTop = standup.getBoundingClientRect().y
      return Array.from(document.querySelectorAll('[data-calendar-main] div'))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.height > 0 && r.height <= 2 && Math.abs(r.x - column.x) < 3)
        .filter((r) => Math.abs(r.width - column.width) < 3)
        .map((r) => Math.round(standupTop - r.y))
    })
    expect(gaps.some((gap) => Math.abs(gap - 608) <= 1)).toBe(true)
  })

  test("timed events are drawn at the viewer's hour, and can move to another day", async ({
    page,
  }) => {
    await openApp(page, LATE)
    await switchView(page, 'Week')
    // 10:00 Berlin (UTC+1) is 20:00 in Sydney (UTC+11), on the same day.
    await expect(entry(page, 'Sprint planning')).toContainText('20:00')

    // 17:00 Wed 28 Oct in Berlin is 03:00 Thu 29 Oct in Sydney: it is on Thursday, not Wednesday.
    await switchView(page, 'Day')
    await press(page.getByRole('button', { name: 'Previous day' }))
    await expect(page.locator('[aria-live="polite"]:visible').first()).toContainText(
      'Thu, 29 Oct 2026',
    )
    await expect(entry(page, 'Dentist')).toContainText('03:00')
    await press(page.getByRole('button', { name: 'Previous day' }))
    await expect(page.locator('[aria-live="polite"]:visible').first()).toContainText(
      'Wed, 28 Oct 2026',
    )
    await expect(calendar(page).getByText('Dentist')).toHaveCount(0)
  })

  test('all-day events stay on their dates', async ({ page }) => {
    await openApp(page, LATE)
    await switchView(page, 'Day')
    // Today is Fri 30 Oct; the trip starts on Saturday.
    await expect(calendar(page).getByText('Trip to the coast')).toHaveCount(0)
    await press(page.getByRole('button', { name: 'Next day' }))
    await expect(page.locator('[aria-live="polite"]:visible').first()).toContainText(
      'Sat, 31 Oct 2026',
    )
    await expect(calendar(page).getByText('Trip to the coast').first()).toBeVisible()
  })

  test("the event sheet shows the viewer's time and the organization time", async ({ page }) => {
    await openApp(page, LATE)
    await switchView(page, 'Day')
    await press(page.getByRole('button', { name: 'Previous day' }))
    await press(entry(page, 'Dentist'))
    const sheet = page.getByRole('dialog', { name: 'Dentist' })
    await expect(sheet).toContainText('Thu, 29 Oct 2026')
    await expect(sheet).toContainText('03:00 – 04:00 (Australia/Sydney)')
    await expect(sheet).toContainText(
      'Organization time (Europe/Berlin): Wed, 28 Oct 2026, 17:00 – 18:00',
    )
  })
})

test.describe('viewer in the organization zone', () => {
  test.use({ timezoneId: 'Europe/Berlin' })

  test('times are as stored and the sheet has no second time', async ({ page }) => {
    await openApp(page, LATE)
    await switchView(page, 'Day')
    await expect(page.locator('[aria-live="polite"]:visible').first()).toContainText(
      'Thu, 29 Oct 2026',
    )
    await press(page.getByRole('button', { name: 'Previous day' }))
    await expect(entry(page, 'Dentist')).toContainText('17:00')
    await press(entry(page, 'Dentist'))
    const sheet = page.getByRole('dialog', { name: 'Dentist' })
    await expect(sheet).toContainText('17:00 – 18:00 (Europe/Berlin)')
    await expect(sheet).not.toContainText('Organization time')
  })
})
