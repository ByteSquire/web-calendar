import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
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
/** The newest tokens Kanidm's token endpoint sent to the page: the app keeps them in memory only. */
const tokens: { accessToken?: string; idToken?: string } = {}

test.beforeAll(async ({ browser }) => {
  page = await (await newAppContext(browser)).newPage()
  // Installed before the app loads so that the code's own `Date.now` is the controllable one; it
  // runs at real speed until a test moves it.
  await page.clock.install()
  problems = collectAppProblems(page)
  page.on('response', async (response) => {
    if (!response.url().includes('/oauth2/token')) return
    const body = (await response.json().catch(() => null)) as {
      access_token?: string
      id_token?: string
    } | null
    if (body?.access_token) tokens.accessToken = body.access_token
    if (body?.id_token) tokens.idToken = body.id_token
  })
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

/** alice's name, as the app knows it (the name the identity provider gives, else the username). */
function aliceName(): { sub: string; name: string } {
  const db = new Database('/tmp/e2e-live.db', { readonly: true, fileMustExist: true })
  try {
    const row = db
      .prepare("SELECT oidc_sub AS sub, name, username FROM users WHERE username = 'alice'")
      .get() as { sub: string; name: string | null; username: string }
    return { sub: row.sub, name: row.name || row.username }
  } finally {
    db.close()
  }
}

/** The name Radicale has for alice's first calendar (it trusts X-Remote-User on this network). */
async function firstCalendarName(sub: string): Promise<string | null> {
  const response = await fetch(`http://radicale:5232/${encodeURIComponent(sub)}/def-calendar/`, {
    method: 'PROPFIND',
    headers: { 'X-Remote-User': sub, Depth: '0', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
  })
  return /<displayname>([^<]*)</.exec(await response.text())?.[1] ?? null
}

test('the app shows the signed-in user and their own calendar, named after them', async () => {
  await menu().click()
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
  await expect(page.getByText('Times in Europe/Berlin')).toBeVisible()
  await page.keyboard.press('Escape')
  // alice's first calendar comes from Radicale through the gateway with her token; the app gave it
  // her name in place of Radicale's "Personal Calendar", in Radicale, so every CalDAV app shows it.
  const alice = aliceName()
  await expect(
    page.locator('#app-sidebar').getByRole('switch', { name: alice.name, exact: true }),
  ).toBeVisible()
  await expect.poll(() => firstCalendarName(alice.sub)).toBe(alice.name)
  await expect(page.locator('#app-sidebar')).not.toContainText('Personal Calendar')
})

test('a reload signs in again without asking for the password', async () => {
  await page.reload()
  await waitForSignedInApp(page)
  await expect(page.locator('#app-sidebar')).toContainText(aliceName().name)
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

test('the real ID token is no access token: the gateway and the API refuse it', async () => {
  expect(tokens.accessToken, 'the token response was seen').toBeTruthy()
  expect(tokens.idToken, 'the token response had an ID token').toBeTruthy()
  const ask = (token: string, method: string, path: string) =>
    page.request.fetch(path, { method, headers: { authorization: `Bearer ${token}`, depth: '0' } })
  // The access token Kanidm issued gets through both.
  expect((await ask(tokens.accessToken!, 'PROPFIND', '/caldav/')).status()).toBe(207)
  expect((await ask(tokens.accessToken!, 'GET', '/api/me')).status()).toBe(200)
  // Its ID token has the same issuer, keys, `aud` and `azp`, and no scope: refused as a bad token.
  const gateway = await ask(tokens.idToken!, 'PROPFIND', '/caldav/')
  expect(gateway.status()).toBe(401)
  expect(gateway.headers()['www-authenticate']).toContain('invalid_token')
  expect((await ask(tokens.idToken!, 'GET', '/api/me')).status()).toBe(401)
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
