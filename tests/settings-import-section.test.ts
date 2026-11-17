// @vitest-environment nuxt
// FR-7 on the settings screen: choose an .ics file, see what it holds, import it into a calendar of
// one's own. The calendar service is a fake; the splitter, the checks and the runner are the real
// ones. The file is untrusted: nothing from it may be drawn as markup.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState, useState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import ImportSection from '~/components/settings/ImportSection.vue'
import { useCalendarState } from '~/composables/useCalendarState'
import { useServerConfigState } from '~/composables/useServerConfigState'
import type { Calendar } from '../shared/types/calendar'
import { DavError } from '../app/utils/caldav/errors'
import { MAX_FILE_BYTES } from '../app/utils/import/limits'
import { fixture } from './ical-read-helpers'

const WORK_HREF = '/caldav/alice/work/'
const calendars: Calendar[] = [
  {
    id: `dav:${WORK_HREF}`,
    name: 'Work',
    type: 'caldav',
    color: '#1d4ed8',
    defaultVisible: true,
    href: WORK_HREF,
  },
  {
    id: 'dav:/caldav/alice/shared/',
    name: 'Shared',
    type: 'caldav',
    color: '#047857',
    defaultVisible: true,
    href: '/caldav/alice/shared/',
    readOnly: true,
  },
  {
    id: 'ics:4',
    name: 'Holidays',
    type: 'ical',
    color: '#b45309',
    defaultVisible: true,
    readOnly: true,
    sourceUrl: 'https://example.org/h.ics',
  },
]

