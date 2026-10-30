import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
import { TODAY, press } from './helpers'

// The settings screen (FR-31 app tokens, FR-7 iCal subscriptions, account). The app runs in demo
// mode here, which serves the SPA without a login, and every `/api/**` call except the settings
// is answered by a small stateful stand-in for the server (MockApi) that gives the same answers
// and error bodies as the real routes (server/api/app-tokens/**, ical-subscriptions/**, me.get.ts).

interface MockToken {
  id: number
  label: string
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
  expired: boolean
}

interface MockSubscription {
  id: number
  ref: string
  name: string
  url: string
  color: string | null
  shared: boolean
}

interface MockReply {
  status: number
  body?: unknown
  /** A body that is text, such as the .ics of a subscription. */
  text?: string
}

interface MockCall {
  method: string
  path: string
  body: unknown
}

/** The routes the settings screen calls; `MockApi` answers these and nothing else. */
const MOCKED = /^\/api\/(me|app-tokens|ical-subscriptions)(\/|$)/

const SECRET = 'wcal_e2e_secret_0123456789abcdef0123456789abcdef'

/** What the real routes answer with for an error (h3 puts `data` into the body). */
const failure = (status: number, message: string, data?: unknown): MockReply => ({
  status,
  body: { statusCode: status, statusMessage: 'Error', message, data },
})

const invalid = (...fields: { field: string; message: string }[]): MockReply =>
  failure(400, 'The request is not valid', { fields })

const token = (id: number, label: string, extra: Partial<MockToken> = {}): MockToken => ({
  id,
  label,
  createdAt: '2026-09-01T08:00:00.000Z',
  expiresAt: '2027-09-01T08:00:00.000Z',
  lastUsedAt: null,
  expired: false,
  ...extra,
})

const subscription = (
  id: number,
  name: string,
  extra: Partial<MockSubscription> = {},
): MockSubscription => ({
  id,
  ref: `ics:${id}`,
  name,
  url: `https://example.org/${name.toLowerCase().replace(/\W+/g, '-')}.ics`,
  color: '#1d4ed8',
  shared: false,
  ...extra,
})

const calendarText = (events: number) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...Array.from({ length: events }, () => 'BEGIN:VEVENT\r\nEND:VEVENT'),
    'END:VCALENDAR',
    '',
  ].join('\r\n')

class MockApi {
  me = {
    id: 1,
    sub: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
    username: 'alice',
    name: 'Alice Example',
    email: 'alice@example.test',
    isAdmin: true,
    timeZone: null,
  }
  tokens: MockToken[] = [
    token(2, 'DAVx5', { lastUsedAt: '2026-10-28T17:30:00.000Z' }),
    token(1, 'Thunderbird'),
  ]
  limit = 10
  subscriptions: MockSubscription[] = [
    subscription(1, 'Holidays'),
    subscription(2, 'Company events', { shared: true, color: null }),
  ]
  /** The .ics served for a subscription; a reply makes it an error. */
  documents = new Map<number, string | MockReply>()
  /** Replies forced for `METHOD /path` until removed. */
  forced = new Map<string, MockReply>()
  calls: MockCall[] = []
  /** `/api` paths nothing here answers: the page asked for something this spec does not know. */
  unhandled: string[] = []
  private nextId = 100

  callsTo(method: string, path: string): MockCall[] {
    return this.calls.filter((call) => call.method === method && call.path === path)
  }

  async handle(route: Route): Promise<void> {
    const request = route.request()
    const path = new URL(request.url()).pathname
    // Only the settings' own routes are answered here. Everything else under /api is the app's
    // (the server settings that switch demo mode on, icons served by Nuxt Icon): let it through,
    // and note what else the page asks for so a new call shows up in the tests that check it.
    if (!MOCKED.test(path)) {
      if (!path.startsWith('/api/_nuxt_icon/') && path !== '/api/config') {
        this.unhandled.push(`${request.method()} ${path}`)
      }
      return route.fallback()
    }

    const method = request.method()
    const raw = request.postData()
    const call: MockCall = { method, path, body: raw ? JSON.parse(raw) : undefined }
    this.calls.push(call)

    const reply =
      this.forced.get(`${method} ${path}`) ?? this.answer(call) ?? failure(404, 'Not found')
    if (reply.text !== undefined) {
      return route.fulfill({
        status: reply.status,
        contentType: 'text/calendar; charset=utf-8',
        body: reply.text,
      })
    }
    return route.fulfill({
      status: reply.status,
      contentType: 'application/json',
      body: reply.body === undefined ? '' : JSON.stringify(reply.body),
    })
  }

