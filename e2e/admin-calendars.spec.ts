import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
import { TODAY, expectOpenFocus, press, settledDialogs, toast } from './helpers'

// Admin › Calendars (FR-14). The app runs in demo mode here, which serves the SPA without a login;
// `/api/me` and `/api/admin/access/**` are answered by a small stateful stand-in for the real routes
// (server/api/admin/access/**, me.get.ts), the links of the calendar included. The menu entry is
// hidden in demo mode, so the page is opened by its old address, /admin/access, which still leads
// there; most tests open the Team calendar's dialog on "Who has access".

interface MockRule {
  id: number
  principalType: 'user' | 'group' | 'authenticated'
  principal: string | null
  label: string
  permission: 'free_busy' | 'read' | 'write'
  applied: boolean
  appliedAt: string | null
}

const BOB = '11111111-1111-4111-8111-111111111111'

interface MockLink {
  id: number
  label: string
  calendarName: string
  calendarColor: string | null
  calendarId: number
  level: 'read' | 'free_busy'
  readsAs: 'maker' | 'owner'
  maker: string
  createdAt: string
  lastUsedAt: string | null
  slug: string | null
}

const FRONT_DESK_SLUG = 'F'.repeat(43)
const FRONT_DESK_PASSWORD = 'front desk secret'

class MockAccess {
  calls: { method: string; path: string; body: unknown }[] = []
  rules: MockRule[] = [
    {
      id: 1,
      principalType: 'user',
      principal: BOB,
      label: 'Bob Builder',
      permission: 'read',
      applied: true,
      appliedAt: '2026-11-01T10:00:00.000Z',
    },
    {
      id: 2,
      principalType: 'group',
      principal: 'staff',
      label: 'staff',
      permission: 'write',
      applied: false,
      appliedAt: null,
    },
  ]
  links: MockLink[] = [
    {
      id: 3,
      label: 'Front desk',
      calendarName: 'Team',
      calendarColor: null,
      calendarId: 5,
      level: 'free_busy',
      readsAs: 'maker',
      maker: 'Bob Builder',
      createdAt: '2026-11-01T10:00:00.000Z',
      lastUsedAt: null,
      slug: FRONT_DESK_SLUG,
    },
  ]
  passwords = new Map<number, string>([[3, FRONT_DESK_PASSWORD]])
  name = 'Team'
  deleted = false
  private nextId = 10

  constructor(readonly admin: boolean) {}

  private calendar() {
    return {
      id: 5,
      name: this.name,
      kind: 'shared',
      color: null,
      owner: null,
      group: null,
      rules: this.rules,
    }
  }

