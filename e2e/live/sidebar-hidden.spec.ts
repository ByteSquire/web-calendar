import { expect, test, type Page } from '@playwright/test'
import { APP_ORIGIN, openSignedIn } from './session'

// Items hidden from the sidebar follow the account (FR-21), with the real stack: alice hides her
// own calendar, which is switched off and listed under "Hidden"; after a reload it is still there
// and still off, and /api/me names it. The eye puts it back, off, and she switches it on again.
// The test shows everything again at the end, and switches the calendar back on, through the API.
test.describe.configure({ mode: 'serial' })

const CALENDAR = 'Alice Example'

let page: Page
let bearer = ''
/** The ref of alice's calendar, as the hidden key names it; switched on again at the end. */
let calendarRef = ''

/** The bearer token the app sends (it is kept in memory, so it is read off a request). */
async function bearerOf(target: Page): Promise<string> {
  const request = target.waitForRequest(
    (candidate) => candidate.url().includes('/api/') && !!candidate.headers()['authorization'],
  )
  await target.goto('/')
  return (await request).headers()['authorization']!
}

async function api(method: string, path: string, data?: unknown) {
  const response = await page.request.fetch(`${APP_ORIGIN}${path}`, {
    method,
    headers: { authorization: bearer, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  })
  return { status: response.status(), body: (await response.json().catch(() => null)) as unknown }
}

const sidebar = () => page.getByRole('complementary', { name: 'Views and calendars' })
const section = (title: string) =>
  sidebar()
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })
const calendarSwitch = () => section('Calendars').getByRole('switch', { name: CALENDAR })
const eye = () => section('Hidden').getByRole('button', { name: `Unhide calendar ${CALENDAR}` })

/** The next save of a setting: the hidden list, or the calendar's visibility (sent 400 ms late). */
const saveOf = (path: string) =>
  page.waitForResponse(
    (response) => response.url().endsWith(path) && response.request().method() === 'PUT',
  )

async function reload(): Promise<void> {
  await page.reload()
  await expect(page.locator('[data-calendar-main]')).toBeVisible()
}

test.beforeAll(async ({ browser }) => {
  page = (await openSignedIn(browser, 'alice')).page
  bearer = await bearerOf(page)
})

test.afterAll(async () => {
  // Whatever a run left, also a failed one: nothing hidden, and the calendars switched on again
  // (the other specs need alice's calendar on).
  const me = (await api('GET', '/api/me')).body as { sidebarHidden?: string[] } | null
  const refs = new Set(
    (me?.sidebarHidden ?? [])
      .filter((key) => key.startsWith('calendar:'))
      .map((key) => key.slice('calendar:'.length)),
  )
  if (calendarRef) refs.add(calendarRef)
  for (const ref of refs) await api('PUT', '/api/calendar-prefs', { ref, visible: true })
  await api('PUT', '/api/me/sidebar-hidden', { hidden: [] })
  await page.context().close()
})

test('alice hides her calendar: it is off and under "Hidden", also after a reload', async () => {
  await expect(calendarSwitch()).toBeChecked()
  await sidebar()
    .getByRole('button', { name: `Actions for calendar ${CALENDAR}`, exact: true })
    .click()
  const saved = saveOf('/api/me/sidebar-hidden')
  const off = saveOf('/api/calendar-prefs')
  await page.getByRole('menuitem', { name: 'Hide', exact: true }).click()
  expect((await saved).status()).toBe(200)
  expect((await off).request().postDataJSON()).toMatchObject({ visible: false })
  await expect(eye()).toBeVisible()
  await expect(calendarSwitch()).toHaveCount(0)

  await reload()
  await expect(eye()).toBeVisible()
  await expect(calendarSwitch()).toHaveCount(0)
  const me = (await api('GET', '/api/me')).body as { sidebarHidden: string[] }
  expect(me.sidebarHidden).toHaveLength(1)
  expect(me.sidebarHidden[0]).toMatch(/^calendar:dav:/)
  calendarRef = me.sidebarHidden[0]!.slice('calendar:'.length)
})

test('the eye puts it back, still off, also after a reload; then she switches it on', async () => {
  const saved = saveOf('/api/me/sidebar-hidden')
  const off = saveOf('/api/calendar-prefs')
  await eye().click()
  expect((await saved).status()).toBe(200)
  expect((await off).request().postDataJSON()).toMatchObject({ visible: false })
  await expect(section('Hidden')).toHaveCount(0)
  await expect(calendarSwitch()).not.toBeChecked()

  await reload()
  await expect(section('Hidden')).toHaveCount(0)
  await expect(calendarSwitch()).not.toBeChecked()
  const on = saveOf('/api/calendar-prefs')
  await calendarSwitch().click()
  await expect(calendarSwitch()).toBeChecked()
  expect((await on).request().postDataJSON()).toMatchObject({ visible: true })
  expect(((await api('GET', '/api/me')).body as { sidebarHidden: string[] }).sidebarHidden).toEqual(
    [],
  )
})
