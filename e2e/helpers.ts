import { expect, test, type Locator, type Page } from '@playwright/test'

/** The date the mock data is anchored to: Thursday 29 October 2026, in the week of Mon 26 Oct. */
export const TODAY = new Date('2026-10-29T10:00:00+01:00')

export const VIEW_TYPES = ['Day', '5 days', 'Week', 'Month', 'Year', 'Split', 'List'] as const

export interface OpenedApp {
  /** Page errors and console errors collected since the page opened. */
  errors: string[]
}

/** Open the app with a fixed clock (`now`, default `TODAY`); resolves when the calendar area is there. */
export async function openApp(page: Page, now: Date = TODAY): Promise<OpenedApp> {
  const errors: string[] = []
  // WebKit reports "ResizeObserver loop completed with undelivered notifications" when
  // FullCalendar lays out inside its own observer callback. The spec defines it as non-fatal.
  const benign = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/
  page.on('pageerror', (error) => {
    if (!benign.test(error.message)) errors.push(error.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.clock.setFixedTime(now)
  await page.goto('/')
  await expect(page.locator('[data-calendar-main]')).toBeVisible()
  return { errors }
}

export function isTouch(): boolean {
  return Boolean(test.info().project.use.hasTouch)
}

/** Tap on touch projects, click otherwise. Both scroll the element into view first. */
export async function press(locator: Locator): Promise<void> {
  if (isTouch()) await locator.tap()
  else await locator.click()
}

/**
 * Where the focus is once a dialog has opened: on `control` (its first or safest one), or, on a
 * touch screen, on the dialog itself, so that no keyboard opens and no ring shows under the finger.
 */
export async function expectOpenFocus(dialog: Locator, control: Locator): Promise<void> {
  if (isTouch()) {
    await expect(dialog).toBeFocused()
    await expect(control).not.toBeFocused()
  } else {
    await expect(control).toBeFocused()
  }
}

export function viewButton(page: Page, name: (typeof VIEW_TYPES)[number]): Locator {
  return page.getByRole('group', { name: 'View type' }).getByRole('button', { name, exact: true })
}

export async function switchView(page: Page, name: (typeof VIEW_TYPES)[number]): Promise<void> {
  await press(viewButton(page, name))
  await expect(viewButton(page, name)).toHaveAttribute('aria-pressed', 'true')
}

/** The calendar area that holds the standard views; the split view has its own container. */
export function viewport(page: Page): { width: number; height: number } {
  const size = page.viewportSize()
  if (!size) throw new Error('no viewport')
  return size
}

/** A touch of `radius` px at the point, sent as Chromium sends the finger of a real phone. */
async function touch(page: Page, x: number, y: number, radius: number): Promise<void> {
  const session = await page.context().newCDPSession(page)
  const point = { x, y, radiusX: radius, radiusY: radius }
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await session.detach()
}

/** A touch where the touch screen is the input, a mouse press elsewhere, at the point. */
export async function pointAt(page: Page, x: number, y: number, radius = 1): Promise<void> {
  if (isTouch()) {
    await touch(page, x, y, radius)
    return
  }
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.up()
}

/**
 * Wait for the dialogs a gesture opens: a second one would show up within this time. A modal
 * hides the others from the accessibility tree, so they are found by their markup, not by role.
 */
export async function settledDialogs(page: Page): Promise<string[]> {
  await page.waitForTimeout(600)
  return page
    .locator('[role="dialog"]')
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute('aria-label') ?? item.textContent?.slice(0, 20) ?? ''),
    )
}

export async function closeDialogs(page: Page): Promise<void> {
  while ((await page.locator('[role="dialog"]').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
}
