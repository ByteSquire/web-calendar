// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { clearNuxtState, useNuxtApp } from '#app'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import TokensSection from '~/components/settings/TokensSection.vue'
import { formatDateTime } from '~/utils/settings/format'
import {
  FakeBackend,
  alerts,
  button,
  dialog,
  errorTexts,
  field,
  keydown,
  reply,
  requireButton,
  rows,
  statusText,
  stubClipboard,
  token,
  type,
} from './settings-helpers'

const state = vi.hoisted(() => ({ backend: null as FakeBackend | null }))
vi.mock('~/composables/useAuthFetch', async () =>
  (await import('./settings-helpers')).authFetchModule(state)(),
)

// The token section inside a real Nuxt UI app: the explanation, the list, the one-time secret and
// the revoke dialog.
const Shell = defineComponent({
  props: { username: { type: String, default: 'alice' } },
  setup: (props) => () =>
    h(UApp, null, { default: () => h(TokensSection, { username: props.username }) }),
})

let backend: FakeBackend
let app: Awaited<ReturnType<typeof mountSuspended>>

async function mountSection(setup?: (backend: FakeBackend) => void) {
  setup?.(backend)
  app = await mountSuspended(Shell, { attachTo: document.body })
  await vi.waitFor(() => expect(backend.callsTo('GET', '/api/app-tokens')).toHaveLength(1))
  await vi.waitFor(() => expect(document.querySelector('[role="status"] .sr-only')).toBeNull())
}

const labelInput = () => field('Label')
const submit = () => requireButton(/^(Create token|Creating…)$/)
const secretInput = () => document.querySelector<HTMLInputElement>('input[readonly]')

beforeEach(() => {
  backend = new FakeBackend()
  state.backend = backend
})

afterEach(() => {
  app.unmount()
  state.backend = null
  clearNuxtState()
  vi.restoreAllMocks()
})

describe('explanation', () => {
  it('names the CalDAV address, the discovery address and the user name to enter', async () => {
    await mountSection()
    const text = document.body.textContent ?? ''
    expect(text).toContain(`${location.origin}/caldav/`)
    expect(text).toContain(`${location.origin}/.well-known/caldav`)
    const codes = [...document.querySelectorAll('code')].map((item) => item.textContent)
    expect(codes).toContain('alice')
  })

  const setWindow = (days: number) => {
    useServerConfigState().value = {
      oidc: { issuer: '', clientId: '', scope: '' },
      timezone: 'UTC',
      demo: false,
      signinWindowDays: days,
    }
  }
  const note = () => document.querySelector('[data-signin-window]')?.textContent?.trim()

  it('says how long after the last sign-in a token works, from the server setting', async () => {
    setWindow(14)
    await mountSection()
    expect(note()).toBe(
      'An app token stops working if you do not sign in to this app for 14 days. Signing in again makes it work again.',
    )
  })

  it('does not say "1 days"', async () => {
    setWindow(1)
    await mountSection()
    expect(note()).toContain('for 1 day.')
  })

  it('assumes the default of 30 days until the settings are known', async () => {
    await mountSection()
    expect(document.querySelector('[data-signin-window]')?.textContent).toContain('30 days')
  })

  it('does not invent a user name while /api/me has not answered', async () => {
    app = await mountSuspended(
      defineComponent({
        setup: () => () => h(UApp, null, { default: () => h(TokensSection, { username: null }) }),
      }),
      { attachTo: document.body },
    )
    expect(document.body.textContent).toContain('Your user name (see Account)')
  })
})

