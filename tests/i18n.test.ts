import { afterEach, describe, expect, it } from 'vitest'
import {
  LANGUAGE_KEY,
  N_,
  chooseLanguage,
  detectLocale,
  initLanguage,
  intlLocale,
  languageChoice,
  locale,
  readLanguageChoice,
  resolveLocale,
  setLocale,
  t,
  tc,
  tparts,
  tv,
  writeLanguageChoice,
} from '../app/utils/i18n'

function store(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[LANGUAGE_KEY, initial]])
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

afterEach(() => {
  initLanguage(null, ['en'])
})

describe('t', () => {
  it('is the text itself in English, with the values filled in', () => {
    expect(t('Enter a title.')).toBe('Enter a title.')
    expect(t('Copied {name} to your views', { name: 'Ops' })).toBe('Copied Ops to your views')
    expect(t('{day} of {count}', { day: 3, count: 7 })).toBe('3 of 7')
  })

  it('leaves a value that was not given as it is', () => {
    expect(t('Hello {name}', {})).toBe('Hello {name}')
    expect(t('Hello {name}')).toBe('Hello {name}')
  })

  it('gives the German text in German, and the English text where there is no German one yet', () => {
    setLocale('de')
    expect(t('Language')).toBe('Sprache')
    expect(t('A text that nobody translated')).toBe('A text that nobody translated')
    expect(
      t('{weekday}, {day} {month} {year}', { weekday: 'Do', day: 29, month: 'Okt', year: 2026 }),
    ).toBe('Do, 29. Okt 2026')
  })

  it('follows the language at the moment of the call, also for a text that N_ marked', () => {
    const label = N_('Language')
    expect(tv(label)).toBe('Language')
    setLocale('de')
    expect(tv(label)).toBe('Sprache')
    expect(label).toBe('Language')
  })
})

describe('tc', () => {
  it('chooses between two forms: one, other', () => {
    expect(tc('{count} booking | {count} bookings', 1)).toBe('1 booking')
    expect(tc('{count} booking | {count} bookings', 0)).toBe('0 bookings')
    expect(tc('{count} booking | {count} bookings', 5)).toBe('5 bookings')
  })

  it('chooses between three forms: none, one, other', () => {
    const text = 'No bookings | {count} booking | {count} bookings'
    expect(tc(text, 0)).toBe('No bookings')
    expect(tc(text, 1)).toBe('1 booking')
    expect(tc(text, 2)).toBe('2 bookings')
  })

  it('fills in other values too', () => {
    expect(tc('{count} event in {name} | {count} events in {name}', 2, { name: 'Ops' })).toBe(
      '2 events in Ops',
    )
  })
})

describe('tparts', () => {
  it('splits a text at its values, in the order of the language', () => {
    expect(tparts('Zone: {zone}. Events without a zone use it.')).toEqual([
      { text: 'Zone: ' },
      { name: 'zone' },
      { text: '. Events without a zone use it.' },
    ])
    expect(tparts('{first} and {second}')).toEqual([
      { name: 'first' },
      { text: ' and ' },
      { name: 'second' },
    ])
    expect(tparts('No values here')).toEqual([{ text: 'No values here' }])
    expect(tparts('Only {value}')).toEqual([{ text: 'Only ' }, { name: 'value' }])
  })

  it('uses the German text', () => {
    setLocale('de')
    expect(tparts('Go to {date}')).toEqual([{ text: 'Gehe zu ' }, { name: 'date' }])
  })
})

describe('the language', () => {
  it('is the first language of the browser that the app has, else English', () => {
    expect(detectLocale(['de-AT', 'en'])).toBe('de')
    expect(detectLocale(['fr-FR', 'de', 'en'])).toBe('de')
    expect(detectLocale(['fr-FR', 'en-GB'])).toBe('en')
    expect(detectLocale(['fr-FR'])).toBe('en')
    expect(detectLocale([])).toBe('en')
    expect(detectLocale(['DE'])).toBe('de')
  })

  it('takes the browser language on auto and the choice otherwise', () => {
    expect(resolveLocale('auto', ['de'])).toBe('de')
    expect(resolveLocale('en', ['de'])).toBe('en')
    expect(resolveLocale('de', ['en'])).toBe('de')
  })

  it('reads only a valid saved choice, and survives a store that fails', () => {
    expect(readLanguageChoice(store('de'))).toBe('de')
    expect(readLanguageChoice(store('en'))).toBe('en')
    expect(readLanguageChoice(store('fr'))).toBe('auto')
    expect(readLanguageChoice(store())).toBe('auto')
    expect(readLanguageChoice(null)).toBe('auto')
    expect(
      readLanguageChoice({
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => undefined,
      }),
    ).toBe('auto')
  })

  it('writes the choice, and does not throw when the store refuses', () => {
    const target = store()
    writeLanguageChoice(target, 'de')
    expect(target.data.get(LANGUAGE_KEY)).toBe('de')
    expect(() =>
      writeLanguageChoice(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error('full')
          },
        },
        'de',
      ),
    ).not.toThrow()
  })

  it('starts from the saved choice, else the browser, and applies a new choice at once', () => {
    expect(initLanguage(store(), ['de'])).toBe('de')
    expect(locale.value).toBe('de')
    expect(languageChoice.value).toBe('auto')

    expect(initLanguage(store('en'), ['de'])).toBe('en')
    expect(languageChoice.value).toBe('en')

    const target = store()
    chooseLanguage('de', target, ['en'])
    expect(locale.value).toBe('de')
    expect(languageChoice.value).toBe('de')
    expect(target.data.get(LANGUAGE_KEY)).toBe('de')

    chooseLanguage('auto', target, ['en-GB'])
    expect(locale.value).toBe('en')
    expect(target.data.get(LANGUAGE_KEY)).toBe('auto')
  })

  it('names the locale for dates', () => {
    expect(intlLocale()).toBe('en-GB')
    setLocale('de')
    expect(intlLocale()).toBe('de-DE')
  })
})