// A fake service behind a stable object: Nuxt's `provide` cannot be done twice.
interface Put {
  url: string
  data: string
  create?: boolean
  signal?: AbortSignal
}
const NEW_HREF = '/caldav/alice/0a1b2c3d/'
const service = {
  puts: [] as Put[],
  /** The calendars the section asked to make (MKCALENDAR), in order. */
  made: [] as { displayName: string }[],
  /** Makes the next calendar fail. */
  makeFails: null as DavError | null,
  invalidated: [] as string[],
  /** Holds every write until released, so a test can look at a run in progress. */
  hold: null as Promise<void> | null,
  fail: (_put: Put, _index: number): DavError | null => null,
}
const caldav = {
  client: {
    listCalendars: async () => [
      {
        url: WORK_HREF,
        displayName: 'Work',
        color: null,
        ctag: null,
        components: ['VEVENT'],
        readOnly: false,
      },
      // A calendar the section made is there afterwards.
      ...service.made.map((made) => ({
        url: NEW_HREF,
        displayName: made.displayName,
        color: null,
        ctag: null,
        components: ['VEVENT'],
        readOnly: false,
      })),
    ],
    createCalendar: async (args: { displayName: string }) => {
      if (service.makeFails) throw service.makeFails
      service.made.push({ displayName: args.displayName })
      return {
        url: NEW_HREF,
        displayName: args.displayName,
        color: null,
        ctag: null,
        components: ['VEVENT'],
        readOnly: false,
      }
    },
    putObject: async (put: Put) => {
      const index = service.puts.length
      service.puts.push(put)
      await service.hold
      if (put.signal?.aborted) throw new DavError('aborted', 'aborted')
      const failure = service.fail(put, index)
      if (failure) throw failure
      return { url: put.url, etag: '"1"' }
    },
  },
  reader: { invalidate: (url: string) => void service.invalidated.push(url) },
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const section = () => document.getElementById('settings-import')?.closest('section') ?? null
/** The dialog a chosen file opens: the preview, the choice of calendar, the progress, the result. */
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!
const chooseButton = () =>
  [...(section()?.querySelectorAll('button') ?? [])].find(
    (item) => text(item) === 'Choose file…',
  ) as HTMLButtonElement
const buttons = () => [...(dialog()?.querySelectorAll('button') ?? [])]
const button = (name: RegExp | string) =>
  buttons().find((item) =>
    typeof name === 'string' ? text(item) === name : name.test(text(item)),
  ) as HTMLButtonElement | undefined
const newNameInput = () =>
  dialog()?.querySelector<HTMLInputElement>('input[name="import-new-calendar"]') ??
  [...(dialog()?.querySelectorAll<HTMLInputElement>('input') ?? [])][0] ??
  null
const status = () => text(dialog()?.querySelector('[role="status"]'))
/** The terms and descriptions of the dialog's lists, by term. */
const details = () =>
  new Map(
    [...(dialog()?.querySelectorAll('dt') ?? [])].map((term) => [
      text(term),
      text(term.nextElementSibling),
    ]),
  )
const sourcesVersion = () => useState<number>('calendar-sources-version', () => 0).value

function useConfig(demo = false) {
  useServerConfigState().value = {
    oidc: { issuer: 'https://idm.example.org/oauth2', clientId: 'x', scope: 'openid' },
    timezone: 'Europe/Berlin',
    demo,
  }
}

function seedCalendars(list: Calendar[] = calendars) {
  const state = useCalendarState()
  state.calendars.value = list
  state.visibleCalendarIds.value = list.map((calendar) => calendar.id)
}

const Shell = defineComponent({
  render: () => h(UApp, null, { default: () => h(ImportSection) }),
})

let app: Awaited<ReturnType<typeof mountSuspended>> | undefined
let consoleWarn: MockInstance<typeof console.warn>
let consoleError: MockInstance<typeof console.error>

beforeAll(() => {
  useNuxtApp().provide('caldav', caldav)
})

beforeEach(() => {
  service.puts = []
  service.made = []
  service.makeFails = null
  service.invalidated = []
  service.hold = null
  service.fail = () => null
  clearNuxtState()
  useConfig()
  consoleWarn = vi.spyOn(console, 'warn')
  consoleError = vi.spyOn(console, 'error')
})

afterEach(() => {
  app?.unmount()
  app = undefined
  const warnings = consoleWarn.mock.calls.map((call) => call.map(String).join(' '))
  const errors = consoleError.mock.calls.map((call) => call.map(String).join(' '))
  vi.restoreAllMocks()
  clearNuxtState()
  document.body.innerHTML = ''
  // Any Vue warning is a bug.
  expect(errors).toEqual([])
  expect(warnings).toEqual([])
})

afterAll(() => {
  service.hold = null
})

async function mountSection(list: Calendar[] = calendars) {
  app = await mountSuspended(Shell, { attachTo: document.body })
  // After the mount, like the loader: the section follows the list as it arrives.
  seedCalendars(list)
}

/**
 * Picks a file the way the browser's file dialog does after "Choose file…": the focus is on that
 * button, the input's list changes, `change` fires.
 */
function choose(content: string, name = 'team.ics', type = 'text/calendar') {
  if (!dialog()) chooseButton().focus()
  const file = new File([content], name, { type })
  Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true })
  fileInput().dispatchEvent(new Event('change', { bubbles: true }))
  return file
}

async function chooseAndRead(content: string, name?: string) {
  choose(content, name)
  await vi.waitFor(() => expect(button(/^Import \d+ events?$/)).toBeDefined())
}

// ---------------------------------------------------------------------------------------------