  private answer({ method, path, body }: MockCall): MockReply | null {
    const fields = (body ?? {}) as Record<string, unknown>
    const tokenId = /^\/api\/app-tokens\/(\d+)$/.exec(path)
    const subscriptionId = /^\/api\/ical-subscriptions\/(\d+)(\/data)?$/.exec(path)

    if (method === 'GET' && path === '/api/me') return { status: 200, body: this.me }

    if (method === 'GET' && path === '/api/app-tokens') {
      return { status: 200, body: { tokens: this.tokens, limit: this.limit } }
    }
    if (method === 'POST' && path === '/api/app-tokens') {
      const label = typeof fields.label === 'string' ? fields.label.trim() : ''
      if (label === '') return invalid({ field: 'label', message: 'must not be empty' })
      if (label.length > 64) {
        return invalid({ field: 'label', message: 'must have at most 64 characters' })
      }
      if (this.tokens.filter((item) => !item.expired).length >= this.limit) {
        return failure(409, `At most ${this.limit} app tokens are allowed per user`, {
          code: 'limit_reached',
        })
      }
      const id = this.nextId++
      this.tokens = [token(id, label, { expiresAt: '2027-10-29T09:00:00.000Z' }), ...this.tokens]
      return {
        status: 201,
        body: { id, label, token: SECRET, expiresAt: '2027-10-29T09:00:00.000Z' },
      }
    }
    if (method === 'DELETE' && tokenId) {
      const id = Number(tokenId[1])
      if (!this.tokens.some((item) => item.id === id)) return failure(404, 'Not found')
      this.tokens = this.tokens.filter((item) => item.id !== id)
      return { status: 204 }
    }

    if (method === 'GET' && path === '/api/ical-subscriptions') {
      return { status: 200, body: { subscriptions: this.subscriptions } }
    }
    if (method === 'POST' && path === '/api/ical-subscriptions') {
      const created = subscription(this.nextId++, String(fields.name), {
        url: String(fields.url),
        color: (fields.color as string | null) ?? null,
      })
      this.subscriptions = [...this.subscriptions, created]
      return { status: 201, body: created }
    }
    if (subscriptionId) {
      const id = Number(subscriptionId[1])
      const current = this.subscriptions.find((item) => item.id === id)
      if (!current) return failure(404, 'Not found')
      if (method === 'GET' && subscriptionId[2]) {
        const document = this.documents.get(id) ?? calendarText(2)
        return typeof document === 'string' ? { status: 200, text: document } : document
      }
      if (method === 'PUT' && !current.shared) {
        const saved = { ...current, ...(fields as Partial<MockSubscription>) }
        this.subscriptions = this.subscriptions.map((item) => (item.id === id ? saved : item))
        return { status: 200, body: saved }
      }
      if (method === 'DELETE' && !current.shared) {
        this.subscriptions = this.subscriptions.filter((item) => item.id !== id)
        return { status: 204 }
      }
      return failure(404, 'Not found')
    }
    return null
  }
}

async function mockApi(page: Page, setup?: (api: MockApi) => void): Promise<MockApi> {
  const api = new MockApi()
  setup?.(api)
  await page.route('**/api/**', (route) => api.handle(route))
  // The browser's clipboard needs permissions that WebKit cannot grant: record what is written.
  await page.addInitScript(() => {
    const copied: string[] = []
    Object.defineProperty(window, '__copied', { value: copied })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    })
  })
  return api
}

/** What the page wrote to the (fake) clipboard. */
const copied = (page: Page) =>
  page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)

// The sidebar next to the page has headings and regions of its own: look in the page area only.
const main = (page: Page) => page.locator('main.main-area')

interface OpenedSettings {
  /** Page errors and console errors since the page opened. */
  errors: string[]
}

