// @vitest-environment nuxt
// The dialogs of the write flows as plain prop/emit components inside a real Nuxt UI app: the
// question "which events?", the delete confirmation and the edit form. ARIA, keyboard, focus.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { ConfirmDeleteDialog, EventEditModal, RecurrenceScopeDialog, UApp } from '#components'
import type { CalendarEvent } from '../shared/types/calendar'
import type { EventChanges } from '../app/utils/ical/write-types'
import type { ScopeChoice } from '../app/utils/writes/types'

const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const buttons = () => [...(dialog()?.querySelectorAll('button') ?? [])]
const buttonNamed = (name: string) => buttons().find((item) => text(item) === name)
const radios = () => [...(dialog()?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])]

function keydown(target: Element | null, key: string) {
  target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

let app: Awaited<ReturnType<typeof mountSuspended>> | undefined
let opener: HTMLButtonElement

afterEach(() => {
  app?.unmount()
  app = undefined
  clearNuxtState()
  document.body.innerHTML = ''
})

/** Mounts `dialogComponent` next to an "Open" button that has the focus, as the sheet's buttons do. */
async function mountDialog(dialogComponent: object, props: Record<string, unknown>) {
  const state = reactive<Record<string, unknown>>({ open: false, returnFocusTo: null, ...props })
  const events: { name: string; args: unknown[] }[] = []
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      events.push({ name, args })
  const Host = defineComponent({
    render: () =>
      h(UApp, null, {
        default: () => [
          h('button', { id: 'opener', type: 'button' }, 'Open'),
          h(dialogComponent, {
            ...state,
            'onUpdate:open': (open: boolean) => {
              events.push({ name: 'update:open', args: [open] })
              state.open = open
            },
            onChoose: record('choose'),
            onConfirm: record('confirm'),
            onSubmit: record('submit'),
          }),
        ],
      }),
  })
  app = await mountSuspended(Host, { attachTo: document.body })
  opener = document.getElementById('opener') as HTMLButtonElement
  opener.focus()
  state.returnFocusTo = opener
  const open = async () => {
    state.open = true
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
  }
  return { state, events, open }
}

describe('RecurrenceScopeDialog', () => {
  const props = { action: 'edit', eventTitle: 'Weekly sync' }

  it('asks which events, with "This event" chosen, and focuses the choice', async () => {
    const { open } = await mountDialog(RecurrenceScopeDialog, props)
    await open()
    expect(dialog()!.getAttribute('aria-labelledby')).toBeTruthy()
    expect(text(dialog())).toContain('Edit repeating event')
    expect(text(dialog())).toContain('Weekly sync')
    expect(text(dialog()!.querySelector('legend'))).toBe('Change which events?')
    const labelOf = (radio: HTMLElement) => text(document.querySelector(`label[for="${radio.id}"]`))
    expect(radios().map(labelOf)).toEqual(['This event', 'This and following events', 'All events'])
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ])
    await vi.waitFor(() => expect(document.activeElement).toBe(radios()[0]))
  })

  it('reports the chosen scope when Continue is pressed', async () => {
    const { open, events } = await mountDialog(RecurrenceScopeDialog, props)
    await open()
    radios()[2]!.click()
    await vi.waitFor(() => expect(radios()[2]!.getAttribute('aria-checked')).toBe('true'))
    buttonNamed('Continue')!.click()
    await vi.waitFor(() =>
      expect(events.filter((event) => event.name === 'choose')).toEqual([
        { name: 'choose', args: ['all' satisfies ScopeChoice] },
      ]),
    )
  })

  it('offers the delete wording for a delete', async () => {
    const { open } = await mountDialog(RecurrenceScopeDialog, { ...props, action: 'delete' })
    await open()
    expect(text(dialog())).toContain('Delete repeating event')
    expect(text(dialog()!.querySelector('legend'))).toBe('Delete which events?')
  })

  it('starts from "This event" again each time it opens', async () => {
    const { open, state } = await mountDialog(RecurrenceScopeDialog, props)
    await open()
    radios()[1]!.click()
    await vi.waitFor(() => expect(radios()[1]!.getAttribute('aria-checked')).toBe('true'))
    state.open = false
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await open()
    expect(radios()[0]!.getAttribute('aria-checked')).toBe('true')
  })

  it('moves with the arrow keys and closes with Escape, returning the focus', async () => {
    const { open, events } = await mountDialog(RecurrenceScopeDialog, props)
    await open()
    await vi.waitFor(() => expect(document.activeElement).toBe(radios()[0]))
    keydown(document.activeElement, 'ArrowDown')
    await vi.waitFor(() => expect(radios()[1]!.getAttribute('aria-checked')).toBe('true'))

    keydown(document.activeElement, 'Escape')
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(events).toContainEqual({ name: 'update:open', args: [false] })
    expect(events.some((event) => event.name === 'choose')).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('returns the focus on Cancel as well', async () => {
    const { open } = await mountDialog(RecurrenceScopeDialog, props)
    await open()
    buttonNamed('Cancel')!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('leaves the focus to the caller after a choice', async () => {
    const { open, state } = await mountDialog(RecurrenceScopeDialog, props)
    await open()
    buttonNamed('Continue')!.click()
    // The caller opens the next dialog and closes this one; nothing may pull the focus back.
    state.open = false
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).not.toBe(opener)
  })
})

describe('ConfirmDeleteDialog', () => {
  const props = { eventTitle: 'Planning', detail: 'The event is removed from the calendar.' }

  it('names the event, starts on Cancel and has a destructive Delete button', async () => {
    const { open } = await mountDialog(ConfirmDeleteDialog, props)
    await open()
    expect(text(dialog()!.querySelector('[id$="title"], h2'))).toBe('Delete "Planning"?')
    expect(dialog()!.getAttribute('aria-describedby')).toBeTruthy()
    expect(text(dialog())).toContain('The event is removed from the calendar.')
    expect(text(dialog())).toContain('This cannot be undone.')
    await vi.waitFor(() => expect(document.activeElement).toBe(buttonNamed('Cancel')))
    const del = buttonNamed('Delete')!
    expect(del.className).toMatch(/bg-error|error/)
  })

  it('reports the confirmation, once the person presses Delete', async () => {
    const { open, events } = await mountDialog(ConfirmDeleteDialog, props)
    await open()
    expect(events.some((event) => event.name === 'confirm')).toBe(false)
    buttonNamed('Delete')!.click()
    await vi.waitFor(() =>
      expect(events.filter((event) => event.name === 'confirm')).toHaveLength(1),
    )
  })

  it('cannot be confirmed twice while it works', async () => {
    const { open, events } = await mountDialog(ConfirmDeleteDialog, { ...props, pending: true })
    await open()
    const del = buttonNamed('Delete')! as HTMLButtonElement
    expect(del.disabled).toBe(true)
    del.click()
    expect(events.some((event) => event.name === 'confirm')).toBe(false)
    expect(dialog()!.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it('announces why a delete failed', async () => {
    const { open } = await mountDialog(ConfirmDeleteDialog, {
      ...props,
      error: "You can't write to this calendar.",
    })
    await open()
    expect(text(dialog()!.querySelector('[role="alert"]'))).toBe(
      "You can't write to this calendar.",
    )
    expect(text(dialog())).not.toContain('This cannot be undone.')
  })

  it('closes with Escape and returns the focus to the button that opened it', async () => {
    const { open } = await mountDialog(ConfirmDeleteDialog, props)
    await open()
    keydown(document.activeElement, 'Escape')
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('leaves the focus alone when told the caller takes it', async () => {
    const { open, state } = await mountDialog(ConfirmDeleteDialog, props)
    await open()
    state.returnFocusTo = false
    state.open = false
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).not.toBe(opener)
  })
})

describe('EventEditModal', () => {
  const event: CalendarEvent = {
    id: 'e1',
    uid: 'u1',
    calendarId: 'dav:/caldav/alice/work/',
    title: 'Planning',
    start: '2026-11-05T09:00:00',
    end: '2026-11-05T10:00:00',
    allDay: false,
    status: 'confirmed',
    description: 'Agenda',
    location: 'Room 1',
    categoryIds: [],
    categoryNames: ['Work'],
    href: '/caldav/alice/work/u1.ics',
  }
  const props = {
    event,
    scope: null,
    calendar: { id: event.calendarId, name: 'Work', color: '#1d4ed8' },
    categoryNames: ['Work', 'Meeting'],
  }
  const field = (label: string) =>
    [...(dialog()?.querySelectorAll('label') ?? [])].find((item) => text(item)?.startsWith(label))
  const inputOf = <T extends HTMLElement>(label: string) => {
    const id = field(label)?.getAttribute('for')
    return (id ? document.getElementById(id) : null) as T | null
  }
  const submits = (events: { name: string; args: unknown[] }[]) =>
    events.filter((item) => item.name === 'submit').map((item) => item.args[0] as EventChanges)

  it('is filled with the event, shows the calendar read-only and starts in the title', async () => {
    const { open } = await mountDialog(EventEditModal, props)
    await open()
    expect(text(dialog())).toContain('Edit event')
    expect(text(dialog())).toContain('Change the details of this event.')
    expect(inputOf<HTMLInputElement>('Title')!.value).toBe('Planning')
    expect(inputOf<HTMLInputElement>('Start')!.value).toBe('2026-11-05T09:00')
    expect(inputOf<HTMLInputElement>('End')!.value).toBe('2026-11-05T10:00')
    expect(inputOf<HTMLInputElement>('Location')!.value).toBe('Room 1')
    expect(inputOf<HTMLTextAreaElement>('Description')!.value).toBe('Agenda')
    const calendar = inputOf<HTMLInputElement>('Calendar')!
    expect(calendar.value).toBe('Work')
    expect(calendar.readOnly).toBe(true)
    expect(text(dialog())).toContain(`Times are in your time zone (${BROWSER_ZONE})`)
    await vi.waitFor(() => expect(document.activeElement).toBe(inputOf('Title')))
    // Categories: the known names, the event's own checked.
    const boxes = [...dialog()!.querySelectorAll<HTMLElement>('[role="checkbox"]')]
    expect(boxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['true', 'false'])
  })

  it('names the scope that was chosen', async () => {
    const { open } = await mountDialog(EventEditModal, { ...props, scope: 'following' })
    await open()
    expect(text(dialog())).toContain('Changing this and the following events.')
  })

  it('sends only the fields that were changed', async () => {
    const { open, events } = await mountDialog(EventEditModal, props)
    await open()
    type(inputOf<HTMLInputElement>('Title')!, 'Planning (new)')
    type(inputOf<HTMLInputElement>('Location')!, '')
    buttonNamed('Save')!.click()
    await vi.waitFor(() => expect(submits(events)).toHaveLength(1))
    expect(submits(events)[0]).toEqual({ title: 'Planning (new)', location: null })
  })

  it('moves the end with the start and sends the whole range', async () => {
    const { open, events } = await mountDialog(EventEditModal, props)
    await open()
    type(inputOf<HTMLInputElement>('Start')!, '2026-11-06T11:00')
    buttonNamed('Save')!.click()
    await vi.waitFor(() => expect(submits(events)).toHaveLength(1))
    expect(submits(events)[0]).toEqual({
      when: { start: '2026-11-06T11:00', end: '2026-11-06T12:00', allDay: false },
    })
  })

  it('sends nothing for a form nobody touched', async () => {
    const { open, events } = await mountDialog(EventEditModal, props)
    await open()
    buttonNamed('Save')!.click()
    await vi.waitFor(() => expect(submits(events)).toEqual([{}]))
  })

  it('refuses an empty title, focuses it and announces why', async () => {
    const { open, events } = await mountDialog(EventEditModal, props)
    await open()
    const title = inputOf<HTMLInputElement>('Title')!
    type(title, ' ')
    buttonNamed('Save')!.click()
    await vi.waitFor(() =>
      expect(text(dialog()!.querySelector('[id$="-error"]'))).toBe('Enter a title.'),
    )
    expect(document.activeElement).toBe(title)
    expect(title.getAttribute('aria-invalid')).toBe('true')
    expect(submits(events)).toEqual([])
  })

  it('does not submit while it is saving and says why a save failed', async () => {
    const { open, events, state } = await mountDialog(EventEditModal, { ...props, pending: true })
    await open()
    const save = buttonNamed('Save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(dialog()!.querySelector('form')!.getAttribute('aria-busy')).toBe('true')
    dialog()!
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    expect(submits(events)).toEqual([])

    state.pending = false
    state.error = 'The calendar service is not reachable. Check your connection and try again.'
    await vi.waitFor(() =>
      expect(text(dialog()!.querySelector('[role="alert"]'))).toBe(state.error as string),
    )
  })

  it('does not pass an event that has no length as invalid when its time is left alone', async () => {
    const { open, events } = await mountDialog(EventEditModal, {
      ...props,
      event: { ...event, end: event.start },
    })
    await open()
    type(inputOf<HTMLInputElement>('Title')!, 'Renamed')
    buttonNamed('Save')!.click()
    await vi.waitFor(() => expect(submits(events)).toEqual([{ title: 'Renamed' }]))
  })

  it('closes with Escape and gives the focus back', async () => {
    const { open } = await mountDialog(EventEditModal, props)
    await open()
    keydown(document.activeElement, 'Escape')
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('shows an all-day event with its last day', async () => {
    const { open } = await mountDialog(EventEditModal, {
      ...props,
      event: { ...event, allDay: true, start: '2026-11-05', end: '2026-11-07' },
    })
    await open()
    expect(inputOf<HTMLInputElement>('Start date')!.value).toBe('2026-11-05')
    expect(inputOf<HTMLInputElement>('End date')!.value).toBe('2026-11-06')
  })
})
