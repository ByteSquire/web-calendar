import { expect, test, type Page } from '@playwright/test'
import {
  APP_ORIGIN,
  collectAppProblems,
  newAppContext,
  signInAtKanidm,
  waitForSignedInApp,
} from './session'

// Design S8: the real code + PKCE flow in a real browser against Kanidm, then the app on live data.
// The tests share one browser context (and so Kanidm's session cookie), in order.
test.describe.configure({ mode: 'serial' })

let page: Page
let problems: string[] = []

test.beforeAll(async ({ browser }) => {
  page = await (await newAppContext(browser)).newPage()
  // Installed before the app loads so that the code's own `Date.now` is the controllable one; it
  // runs at real speed until a test moves it.
  await page.clock.install()
  problems = collectAppProblems(page)
})

test.afterAll(async () => {
  await page.context().close()
})

const menu = () => page.getByRole('button', { name: 'More options' })

test('an unauthenticated visit goes to Kanidm and comes back signed in', async () => {
  await page.goto('/')
  await signInAtKanidm(page, 'alice')
  await waitForSignedInApp(page)
  // The login left no tokens or codes in the address bar.
  expect(page.url()).toBe(`${APP_ORIGIN}/`)
})

test('the app shows the signed-in user and their own calendar', async () => {
  await menu().click()
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
  await expect(page.getByText('Times in Europe/Berlin')).toBeVisible()
  await page.keyboard.press('Escape')
  // alice's default calendar comes from Radicale through the gateway with her token.
  await expect(page.locator('#app-sidebar')).toContainText('Personal Calendar')
})

test('a reload signs in again without asking for the password', async () => {
  await page.reload()
  await waitForSignedInApp(page)
  await expect(page.locator('#app-sidebar')).toContainText('Personal Calendar')
})

test('an expired access token is renewed with the refresh token', async () => {
  // Kanidm's access tokens last 15 minutes: move the browser's clock past that, then ask for a
  // reload of the events, which needs a token.
  const renewal = page.waitForRequest(
    (request) =>
      request.url().includes('/oauth2/token') &&
      (request.postData() ?? '').includes('grant_type=refresh_token'),
  )
  await page.clock.setSystemTime(new Date(Date.now() + 20 * 60_000))
  await menu().click()
  await page.getByRole('menuitem', { name: 'Refresh' }).click()
  await renewal
  // Still in the app, not sent to Kanidm, and the calendar list still loads.
  await expect(page.locator('[data-calendar-main]')).toBeVisible()
  expect(page.url().startsWith(APP_ORIGIN)).toBe(true)
  await page.reload()
  await waitForSignedInApp(page)
})

test('the settings page loads the user and their app tokens through the API', async () => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(page.locator('main.main-area')).toContainText('alice')
  await expect(page.getByRole('heading', { name: 'App tokens' })).toBeVisible()
})

test('signing out ends the session in this tab', async () => {
  await page.goto('/')
  await waitForSignedInApp(page)
  await menu().click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await page.waitForURL(`${APP_ORIGIN}/auth/signed-out`)
  await expect(page.getByRole('heading', { name: 'You are signed out' })).toBeVisible()
  // The app's tokens are gone: going back makes it start a new sign-in at Kanidm. Kanidm's own
  // session cookie survives (it has no end-session endpoint, and the page above says so), so
  // that sign-in completes without a password.
  const newSignIn = page.waitForRequest((request) => request.url().includes('/ui/oauth2'))
  await page.goBack()
  await newSignIn
  await waitForSignedInApp(page)
})

test('the app logged no script or console errors', () => {
  expect(problems).toEqual([])
})