/** Opens /settings with a fixed clock and waits until the three sections have their data. */
async function openSettings(page: Page): Promise<OpenedSettings> {
  const errors: string[] = []
  const benign = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/
  page.on('pageerror', (error) => {
    if (!benign.test(error.message)) errors.push(error.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.clock.setFixedTime(TODAY)
  await page.goto('/settings')
  await expect(main(page).getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  for (const loading of ['Loading account details', 'Loading app tokens']) {
    await expect(main(page).getByText(loading)).toBeHidden()
  }
  await expect(main(page).getByText('Loading calendar subscriptions')).toBeHidden()
  return { errors }
}

/** Chromium reports every refused request ("Failed to load resource") as a console error. */
const withoutRefusedRequests = (errors: string[]) =>
  errors.filter((message) => !/^Failed to load resource/.test(message))

const accountSection = (page: Page) => main(page).getByRole('region', { name: 'Account' })
const tokensSection = (page: Page) => main(page).getByRole('region', { name: 'App tokens' })
const subscriptionsSection = (page: Page) =>
  main(page).getByRole('region', { name: 'iCal subscriptions' })
const tokenRow = (page: Page, label: string) =>
  page.getByRole('list', { name: 'Your app tokens' }).getByRole('listitem').filter({
    hasText: label,
  })
const subscriptionRow = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Your calendar subscriptions' }).getByRole('listitem').filter({
    hasText: name,
  })

// WCAG 2.1 A and AA (NFR-3), as far as an automated scan can tell. The same helper as a11y.spec.ts.
async function scan(page: Page) {
  // Dialogs fade in; axe would measure the colours of a half-transparent dialog. Endless animations
  // (spinners) are skipped, they never finish.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  )
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  return violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(' ')),
  }))
}

test.describe('settings: account', () => {
  test('shows who is signed in and the time zones, in demo mode with a notice', async ({
    page,
  }) => {
    const api = await mockApi(page)
    const { errors } = await openSettings(page)

    const account = accountSection(page)
    await expect(account.getByText('Alice Example')).toBeVisible()
    await expect(account.getByText('alice@example.test')).toBeVisible()
    await expect(account.getByText('Administrator')).toBeVisible()
    // The test browser runs in Berlin, the server's organization zone is Berlin too.
    await expect(account).toContainText(
      "Times are shown in Europe/Berlin (your browser's zone). Organization time zone: Europe/Berlin.",
    )
    await expect(page.getByText('Nothing is saved in demo mode')).toBeVisible()
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveCount(1)

    expect(api.unhandled).toEqual([])
    expect(errors).toEqual([])
  })
})

