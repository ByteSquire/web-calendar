import { expect, test, type Page } from '@playwright/test'
import { isTouch, openApp, press } from './helpers'

// The sections of the sidebar in the order a person likes (FR-21). The demo has no server, so the
// order lives in the page; that it is saved for the account and comes back in another browser is
// checked against the real stack (tests/server/api-sidebar-order.test.ts covers the route).
// Dragging with a finger (a long press first) is checked with pointer events, not with a real
// touch screen: Playwright cannot press and hold.

// Where the sidebar is a drawer (a phone) it starts closed.
async function showSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open sidebar' })
  if (await open.isVisible()) await press(open)
}

// The drag tests run on the real clock. With the fixed clock of `openApp`, Vue skips a handler for an
// event that a handler further up (a dialog's) has stamped already, which a script-made touch event
// triggers.
async function openAppRealClock(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.locator('[data-calendar-main]')).toBeVisible()
  return errors
}

const headings = (page: Page) =>
  page
    .locator('section[data-section-id] h2')
    .evaluateAll((items) => items.map((item) => item.textContent?.trim()))

test.describe('the order of the sidebar sections', () => {
  test('moves a section with the arrow buttons and keeps the focus on the button', async ({
    page,
  }) => {
    const { errors } = await openApp(page)
    await showSidebar(page)
    expect(await headings(page)).toEqual([
      'Views',
      'Calendars',
      'Resources',
      'Categories',
      'Filters',
    ])

    await press(page.getByRole('button', { name: 'Arrange sections' }))
    await expect(page.getByRole('button', { name: 'Move Views up' })).toBeDisabled()
    await press(page.getByRole('button', { name: 'Move Filters up' }))
    await press(page.getByRole('button', { name: 'Move Filters up' }))
    await expect(page.getByRole('status').filter({ hasText: 'number 3 of 5' })).toBeAttached()
    await expect(page.getByRole('button', { name: 'Move Filters up' })).toBeFocused()
    await press(page.getByRole('button', { name: 'Done' }))

    expect(await headings(page)).toEqual([
      'Views',
      'Calendars',
      'Filters',
      'Resources',
      'Categories',
    ])
    await expect(page.getByRole('button', { name: 'Arrange sections' })).toBeFocused()
    expect(errors).toEqual([])
  })

  test('drags a section by its heading, with the others folded away while it moves', async ({
    page,
  }) => {
    test.skip(isTouch(), 'A mouse drag; the touch drag has its own test.')
    const errors = await openAppRealClock(page)
    const filters = page.getByRole('button', { name: 'Filters', exact: true })
    const views = page.getByRole('button', { name: 'Views', exact: true })
    await filters.scrollIntoViewIfNeeded()
    const box = (await filters.boundingBox())!
    const target = (await views.boundingBox())!

    await page.mouse.move(box.x + 30, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 30, box.y - 40, { steps: 4 })
    await expect(page.locator('section[data-dragging="true"]')).toHaveCount(1)
    // every section is only a heading now, so the whole list is in reach
    await expect(page.getByRole('button', { name: 'All staff', exact: true })).toBeHidden()
    const top = (await views.boundingBox())!
    await page.mouse.move(target.x + 30, top.y + 4, { steps: 6 })
    await page.mouse.up()

    await expect
      .poll(() => headings(page))
      .toEqual(['Filters', 'Views', 'Calendars', 'Resources', 'Categories'])
    // the drag did not fold the section it ended on, and the sections are open again
    await expect(filters).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('button', { name: 'All staff', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('puts a dragged section back on Escape', async ({ page }) => {
    test.skip(isTouch(), 'A mouse drag.')
    await openAppRealClock(page)
    const filters = page.getByRole('button', { name: 'Filters', exact: true })
    await filters.scrollIntoViewIfNeeded()
    const box = (await filters.boundingBox())!
    await page.mouse.move(box.x + 30, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 30, box.y - 40, { steps: 4 })
    // the sections are headings only now: go to the top one
    const views = (await page.getByRole('button', { name: 'Views', exact: true }).boundingBox())!
    await page.mouse.move(box.x + 30, views.y + 4, { steps: 6 })
    await expect
      .poll(() => headings(page))
      .not.toEqual(['Views', 'Calendars', 'Resources', 'Categories', 'Filters'])
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await headings(page)).toEqual([
      'Views',
      'Calendars',
      'Resources',
      'Categories',
      'Filters',
    ])
  })

  test('picks a section up after a long press on a touch screen and drops it higher', async ({
    page,
  }) => {
    test.skip(!isTouch(), 'Touch screens only.')
    await openAppRealClock(page)
    await showSidebar(page)
    const filters = page.getByRole('button', { name: 'Filters', exact: true })
    await filters.scrollIntoViewIfNeeded()
    const box = (await filters.boundingBox())!
    const x = box.x + 30
    const y = box.y + box.height / 2
    // Playwright cannot hold a finger down, so the events are sent: press, wait, move, let go.
    const send = (type: string, clientY: number) =>
      filters.evaluate(
        (element, args) => {
          element.dispatchEvent(
            new PointerEvent(args.type, {
              bubbles: true,
              cancelable: true,
              pointerId: 7,
              isPrimary: true,
              pointerType: 'touch',
              clientX: args.x,
              clientY: args.y,
            }),
          )
        },
        { type, x, y: clientY },
      )
    await send('pointerdown', y)
    await page.waitForTimeout(700)
    await expect(page.locator('section[data-dragging="true"]')).toHaveCount(1)
    const views = (await page.getByRole('button', { name: 'Views', exact: true }).boundingBox())!
    await page.evaluate(
      ({ clientX, clientY }) =>
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerId: 7,
            isPrimary: true,
            pointerType: 'touch',
            clientX,
            clientY,
          }),
        ),
      { clientX: x, clientY: views.y + 4 },
    )
    await expect
      .poll(() => headings(page))
      .toEqual(['Filters', 'Views', 'Calendars', 'Resources', 'Categories'])
    await page.evaluate(
      ({ clientX, clientY }) =>
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            pointerId: 7,
            isPrimary: true,
            pointerType: 'touch',
            clientX,
            clientY,
          }),
        ),
      { clientX: x, clientY: views.y + 4 },
    )
    await expect(page.locator('section[data-dragging]')).toHaveCount(0)
  })
})