  async handle(route: Route): Promise<void> {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (path === '/api/me') {
      return route.fulfill({
        json: {
          id: 1,
          sub: 'sub-alice',
          username: 'alice',
          name: 'Alice Example',
          email: null,
          isAdmin: this.admin,
          timeZone: null,
        },
      })
    }
    if (path === '/api/groups') {
      return route.fulfill({
        json: {
          groups: [
            { id: 1, name: 'staff', source: 'app', memberCount: 3, member: true },
            { id: 2, name: 'parents', source: 'app', memberCount: 12, member: false },
          ],
        },
      })
    }
    if (!path.startsWith('/api/admin/access/')) return route.fallback()
    const raw = request.postData()
    const body: unknown = raw ? JSON.parse(raw) : undefined
    this.calls.push({ method, path, body })
    if (path === '/api/admin/access/calendars' && method === 'GET') {
      return route.fulfill({ json: { calendars: this.deleted ? [] : [this.calendar()] } })
    }
    if (path === '/api/admin/access/calendars/5' && method === 'PATCH') {
      this.name = (body as { name: string }).name
      return route.fulfill({ json: { calendar: this.calendar() } })
    }
    if (path === '/api/admin/access/calendars/5' && method === 'DELETE') {
      this.deleted = true
      return route.fulfill({ json: {} })
    }
    if (path === '/api/admin/access/users') {
      return route.fulfill({
        json: { users: [{ sub: BOB, name: 'Bob Builder', username: 'bob' }] },
      })
    }
    if (path === '/api/admin/access/calendars/5' && method === 'PUT') {
      const sent = (body as { rules: Omit<MockRule, 'id' | 'label' | 'applied' | 'appliedAt'>[] })
        .rules
      this.rules = sent.map((rule) => {
        const same = this.rules.find(
          (old) => old.principalType === rule.principalType && old.principal === rule.principal,
        )
        return same && same.permission === rule.permission
          ? same
          : {
              ...rule,
              id: this.nextId++,
              label: rule.principal ?? 'Everyone signed in',
              applied: false,
              appliedAt: null,
            }
      })
      return route.fulfill({ json: { changed: true, calendar: this.calendar() } })
    }
    if (path === '/api/admin/access/calendars/5/links' && method === 'GET') {
      return route.fulfill({ json: { links: this.links } })
    }
    if (path === '/api/admin/access/calendars/5/links' && method === 'POST') {
      const sent = body as { label?: string; level: 'read' | 'free_busy'; password: string }
      const link: MockLink = {
        id: this.nextId++,
        label: sent.label ?? 'Team',
        calendarName: 'Team',
        calendarColor: null,
        calendarId: 5,
        level: sent.level,
        readsAs: 'owner',
        maker: 'Alice Example',
        createdAt: '2026-11-05T10:00:00.000Z',
        lastUsedAt: null,
        slug: 'N'.repeat(43),
      }
      this.links = [link, ...this.links]
      this.passwords.set(link.id, sent.password)
      return route.fulfill({ status: 201, json: { link } })
    }
    const linkMatch = /^\/api\/admin\/access\/links\/(\d+)(\/reveal)?$/.exec(path)
    if (linkMatch) {
      const id = Number(linkMatch[1])
      const known = this.links.find((link) => link.id === id)
      if (!known) return route.fulfill({ status: 404, json: { statusCode: 404 } })
      if (linkMatch[2] && method === 'POST') {
        return route.fulfill({ json: { password: this.passwords.get(id) } })
      }
      if (!linkMatch[2] && method === 'DELETE') {
        this.links = this.links.filter((link) => link.id !== id)
        return route.fulfill({ json: { removed: { id } } })
      }
    }
    return route.fulfill({ status: 404, json: { statusCode: 404, message: 'Not found' } })
  }
}

async function openPage(page: Page, admin = true, openAccess = true) {
  const api = new MockAccess(admin)
  const errors: string[] = []
  const benign = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/
  page.on('pageerror', (error) => {
    if (!benign.test(error.message)) errors.push(error.message)
  })
  await page.route('**/api/**', (route) => api.handle(route))
  await page.clock.setFixedTime(TODAY)
  await page.goto('/admin/access')
  if (admin && openAccess) {
    await press(page.getByRole('button', { name: 'Access for Team' }))
    await expect(page.getByRole('dialog', { name: 'Team' })).toBeVisible()
  }
  return { api, errors }
}

const link = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Links' }).getByRole('listitem').filter({ hasText: name })

const reveals = (api: MockAccess) => api.calls.filter((call) => call.path.endsWith('/reveal'))

const rule = (page: Page, name: string) =>
  page.getByRole('list', { name: 'Access rules of Team' }).getByRole('listitem').filter({
    hasText: name,
  })

// The row that adds a rule: "Who", "Level" and "Add".
const addForm = (page: Page) => page.getByRole('form', { name: 'Add access' })
const addButton = (page: Page) => addForm(page).getByRole('button', { name: 'Add', exact: true })

