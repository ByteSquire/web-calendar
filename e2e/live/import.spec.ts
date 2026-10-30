import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openSignedIn } from './session'

// FR-7 (the file half) with the real stack (design S8 setup: the production build with the login
// ON, Kanidm and Radicale): in Settings choose an .ics file, read the preview, import it into
// alice's first calendar, import it again ("already there"), find the events in the calendar
// without a reload, and delete them again through the event sheet. The file holds a single event,
// a weekly series with one changed occurrence and a to-do, which is not imported. The test removes
// what it made; a run that fails half-way leaves events titled "E2E import <number>" behind. The
// tests share one signed-in page, in order, as in event-write.spec.ts.
test.describe.configure({ mode: 'serial' })

const STAMP = Date.now()
const SINGLE = `E2E import ${STAMP}`
const SERIES = `E2E import series ${STAMP}`
const MOVED = `${SERIES} (second)`

/** A date in Berlin, where the browser context runs, as `YYYYMMDD`. */
const berlinDay = (daysFromNow: number): string =>
  new Date(Date.now() + daysFromNow * 86_400_000)
    .toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
    .replace(/-/g, '')

const BERLIN = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
]

const FILE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//web-calendar//e2e import//EN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:E2E import file',
  ...BERLIN,
  'BEGIN:VEVENT',
  `UID:e2e-import-single-${STAMP}@example.test`,
  'DTSTAMP:20261001T080000Z',
  `SUMMARY:${SINGLE}`,
  `DTSTART;TZID=Europe/Berlin:${berlinDay(0)}T140000`,
  `DTEND;TZID=Europe/Berlin:${berlinDay(0)}T150000`,
  'END:VEVENT',
  'BEGIN:VEVENT',
  `UID:e2e-import-series-${STAMP}@example.test`,
  'DTSTAMP:20261001T080000Z',
  `SUMMARY:${SERIES}`,
  `DTSTART;TZID=Europe/Berlin:${berlinDay(0)}T110000`,
  `DTEND;TZID=Europe/Berlin:${berlinDay(0)}T120000`,
  'RRULE:FREQ=WEEKLY;COUNT=2',
  'END:VEVENT',
  'BEGIN:VEVENT',
  `UID:e2e-import-series-${STAMP}@example.test`,
  'DTSTAMP:20261001T080000Z',
  `SUMMARY:${MOVED}`,
  `RECURRENCE-ID;TZID=Europe/Berlin:${berlinDay(7)}T110000`,
  `DTSTART;TZID=Europe/Berlin:${berlinDay(7)}T130000`,
  `DTEND;TZID=Europe/Berlin:${berlinDay(7)}T140000`,
  'END:VEVENT',
  'BEGIN:VTODO',
  `UID:e2e-import-todo-${STAMP}@example.test`,
  'DTSTAMP:20261001T080000Z',
  'SUMMARY:Not an event',
  'END:VTODO',
  'END:VCALENDAR',
  '',
].join('\r\n')

let page: Page
let problems: string[] = []

test.beforeAll(async ({ browser }) => {
  const session = await openSignedIn(browser, 'alice')
  page = session.page
  problems = session.problems
})

test.afterAll(async () => {
  await page.context().close()
})

const area = () => page.locator('[data-calendar-main]')
const section = () => page.getByRole('region', { name: 'Import a calendar file' })
const fileField = () => section().getByLabel('Calendar file', { exact: true })

/** Picks the file the way a person does: through the file field, with the keyboard-reachable input. */
async function chooseFile(): Promise<void> {
  await fileField().setInputFiles({
    name: 'e2e-import.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(FILE),
  })
}

/** WCAG 2.1 A and AA inside the section. */
async function scanSection(): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page })
    .include('section[aria-labelledby="settings-import"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  return violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  )
}

/** Buttons, text fields and select buttons are at least 44 px high and wide. */
async function expectTargetsAtLeast44(scope: Locator): Promise<void> {
  const small = await scope
    .locator('button, input, textarea, [role="combobox"]')
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const box = element.getBoundingClientRect()
          return (
            element.getAttribute('aria-hidden') !== 'true' &&
            box.width > 1 &&
            box.height > 1 &&
            (box.height < 43.5 || box.width < 43.5)
          )
        })
        .map((element) => {
          const box = element.getBoundingClientRect()
          const name =
            element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.id
          return `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`
        }),
    )
  expect(small).toEqual([])
}