describe('the list', () => {
  it('shows label, created, expires and last used in the display zone, and "Never"', async () => {
    const zone = useDisplayTimeZone()
    await mountSection((api) => {
      api.tokens = [
        token(2, {
          label: 'DAVx5',
          createdAt: '2026-10-29T09:00:00.000Z',
          expiresAt: '2027-10-29T09:00:00.000Z',
          lastUsedAt: '2026-10-30T10:15:00.000Z',
        }),
        token(1, { label: 'Thunderbird' }),
      ]
    })
    const [first, second] = rows('Your app tokens')
    expect(first!.textContent).toContain('DAVx5')
    expect(first!.textContent).toContain(formatDateTime('2026-10-29T09:00:00.000Z', zone.value))
    expect(first!.textContent).toContain(formatDateTime('2027-10-29T09:00:00.000Z', zone.value))
    expect(first!.textContent).toContain(formatDateTime('2026-10-30T10:15:00.000Z', zone.value))
    expect(second!.textContent).toContain('Never')
    expect(first!.textContent).not.toContain('Never')
    expect(first!.querySelectorAll('time')).toHaveLength(3)
  })

  it('marks an expired token with a text badge and counts only the others', async () => {
    await mountSection((api) => {
      api.tokens = [token(2, { label: 'Old phone', expired: true }), token(1)]
    })
    const [expired, active] = rows('Your app tokens')
    expect(expired!.textContent).toContain('Expired')
    expect(active!.textContent).not.toContain('Expired')
    expect(document.body.textContent).toContain('1 of 10 app tokens in use')
  })

  it('says so when there are none', async () => {
    await mountSection()
    expect(document.body.textContent).toContain('You have no app tokens yet.')
    expect(rows('Your app tokens')).toHaveLength(0)
  })

  it('shows an alert with Retry when the list cannot be loaded, and recovers', async () => {
    let failing = true
    backend.override = (call) =>
      failing && call.method === 'GET' && call.path === '/api/app-tokens'
        ? reply.error(500, 'boom')
        : undefined
    app = await mountSuspended(Shell, { attachTo: document.body })
    // ofetch repeats a GET that failed with a 5xx once; the alert comes after that
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain(
      'Could not load your app tokens. The server answered with an error (HTTP 500).',
    )
    // no skeleton stays behind, and the form still works
    expect(document.querySelector('.animate-pulse')).toBeNull()
    expect(submit().disabled).toBe(false)

    failing = false
    requireButton('Retry').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('You have no app tokens'))
    expect(alerts()).toHaveLength(0)
  })
})

