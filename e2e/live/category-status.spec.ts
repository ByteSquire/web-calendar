import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { openSignedIn } from './session'

// "Turn into a status…" with the real stack: alice has two events from an old system that marked
// them tentative with a category, one of them a weekly series with a changed occurrence. The dialog
// finds both, and turns the category into STATUS:TENTATIVE in Radicale, taking it away and keeping
// her other category. The test removes the events it made.
test.describe.configure({ mode: 'serial' })

const STAMP = Date.now()
const TAG = `Old tentative ${STAMP}`
const RADICALE = 'http://radicale:5232'
const DB_PATH = '/tmp/e2e-live.db'

let page: Page
let problems: string[] = []
let sub = ''

const path = (uid: string) => `/${sub}/def-calendar/${uid}.ics`
const single = `e2e-status-single-${STAMP}`
const series = `e2e-status-series-${STAMP}`

function wall(daysFromToday: number, hour: number): string {
  const day = new Date(Date.now() + daysFromToday * 86_400_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${day.getFullYear()}${pad(day.getMonth() + 1)}${pad(day.getDate())}T${pad(hour)}0000`
}

const ics = (uid: string, lines: string[], extra: string[] = []) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//old system//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20200101T000000Z',
    ...lines,
    'END:VEVENT',
    ...extra,
    'END:VCALENDAR',
    '',
  ].join('\r\n')

async function put(uid: string, text: string): Promise<void> {
  const response = await fetch(`${RADICALE}${path(uid)}`, {
    method: 'PUT',
    headers: { 'X-Remote-User': sub, 'Content-Type': 'text/calendar; charset=utf-8' },
    body: text,
  })
  expect(response.status).toBe(201)
}

const stored = async (uid: string) =>
  (await fetch(`${RADICALE}${path(uid)}`, { headers: { 'X-Remote-User': sub } })).text()

test.beforeAll(async ({ browser }) => {
  const session = await openSignedIn(browser, 'alice')
  page = session.page
  problems = session.problems
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  sub = (
    db.prepare("SELECT oidc_sub FROM users WHERE username = 'alice'").get() as { oidc_sub: string }
  ).oidc_sub
  db.close()
  await put(
    single,
    ics(single, [
      `DTSTART;TZID=Europe/Berlin:${wall(0, 9)}`,
      `DTEND;TZID=Europe/Berlin:${wall(0, 10)}`,
      'SUMMARY:Old single',
      `CATEGORIES:Work,${TAG}`,
    ]),
  )
  await put(
    series,
    ics(
      series,
      [
        `DTSTART;TZID=Europe/Berlin:${wall(0, 14)}`,
        `DTEND;TZID=Europe/Berlin:${wall(0, 15)}`,
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:Old series',
        `CATEGORIES:${TAG}`,
      ],
      [
        'BEGIN:VEVENT',
        `UID:${series}`,
        'DTSTAMP:20200101T000000Z',
        `RECURRENCE-ID;TZID=Europe/Berlin:${wall(7, 14)}`,
        `DTSTART;TZID=Europe/Berlin:${wall(7, 16)}`,
        `DTEND;TZID=Europe/Berlin:${wall(7, 17)}`,
        'SUMMARY:Old series moved',
        `CATEGORIES:${TAG}`,
        'END:VEVENT',
      ],
    ),
  )
  await page.reload()
})

test.afterAll(async () => {
  for (const uid of [single, series]) {
    await fetch(`${RADICALE}${path(uid)}`, { method: 'DELETE', headers: { 'X-Remote-User': sub } })
  }
  await page.context().close()
})

const sidebar = () => page.locator('#app-sidebar')

test('the dialog finds both events and changes nothing yet', async () => {
  await expect(sidebar().getByText(TAG, { exact: true })).toBeVisible()
  await sidebar()
    .getByRole('button', { name: `Actions for category ${TAG}`, exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Turn into a status…' }).click()
  const dialog = page.getByRole('dialog', { name: `Turn ${TAG} into a status` })
  await expect(dialog.locator('[data-category-status-found]')).toContainText(
    '2 events have this category.',
  )
  expect(await stored(single)).not.toContain('STATUS:')
})

test('Change sets the status in Radicale, takes the category away and keeps the other', async () => {
  const dialog = page.getByRole('dialog', { name: `Turn ${TAG} into a status` })
  await dialog.getByRole('radio', { name: 'Tentative' }).check({ force: true })
  await expect(
    dialog.getByRole('checkbox', { name: `Remove ${TAG} from these events` }),
  ).toBeChecked()
  await dialog.getByRole('button', { name: 'Change 2 events' }).click()
  await expect(dialog.locator('[data-category-status-done]')).toContainText(
    '2 events were changed.',
  )

  const one = await stored(single)
  expect(one).toContain('STATUS:TENTATIVE')
  expect(one).toMatch(/CATEGORIES:Work\r\n/)
  expect(one).not.toContain(TAG)
  const many = await stored(series)
  expect(many.match(/STATUS:TENTATIVE/g)).toHaveLength(2)
  expect(many).not.toContain(TAG)
  expect(many).toContain('RRULE:FREQ=WEEKLY;COUNT=3')

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // no event carries the name any more, so it leaves the list
  await expect(sidebar().getByText(TAG, { exact: true })).toHaveCount(0)
})

test('no script or console errors came up', () => {
  expect(problems).toEqual([])
})