describe('where it is shown', () => {
  it('is not drawn in demo mode, where there is no calendar service', async () => {
    useConfig(true)
    await mountSection()
    expect(section()).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  it('is not drawn without a sign-in provider (such an app cannot log in)', async () => {
    useServerConfigState().value = {
      oidc: { issuer: '', clientId: '', scope: '' },
      timezone: 'Europe/Berlin',
      demo: false,
    }
    await mountSection()
    expect(section()).toBeNull()
  })

  it('is a labelled section with a heading that can take the focus and "Choose file…"', async () => {
    await mountSection()
    const heading = document.getElementById('settings-import')!
    expect(heading.tagName).toBe('H2')
    expect(text(heading)).toBe('Import a calendar file')
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(section()?.getAttribute('aria-labelledby')).toBe('settings-import')

    // The button is the way to the file input, which is out of sight and out of the tab order.
    const choose = chooseButton()
    expect(choose.getAttribute('aria-haspopup')).toBe('dialog')
    const limits = document.getElementById(choose.getAttribute('aria-describedby')!)
    expect(text(limits)).toContain('up to 5 MB and 2000 events')
    expect(fileInput().accept).toContain('.ics')
    expect(fileInput().getAttribute('tabindex')).toBe('-1')
    expect(fileInput().getAttribute('aria-hidden')).toBe('true')
    const opened = vi.spyOn(fileInput(), 'click').mockImplementation(() => {})
    choose.click()
    expect(opened).toHaveBeenCalledTimes(1)
    // No dialog before a file is chosen.
    expect(dialog()).toBeNull()
  })

  it('does not change when a file is chosen: the file opens a dialog', async () => {
    await mountSection()
    const before = text(section())
    await chooseAndRead(fixture('import-mixed.ics'))
    expect(text(section())).toBe(before)
    expect(dialog()!.getAttribute('aria-labelledby')).toBeTruthy()
    expect(text(dialog())).toContain('Import a calendar file')
    const live = dialog()!.querySelector('[role="status"]')!
    expect(live.getAttribute('aria-live')).toBe('polite')
  })

  it('goes back to the start when the dialog is closed, with the file input emptied', async () => {
    await mountSection()
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    button('Cancel')!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(fileInput().value).toBe('')
    expect(service.puts).toEqual([])
    await vi.waitFor(() => expect(document.activeElement).toBe(chooseButton()))
    // a new choice starts afresh
    await chooseAndRead(fixture('import-mixed.ics'), 'projects.ics')
    expect(text(dialog())).toContain('projects.ics')
  })
})

describe('choosing a file', () => {
  it('shows what it holds: name, calendar name, events, titles and what is left out', async () => {
    await mountSection()
    await chooseAndRead(fixture('import-mixed.ics'), 'projects.ics')
    const card = text(dialog())
    expect(card).toContain('projects.ics')
    expect(details()).toEqual(
      new Map([
        ['Calendar name', 'Projects'],
        ['Events', '5'],
        ['Not imported', '7'],
      ]),
    )
    for (const title of ['Kick-off', 'No UID at all', 'Twice in the file (first)']) {
      expect(card).toContain(title)
    }
    for (const reason of [
      '1 to-do (only events are imported)',
      '1 event without a start time',
      '2 damaged items that could not be read',
    ]) {
      expect(card).toContain(reason)
    }
    expect(status()).toBe('File read: 5 events can be imported.')
    expect(button('Import 5 events')).toBeDefined()
    expect(service.puts).toEqual([])
  })

  it('offers the calendars the person may write to, the first one chosen', async () => {
    await mountSection()
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    const select = dialog()!.querySelector<HTMLElement>('[role="combobox"]')!
    expect(text(select)).toBe('Work')
    const label = [...dialog()!.querySelectorAll('label')].find((item) =>
      text(item).startsWith('Import into'),
    )
    expect(label).toBeDefined()
  })

  it('offers "New calendar…" after the calendars, and has no name field while a calendar is chosen', async () => {
    await mountSection()
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    expect(dialog()!.querySelector('input[name="import-new-calendar"]')).toBeNull()
    const select = dialog()!.querySelector<HTMLElement>('[role="combobox"]')!
    select.click()
    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]').length).toBe(2))
    expect([...document.querySelectorAll('[role="option"]')].map((item) => text(item))).toEqual([
      'Work',
      'New calendar…',
    ])
  })

  it('has "New calendar…" chosen when no calendar can take events, and the button works', async () => {
    // A read-only share and a subscription: neither takes events, but a new calendar can.
    await mountSection(calendars.slice(1))
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    expect(text(dialog())).not.toContain('None of your calendars can take new events.')
    await vi.waitFor(() => expect(newNameInput()).not.toBeNull())
    expect(button('Import 2 events')?.disabled).toBe(false)
    // The name starts as the calendar name of the file.
    expect(newNameInput()!.value).toBe('Team calendar')
  })

  it('shows a file that is too large, no calendar or no text as a message at the field', async () => {
    await mountSection()
    const big = new File(['BEGIN:VCALENDAR'], 'big.ics', { type: 'text/calendar' })
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 })
    Object.defineProperty(fileInput(), 'files', { value: [big], configurable: true })
    fileInput().dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(text(dialog())).toContain('The file is too large (5 MB)'))
    // Announced to screen readers when it appears.
    expect(text(dialog()?.querySelector('[role="alert"]'))).toContain('The file is too large')
    expect(button(/^Import/)).toBeUndefined()
    expect(status()).toBe('')
    // Another file can be chosen from the dialog.
    const opened = vi.spyOn(fileInput(), 'click').mockImplementation(() => {})
    button('Choose another file…')!.click()
    expect(opened).toHaveBeenCalledTimes(1)

    choose(fixture('garbage.ics'), 'page.ics')
    await vi.waitFor(() =>
      expect(text(dialog())).toContain('This is not an iCalendar (.ics) file.'),
    )
    expect(text(dialog())).not.toContain('too large')

    choose('x', 'photo.png', 'image/png')
    await vi.waitFor(() =>
      expect(text(dialog())).toContain('This does not look like a calendar file.'),
    )
  })

  it('clears an old message and an old preview when another file is chosen', async () => {
    await mountSection()
    choose(fixture('garbage.ics'), 'page.ics')
    await vi.waitFor(() => expect(text(dialog())).toContain('This is not an iCalendar'))
    await chooseAndRead(fixture('import-recurring-overrides.ics'), 'good.ics')
    expect(text(dialog())).not.toContain('This is not an iCalendar')
    choose(fixture('garbage.ics'), 'page.ics')
    await vi.waitFor(() => expect(text(dialog())).toContain('This is not an iCalendar'))
    expect(text(dialog())).not.toContain('Events 2')
    expect(button(/^Import/)).toBeUndefined()
  })

  it('says a calendar without events has none to import', async () => {
    await mountSection()
    choose('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', 'empty.ics')
    await vi.waitFor(() => expect(status()).toBe('File read: it has no events to import.'))
    expect(button(/^Import/)).toBeUndefined()
  })
})

