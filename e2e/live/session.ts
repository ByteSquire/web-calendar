import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { testPassword } from './credentials'

// Shared by the real-login specs: a browser context for the app, the Kanidm sign-in and a
// collector for the app's own script and console errors.

export const APP_ORIGIN = 'http://localhost:3400'

export async function newAppContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: APP_ORIGIN,
    ignoreHTTPSErrors: true,
    locale: 'en-GB',
    timezoneId: 'Europe/Berlin',
  })
}

/**
 * Script and console errors that come from the app. Kanidm's own pages are not ours to judge (its
 * login page logs a duplicated `frame-ancestors` directive, for example).
 */
export function collectAppProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('pageerror', (error) => {
    if (page.url().startsWith(APP_ORIGIN)) problems.push(`pageerror: ${error.message}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && message.location().url.startsWith(APP_ORIGIN)) {
      problems.push(`console: ${message.text()}`)
    }
  })
  return problems
}

/** The username and password steps of Kanidm's login page, then its one-time consent prompt. */
export async function signInAtKanidm(page: Page, user: 'alice' | 'bob'): Promise<void> {
  await page.waitForURL(/idm\.localhost:8443/)
  await page.locator('#username').fill(user)
  await page.getByRole('button', { name: 'Begin' }).click()
  await page.locator('#password').fill(testPassword(user))
  await page.getByRole('button', { name: 'Submit' }).click()
  const consent = page.getByRole('button', { name: /^(permit|allow|accept|proceed)/i })
  if (await consent.isVisible({ timeout: 5000 }).catch(() => false)) await consent.click()
}

export async function waitForSignedInApp(page: Page): Promise<void> {
  await page.waitForURL((url) => url.origin === APP_ORIGIN && !url.pathname.startsWith('/auth/'))
  await expect(page.locator('[data-calendar-main]')).toBeVisible()
}

/** A new context, signed in at Kanidm as `user`, on the app's calendar. */
export async function openSignedIn(
  browser: Browser,
  user: 'alice' | 'bob' = 'alice',
): Promise<{ page: Page; problems: string[] }> {
  const page = await (await newAppContext(browser)).newPage()
  const problems = collectAppProblems(page)
  await page.goto('/')
  await signInAtKanidm(page, user)
  await waitForSignedInApp(page)
  return { page, problems }
}