test.describe('settings: app tokens', () => {
  test('lists the tokens with their dates in the display zone', async ({ page }) => {
    await mockApi(page)
    await openSettings(page)
    const section = tokensSection(page)
    await expect(section).toContainText('/caldav/')
    await expect(section).toContainText('/.well-known/caldav')
    await expect(section.getByText('alice', { exact: true })).toBeVisible()

    const davx5 = tokenRow(page, 'DAVx5')
    // 08:00 UTC on 1 Sep 2026 is 10:00 in Berlin (summer time)
    await expect(davx5).toContainText('Tue, 1 Sep 2026, 10:00')
    await expect(davx5).toContainText('Wed, 28 Oct 2026, 18:30')
    await expect(tokenRow(page, 'Thunderbird')).toContainText('Never')
  })

  test('creates a token: the secret is shown once and is gone after Done', async ({ page }) => {
    const api = await mockApi(page)
    const { errors } = await openSettings(page)
    const section = tokensSection(page)

    await section.getByLabel('Label', { exact: true }).fill('iOS Calendar')
    await press(section.getByRole('button', { name: 'Create token' }))

    const secret = section.getByLabel('Token', { exact: true })
    await expect(secret).toHaveValue(SECRET)
    await expect(secret).toHaveAttribute('readonly', '')
    await expect(secret).toBeFocused()
    await expect(section).toContainText('shown only once')
    expect(api.callsTo('POST', '/api/app-tokens')[0]!.body).toEqual({ label: 'iOS Calendar' })
    // the list shows the new token, never its secret
    await expect(tokenRow(page, 'iOS Calendar')).toBeVisible()
    await expect(tokenRow(page, 'iOS Calendar')).not.toContainText(SECRET)

    await press(section.getByRole('button', { name: 'Copy' }))
    await expect(section.getByRole('status').filter({ hasText: 'Copied' })).toHaveText(
      'Copied to the clipboard.',
    )
    expect(await copied(page)).toEqual([SECRET])

    await press(section.getByRole('button', { name: 'Done' }))
    await expect(secret).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText(SECRET)
    expect(await page.content()).not.toContain(SECRET)
    await expect(section.getByLabel('Label', { exact: true })).toBeFocused()
    await expect(section.getByLabel('Label', { exact: true })).toHaveValue('')

    // after a reload there is no way back to it
    await page.reload()
    await expect(tokenRow(page, 'iOS Calendar')).toBeVisible()
    expect(await page.content()).not.toContain(SECRET)

    expect(errors).toEqual([])
  })

  test('refuses an empty or a too long label before asking the server', async ({ page }) => {
    const api = await mockApi(page)
    await openSettings(page)
    const section = tokensSection(page)
    const label = section.getByLabel('Label', { exact: true })

    await press(section.getByRole('button', { name: 'Create token' }))
    await expect(section.getByText('Enter a label, for example the name of the app.')).toBeVisible()
    await expect(label).toHaveAttribute('aria-invalid', 'true')
    await expect(label).toBeFocused()

    await label.fill('x'.repeat(65))
    await expect(section.getByText('The label can have at most 64 characters.')).toBeVisible()
    await label.fill('x'.repeat(64))
    await expect(section.getByText('at most 64 characters')).toHaveCount(0)
    expect(api.callsTo('POST', '/api/app-tokens')).toHaveLength(0)
  })

  test('disables creating at the limit and says why', async ({ page }) => {
    await mockApi(page, (api) => {
      api.tokens = Array.from({ length: 10 }, (_, index) => token(index + 1, `App ${index + 1}`))
    })
    await openSettings(page)
    const section = tokensSection(page)
    await expect(section.getByRole('button', { name: 'Create token' })).toBeDisabled()
    await expect(section.getByLabel('Label', { exact: true })).toBeDisabled()
    await expect(section).toContainText('You have 10 of 10 app tokens, which is the limit.')
    await expect(section).toContainText('Revoke a token to create another one.')
  })

  test('does not count expired tokens against the limit and marks them', async ({ page }) => {
    await mockApi(page, (api) => {
      api.tokens = [
        ...Array.from({ length: 9 }, (_, index) => token(index + 1, `App ${index + 1}`)),
        token(50, 'Old laptop', { expired: true }),
      ]
    })
    await openSettings(page)
    const section = tokensSection(page)
    await expect(section.getByRole('button', { name: 'Create token' })).toBeEnabled()
    await expect(tokenRow(page, 'Old laptop').getByText('Expired')).toBeVisible()
  })

  test('revokes a token after a confirmation', async ({ page }) => {
    const api = await mockApi(page)
    const { errors } = await openSettings(page)

    await press(page.getByRole('button', { name: 'Revoke token Thunderbird' }))
    const dialog = page.getByRole('dialog', { name: /Revoke token/ })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('This cannot be undone.')
    await press(dialog.getByRole('button', { name: 'Cancel' }))
    await expect(dialog).toBeHidden()
    await expect(tokenRow(page, 'Thunderbird')).toBeVisible()
    expect(api.callsTo('DELETE', '/api/app-tokens/1')).toHaveLength(0)

    await press(page.getByRole('button', { name: 'Revoke token Thunderbird' }))
    await press(dialog.getByRole('button', { name: 'Revoke token', exact: true }))
    await expect(dialog).toBeHidden()
    await expect(tokenRow(page, 'Thunderbird')).toHaveCount(0)
    await expect(tokensSection(page).getByRole('status').filter({ hasText: 'revoked' })).toHaveText(
      'Token “Thunderbird” revoked.',
    )
    expect(api.callsTo('DELETE', '/api/app-tokens/1')).toHaveLength(1)
    expect(errors).toEqual([])
  })

  test('the revoke dialog works with the keyboard: focus, Tab, Escape, confirm', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'WebKit does not Tab to buttons by default')
    await mockApi(page)
    await openSettings(page)

    const opener = page.getByRole('button', { name: 'Revoke token Thunderbird' })
    await opener.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: /Revoke token/ })
    await expect(dialog).toBeVisible()
    // the safe choice has focus
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()

    // Tab stays inside the dialog
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press('Tab')
      await expect(dialog.locator(':focus')).toHaveCount(1)
    }

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
    await expect(tokenRow(page, 'Thunderbird')).toBeVisible()

    // Enter on the button, Tab to "Revoke token", Enter: the token is gone and focus is not lost
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Revoke token', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(tokenRow(page, 'Thunderbird')).toHaveCount(0)
    await expect(main(page).getByRole('heading', { level: 2, name: 'App tokens' })).toBeFocused()
  })

  test('shows an alert with Retry when the list cannot be loaded', async ({ page }) => {
    const api = await mockApi(page, (mock) => {
      mock.forced.set('GET /api/app-tokens', failure(500, 'boom'))
    })
    await openSettings(page)
    const alert = tokensSection(page).getByRole('alert')
    await expect(alert).toContainText('Could not load your app tokens.')
    // the rest of the page is fine
    await expect(subscriptionRow(page, 'Holidays')).toBeVisible()

    api.forced.clear()
    await press(alert.getByRole('button', { name: 'Retry' }))
    await expect(tokenRow(page, 'DAVx5')).toBeVisible()
    await expect(tokensSection(page).getByRole('alert')).toHaveCount(0)
  })
})