test.describe('admin calendars', () => {
  test('sends somebody who is not an admin back to the calendar', async ({ page }) => {
    const { api } = await openPage(page, false)
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    expect(api.calls).toEqual([])
  })

  test('lists the calendars, renames one and deletes it after asking', async ({ page }) => {
    const { api, errors } = await openPage(page, true, false)
    await expect(page).toHaveURL(/\/admin\/access$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Calendars' })).toBeVisible()
    const row = page.locator('[data-admin-calendar]')
    await expect(row).toContainText('Calendar of the organization · 2 access rules')
    await press(page.getByRole('button', { name: 'Edit Team' }))
    const dialog = page.getByRole('dialog', { name: 'Team' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Front office')
    await press(dialog.getByRole('button', { name: 'Save changes' }))
    await expect(row).toContainText('Front office')
    await expect(toast(page, 'Front office was saved.')).toBeVisible()
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      name: 'Front office',
      color: null,
    })
    await press(page.getByRole('button', { name: 'Delete calendar' }))
    const confirm = page.getByRole('dialog', { name: 'Delete "Front office"?' })
    await expect(confirm).toContainText('deleted for everybody who has it')
    await press(confirm.getByRole('button', { name: 'Delete' }))
    await expect(row).toHaveCount(0)
    await expect(toast(page, 'Front office was deleted.')).toBeVisible()
    await expect(page.getByText('There are no calendars to manage yet.')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('lists the rules with who, what and whether they are applied', async ({ page }) => {
    await openPage(page)
    await expect(rule(page, 'Bob Builder')).toContainText('Can view')
    await expect(rule(page, 'Bob Builder')).toContainText('Applied')
    await expect(rule(page, 'staff')).toContainText('Can edit')
    await expect(rule(page, 'staff')).toContainText('Pending')
  })

  test('removes a rule', async ({ page }) => {
    const { api } = await openPage(page)
    await expect(rule(page, 'Bob Builder')).toBeVisible()
    await press(page.getByRole('button', { name: 'Remove Bob Builder from Team' }))
    await expect(rule(page, 'Bob Builder')).toHaveCount(0)
    await expect(toast(page, 'Bob Builder no longer has access.')).toBeVisible()
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(1)
  })

  test('adds access for a group chosen from the groups of the Groups page', async ({ page }) => {
    const { api } = await openPage(page)
    await expect(rule(page, 'staff')).toBeVisible()
    await press(addButton(page))
    await expect(addForm(page).getByText('Choose who gets access.')).toBeVisible()
    expect(api.calls.filter((call) => call.method === 'PUT')).toEqual([])

    // one list for everyone, the groups and the people, searched together
    await press(addForm(page).getByRole('button', { name: /^Who/ }))
    await page.getByLabel('Search people and groups').fill('par')
    await expect(page.getByRole('option')).toHaveText(['Group parents'])
    await press(page.getByRole('option', { name: 'Group parents' }))
    await press(addButton(page))
    await expect(rule(page, 'parents')).toContainText('Can view')
    await expect(toast(page, 'Access for parents is now: Can view.')).toBeVisible()
    // "Who" is cleared for the next one
    await expect(addForm(page).getByRole('button', { name: /^Who/ })).toContainText(
      'Choose a person or group',
    )
    const put = api.calls.find((call) => call.method === 'PUT')
    expect(put?.body).toMatchObject({
      rules: expect.arrayContaining([
        { principalType: 'group', principal: 'parents', permission: 'read' },
      ]),
    })
  })

  test('adds access for everyone signed in, pending until applied', async ({ page }) => {
    const { api } = await openPage(page)
    await expect(rule(page, 'staff')).toBeVisible()
    await press(addForm(page).getByRole('button', { name: /^Who/ }))
    await press(page.getByRole('option', { name: 'Everyone signed in' }))
    // the explanation of the level is under it all the time; only its words change
    await expect(addForm(page)).toContainText('Sees all events and their details.')
    await press(addForm(page).getByRole('combobox', { name: 'Level' }))
    await press(page.getByRole('option', { name: 'Busy times only' }))
    await expect(addForm(page)).toContainText('Sees when the calendar is busy')
    await press(addButton(page))
    await expect(rule(page, 'Everyone signed in')).toContainText('Busy times only')
    await expect(rule(page, 'Everyone signed in')).toContainText('Pending')
    const put = api.calls.find((call) => call.method === 'PUT')
    expect(put?.body).toMatchObject({
      rules: expect.arrayContaining([
        { principalType: 'authenticated', principal: null, permission: 'free_busy' },
      ]),
    })
  })

  test('lists the links first, and shows a password only when asked, hiding it again', async ({
    page,
  }) => {
    const { api } = await openPage(page)
    const row = link(page, 'Front desk')
    await expect(row).toContainText('Busy times only · created by Bob Builder in Settings')
    // the links come before the people and groups, and the row that adds one comes last
    const order = await page.evaluate(() => {
      const links = document.querySelector('[data-calendar-link]')!
      const rule = document.querySelector('[data-access-rule]')!
      const add = document.querySelector('form[aria-label="Add access"]')!
      return (
        (links.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
        (rule.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      )
    })
    expect(order).toBe(true)

    // the row has nothing of the password, not even dots
    await expect(row).not.toContainText('Hidden')
    await expect(row.getByRole('button')).toHaveCount(1)
    const opener = page.getByRole('button', { name: 'Details of Front desk' })
    await expect(opener).toHaveAttribute('aria-haspopup', 'dialog')
    await press(opener)
    // the details are a dialog of their own, over the access dialog
    const details = page.getByRole('dialog', { name: 'Front desk', exact: true })
    await expect(details).toBeVisible()
    await expect(details.getByRole('textbox', { name: 'Address of Front desk' })).toHaveValue(
      new RegExp(`/link/${FRONT_DESK_SLUG}$`),
    )
    await expect(details).toContainText('Hidden')
    expect(reveals(api)).toEqual([])

    const show = details.getByRole('button', { name: 'Show the password of Front desk' })
    await expect(show).toHaveAttribute('aria-pressed', 'false')
    await press(show)
    await expect(details.getByRole('textbox', { name: 'Password of Front desk' })).toHaveValue(
      FRONT_DESK_PASSWORD,
    )
    await expect(show).toHaveAttribute('aria-pressed', 'true')
    expect(reveals(api)).toHaveLength(1)
    await press(show)
    await expect(details.getByRole('textbox', { name: 'Password of Front desk' })).toHaveCount(0)
    await expect(show).toHaveAttribute('aria-pressed', 'false')

    // copying works, or says how to copy by hand
    await press(details.getByRole('button', { name: 'Copy the address of Front desk' }))
    await expect(details.getByRole('status')).toHaveText(/Copied to the clipboard|press Ctrl\+C/)

    // closing forgets the password; the access dialog is still there
    await page.keyboard.press('Escape')
    await expect(details).toBeHidden()
    await expect(page.getByRole('dialog', { name: 'Team' })).toBeVisible()
    await expect(opener).toBeFocused()
    expect(await page.content()).not.toContain(FRONT_DESK_PASSWORD)
  })

  test('creates a link with a level and a password, and shows it with the password hidden', async ({
    page,
  }) => {
    const { api } = await openPage(page)
    await expect(link(page, 'Front desk')).toBeVisible()
    await press(page.getByRole('button', { name: 'Create link' }))
    const form = page.getByRole('dialog', { name: 'New link' })
    await expectOpenFocus(form, form.getByRole('textbox', { name: 'Label' }))
    await form.getByRole('textbox', { name: 'Label' }).fill('For the parents')
    await press(form.getByRole('radio', { name: /^Busy times only/ }))
    await form.getByLabel(/^Password/).fill('short')
    await press(form.getByRole('button', { name: 'Create link' }))
    await expect(form).toContainText('Choose a password of at least 8 characters.')
    expect(api.calls.filter((call) => call.method === 'POST')).toEqual([])

    await form.getByLabel(/^Password/).fill('correct horse')
    await press(form.getByRole('button', { name: 'Create link' }))
    // the same dialog turns into the details of the new link, with the password hidden
    const details = page.getByRole('dialog', { name: 'For the parents', exact: true })
    await expect(details).toBeVisible()
    await expect(details).toContainText('Busy times only · created by Alice Example')
    await expect(details.getByRole('textbox', { name: 'Address of For the parents' })).toHaveValue(
      /\/link\/N{43}$/,
    )
    await expect(details.getByRole('textbox', { name: 'Address of For the parents' })).toBeFocused()
    await expect(details).toContainText('Hidden')
    await expect(toast(page, 'Link “For the parents” created.')).toBeVisible()
    const create = api.calls.find((call) => call.method === 'POST')
    expect(create?.body).toEqual({
      label: 'For the parents',
      level: 'free_busy',
      password: 'correct horse',
    })
    // the password just typed is shown without asking the server
    await press(details.getByRole('button', { name: 'Show the password of For the parents' }))
    await expect(details.getByRole('textbox', { name: 'Password of For the parents' })).toHaveValue(
      'correct horse',
    )
    expect(reveals(api)).toEqual([])

    await press(details.getByRole('button', { name: 'Done' }))
    await expect(details).toBeHidden()
    await expect(link(page, 'For the parents')).toContainText(
      'Busy times only · created by Alice Example',
    )
  })

  test('removes a link after asking', async ({ page }) => {
    const { api } = await openPage(page)
    await press(page.getByRole('button', { name: 'Details of Front desk' }))
    await press(page.getByRole('button', { name: 'Remove link Front desk' }))
    const dialog = page.getByRole('dialog', { name: 'Remove the link “Front desk”?' })
    await press(dialog.getByRole('button', { name: 'Remove link' }))
    // the confirmation and the details close; the access dialog stays
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(link(page, 'Front desk')).toHaveCount(0)
    await expect(page.getByText('There are no links to Team yet.')).toBeVisible()
    await expect(page.getByText('Link “Front desk” removed.', { exact: true })).toBeVisible()
    expect(api.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([
      '/api/admin/access/links/3',
    ])
  })

  test('fits the screen and has 44 px controls', async ({ page }) => {
    await openPage(page)
    await expect(rule(page, 'staff')).toBeVisible()
    // measured once the dialog has finished zooming in
    await settledDialogs(page)
    for (const name of [
      'Remove Bob Builder from Team',
      'Add',
      'Create link',
      'Details of Front desk',
    ]) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
    }
    for (const control of [
      addForm(page).getByRole('button', { name: /^Who/ }),
      addForm(page).getByRole('combobox', { name: 'Level' }),
    ]) {
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }
    // the details of a link are a dialog over the access dialog: it fits and has 44 px buttons
    await press(page.getByRole('button', { name: 'Details of Front desk' }))
    const details = page.getByRole('dialog', { name: 'Front desk', exact: true })
    await expect(details).toBeVisible()
    await settledDialogs(page)
    for (const dialog of await page.getByRole('dialog').all()) {
      const overflow = await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    }
    for (const name of [
      'Copy the address of Front desk',
      'Show the password of Front desk',
      'Copy the password of Front desk',
      'Remove link Front desk',
      'Done',
    ]) {
      const box = await details.getByRole('button', { name, exact: true }).boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
    }
  })

  test('has the search, "Show" and "New calendar" in one row of 44 px controls', async ({
    page,
  }) => {
    await openPage(page, true, false)
    const row = page.locator('[data-admin-calendar]')
    await expect(row).toHaveCount(1)
    const show = page.getByRole('combobox', { name: 'Show' })
    const controls = [
      page.getByRole('searchbox', { name: 'Search calendars' }),
      show,
      page.getByRole('button', { name: 'New calendar' }),
    ]
    for (const control of controls) {
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    }
    // "Show" filters by whom a calendar belongs to
    await press(show)
    await expect(page.getByRole('option')).toHaveText([
      'All',
      'People',
      'Organization',
      'Groups',
      'Resources',
    ])
    await press(page.getByRole('option', { name: 'People' }))
    await expect(row).toHaveCount(0)
    await expect(page.getByText('No calendar matches.')).toBeVisible()
    // nothing of the page's width is lost on a phone: the row wraps
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('has no accessibility violations', async ({ page }) => {
    await openPage(page)
    await expect(rule(page, 'staff')).toBeVisible()
    const violations = async () =>
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze()
      ).violations.map((violation) => violation.id)
    // with the details of a link open and its password shown
    await press(page.getByRole('button', { name: 'Details of Front desk' }))
    const details = page.getByRole('dialog', { name: 'Front desk', exact: true })
    await press(details.getByRole('button', { name: 'Show the password of Front desk' }))
    await expect(details.getByRole('textbox', { name: 'Password of Front desk' })).toBeVisible()
    await settledDialogs(page)
    expect(await violations()).toEqual([])
    await page.keyboard.press('Escape')
    await expect(details).toBeHidden()
    // and with the form for a new link
    await press(page.getByRole('button', { name: 'Create link' }))
    await expect(page.getByRole('dialog', { name: 'New link' })).toBeVisible()
    // scanned once the dialog has faded in
    await settledDialogs(page)
    expect(await violations()).toEqual([])
  })

  test('is not offered in the menu in demo mode', async ({ page }) => {
    await openPage(page)
    await page.goto('/')
    await expect(page.locator('[data-calendar-main]')).toBeVisible()
    await press(page.getByRole('button', { name: 'More options' }))
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Calendars' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'People' })).toHaveCount(0)
  })
})
