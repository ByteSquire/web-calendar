// @vitest-environment nuxt
// The write flows through the real dialogs: quick add, the event sheet's Edit and Delete, the
// "which events?" question, failures, focus. The calendar service is a fake collection; the
// iCalendar writer and the orchestration are the real ones.
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
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { EventSheet, QuickAddModal, UApp } from '#components'
import { useCalendarState } from '~/composables/useCalendarState'
import { useServerConfigState } from '~/composables/useServerConfigState'
import type { Calendar, CalendarEvent } from '../shared/types/calendar'
import { createEventResource, type NewEventInput } from '../app/utils/ical/write'
import { contentLines, instants } from './ical-write-helpers'
import { CALENDAR as WORK_HREF, FakeCalendarServer } from './writes-helpers'

const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const WORK = `dav:${WORK_HREF}`
const READONLY = 'dav:/caldav/alice/shared/'

const calendars: Calendar[] = [
  {
    id: WORK,
    name: 'Work',
    type: 'caldav',
    color: '#1d4ed8',
    defaultVisible: true,
    href: WORK_HREF,
  },
  {
    id: READONLY,
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
let server = new FakeCalendarServer()
const invalidated: string[] = []
const caldav = {
  client: {
    getObject: (url: string) => server.client.getObject(url),
    putObject: (args: Parameters<FakeCalendarServer['client']['putObject']>[0]) =>
      server.client.putObject(args),
    deleteObject: (url: string, etag?: string) => server.client.deleteObject(url, etag),
  },
  reader: { invalidate: (url: string) => void invalidated.push(url) },
}

const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
const top = () => dialogs().at(-1) ?? null
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const buttonIn = (root: Element | null, name: string) =>
  [...(root?.querySelectorAll('button') ?? [])].find(
    (item) => text(item) === name || item.getAttribute('aria-label') === name,
  ) as HTMLButtonElement | undefined
const labelled = <T extends HTMLElement>(root: Element | null, label: string) => {
  const found = [...(root?.querySelectorAll('label') ?? [])].find((item) =>
    text(item)?.startsWith(label),
  )
  const id = found?.getAttribute('for')
  return (id ? document.getElementById(id) : null) as T | null
}
const radios = () => [...(top()?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])]

function keydown(target: Element | null, key: string) {
  target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const NEW_INPUT: NewEventInput = {
  title: 'Planning',
  when: { start: '2026-11-05T09:00', end: '2026-11-05T10:00', allDay: false },
}
const WEEKLY_INPUT: NewEventInput = {
  title: 'Weekly',
  when: { start: '2026-10-12T09:00', end: '2026-10-12T10:00', allDay: false },
  recurrence: { freq: 'WEEKLY', byDay: ['MO'], count: 6 },
}
const ZONES = { displayTimeZone: 'Europe/Berlin', orgTimeZone: 'Europe/Berlin' }

/** A resource on the fake service and the event the calendar state would hold for it. */
function seedEvent(
  input: NewEventInput,
  extra: Partial<CalendarEvent> = {},
): { event: CalendarEvent; href: string } {
  const { uid, ics } = createEventResource(input, ZONES)
  const href = `${WORK_HREF}${uid}.ics`
  const etag = server.seed(href, ics)
  const event: CalendarEvent = {
    id: `evt-${uid}`,
    uid,
    calendarId: WORK,
    title: input.title,
    start: input.when.start.length === 10 ? input.when.start : `${input.when.start}:00`,
    end: input.when.end.length === 10 ? input.when.end : `${input.when.end}:00`,
    allDay: input.when.allDay,
    status: 'confirmed',
    categoryIds: [],
    href,
    etag,
    ...extra,
  }
  return { event, href }
}

function useConfig(demo = false) {
  useServerConfigState().value = {
    oidc: { issuer: 'https://idm.example.org/oauth2', clientId: 'x', scope: 'openid' },
    timezone: BROWSER_ZONE,
    demo,
  }
}

function seedState(events: CalendarEvent[]) {
  const state = useCalendarState()
  state.calendars.value = calendars
  state.visibleCalendarIds.value = calendars.map((calendar) => calendar.id)
  state.categories.value = [
    { id: 'c1', name: 'Work', color: '#1d4ed8' },
    { id: 'c2', name: 'Meeting', color: '#6d28d9' },
  ]
  state.events.value = events
  return state
}

const Shell = defineComponent({
  render: () =>
    h(UApp, null, {
      default: () => [
        h('button', { id: 'opener', type: 'button' }, 'Opener'),
        h(EventSheet),
        h(QuickAddModal),
      ],
    }),
})

let app: Awaited<ReturnType<typeof mountSuspended>> | undefined
let consoleWarn: MockInstance<typeof console.warn>
let consoleError: MockInstance<typeof console.error>

beforeAll(() => {
  useNuxtApp().provide('caldav', caldav)
})

beforeEach(() => {
  server = new FakeCalendarServer()
  invalidated.length = 0
  clearNuxtState()
  useConfig()
  consoleWarn = vi.spyOn(console, 'warn')
  consoleError = vi.spyOn(console, 'error')
})

afterEach(() => {
  // useEventWrites logs the technical reason of a failed write for whoever debugs.
  const warnings = consoleWarn.mock.calls
    .map((call) => call.map(String).join(' '))
    .filter((line) => !line.startsWith('Writing the event failed'))
  const errors = consoleError.mock.calls.map((call) => call.map(String).join(' '))
  vi.restoreAllMocks()
  app?.unmount()
  app = undefined
  clearNuxtState()
  document.body.innerHTML = ''
  // Dialogs that warn about a missing title or description, or any Vue warning, are bugs.
  expect(errors).toEqual([])
  expect(warnings).toEqual([])
})

afterAll(() => {
  server = new FakeCalendarServer()
})

async function mountApp() {
  app = await mountSuspended(Shell, { attachTo: document.body })
  const opener = document.getElementById('opener') as HTMLButtonElement
  opener.focus()
  return opener
}

// ---------------------------------------------------------------------------------------------

describe('quick add on live data', () => {
  async function openQuickAdd(
    preset?: Parameters<ReturnType<typeof useCalendarState>['openQuickAdd']>[0],
  ) {
    const opener = await mountApp()
    seedState([])
    useCalendarState().openQuickAdd(
      preset ?? { start: '2026-11-05T09:00', end: '2026-11-05T10:00' },
    )
    await vi.waitFor(() => expect(top()).not.toBeNull())
    return { opener, dialog: top()! }
  }

  it('creates the event in a writable calendar, closes, reloads and returns the focus', async () => {
    const { opener, dialog } = await openQuickAdd()
    // Description and location come with live data; the dialog starts in the title.
    expect(labelled(dialog, 'Location')).not.toBeNull()
    expect(labelled(dialog, 'Description')).not.toBeNull()
    expect(text(dialog)).toContain('Repeat')
    await vi.waitFor(() => expect(document.activeElement).toBe(labelled(dialog, 'Title')))

    type(labelled<HTMLInputElement>(dialog, 'Title')!, 'Lunch with Ana')
    type(labelled<HTMLInputElement>(dialog, 'Location')!, 'Canteen')
    type(labelled<HTMLTextAreaElement>(dialog, 'Description')!, 'Bring the slides')
    buttonIn(dialog, 'Add event')!.click()

    await vi.waitFor(() => expect(top()).toBeNull())
    const puts = server.callsOf('PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0]!.create).toBe(true)
    expect(puts[0]!.url.startsWith(WORK_HREF)).toBe(true)
    expect(puts[0]!.url.endsWith('.ics')).toBe(true)
    const lines = contentLines(puts[0]!.data!)
    expect(lines).toContain('SUMMARY:Lunch with Ana')
    expect(lines).toContain('LOCATION:Canteen')
    expect(lines).toContain('DESCRIPTION:Bring the slides')
    expect(invalidated).toEqual([WORK_HREF])
    await vi.waitFor(() => expect(document.body.textContent).toContain('Event added'))
    expect(document.activeElement).toBe(opener)
  })

  it('offers only the calendars that can be written to', async () => {
    const { dialog } = await openQuickAdd()
    // The only writable calendar is the one the form starts with.
    const select = dialog.querySelector<HTMLElement>('[role="combobox"]')
    expect(text(select)).toContain('Work')
    buttonIn(dialog, 'Add event')!.click()
    // An empty title is refused first; the calendar was chosen already.
    await vi.waitFor(() => expect(text(dialog)).toContain('Enter a title.'))
    expect(server.callsOf('PUT')).toEqual([])
  })

  it('says so when no calendar takes new events', async () => {
    await mountApp()
    seedState([])
    useCalendarState().calendars.value = calendars.slice(1)
    useCalendarState().openQuickAdd()
    await vi.waitFor(() => expect(top()).not.toBeNull())
    expect(text(top())).toContain('None of your calendars can take new events.')
    expect(buttonIn(top(), 'Add event')!.disabled).toBe(true)
  })

  it('keeps the dialog open with the reason, and works again after a retry', async () => {
    const { dialog } = await openQuickAdd()
    type(labelled<HTMLInputElement>(dialog, 'Title')!, 'Lunch')
    server.failNext('PUT', 'forbidden')
    buttonIn(dialog, 'Add event')!.click()

    await vi.waitFor(() =>
      expect(text(dialog.querySelector('[role="alert"]'))).toBe(
        "You can't write to this calendar.",
      ),
    )
    expect(top()).toBe(dialog)
    expect(buttonIn(dialog, 'Add event')!.disabled).toBe(false)
    expect(dialog.querySelector('form')!.getAttribute('aria-busy')).toBe('false')
    expect(invalidated).toEqual([])

    buttonIn(dialog, 'Add event')!.click()
    await vi.waitFor(() => expect(top()).toBeNull())
    expect(server.callsOf('PUT')).toHaveLength(2)
  })

  it('does not submit twice while the first request runs', async () => {
    const { dialog } = await openQuickAdd()
    type(labelled<HTMLInputElement>(dialog, 'Title')!, 'Lunch')
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const original = server.client.putObject
    server.client.putObject = async (args) => {
      await gate
      return original(args)
    }
    const form = dialog.querySelector('form')!
    buttonIn(dialog, 'Add event')!.click()
    await vi.waitFor(() => expect(form.getAttribute('aria-busy')).toBe('true'))
    expect(buttonIn(dialog, 'Add event')!.disabled).toBe(true)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    release()
    await vi.waitFor(() => expect(top()).toBeNull())
    expect(server.callsOf('PUT')).toHaveLength(1)
  })

  it('still adds to the in-memory store in demo mode, without the live fields', async () => {
    useConfig(true)
    await mountApp()
    seedState([])
    useCalendarState().calendars.value = [{ ...calendars[0]!, id: 'cal-demo', href: undefined }]
    useCalendarState().visibleCalendarIds.value = ['cal-demo']
    useCalendarState().openQuickAdd()
    await vi.waitFor(() => expect(top()).not.toBeNull())
    expect(labelled(top(), 'Location')).toBeNull()
    expect(text(top())).not.toContain('Repeat')
    type(labelled<HTMLInputElement>(top(), 'Title')!, 'Demo event')
    buttonIn(top(), 'Add event')!.click()
    await vi.waitFor(() => expect(top()).toBeNull())
    expect(useCalendarState().events.value.map((event) => event.title)).toEqual(['Demo event'])
    expect(server.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------

describe('the event sheet on live data', () => {
  async function open(event: CalendarEvent) {
    const opener = await mountApp()
    const state = seedState([event])
    state.selectEvent(event.id)
    await vi.waitFor(() => expect(top()).not.toBeNull())
    const sheet = top()!
    return { state, opener, sheet }
  }
  const pressed = async (name: string, root: () => Element | null = top) => {
    const button = buttonIn(root(), name)!
    button.focus()
    button.click()
  }

  describe('who may edit', () => {
    it.each([
      ['a read-only calendar', { calendarId: READONLY }, 'This calendar is read-only for you.'],
      [
        'a subscription',
        { calendarId: 'ics:4', href: undefined },
        'This calendar is a subscription and is read-only.',
      ],
      ['an event without a resource', { href: undefined }, "This event can't be changed here."],
    ])('disables Edit and Delete for %s and says why', async (_name, extra, reason) => {
      const { event } = seedEvent(NEW_INPUT, extra as Partial<CalendarEvent>)
      const { sheet } = await open(event)
      for (const name of ['Edit', 'Delete']) {
        const button = buttonIn(sheet, name)!
        expect(button.disabled).toBe(true)
        expect(button.getAttribute('aria-describedby')).toBe('event-write-reason')
      }
      expect(text(sheet.querySelector('#event-write-reason'))).toBe(reason)
    })

    it('enables them for an event of a writable calendar', async () => {
      const { event } = seedEvent(NEW_INPUT)
      const { sheet } = await open(event)
      expect(buttonIn(sheet, 'Edit')!.disabled).toBe(false)
      expect(buttonIn(sheet, 'Delete')!.disabled).toBe(false)
      expect(sheet.querySelector('#event-write-reason')).toBeNull()
    })

    it('keeps the "not available" notice in demo mode', async () => {
      useConfig(true)
      const { event } = seedEvent(NEW_INPUT)
      const { sheet } = await open(event)
      expect(buttonIn(sheet, 'Edit')!.disabled).toBe(false)
      buttonIn(sheet, 'Edit')!.click()
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          'Editing arrives with the real calendar service',
        ),
      )
      expect(dialogs()).toHaveLength(1)
      expect(server.calls).toEqual([])
    })
  })

  describe('edit', () => {
    it('edits a single event and closes the sheet', async () => {
      const { event, href } = seedEvent(NEW_INPUT)
      const { state, opener, sheet } = await open(event)
      // Somebody saved meanwhile: the PUT must carry the fresh tag, not the state's.
      const fresh = server.touch(href)
      await pressed('Edit')

      await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
      const form = top()!
      expect(text(form)).toContain('Edit event')
      await vi.waitFor(() => expect(document.activeElement).toBe(labelled(form, 'Title')))
      type(labelled<HTMLInputElement>(form, 'Title')!, 'Planning (new)')
      buttonIn(form, 'Save')!.click()

      await vi.waitFor(() => expect(state.selectedEventId.value).toBeNull())
      await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
      expect(server.callsOf('PUT')).toHaveLength(1)
      expect(server.callsOf('PUT')[0]).toMatchObject({ url: href, etag: fresh })
      expect(contentLines(server.dataOf(href))).toContain('SUMMARY:Planning (new)')
      expect(invalidated).toEqual([WORK_HREF])
      await vi.waitFor(() => expect(document.body.textContent).toContain('Event updated'))
      expect(sheet.isConnected).toBe(false)
      // The sheet took the focus back to where it had been when the event was opened.
      expect(document.activeElement).toBe(opener)
    })

    it('puts the focus back on Edit when the form is cancelled', async () => {
      const { event } = seedEvent(NEW_INPUT)
      const { sheet } = await open(event)
      await pressed('Edit')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
      keydown(document.activeElement, 'Escape')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
      expect(top()).toBe(sheet)
      expect(document.activeElement).toBe(buttonIn(sheet, 'Edit'))
      expect(server.calls).toEqual([])
    })

    it('does not write when nothing was changed', async () => {
      const { event } = seedEvent(NEW_INPUT)
      const { state } = await open(event)
      await pressed('Edit')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
      buttonIn(top(), 'Save')!.click()
      await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
      expect(server.calls).toEqual([])
      expect(document.body.textContent).toContain('Nothing to save')
      expect(state.selectedEventId.value).toBe(event.id)
    })

    it('shows why a save failed and lets the person try again', async () => {
      const { event, href } = seedEvent(NEW_INPUT)
      await open(event)
      await pressed('Edit')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
      const form = top()!
      type(labelled<HTMLInputElement>(form, 'Title')!, 'Retry me')
      server.failNext('PUT', 'network')
      buttonIn(form, 'Save')!.click()
      await vi.waitFor(() =>
        expect(text(form.querySelector('[role="alert"]'))).toBe(
          'The calendar service is not reachable. Check your connection and try again.',
        ),
      )
      expect(top()).toBe(form)
      buttonIn(form, 'Save')!.click()
      await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
      expect(contentLines(server.dataOf(href))).toContain('SUMMARY:Retry me')
    })

    it('reports a change by someone else, reloads and closes the form', async () => {
      const { event } = seedEvent(NEW_INPUT)
      const { state } = await open(event)
      await pressed('Edit')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
      type(labelled<HTMLInputElement>(top(), 'Title')!, 'Mine')
      server.failNext('PUT', 'conflict')
      buttonIn(top(), 'Save')!.click()
      await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
      expect(document.body.textContent).toContain(
        'This event was changed by someone else. It has been reloaded — try again.',
      )
      expect(invalidated).toEqual([WORK_HREF])
      expect(state.selectedEventId.value).toBe(event.id)
    })

    describe('a repeating event', () => {
      const third = '2026-10-26T08:00:00Z'
      async function openOccurrence() {
        const { event, href } = seedEvent(WEEKLY_INPUT, {
          recurring: true,
          recurrenceId: third,
          start: '2026-10-26T08:00:00',
          end: '2026-10-26T09:00:00',
        })
        const result = await open(event)
        return { ...result, event, href }
      }

      it('asks which events first, with "This event" chosen', async () => {
        await openOccurrence()
        await pressed('Edit')
        await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
        const question = top()!
        expect(text(question)).toContain('Edit repeating event')
        expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual([
          'true',
          'false',
          'false',
        ])
        await vi.waitFor(() => expect(document.activeElement).toBe(radios()[0]))
        expect(server.calls).toEqual([])
      })

      it('goes back to Edit on Escape without asking the service anything', async () => {
        const { sheet } = await openOccurrence()
        await pressed('Edit')
        await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
        keydown(document.activeElement, 'Escape')
        await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
        expect(document.activeElement).toBe(buttonIn(sheet, 'Edit'))
        expect(server.calls).toEqual([])
      })

      it('"This event" changes one occurrence', async () => {
        const { href } = await openOccurrence()
        await pressed('Edit')
        await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
        buttonIn(top(), 'Continue')!.click()
        await vi.waitFor(() => expect(text(top())).toContain('Changing this event only.'))
        // The focus went to the form, not back to the sheet behind the question.
        await vi.waitFor(() => expect(document.activeElement).toBe(labelled(top(), 'Title')))
        type(labelled<HTMLInputElement>(top(), 'Title')!, 'Weekly (special)')
        buttonIn(top(), 'Save')!.click()
        await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
        const lines = contentLines(server.dataOf(href))
        expect(lines.filter((line) => line.startsWith('SUMMARY:'))).toEqual([
          'SUMMARY:Weekly',
          'SUMMARY:Weekly (special)',
        ])
        expect(lines).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000')
        expect(instants(server.dataOf(href))).toHaveLength(6)
      })

      it('"All events" changes the series', async () => {
        const { href } = await openOccurrence()
        await pressed('Edit')
        await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
        radios()[2]!.click()
        await vi.waitFor(() => expect(radios()[2]!.getAttribute('aria-checked')).toBe('true'))
        buttonIn(top(), 'Continue')!.click()
        await vi.waitFor(() => expect(text(top())).toContain('Changing all events of the series.'))
        type(labelled<HTMLInputElement>(top(), 'Title')!, 'Weekly sync')
        buttonIn(top(), 'Save')!.click()
        await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
        expect(contentLines(server.dataOf(href))).toContain('SUMMARY:Weekly sync')
        expect(server.callsOf('PUT')).toHaveLength(1)
      })

      it('"This and following events" splits the series and writes the new half first', async () => {
        const { href } = await openOccurrence()
        await pressed('Edit')
        await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
        radios()[1]!.click()
        await vi.waitFor(() => expect(radios()[1]!.getAttribute('aria-checked')).toBe('true'))
        buttonIn(top(), 'Continue')!.click()
        await vi.waitFor(() =>
          expect(text(top())).toContain('Changing this and the following events.'),
        )
        type(labelled<HTMLInputElement>(top(), 'Title')!, 'Weekly (new room)')
        buttonIn(top(), 'Save')!.click()
        await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
        const puts = server.callsOf('PUT')
        expect(puts).toHaveLength(2)
        expect(puts[0]!.create).toBe(true)
        expect(puts[1]).toMatchObject({ url: href })
        expect(server.resources.size).toBe(2)
      })
    })
  })

  describe('delete', () => {
    it('asks for confirmation with Cancel focused, then deletes with the fetched tag', async () => {
      const { event, href } = seedEvent(NEW_INPUT)
      const { state, opener } = await open(event)
      const fresh = server.touch(href)
      await pressed('Delete')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
      const confirm = top()!
      expect(text(confirm)).toContain('Delete "Planning"?')
      await vi.waitFor(() => expect(document.activeElement).toBe(buttonIn(confirm, 'Cancel')))
      expect(server.calls).toEqual([])

      buttonIn(confirm, 'Delete')!.click()
      await vi.waitFor(() => expect(state.selectedEventId.value).toBeNull())
      await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
      expect(server.calls.filter((call) => call.method === 'DELETE')).toEqual([
        { method: 'DELETE', url: href, etag: fresh },
      ])
      expect(server.resources.size).toBe(0)
      expect(invalidated).toEqual([WORK_HREF])
      await vi.waitFor(() => expect(document.body.textContent).toContain('Event deleted'))
      expect(document.activeElement).toBe(opener)
    })

    it('goes back to Delete when cancelled', async () => {
      const { event } = seedEvent(NEW_INPUT)
      const { sheet } = await open(event)
      await pressed('Delete')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
      keydown(document.activeElement, 'Escape')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
      expect(document.activeElement).toBe(buttonIn(sheet, 'Delete'))
      expect(server.callsOf('DELETE')).toEqual([])
    })

    it('asks which events of a series, then confirms', async () => {
      const { event, href } = seedEvent(WEEKLY_INPUT, {
        recurring: true,
        recurrenceId: '2026-10-26T08:00:00Z',
      })
      await open(event)
      await pressed('Delete')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
      expect(text(top())).toContain('Delete repeating event')
      buttonIn(top(), 'Continue')!.click()
      await vi.waitFor(() => expect(text(top())).toContain('Delete "Weekly"?'))
      expect(text(top())).toContain('Only this event is deleted')
      buttonIn(top(), 'Delete')!.click()
      await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
      expect(server.callsOf('DELETE')).toEqual([])
      expect(instants(server.dataOf(href))).toHaveLength(5)
      await vi.waitFor(() => expect(document.body.textContent).toContain('was deleted.'))
    })

    it('shows why a delete failed and keeps the dialog', async () => {
      const { event } = seedEvent(NEW_INPUT)
      await open(event)
      await pressed('Delete')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
      const confirm = top()!
      server.failNext('DELETE', 'unavailable')
      buttonIn(confirm, 'Delete')!.click()
      await vi.waitFor(() =>
        expect(text(confirm.querySelector('[role="alert"]'))).toBe(
          'The calendar service is busy or down. Try again in a moment.',
        ),
      )
      expect(top()).toBe(confirm)
      expect(buttonIn(confirm, 'Delete')!.disabled).toBe(false)
    })

    it('treats an event that is already gone as deleted', async () => {
      const { event, href } = seedEvent(NEW_INPUT)
      const { state } = await open(event)
      server.resources.delete(href)
      await pressed('Delete')
      await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
      buttonIn(top(), 'Delete')!.click()
      await vi.waitFor(() => expect(state.selectedEventId.value).toBeNull())
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Event was already deleted'),
      )
      expect(invalidated).toEqual([WORK_HREF])
    })
  })
})
