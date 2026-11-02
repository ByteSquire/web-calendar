// @vitest-environment nuxt
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { SettingsLanguageSection, UApp, USelect } from '#components'
import { LANGUAGE_KEY, initLanguage, languageChoice, locale } from '~/utils/i18n'

const Shell = defineComponent({
  render: () => h(UApp, null, { default: () => h(SettingsLanguageSection) }),
})

let app: Awaited<ReturnType<typeof mountSuspended>> | undefined

afterEach(() => {
  app?.unmount()
  app = undefined
  window.localStorage.removeItem(LANGUAGE_KEY)
  initLanguage(null, ['en'])
})

const heading = () => document.querySelector('h2')?.textContent?.trim()
const trigger = () => document.querySelector<HTMLElement>('button[role="combobox"]')!
const label = () => document.querySelector('label')?.textContent?.trim()
const choose = (value: string) => app!.findComponent(USelect).vm.$emit('update:modelValue', value)

describe('the Language section of the settings', () => {
  it('names the language of the browser in the first choice, and starts on it', async () => {
    app = await mountSuspended(Shell, { attachTo: document.body })
    expect(heading()).toBe('Language')
    expect(label()).toBe('Language')
    expect(trigger().textContent).toContain('Browser language (English)')
  })

  it('switches to German at once, keeps the choice in this browser, and goes back', async () => {
    app = await mountSuspended(Shell, { attachTo: document.body })
    choose('de')
    await vi.waitFor(() => expect(heading()).toBe('Sprache'))
    expect(label()).toBe('Sprache')
    expect(locale.value).toBe('de')
    expect(languageChoice.value).toBe('de')
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('de')
    await vi.waitFor(() => expect(trigger().textContent).toContain('Deutsch'))

    choose('auto')
    await vi.waitFor(() => expect(heading()).toBe('Language'))
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('auto')
    await vi.waitFor(() => expect(trigger().textContent).toContain('Browser language (English)'))

    choose('en')
    await vi.waitFor(() => expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('en'))
  })

  it('ignores a value that is no language', async () => {
    app = await mountSuspended(Shell, { attachTo: document.body })
    choose('fr')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(locale.value).toBe('en')
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBeNull()
  })

  it('starts in the saved language', async () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'de')
    initLanguage(window.localStorage, ['en'])
    app = await mountSuspended(Shell, { attachTo: document.body })
    expect(heading()).toBe('Sprache')
    expect(trigger().textContent).toContain('Deutsch')
  })
})