test('Settings has the import section, with a labelled file field', async () => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(section().getByRole('heading', { level: 2 })).toHaveText('Import a calendar file')
  await expect(fileField()).toBeVisible()
  await expect(section()).toContainText('up to 5 MB and 2000 events')
  expect(await scanSection()).toEqual([])
  await expectTargetsAtLeast44(section())
})

test('shows what the file holds before anything is written', async () => {
  await chooseFile()
  await expect(section().getByRole('status')).toHaveText('File read: 2 events can be imported.')
  await expect(section()).toContainText('E2E import file')
  await expect(section().getByText(SINGLE, { exact: true })).toBeVisible()
  await expect(section().getByText(SERIES, { exact: true })).toBeVisible()
  // The to-do is counted and explained, not imported.
  await expect(section().getByText('1 to-do (only events are imported)')).toBeVisible()
  // The first calendar the person may write to is chosen, as in the quick-add dialog.
  await expect(section().getByLabel('Import into')).toContainText(/\S/)
  await expect(section().getByRole('button', { name: 'Import 2 events' })).toBeEnabled()
  expect(await scanSection()).toEqual([])
  await expectTargetsAtLeast44(section())
})

test('imports the events and says what happened', async () => {
  await section().getByRole('button', { name: 'Import 2 events' }).click()
  await expect(section().getByRole('heading', { level: 3, name: 'Import finished' })).toBeFocused()
  await expect(section().getByRole('status')).toHaveText('Imported 2 events.')
  expect(await scanSection()).toEqual([])
  await section().getByRole('button', { name: 'Done' }).click()
  await expect(fileField()).toBeFocused()
})

test('shows the events in the calendar without a reload, the changed occurrence a week later', async () => {
  await page.getByRole('link', { name: 'Back to calendar' }).click()
  await expect(area().getByText(SINGLE).first()).toBeVisible()
  await expect(area().getByText(SERIES, { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Next week' }).click()
  await expect(area().getByText(MOVED).first()).toBeVisible()
  await page.getByRole('button', { name: 'Previous week' }).click()
})

test('finds everything already there when the file is imported again', async () => {
  await page.goto('/settings')
  await chooseFile()
  await section().getByRole('button', { name: 'Import 2 events' }).click()
  await expect(section().getByRole('status')).toHaveText(
    'Nothing was imported. 2 events were already in the calendar.',
  )
  expect(await scanSection()).toEqual([])
  await section().getByRole('button', { name: 'Done' }).click()
  // A copy would survive the deletions below.
  await page.getByRole('link', { name: 'Back to calendar' }).click()
  await expect(area().getByText(SINGLE).first()).toBeVisible()
})

test('deletes the single event through the event sheet', async () => {
  await area().getByText(SINGLE).first().click()
  const sheet = page.getByRole('dialog', { name: SINGLE })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: `Delete "${SINGLE}"?` })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(page.getByText('Event deleted', { exact: true })).toBeVisible()
  await expect(area().getByText(SINGLE)).toHaveCount(0)
})

test('deletes the series with its changed occurrence: all events', async () => {
  await area().getByText(SERIES, { exact: true }).first().click()
  const sheet = page.getByRole('dialog', { name: SERIES })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Delete' }).click()
  const question = page.getByRole('dialog', { name: 'Delete repeating event' })
  await expect(question).toBeVisible()
  await question.getByRole('radio', { name: 'All events' }).click()
  await question.getByRole('button', { name: 'Continue' }).click()
  const confirm = page.getByRole('dialog', { name: `Delete "${SERIES}"?` })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(area().getByText(SERIES, { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Next week' }).click()
  await expect(area().getByText(MOVED)).toHaveCount(0)
  await page.getByRole('button', { name: 'Previous week' }).click()
})

test('no script or console errors came up', () => {
  // The browser logs every non-2xx answer; the 412s are the "already there" answers of the
  // second import, which the test expects.
  expect(problems.filter((message) => !/status of 412/.test(message))).toEqual([])
})
