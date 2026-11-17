// @vitest-environment nuxt
// The view dialog and the filter dialog as plain prop/emit components inside a real Nuxt UI app:
// what they show when they open, what they refuse, and what they report.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { clearNuxtState } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { FilterDialog, UApp, ViewDialog } from '#components'
import type { CalendarFilter } from '../shared/types/calendar'

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()
const buttonNamed = (name: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((item) => text(item) === name)
const nameInput = () => dialog()!.querySelector<HTMLInputElement>('input')!
/** The radio button that the label `name` is for. */
function radioNamed(name: string): HTMLElement | null {
  const label = [...(dialog()?.querySelectorAll('label') ?? [])].find((item) => text(item) === name)
  return label?.htmlFor ? document.getElementById(label.htmlFor) : null
}

function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

let app: Awaited<ReturnType<typeof mountSuspended>> | undefined

afterEach(() => {
  app?.unmount()
  app = undefined
  clearNuxtState()
  document.body.innerHTML = ''
})

async function mountOpen(component: object, props: Record<string, unknown>) {
  const state = reactive<Record<string, unknown>>({ open: false, ...props })
  const saved: unknown[] = []
  const Host = defineComponent({
    render: () =>
      h(UApp, null, {
        default: () =>
          h(component, {
            ...state,
            'onUpdate:open': (open: boolean) => {
              state.open = open
            },
            onSave: (value: unknown) => saved.push(value),
          }),
      }),
  })
  app = await mountSuspended(Host, { attachTo: document.body })
  state.open = true
  await vi.waitFor(() => expect(dialog()).not.toBeNull())
  return { saved }
}

describe('ViewDialog', () => {
  const calendars = [
    { id: 'a', name: 'Team', color: '#112233' },
    { id: 'b', name: 'Sales', color: '#445566' },
  ]

  it('starts with the name and calendars given, and reports the chosen ones in order', async () => {
    const { saved } = await mountOpen(ViewDialog, {
      mode: 'edit',
      initialName: 'Mine',
      initialIds: ['b', 'gone'],
      calendars,
      hiddenCount: 1,
    })
    expect(text(dialog())).toContain('Edit view Mine')
    expect(text(dialog())).toContain('One more calendar of this view is not listed')
    const boxes = [...dialog()!.querySelectorAll<HTMLElement>('[role="checkbox"]')]
    expect(boxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    boxes[0]!.click()
    buttonNamed('Save')!.click()
    await vi.waitFor(() => expect(saved).toEqual([{ name: 'Mine', calendarIds: ['a', 'b'] }]))
  })

  it('refuses a taken name and a view without a calendar', async () => {
    const { saved } = await mountOpen(ViewDialog, {
      mode: 'add',
      calendars,
      takenNames: ['Team week'],
    })
    type(nameInput(), 'team WEEK')
    buttonNamed('Add view')!.click()
    await vi.waitFor(() => {
      expect(text(dialog())).toContain('A view with this name already exists.')
      expect(text(dialog())).toContain('Choose at least one calendar.')
    })
    expect(saved).toEqual([])
  })

  it('renames a view that holds only calendars the viewer cannot see, which it keeps', async () => {
    const { saved } = await mountOpen(ViewDialog, {
      mode: 'edit',
      initialName: 'Copy',
      initialIds: ['gone'],
      calendars,
      hiddenCount: 1,
    })
    type(nameInput(), 'Mine')
    buttonNamed('Save')!.click()
    await vi.waitFor(() => expect(saved).toEqual([{ name: 'Mine', calendarIds: [] }]))
    expect(text(dialog())).not.toContain('Choose at least one calendar.')
  })
})

describe('FilterDialog', () => {
  it('names the filter after what it looks for until a name is typed, and reports it', async () => {
    const { saved } = await mountOpen(FilterDialog, { filter: null, filters: [] })
    expect(text(dialog())).toContain('Add filter')
    radioNamed('Status')!.click()
    await vi.waitFor(() => expect(nameInput().value).toBe('Cancelled'))
    radioNamed('Hide matching events')!.click()
    await vi.waitFor(() => expect(nameInput().value).toBe('Hide: Cancelled'))
    expect(text(dialog())).toContain('Hides the events with the status Cancelled.')
    buttonNamed('Add filter')!.click()
    await vi.waitFor(() =>
      expect(saved).toEqual([
        { name: 'Hide: Cancelled', kind: 'status', value: 'cancelled', mode: 'hide' },
      ]),
    )
  })

  it('keeps password managers away from its form and its fields', async () => {
    await mountOpen(FilterDialog, { filter: null, filters: [] })
    radioNamed('Person')!.click()
    // the list of people is a search field, which Bitwarden never fills
    await vi.waitFor(() => expect(dialog()!.querySelector('input[type="search"]')).not.toBeNull())
    const form = dialog()!.querySelector('form')!
    const fields = [
      ...dialog()!.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="search"]'),
    ]
    expect(fields.map((field) => field.type)).toEqual(['text', 'search'])
    for (const element of [form, ...fields]) {
      expect(element.getAttribute('data-1p-ignore')).toBe('true')
      expect(element.getAttribute('data-lpignore')).toBe('true')
      expect(element.getAttribute('data-bwignore')).toBe('true')
      expect(element.getAttribute('data-form-type')).toBe('other')
      expect(element.getAttribute('data-protonpass-ignore')).toBe('true')
    }
    expect(fields.map((field) => field.getAttribute('autocomplete'))).toEqual(['off', 'off'])
  })

  it('opens a filter as it is, a category held by its id by name, and checks names', async () => {
    const filters: CalendarFilter[] = [
      { id: '1', name: 'Work only', kind: 'category', value: 'cat-work', mode: 'only' },
      { id: '2', name: 'Lunch', kind: 'text', value: 'lunch', mode: 'only' },
    ]
    const { saved } = await mountOpen(FilterDialog, {
      filter: filters[0],
      filters,
      categories: [{ id: 'cat-work', name: 'Work' }],
    })
    expect(text(dialog())).toContain('Edit filter Work only')
    expect(nameInput().value).toBe('Work only')
    expect(text(dialog())).toContain('Shows only the events in the category Work.')
    type(nameInput(), 'lunch')
    buttonNamed('Save')!.click()
    await vi.waitFor(() =>
      expect(text(dialog())).toContain('A filter with this name already exists.'),
    )
    expect(saved).toEqual([])
    type(nameInput(), 'Work things')
    buttonNamed('Save')!.click()
    await vi.waitFor(() =>
      expect(saved).toEqual([
        { name: 'Work things', kind: 'category', value: 'Work', mode: 'only' },
      ]),
    )
  })

  it('opens a status filter with its status chosen, and asks for one it does not know', async () => {
    const known: CalendarFilter = {
      id: '1',
      name: 'No tentative',
      kind: 'status',
      value: 'tentative',
      mode: 'hide',
    }
    await mountOpen(FilterDialog, { filter: known, filters: [known] })
    await vi.waitFor(() =>
      expect(radioNamed('Tentative')?.getAttribute('aria-checked')).toBe('true'),
    )
    app?.unmount()
    document.body.innerHTML = ''

    // An old row with a status the app does not know: nothing is chosen, so it is not changed
    // silently, and saving asks for a status.
    const odd: CalendarFilter = {
      id: '2',
      name: 'Odd',
      kind: 'status',
      value: 'x-done',
      mode: 'hide',
    }
    const { saved } = await mountOpen(FilterDialog, { filter: odd, filters: [odd] })
    await vi.waitFor(() => expect(radioNamed('Cancelled')).not.toBeNull())
    for (const label of ['Confirmed', 'Tentative', 'Cancelled']) {
      expect(radioNamed(label)?.getAttribute('aria-checked'), label).not.toBe('true')
    }
    buttonNamed('Save')!.click()
    await vi.waitFor(() => expect(text(dialog())).toContain('Choose a status.'))
    expect(saved).toEqual([])
    radioNamed('Cancelled')!.click()
    await vi.waitFor(() =>
      expect(radioNamed('Cancelled')?.getAttribute('aria-checked')).toBe('true'),
    )
    buttonNamed('Save')!.click()
    await vi.waitFor(() =>
      expect(saved).toEqual([{ name: 'Odd', kind: 'status', value: 'cancelled', mode: 'hide' }]),
    )
  })
})