describe('creating a token', () => {
  it('shows the secret once, read-only and selected, and removes it with Done', async () => {
    await mountSection()
    type(labelInput(), '  Thunderbird  ')
    submit().click()

    await vi.waitFor(() => expect(secretInput()).not.toBeNull())
    expect(backend.callsTo('POST', '/api/app-tokens')[0]!.body).toEqual({ label: 'Thunderbird' })
    const secret = secretInput()!
    expect(secret.value).toBe(backend.nextSecret)
    expect(secret.readOnly).toBe(true)
    expect(document.activeElement).toBe(secret)
    expect(secret.selectionStart).toBe(0)
    expect(secret.selectionEnd).toBe(secret.value.length)
    // named, and the warning is in the text
    expect(field('Token')).toBe(secret)
    expect(document.body.textContent).toContain('shown only once')
    expect(document.body.textContent).toContain('New token for “Thunderbird”')
    // the form is replaced, so a second token cannot push the first secret off the screen
    expect(document.querySelector('form')).toBeNull()
    // the list has the new token (without the secret)
    await vi.waitFor(() => expect(rows('Your app tokens')).toHaveLength(1))
    expect(rows('Your app tokens')[0]!.textContent).not.toContain(backend.nextSecret)

    // the secret is not kept in shared state, where another component or a payload could see it
    expect(JSON.stringify(useNuxtApp().payload.state)).not.toContain(backend.nextSecret)

    requireButton('Done').click()
    await vi.waitFor(() => expect(secretInput()).toBeNull())
    expect(document.body.textContent).not.toContain(backend.nextSecret)
    expect(document.body.textContent).not.toContain('shown only once')
    // the form is back, empty, with focus
    expect(labelInput().value).toBe('')
    expect(document.activeElement).toBe(labelInput())
  })

  it('drops the secret when the section goes away', async () => {
    await mountSection()
    type(labelInput(), 'DAVx5')
    submit().click()
    await vi.waitFor(() => expect(secretInput()).not.toBeNull())
    app.unmount()
    expect(document.body.textContent).not.toContain(backend.nextSecret)
    app = await mountSuspended(Shell, { attachTo: document.body })
    expect(secretInput()).toBeNull()
  })

  it('copies the secret and announces it politely', async () => {
    const written: string[] = []
    const restore = stubClipboard(async (text) => void written.push(text))
    try {
      await mountSection()
      type(labelInput(), 'DAVx5')
      submit().click()
      await vi.waitFor(() => expect(secretInput()).not.toBeNull())

      const live = document.querySelector('[role="status"][aria-live="polite"]')
      expect(live).not.toBeNull()
      expect(statusText()).not.toContain('Copied')
      requireButton('Copy').click()
      await vi.waitFor(() => expect(statusText()).toContain('Copied to the clipboard.'))
      expect(written).toEqual([backend.nextSecret])
    } finally {
      restore()
    }
  })

  it('selects the token and says what to do when copying is refused', async () => {
    const restore = stubClipboard(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    const consoleError = vi.spyOn(console, 'error')
    try {
      await mountSection()
      type(labelInput(), 'DAVx5')
      submit().click()
      await vi.waitFor(() => expect(secretInput()).not.toBeNull())
      requireButton('Copy').click()
      await vi.waitFor(() => expect(statusText()).toContain('Could not copy automatically'))
      expect(statusText()).toContain('press Ctrl+C')
      expect(document.activeElement).toBe(secretInput())
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('checks the label before asking the server, and follows the input afterwards', async () => {
    await mountSection()
    submit().click()
    await vi.waitFor(() =>
      expect(errorTexts()).toEqual(['Enter a label, for example the name of the app.']),
    )
    expect(backend.callsTo('POST', '/api/app-tokens')).toHaveLength(0)
    expect(labelInput().getAttribute('aria-invalid')).toBe('true')
    expect(labelInput().getAttribute('aria-describedby')).toMatch(/-error\b/)
    expect(document.activeElement).toBe(labelInput())

    type(labelInput(), 'x'.repeat(65))
    await vi.waitFor(() =>
      expect(errorTexts()).toEqual(['The label can have at most 64 characters.']),
    )

    type(labelInput(), 'x'.repeat(64))
    await vi.waitFor(() => expect(errorTexts()).toEqual([]))
    submit().click()
    await vi.waitFor(() => expect(secretInput()).not.toBeNull())
  })

  it('shows what the server rejects under the label', async () => {
    await mountSection((api) => {
      api.override = (call) =>
        call.method === 'POST'
          ? reply.invalid({ field: 'label', message: 'must have at most 64 characters' })
          : undefined
    })
    type(labelInput(), 'fine')
    submit().click()
    await vi.waitFor(() =>
      expect(errorTexts()).toEqual(['The label must have at most 64 characters.']),
    )
    expect(document.activeElement).toBe(labelInput())
    // the message is about the value that was sent: editing removes it
    type(labelInput(), 'finer')
    await vi.waitFor(() => expect(errorTexts()).toEqual([]))
  })

  it('shows a failure without an input to blame in an alert and keeps the label', async () => {
    await mountSection((api) => {
      api.override = (call) => (call.method === 'POST' ? reply.error(500, 'boom') : undefined)
    })
    type(labelInput(), 'DAVx5')
    submit().click()
    await vi.waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]!.textContent).toContain(
      'Could not create the token. The server answered with an error (HTTP 500).',
    )
    expect(labelInput().value).toBe('DAVx5')
    expect(secretInput()).toBeNull()
  })
})

describe('the limit', () => {
  it('disables creating at the limit and says why, in text next to the button', async () => {
    await mountSection((api) => {
      api.tokens = Array.from({ length: 10 }, (_, index) => token(index + 1))
    })
    expect(submit().disabled).toBe(true)
    expect(labelInput().disabled).toBe(true)
    const reason = document.getElementById(submit().getAttribute('aria-describedby')!)
    expect(reason?.textContent).toContain('You have 10 of 10 app tokens')
    expect(reason?.textContent).toContain('Revoke a token to create another one.')
  })

  it('counts only unexpired tokens', async () => {
    await mountSection((api) => {
      api.tokens = [
        ...Array.from({ length: 9 }, (_, index) => token(index + 1)),
        token(20, { expired: true }),
        token(21, { expired: true }),
      ]
    })
    expect(submit().disabled).toBe(false)
  })

  it('enables creating again after a revoke', async () => {
    await mountSection((api) => {
      api.tokens = Array.from({ length: 10 }, (_, index) => token(index + 1))
    })
    expect(submit().disabled).toBe(true)
    requireButton('Revoke token Token 1').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    requireButton('Revoke token').click()
    await vi.waitFor(() => expect(submit().disabled).toBe(false))
  })

  it('blocks the form when the server says the limit is reached, whatever the list said', async () => {
    await mountSection((api) => {
      api.override = (call) =>
        call.method === 'POST'
          ? reply.error(409, 'At most 10 app tokens are allowed per user', {
              code: 'limit_reached',
            })
          : undefined
    })
    type(labelInput(), 'one too many')
    submit().click()
    await vi.waitFor(() =>
      expect(alerts()[0]?.textContent).toContain('At most 10 app tokens are allowed per user'),
    )
    // the list is loaded again, so the form follows the real state
    await vi.waitFor(() => expect(backend.callsTo('GET', '/api/app-tokens')).toHaveLength(2))
  })
})

describe('revoking a token', () => {
  beforeEach(async () => {
    await mountSection((api) => {
      api.tokens = [token(2, { label: 'DAVx5' }), token(1, { label: 'Thunderbird' })]
    })
  })

  it('asks first, with the focus on Cancel; Escape closes it and focus returns', async () => {
    const opener = requireButton('Revoke token Thunderbird')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Revoke token “Thunderbird”?')
    expect(dialog()!.textContent).toContain('This cannot be undone.')
    expect(dialog()!.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dialog()!.getAttribute('aria-describedby')).toBeTruthy()
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Cancel'))

    keydown(document.activeElement, 'Escape')
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(opener)
    expect(backend.callsTo('DELETE', '/api/app-tokens/1')).toHaveLength(0)
    expect(rows('Your app tokens')).toHaveLength(2)
  })

  it('does nothing on Cancel', async () => {
    const opener = requireButton('Revoke token DAVx5')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    button('Cancel', dialog()!)!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
    expect(document.activeElement).toBe(opener)
  })

  it('revokes on confirm, removes the row, announces it and puts focus on the heading', async () => {
    const opener = requireButton('Revoke token Thunderbird')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    button('Revoke token', dialog()!)!.click()

    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('DELETE', '/api/app-tokens/1')).toHaveLength(1)
    expect(rows('Your app tokens').map((row) => row.textContent)).toEqual([
      expect.stringContaining('DAVx5'),
    ])
    expect(statusText()).toContain('Token “Thunderbird” revoked.')
    // the button that opened the dialog is gone: focus must not fall back to the page body
    expect(opener.isConnected).toBe(false)
    expect(document.activeElement?.tagName).toBe('H2')
    expect(document.activeElement?.textContent?.trim()).toBe('App tokens')
  })

  it('keeps the dialog open with the reason when revoking fails', async () => {
    backend.override = (call) => (call.method === 'DELETE' ? reply.error(500, 'boom') : undefined)
    requireButton('Revoke token DAVx5').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    button('Revoke token', dialog()!)!.click()
    await vi.waitFor(() => expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull())
    expect(dialog()!.textContent).toContain('Could not revoke the token.')
    expect(rows('Your app tokens')).toHaveLength(2)
  })

  it('treats a token that is already gone as revoked', async () => {
    backend.tokens = []
    requireButton('Revoke token DAVx5').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    button('Revoke token', dialog()!)!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(rows('Your app tokens').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Thunderbird'),
    ])
  })
})