describe('importing into a new calendar', () => {
  async function chooseNew(name?: string) {
    await mountSection(calendars.slice(1))
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    await vi.waitFor(() => expect(newNameInput()).not.toBeNull())
    if (name !== undefined) {
      const input = newNameInput()!
      input.value = name
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  it('makes the calendar with the chosen name, writes the events into it and reloads the sources', async () => {
    await chooseNew('Holidays 2027')
    const before = sourcesVersion()
    button('Import 2 events')!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Import finished'))
    expect(service.made).toEqual([{ displayName: 'Holidays 2027' }])
    expect(service.puts).toHaveLength(2)
    for (const put of service.puts)
      expect(put.url).toMatch(/^\/caldav\/alice\/0a1b2c3d\/[0-9a-f]{32}\.ics$/)
    expect(text(dialog())).toContain('The calendar “Holidays 2027” was created.')
    // Once for the new calendar, once for its events.
    expect(sourcesVersion()).toBe(before + 2)
    expect(service.invalidated).toEqual([NEW_HREF])
  })

  it('refuses an empty or too long name before anything is made, and says why at the field', async () => {
    await chooseNew('   ')
    button('Import 2 events')!.click()
    await vi.waitFor(() => expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull())
    expect(text(dialog()!.querySelector('[role="alert"]'))).toContain('Enter a name.')
    expect(service.made).toEqual([])
    expect(service.puts).toEqual([])
    const input = newNameInput()!
    // The field stops typing at 100 characters; a longer value set by a script is still refused.
    input.value = 'x'.repeat(101)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(dialog()!.querySelector('[role="alert"]')).toBeNull())
    button('Import 2 events')!.click()
    await vi.waitFor(() =>
      expect(text(dialog()!.querySelector('[role="alert"]'))).toContain('at most 100'),
    )
    expect(service.made).toEqual([])
    expect(service.puts).toEqual([])
  })

  it('shows why the calendar could not be made, imports nothing, and can be tried again', async () => {
    await chooseNew('Holidays')
    service.makeFails = new DavError('forbidden', 'no')
    button('Import 2 events')!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('The calendar could not be created'))
    expect(service.puts).toEqual([])
    expect(text(dialog())).not.toContain('Import finished')
    service.makeFails = null
    button('Import 2 events')!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Import finished'))
    expect(service.made).toHaveLength(1)
  })

  it('fills the calendar it made when the file is imported again, and does not make a second one', async () => {
    await chooseNew('Holidays')
    service.fail = (_put, index) =>
      index === 0 ? new DavError('rejected', 'no', { status: 500 }) : null
    button('Import 2 events')!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Import again'))
    service.fail = () => null
    button('Import again')!.click()
    await vi.waitFor(() => expect(button('Import 2 events')).toBeDefined())
    button('Import 2 events')!.click()
    await vi.waitFor(() => expect(service.puts).toHaveLength(4))
    expect(service.made).toHaveLength(1)
    expect(new Set(service.puts.map((put) => put.url.slice(0, NEW_HREF.length)))).toEqual(
      new Set([NEW_HREF]),
    )
  })
})