test.describe('a real touch on a phone', () => {
  // Chromium's own touch path, through the DevTools protocol: touch start, hold, move, touch end.
  // It is the path on which the browser may take the gesture for a scroll and cancel the pointer.
  test('a finger that holds a heading and moves drags the section, and the sidebar does not scroll away from it', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium' || !isTouch(), 'Chromium with touch only.')
    await openAppRealClock(page)
    await showSidebar(page)
    const cancelled = await page.evaluate(() => {
      const seen = { count: 0 }
      window.addEventListener('pointercancel', () => (seen.count += 1))
      ;(window as unknown as { __cancelled: typeof seen }).__cancelled = seen
      return 0
    })
    expect(cancelled).toBe(0)
    const filters = page.getByRole('button', { name: 'Filters', exact: true })
    await filters.scrollIntoViewIfNeeded()
    const box = (await filters.boundingBox())!
    const x = box.x + 40
    const y = box.y + box.height / 2

    const cdp = await page.context().newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', touchY?: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: touchY === undefined ? [] : [{ x, y: touchY }],
      })
    await touch('touchStart', y)
    await page.waitForTimeout(700)
    await expect(page.locator('section[data-dragging="true"]')).toHaveCount(1)
    // every section is a heading now: go up to the first one
    const views = (await page.getByRole('button', { name: 'Views', exact: true }).boundingBox())!
    const target = views.y + 4
    for (let step = 1; step <= 6; step += 1) {
      await touch('touchMove', y + ((target - y) * step) / 6)
      await page.waitForTimeout(40)
    }
    await expect
      .poll(() => headings(page))
      .toEqual(['Filters', 'Views', 'Calendars', 'Resources', 'Categories'])
    await touch('touchEnd')
    await expect(page.locator('section[data-dragging]')).toHaveCount(0)
    expect(
      await page.evaluate(
        () => (window as unknown as { __cancelled: { count: number } }).__cancelled.count,
      ),
    ).toBe(0)
    expect(await headings(page)).toEqual([
      'Filters',
      'Views',
      'Calendars',
      'Resources',
      'Categories',
    ])
  })
})

test.describe('the plus in a section heading', () => {
  test('shows the field under the heading on a large screen and in a pop-up on a small one', async ({
    page,
  }) => {
    await openApp(page)
    await showSidebar(page)
    await press(page.getByRole('button', { name: 'Add category', exact: true }))
    const field = page.getByLabel('New category name', { exact: true })
    await expect(field).toBeVisible()
    await expect(field).toBeFocused()
    const dialog = page.getByRole('dialog', { name: 'Add category' })
    const viewport = page.viewportSize()!
    if (viewport.width < 768) {
      // a pop-up near the top of the screen, where the keyboard does not reach
      await expect(dialog).toBeVisible()
      const box = (await dialog.boundingBox())!
      expect(box.y).toBeLessThan(viewport.height / 4)
      await press(dialog.getByRole('button', { name: 'Cancel' }))
      await expect(dialog).toBeHidden()
    } else {
      await expect(dialog).toHaveCount(0)
      await field.press('Escape')
      await expect(field).toBeHidden()
    }
    await expect(page.getByRole('button', { name: 'Add category', exact: true })).toBeVisible()
  })

  test('the pop-up on a small screen closes with the Back gesture and leaves the drawer open', async ({
    page,
  }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, 'The pop-up is for small screens.')
    await openAppRealClock(page)
    await showSidebar(page)
    const drawer = page.getByRole('dialog', { name: 'Views and calendars' })
    const plus = page.getByRole('button', { name: 'Add category', exact: true })
    await press(plus)
    const popup = page.getByRole('dialog', { name: 'Add category' })
    await expect(popup).toBeVisible()
    await page.goBack()
    await expect(popup).toBeHidden()
    await expect(drawer).toBeVisible()
    await expect(plus).toBeFocused()

    // Cancel closes only the pop-up as well
    await press(plus)
    await expect(popup).toBeVisible()
    await press(popup.getByRole('button', { name: 'Cancel' }))
    await expect(popup).toBeHidden()
    await expect(drawer).toBeVisible()
    await expect(plus).toBeFocused()
  })
})
