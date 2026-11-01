import AxeBuilder from '@axe-core/playwright'
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

// FR-32: a time zone chosen in the settings beats the browser's. The app runs in demo mode here,
// which has no account to save the choice in: it lasts until the page is reloaded, and the calendar
// follows it at once. The account the settings page asks for is a stand-in (`/api/me` and the
// lists of the other sections); a PUT to the real route is covered by the Vitest suites.
// The browser is in Berlin like the organization: only the choice can put times in another zone.

const ME = {
  id: 1,
  sub: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
  username: 'alice',
  name: 'Alice Example',
  email: 'alice@example.test',
  isAdmin: false,
  timeZone: null,
}

const main = (page: Page) => page.locator('main.main-area')
const timeZoneSection = (page: Page) => main(page).getByRole('region', { name: 'Time zone' })
const accountSection = (page: Page) => main(page).getByRole('region', { name: 'Account' })

/** Opens /settings with a fixed clock; resolves when the time zone control is there. */
async function openSettings(page: Page, now: Date = LATE) {
  const errors: string[] = []
  const benign = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/
  page.on('pageerror', (error) => {
    if (!benign.test(error.message)) errors.push(error.message)
  })
  page.on('console', (message) => {
    // Chromium reports every refused request ("Failed to load resource"), also those of sections
    // of the page that are not the subject here and that this spec does not stand in for.
    if (message.type() === 'error' && !/^Failed to load resource/.test(message.text())) {
      errors.push(message.text())
    }
  })
  const puts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PUT') puts.push(request.url())
  })
  await page.route(/\/api\/(me|app-tokens|ical-subscriptions)$/, (route) => {
    const { pathname } = new URL(route.request().url())
    const body =
      pathname === '/api/me'
        ? ME
        : pathname === '/api/app-tokens'
          ? { tokens: [], limit: 10 }
          : { subscriptions: [] }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
  await page.clock.setFixedTime(now)
  await page.goto('/settings')
  await expect(main(page).getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(page.getByLabel('Show times in')).toBeVisible()
  return { errors, puts }
}

/**
 * Picks an entry of the open list and waits until the list is gone and the focus is back on its
 * button. That happens a moment after the pick and scrolls the page to the button on a phone, so a
 * tap made earlier (on "Back to calendar") would land on whatever is under the finger by then.
 */
async function pickZone(page: Page, option: string) {
  await press(page.getByRole('option', { name: option, exact: true }))
  await expect(page.getByRole('listbox')).toBeHidden()
  await expect(page.getByLabel('Show times in')).toBeFocused()
}

/** Opens the list of zones, looks for `search` and picks the entry called `option`. */
async function chooseZone(page: Page, search: string, option: string) {
  await press(page.getByLabel('Show times in'))
  await page.getByLabel('Search time zones').fill(search)
  await pickZone(page, option)
}

async function backToCalendar(page: Page) {
  await press(page.getByRole('link', { name: 'Back to calendar' }))
  await expect(page.locator('[data-calendar-main]')).toBeVisible()
}

const dateLabel = (page: Page) => page.locator('[aria-live="polite"]:visible').first()

test.describe('a time zone chosen in the settings', () => {
  test.use({ timezoneId: 'Europe/Berlin' })

  test('starts with the browser zone and names the organization zone', async ({ page }) => {
    const { errors } = await openSettings(page)
    await expect(page.getByLabel('Show times in')).toContainText("Browser's zone (Europe/Berlin)")
    await expect(timeZoneSection(page)).toContainText('Organization time zone: Europe/Berlin')
    await expect(accountSection(page)).toContainText(
      "Times are shown in Europe/Berlin (your browser's zone).",
    )
    expect(errors).toEqual([])
  })

  test('finds a zone by the words of its city and marks the organization zone', async ({
    page,
  }) => {
    await openSettings(page)
    await press(page.getByLabel('Show times in'))
    await page.getByLabel('Search time zones').fill('new york')
    await expect(page.getByRole('option')).toHaveText(['America/New_York'])

    await page.getByLabel('Search time zones').fill('berlin')
    await expect(
      page.getByRole('option', { name: 'Europe/Berlin (organization zone)' }),
    ).toBeVisible()

    await page.getByLabel('Search time zones').fill('atlantis')
    await expect(page.getByRole('option')).toHaveCount(0)
    await expect(page.getByText('No time zone matches your search.')).toBeVisible()
  })

  test('switches the calendar to the chosen zone, without a reload', async ({ page }) => {
    const { errors, puts } = await openSettings(page)
    await chooseZone(page, 'sydney', 'Australia/Sydney')

    await expect(timeZoneSection(page).getByRole('status').last()).toHaveText(
      'Times are now shown in Australia/Sydney.',
    )
    await expect(page.getByLabel('Show times in')).toContainText('Australia/Sydney')
    await expect(accountSection(page)).toContainText(
      'Times are shown in Australia/Sydney (your setting).',
    )

    // 23:30 on Thu 29 Oct in Berlin is 09:30 on Fri 30 Oct in Sydney: today is another date, and
    // the calendar that showed today shows the new today.
    await backToCalendar(page)
    await switchView(page, 'Day')
    await expect(dateLabel(page)).toContainText('Fri, 30 Oct 2026')

    // 10:00 Mon 26 Oct in Berlin (UTC+1) is 20:00 in Sydney (UTC+11).
    await switchView(page, 'Week')
    await expect(entry(page, 'Sprint planning')).toContainText('20:00')

    // All-day events stay on their dates.
    await switchView(page, 'Day')
    await press(page.getByRole('button', { name: 'Next day' }))
    await expect(dateLabel(page)).toContainText('Sat, 31 Oct 2026')
    await expect(calendar(page).getByText('Trip to the coast').first()).toBeVisible()

    expect(puts).toEqual([])
    expect(errors).toEqual([])
  })

  test("the event sheet shows the chosen zone and the organization's time", async ({ page }) => {
    await openSettings(page)
    await chooseZone(page, 'sydney', 'Australia/Sydney')
    await backToCalendar(page)
    await switchView(page, 'Day')
    await press(page.getByRole('button', { name: 'Previous day' }))
    await expect(dateLabel(page)).toContainText('Thu, 29 Oct 2026')

    // 17:00 Wed 28 Oct in Berlin is 03:00 Thu 29 Oct in Sydney.
    await press(entry(page, 'Dentist'))
    const sheet = page.getByRole('dialog', { name: 'Dentist' })
    await expect(sheet).toContainText('03:00 – 04:00 (Australia/Sydney)')
    await expect(sheet).toContainText(
      'Organization time (Europe/Berlin): Wed, 28 Oct 2026, 17:00 – 18:00',
    )
  })

  test("goes back to the browser's zone with the first choice", async ({ page }) => {
    await openSettings(page)
    await chooseZone(page, 'sydney', 'Australia/Sydney')
    await press(page.getByLabel('Show times in'))
    await pickZone(page, "Browser's zone (Europe/Berlin)")

    await expect(timeZoneSection(page).getByRole('status').last()).toHaveText(
      "Times are now shown in your browser's zone, Europe/Berlin.",
    )
    await expect(accountSection(page)).toContainText(
      "Times are shown in Europe/Berlin (your browser's zone).",
    )

    await backToCalendar(page)
    await switchView(page, 'Day')
    await expect(dateLabel(page)).toContainText('Thu, 29 Oct 2026')
    await press(page.getByRole('button', { name: 'Previous day' }))
    await expect(entry(page, 'Dentist')).toContainText('17:00')
  })

  test('is not kept in demo mode: a reload brings back the browser zone', async ({ page }) => {
    await openSettings(page)
    await chooseZone(page, 'sydney', 'Australia/Sydney')
    await expect(accountSection(page)).toContainText('(your setting)')

    await page.reload()
    await expect(page.getByLabel('Show times in')).toContainText("Browser's zone (Europe/Berlin)")
    await expect(accountSection(page)).toContainText("(your browser's zone)")
  })

  test('fits the screen, with a control of at least 44 px', async ({ page }) => {
    await openSettings(page)
    const box = await page.getByLabel('Show times in').boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    // The open list stays inside the screen as well.
    await press(page.getByLabel('Show times in'))
    const list = await page.getByRole('listbox').boundingBox()
    const width = page.viewportSize()!.width
    expect(list!.x).toBeGreaterThanOrEqual(0)
    expect(list!.x + list!.width).toBeLessThanOrEqual(width)
    const first = await page.getByRole('option').first().boundingBox()
    // 43.5: the same sub-pixel allowance as the other 44 px checks (a list item lays out at 43.86).
    expect(first!.height).toBeGreaterThanOrEqual(43.5)
  })

  test('has no accessibility violations (WCAG 2.1 A and AA)', async ({ page }) => {
    await openSettings(page)
    const scan = async () => {
      const { violations } = await new AxeBuilder({ page })
        .include('section[aria-labelledby="settings-time-zone"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      return violations.map((violation) => ({
        rule: violation.id,
        nodes: violation.nodes.map((node) => node.target.join(' ')),
      }))
    }
    expect(await scan()).toEqual([])

    await chooseZone(page, 'sydney', 'Australia/Sydney')
    await expect(timeZoneSection(page).getByRole('status').last()).toHaveText(
      'Times are now shown in Australia/Sydney.',
    )
    expect(await scan()).toEqual([])
  })
})