describe('text from the file', () => {
  const hostile = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'X-WR-CALNAME:<script>window.__pwned = 1</script>',
    'BEGIN:VEVENT',
    'UID:x',
    'DTSTART:20261110T100000Z',
    'SUMMARY:<img src=x onerror="window.__pwned = 2"> Click',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:y',
    'DTSTART:20261110T100000Z',
    `SUMMARY:Ab${String.fromCodePoint(0x202e)}cd\\nSecond`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('is drawn as text: no element, no script, no reordering characters', async () => {
    await mountSection()
    await chooseAndRead(hostile, '<b>evil</b>.ics')
    expect(dialog()?.querySelector('img, script, b')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
    const card = text(dialog())
    expect(card).toContain('<b>evil</b>.ics')
    expect(card).toContain('<script>window.__pwned = 1</script>')
    expect(card).toContain('<img src=x onerror="window.__pwned = 2"> Click')
    expect(card).toContain('Ab cd Second')
    expect(dialog()?.textContent).not.toContain(String.fromCodePoint(0x202e))
  })

  it('stays text in the list of events that failed', async () => {
    service.fail = () => new DavError('rejected', 'refused', { status: 400 })
    await mountSection()
    await chooseAndRead(hostile)
    button(/^Import 2 events$/)!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Import finished'))
    expect(dialog()?.querySelector('img, script')).toBeNull()
    expect(text(dialog())).toContain(
      '<img src=x onerror="window.__pwned = 2"> Click: The calendar service did not accept this event.',
    )
  })
})

describe('importing', () => {
  it('writes the events to the chosen calendar, says so, reloads the calendar and moves the focus', async () => {
    await mountSection()
    const before = sourcesVersion()
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    button('Import 2 events')!.click()

    await vi.waitFor(() => expect(text(dialog())).toContain('Import finished'))
    expect(service.puts).toHaveLength(2)
    for (const put of service.puts) {
      expect(put.url).toMatch(/^\/caldav\/alice\/work\/[0-9a-f]{32}\.ics$/)
      expect(put.create).toBe(true)
    }
    expect(text(dialog())).toContain('Imported 2 events.')
    expect(status()).toBe('Imported 2 events.')
    // The calendar view loads again, without the reader's short-lived copy.
    expect(sourcesVersion()).toBe(before + 1)
    expect(service.invalidated).toEqual([WORK_HREF])
    // The result has the focus, and the preview is out of the way.
    expect(document.activeElement).toBe(document.getElementById('settings-import-result'))
    expect(dialog()!.querySelector('[role="combobox"]')).toBeNull()
  })

  it('runs again after "Done" with a clean slate and the focus on "Choose file…"', async () => {
    await mountSection()
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    button('Import 2 events')!.click()
    await vi.waitFor(() => expect(button('Done')).toBeDefined())
    button('Done')!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(chooseButton()))
    expect(fileInput().value).toBe('')
    expect(text(section())).not.toContain('Import finished')
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    expect(status()).toBe('File read: 2 events can be imported.')
    expect(text(dialog())).not.toContain('Import finished')
  })

  it('counts what was already there, and does not reload when nothing was written', async () => {
    service.fail = () => new DavError('exists', 'exists', { status: 412 })
    await mountSection()
    const before = sourcesVersion()
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    button('Import 2 events')!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Import finished'))
    expect(status()).toBe('Nothing was imported. 2 events were already in the calendar.')
    expect(sourcesVersion()).toBe(before)
    expect(service.invalidated).toEqual([])
    // Nothing to do over again.
    expect(button('Import again')).toBeUndefined()
  })

  it('lists the events the service did not take and offers to run the file again', async () => {
    service.fail = (_put, index) =>
      index === 0 ? new DavError('rejected', 'too big', { status: 413 }) : null
    await mountSection()
    const before = sourcesVersion()
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    button('Import 2 events')!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Import finished'))

    expect(status()).toBe('Imported 1 event. 1 event could not be imported.')
    const failed = dialog()!.querySelectorAll(
      'ul[aria-label="Events that could not be imported"] li',
    )
    expect(failed).toHaveLength(1)
    expect(text(failed[0])).toMatch(
      /^(Weekly planning|Lunch): Too large for the calendar service\.$/,
    )
    // One event was written: the calendar is loaded again.
    expect(sourcesVersion()).toBe(before + 1)
    expect(text(dialog())).toContain('events that are already in the calendar are left alone')

    // "Import again" goes back to the file's preview, with the focus on the button.
    button('Import again')!.click()
    await vi.waitFor(() => expect(button('Import 2 events')).toBeDefined())
    await vi.waitFor(() => expect(document.activeElement).toBe(button('Import 2 events')))
    expect(text(dialog())).toContain('team.ics')
  })

  it('shows why the run stopped, in an alert', async () => {
    service.fail = () => new DavError('unauthorized', 'expired', { status: 401 })
    await mountSection()
    await chooseAndRead(fixture('import-recurring-overrides.ics'))
    button('Import 2 events')!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Import stopped'))
    expect(text(dialog()?.querySelector('[role="alert"]'))).toContain(
      'Your sign-in expired. Sign in again.',
    )
  })

  it('shows progress while it runs, takes the focus to Cancel, and can be cancelled', async () => {
    let release = () => {}
    service.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    await mountSection()
    const before = sourcesVersion()
    const events = Array.from({ length: 12 }, (_, i) =>
      ['BEGIN:VEVENT', `UID:e${i}`, 'DTSTART:20261110T100000Z', `SUMMARY:E${i}`, 'END:VEVENT'].join(
        '\r\n',
      ),
    )
    await chooseAndRead(
      `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`,
    )
    button('Import 12 events')!.click()

    await vi.waitFor(() => expect(service.puts).toHaveLength(4))
    const progress = dialog()!.querySelector<HTMLProgressElement>('progress')!
    expect(progress.getAttribute('aria-label')).toBe('Import progress')
    expect(progress.outerHTML).toMatch(/max="12"/)
    expect(status()).toBe('Importing 12 events…')
    expect(button('Importing…')?.disabled).toBe(true)
    await vi.waitFor(() => expect(document.activeElement).toBe(button('Cancel import')))
    // The dialog cannot be closed while the run is going; Cancel import is the way out.
    button('Cancel import')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(dialog()).not.toBeNull()

    button('Cancel import')!.click()
    await vi.waitFor(() => expect(status()).toBe('Cancelling…'))
    release()
    await vi.waitFor(() => expect(text(dialog())).toContain('Import cancelled'))
    expect(service.puts).toHaveLength(4)
    // The four that were being sent are not claimed to be unsaved.
    expect(status()).toBe(
      'Nothing was imported. 8 events were not imported because the import was cancelled. ' +
        '4 events were being sent when the import was cancelled and may have been saved.',
    )
    // Nothing was confirmed, but four may have been saved: the calendar looks again.
    expect(sourcesVersion()).toBe(before + 1)
    expect(button('Import again')).toBeDefined()
  })
})