describe('revoking every token (security review 2026-11-01, finding 3)', () => {
  beforeEach(async () => {
    await mountSection((api) => {
      api.tokens = [token(2, { label: 'DAVx5' }), token(1, { label: 'Thunderbird' })]
    })
  })

  it('asks first, with the focus on Cancel, and revokes nothing on Cancel', async () => {
    const opener = requireButton('Revoke all')
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain('Revoke all app tokens?')
    expect(dialog()!.textContent).toContain('This cannot be undone.')
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Cancel'))

    button('Cancel', dialog()!)!.click()
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
    expect(rows('Your app tokens')).toHaveLength(2)
    expect(document.activeElement).toBe(opener)
  })

  it('revokes every token on confirm, empties the list and announces it', async () => {
    requireButton('Revoke all').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    button('Revoke all', dialog()!)!.click()

    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(backend.callsTo('DELETE', '/api/app-tokens')).toHaveLength(1)
    expect(backend.tokens).toEqual([])
    expect(document.body.textContent).toContain('You have no app tokens yet.')
    expect(statusText()).toContain('All app tokens revoked.')
    expect(button('Revoke all')).toBeUndefined()
    expect(document.activeElement?.textContent?.trim()).toBe('App tokens')
  })

  it('keeps the dialog open with the reason when it fails, and the tokens stay listed', async () => {
    backend.override = (call) => (call.method === 'DELETE' ? reply.error(500, 'boom') : undefined)
    requireButton('Revoke all').click()
    await vi.waitFor(() => expect(dialog()).not.toBeNull())
    button('Revoke all', dialog()!)!.click()
    await vi.waitFor(() => expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull())
    expect(dialog()!.textContent).toContain('Could not revoke your app tokens.')
    expect(rows('Your app tokens')).toHaveLength(2)
  })
})

describe('with no tokens', () => {
  it('has nothing to revoke, so it offers no "Revoke all"', async () => {
    await mountSection()
    expect(rows('Your app tokens')).toHaveLength(0)
    expect(button('Revoke all')).toBeUndefined()
  })
})