test.describe('settings: iCal subscriptions', () => {
  test('lists own and shared subscriptions; a shared one cannot be changed', async ({ page }) => {
    await mockApi(page)
    await openSettings(page)
    const own = subscriptionRow(page, 'Holidays')
    await expect(own.getByRole('button', { name: 'Edit Holidays' })).toBeVisible()
    await expect(own.getByRole('button', { name: 'Delete Holidays' })).toBeVisible()
    await expect(own.getByText('https://example.org/holidays.ics')).toHaveAttribute(
      'title',
      'https://example.org/holidays.ics',
    )

    const shared = subscriptionRow(page, 'Company events')
    await expect(shared.getByText('Shared', { exact: true })).toBeVisible()
    await expect(shared.getByRole('button', { name: 'Check Company events' })).toBeVisible()
    await expect(shared.getByRole('button', { name: /^(Edit|Delete)/ })).toHaveCount(0)
  })

  test('adds a subscription, checks it and deletes it', async ({ page }) => {
    const api = await mockApi(page)
    const { errors } = await openSettings(page)
    const section = subscriptionsSection(page)

    await section.getByLabel('Name', { exact: true }).fill('Public holidays')
    await section
      .getByLabel('Address of the .ics file', { exact: true })
      .fill('webcal://example.org/de.ics')
    // the colour group is a radio group with named choices; Blue is chosen at first
    const colours = section.getByRole('group', { name: 'Colour' })
    await expect(colours.getByRole('radio', { name: 'Blue' })).toBeChecked()
    await press(colours.locator('label', { hasText: 'Green' }))
    await expect(colours.getByRole('radio', { name: 'Green' })).toBeChecked()
    await press(section.getByRole('button', { name: 'Add subscription' }))

    const row = subscriptionRow(page, 'Public holidays')
    await expect(row).toBeVisible()
    await expect(section.getByRole('status').filter({ hasText: 'added' })).toHaveText(
      'Subscription “Public holidays” added.',
    )
    expect(api.callsTo('POST', '/api/ical-subscriptions')[0]!.body).toEqual({
      name: 'Public holidays',
      url: 'webcal://example.org/de.ics',
      color: '#047857',
    })
    // the form is empty again
    await expect(section.getByLabel('Name', { exact: true })).toHaveValue('')

    await press(row.getByRole('button', { name: 'Check Public holidays' }))
    await expect(row.getByRole('status')).toContainText(/Works: 2 events, \d+ bytes\./)

    await press(row.getByRole('button', { name: 'Delete Public holidays' }))
    const dialog = page.getByRole('dialog', { name: /Delete/ })
    await expect(dialog).toBeVisible()
    await press(dialog.getByRole('button', { name: 'Delete subscription' }))
    await expect(dialog).toBeHidden()
    await expect(row).toHaveCount(0)
    // the first id the mock hands out
    expect(api.callsTo('DELETE', '/api/ical-subscriptions/100')).toHaveLength(1)
    expect(errors).toEqual([])
  })

  test('checks the form before asking the server', async ({ page }) => {
    const api = await mockApi(page)
    await openSettings(page)
    const section = subscriptionsSection(page)
    await press(section.getByRole('button', { name: 'Add subscription' }))
    await expect(section.getByText('Enter a name for the calendar.')).toBeVisible()
    await expect(section.getByText('Enter the address of the calendar.')).toBeVisible()
    await expect(section.getByLabel('Name', { exact: true })).toBeFocused()

    await section.getByLabel('Name', { exact: true }).fill('Odd')
    await section
      .getByLabel('Address of the .ics file', { exact: true })
      .fill('ftp://example.org/a.ics')
    await expect(
      section.getByText('The address must start with http://, https:// or webcal://.'),
    ).toBeVisible()
    expect(api.callsTo('POST', '/api/ical-subscriptions')).toHaveLength(0)
  })

  test('shows what the server rejects next to the input and the rest in an alert', async ({
    page,
  }) => {
    const api = await mockApi(page, (mock) => {
      mock.forced.set(
        'POST /api/ical-subscriptions',
        invalid({ field: 'url', message: 'must not point to a private or reserved network' }),
      )
    })
    await openSettings(page)
    const section = subscriptionsSection(page)
    await section.getByLabel('Name', { exact: true }).fill('Intranet')
    await section
      .getByLabel('Address of the .ics file', { exact: true })
      .fill('https://192.168.1.5/a.ics')
    await press(section.getByRole('button', { name: 'Add subscription' }))

    const url = section.getByLabel('Address of the .ics file', { exact: true })
    await expect(
      section.getByText(
        'This address points to a private or reserved network, which is not allowed.',
      ),
    ).toBeVisible()
    await expect(url).toHaveAttribute('aria-invalid', 'true')
    await expect(url).toBeFocused()
    await expect(subscriptionRow(page, 'Intranet')).toHaveCount(0)

    // a duplicate is also about the address
    api.forced.set(
      'POST /api/ical-subscriptions',
      failure(409, 'You already subscribed to this address', { code: 'duplicate' }),
    )
    await url.fill('https://example.org/holidays.ics')
    await press(section.getByRole('button', { name: 'Add subscription' }))
    await expect(section.getByText('You already subscribed to this address.')).toBeVisible()

    // the limit and other failures are not about an input
    api.forced.set(
      'POST /api/ical-subscriptions',
      failure(409, 'At most 50 calendar subscriptions are allowed per user', {
        code: 'limit_reached',
      }),
    )
    await press(section.getByRole('button', { name: 'Add subscription' }))
    await expect(section.getByRole('alert')).toContainText('At most 50 calendar subscriptions')
  })

  test('the Check button reports why a calendar cannot be fetched', async ({ page }) => {
    const api = await mockApi(page, (mock) => {
      mock.documents.set(1, failure(502, 'Bad Gateway', { reason: 'timeout' }))
    })
    await openSettings(page)
    const row = subscriptionRow(page, 'Holidays')
    await press(row.getByRole('button', { name: 'Check Holidays' }))
    await expect(row.getByRole('status')).toHaveText(
      'Check failed: The address did not answer in time.',
    )
    // once: the browser must not repeat a check that failed
    expect(api.callsTo('GET', '/api/ical-subscriptions/1/data')).toHaveLength(1)

    for (const [reason, text] of [
      ['blocked', 'private or reserved network'],
      ['not-ical', 'does not return an iCal calendar file'],
      ['http-404', 'HTTP 404 (not found)'],
    ] as const) {
      api.documents.set(1, failure(502, 'Bad Gateway', { reason }))
      await press(row.getByRole('button', { name: 'Check Holidays' }))
      await expect(row.getByRole('status')).toContainText(text)
    }
  })

  test('changes a subscription in a dialog that returns focus', async ({ page }) => {
    const api = await mockApi(page)
    await openSettings(page)
    const opener = page.getByRole('button', { name: 'Edit Holidays' })
    await press(opener)
    const dialog = page.getByRole('dialog', { name: 'Edit subscription' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused()
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Holidays')

    // Escape throws the changes away and focus goes back to the button
    await dialog.getByLabel('Name', { exact: true }).fill('Changed')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0)

    await press(opener)
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Holidays')
    await dialog.getByLabel('Name', { exact: true }).fill('Bank holidays')
    await press(dialog.getByRole('button', { name: 'Save changes' }))
    await expect(dialog).toBeHidden()
    await expect(subscriptionRow(page, 'Bank holidays')).toBeVisible()
    expect(api.callsTo('PUT', '/api/ical-subscriptions/1')[0]!.body).toMatchObject({
      name: 'Bank holidays',
    })
    await expect(page.getByRole('button', { name: 'Edit Bank holidays' })).toBeFocused()
  })

  test('the delete dialog works with the keyboard', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit does not Tab to buttons by default')
    const api = await mockApi(page)
    await openSettings(page)
    const opener = page.getByRole('button', { name: 'Delete Holidays' })
    await opener.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: /Delete/ })
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()

    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(subscriptionRow(page, 'Holidays')).toHaveCount(0)
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
    await expect(
      main(page).getByRole('heading', { level: 2, name: 'iCal subscriptions' }),
    ).toBeFocused()
  })

  test('arrow keys move through the colours', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit does not Tab to radio buttons by default')
    await mockApi(page)
    await openSettings(page)
    const colours = subscriptionsSection(page).getByRole('group', { name: 'Colour' })
    await colours.getByRole('radio', { name: 'Blue' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(colours.getByRole('radio', { name: 'Green' })).toBeChecked()
    await expect(colours.getByRole('radio', { name: 'Green' })).toBeFocused()
  })
})

test.describe('settings: when the API is not there', () => {
  test('renders with an alert and Retry in each section, without page errors', async ({ page }) => {
    const api = await mockApi(page, (mock) => {
      for (const path of ['/api/me', '/api/app-tokens', '/api/ical-subscriptions']) {
        mock.forced.set(`GET ${path}`, failure(401, 'Unauthorized'))
      }
    })
    const { errors } = await openSettings(page)
    const alerts = main(page).getByRole('alert')
    await expect(alerts).toHaveCount(3)
    for (const alert of await alerts.all()) {
      await expect(alert).toContainText('You are signed out')
      await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible()
    }
    // the page is still a page: forms, headings and the notice
    await expect(main(page).getByRole('heading', { level: 2 })).toHaveCount(3)
    await expect(page.getByText('Nothing is saved in demo mode')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create token' })).toBeEnabled()
    expect(withoutRefusedRequests(errors)).toEqual([])

    api.forced.clear()
    await press(alerts.first().getByRole('button', { name: 'Retry' }))
    await expect(accountSection(page).getByText('Alice Example')).toBeVisible()
  })

  test('survives a server that cannot be reached', async ({ page }) => {
    await page.route('**/api/**', (route) =>
      MOCKED.test(new URL(route.request().url()).pathname) ? route.abort() : route.fallback(),
    )
    const { errors } = await openSettings(page)
    const alerts = main(page).getByRole('alert')
    await expect(alerts).toHaveCount(3)
    await expect(alerts.first()).toContainText('could not be reached')
    expect(errors.filter((message) => !/Failed to load resource|net::/.test(message))).toEqual([])
  })
})

test.describe('settings: layout and accessibility', () => {
  test.describe('at 360 px', () => {
    test.use({ viewport: { width: 360, height: 640 } })

    test('has no horizontal scroll, even with long names, labels and addresses', async ({
      page,
    }) => {
      await mockApi(page, (api) => {
        api.tokens = [token(1, 'T'.repeat(64)), token(2, 'A label with several short words in it')]
        api.subscriptions = [
          subscription(1, 'N'.repeat(80), {
            url: `https://example.org/${'long-path-segment/'.repeat(40)}calendar.ics?token=${'x'.repeat(60)}`,
          }),
          subscription(2, 'Shared with everybody', { shared: true }),
        ]
      })
      await openSettings(page)
      // everything below the fold, too: the page scrolls inside `main`, never sideways
      for (const locator of [
        page.locator('main.main-area'),
        page.locator('html'),
        page.locator('body'),
      ]) {
        const { scroll, client } = await locator.evaluate((element) => ({
          scroll: element.scrollWidth,
          client: element.clientWidth,
        }))
        expect(scroll).toBeLessThanOrEqual(client)
      }

      // open the dialogs with the long names: they must fit as well
      await press(page.getByRole('button', { name: /^Revoke token T+$/ }))
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      const box = await dialog.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(360)
      const overflow = await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    })

    test('keeps the controls at least 44 px high and wide', async ({ page }) => {
      await mockApi(page)
      await openSettings(page)
      const small = await page
        .locator('main.main-area')
        .locator(
          'button:visible, a:visible, input:visible:not([type="radio"]), label:has(input[type="radio"])',
        )
        .evaluateAll((elements) =>
          elements
            .map((element) => {
              const box = element.getBoundingClientRect()
              return {
                name:
                  element.getAttribute('aria-label') ??
                  element.textContent?.trim().slice(0, 40) ??
                  element.tagName,
                w: Math.round(box.width),
                h: Math.round(box.height),
              }
            })
            .filter((item) => item.w < 44 || item.h < 44),
        )
      expect(small).toEqual([])
    })
  })

  test('has no WCAG A/AA violations: the page with data', async ({ page }) => {
    await mockApi(page)
    await openSettings(page)
    expect(await scan(page)).toEqual([])
  })

  test('has none with errors and alerts showing', async ({ page }) => {
    await mockApi(page, (api) => {
      api.forced.set('GET /api/app-tokens', failure(500, 'boom'))
      api.forced.set(
        'POST /api/ical-subscriptions',
        invalid({ field: 'url', message: 'has a host name that cannot be resolved' }),
      )
    })
    await openSettings(page)
    const section = subscriptionsSection(page)
    await press(section.getByRole('button', { name: 'Add subscription' }))
    await section.getByLabel('Name', { exact: true }).fill('Nowhere')
    await section
      .getByLabel('Address of the .ics file', { exact: true })
      .fill('https://nowhere.invalid/a.ics')
    await press(section.getByRole('button', { name: 'Add subscription' }))
    await expect(section.getByText('cannot be found')).toBeVisible()
    await expect(tokensSection(page).getByRole('alert')).toBeVisible()
    // the other kind of message: client side checks under the label
    await press(tokensSection(page).getByRole('button', { name: 'Create token' }))
    await expect(tokensSection(page).getByText('Enter a label')).toBeVisible()
    // and a result of the Check button, green and red
    await press(subscriptionRow(page, 'Holidays').getByRole('button', { name: 'Check Holidays' }))
    await expect(subscriptionRow(page, 'Holidays').getByRole('status')).toContainText('Works')
    expect(await scan(page)).toEqual([])
  })

  test('has none with the check failing', async ({ page }) => {
    await mockApi(page, (api) => {
      api.documents.set(1, failure(502, 'Bad Gateway', { reason: 'unreachable' }))
    })
    await openSettings(page)
    await press(subscriptionRow(page, 'Holidays').getByRole('button', { name: 'Check Holidays' }))
    await expect(subscriptionRow(page, 'Holidays').getByRole('status')).toContainText(
      'Check failed',
    )
    expect(await scan(page)).toEqual([])
  })

  test('has none with the new token showing', async ({ page }) => {
    await mockApi(page)
    await openSettings(page)
    const section = tokensSection(page)
    await section.getByLabel('Label', { exact: true }).fill('Thunderbird on the laptop')
    await press(section.getByRole('button', { name: 'Create token' }))
    await expect(section.getByLabel('Token', { exact: true })).toHaveValue(SECRET)
    await press(section.getByRole('button', { name: 'Copy' }))
    await expect(section.getByText('Copied to the clipboard.')).toBeVisible()
    expect(await scan(page)).toEqual([])
  })

  test('has none with a dialog open', async ({ page }) => {
    await mockApi(page)
    await openSettings(page)
    await press(page.getByRole('button', { name: 'Revoke token DAVx5' }))
    await expect(page.getByRole('dialog')).toBeVisible()
    expect(await scan(page)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()

    await press(page.getByRole('button', { name: 'Edit Holidays' }))
    await expect(page.getByRole('dialog', { name: 'Edit subscription' })).toBeVisible()
    expect(await scan(page)).toEqual([])
  })
})
