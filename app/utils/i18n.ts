// Translations (docs/i18n.md). The English text IS the key: `t('Enter a title.')` is that text in
// English and the entry of the same text in app/i18n/<language>/ otherwise, so English needs no
// dictionary and a text that was not translated yet shows in English instead of as a key.
//
//   t('Copied {name} to your views', { name })       text with values; no template literals
//   tc('{count} booking | {count} bookings', n)       plural: forms split by " | " (two: one |
//                                                     other; three: none | one | other)
//   N_('Read') ... tv(level.label)                    N_ marks a text that sits in a table or a
//                                                     constant; tv() translates it when it is shown
//   tparts('Zone: {zone}. More text')                 the text split at its {values}, to put markup
//                                                     (<strong>, a link) around a value
//
// The language is module state, so `t` works in components, composables and plain TypeScript. A
// component that calls `t` while it renders follows a change of language without a reload.
// tests/i18n-completeness.test.ts reads every `t(`, `tc(` and `N_(` of the source: the first
// argument must be a plain string literal, and each text needs a German entry with the same {values}.
import { computed, shallowRef } from 'vue'
import { de } from '~/i18n/de'
import type { KeyValueStore } from '~/utils/resources/updates'

export type Locale = 'en' | 'de'
/** What a person chose: a language, or 'auto' for the browser's. */
export type LanguageChoice = 'auto' | Locale
export type Params = Record<string, string | number>

export const LOCALES: readonly Locale[] = ['en', 'de']
/** Each language in its own language: these names are never translated. */
export const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', de: 'Deutsch' }
export const LANGUAGE_KEY = 'web-calendar:language'

const DICTIONARIES: Record<Locale, Readonly<Record<string, string>>> = { en: {}, de }

const current = shallowRef<Locale>('en')
const chosen = shallowRef<LanguageChoice>('auto')

/** The language in use. Read it inside a render or a computed to follow a change. */
export const locale = computed<Locale>(() => current.value)
/** What the person chose (`auto` follows the browser). */
export const languageChoice = computed<LanguageChoice>(() => chosen.value)

export function setLocale(next: Locale): void {
  current.value = next
}

function fill(text: string, params: Params | undefined): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  )
}

function lookup(text: string): string {
  return DICTIONARIES[current.value][text] ?? text
}

/** The text in the language in use. */
export function t(text: string, params?: Params): string {
  return fill(lookup(text), params)
}

/** Marks a text that is translated later, with `tv`. It returns the text as it is. */
export function N_<T extends string>(text: T): T {
  return text
}

/** Translates a text that `N_` marked (a table entry, a constant). Not read by the tests. */
export function tv(text: string, params?: Params): string {
  return fill(lookup(text), params)
}

/** A text that depends on a number: forms split by " | ", chosen for `count` (it is `{count}`). */
export function tc(text: string, count: number, params?: Params): string {
  const forms = lookup(text).split(' | ')
  let form: string
  if (forms.length >= 3) {
    form = count === 0 ? forms[0]! : count === 1 ? forms[1]! : forms[2]!
  } else {
    const one = new Intl.PluralRules(current.value).select(count) === 'one'
    form = one ? forms[0]! : (forms[1] ?? forms[0]!)
  }
  return fill(form, { count, ...params })
}

export type TextPart = { text: string } | { name: string }

/**
 * A text split at its {values}, for a sentence with markup in it (a bold value, a link): the
 * template draws each `{ text }` as it is and puts its own element where `{ name }` stands, so the
 * translation decides the word order.
 *
 *   <template v-for="(part, i) in tparts('Zone: {zone}. Events without a zone use it.')" :key="i">
 *     <strong v-if="'name' in part">{{ orgZone }}</strong>
 *     <template v-else>{{ part.text }}</template>
 *   </template>
 */
export function tparts(text: string): TextPart[] {
  const translated = lookup(text)
  const parts: TextPart[] = []
  let last = 0
  for (const match of translated.matchAll(/\{(\w+)\}/g)) {
    if (match.index > last) parts.push({ text: translated.slice(last, match.index) })
    parts.push({ name: match[1]! })
    last = match.index + match[0].length
  }
  if (last < translated.length) parts.push({ text: translated.slice(last) })
  return parts
}

/** The locale for `Intl` formatters and dates in the language in use. */
export function intlLocale(): string {
  return current.value === 'de' ? 'de-DE' : 'en-GB'
}

/** The code of the language in FullCalendar's locale files. */
export function calendarLocaleCode(): string {
  return current.value === 'de' ? 'de' : 'en-gb'
}

// ---- Which language ----

/** The first language of the browser's list that the app has; English when none. */
export function detectLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split('-')[0]
    const found = LOCALES.find((locale) => locale === primary)
    if (found) return found
  }
  return 'en'
}

export function resolveLocale(choice: LanguageChoice, languages: readonly string[]): Locale {
  return choice === 'auto' ? detectLocale(languages) : choice
}

/** The saved choice; `auto` when nothing valid is saved or the store fails. */
export function readLanguageChoice(store: KeyValueStore | null): LanguageChoice {
  try {
    const value = store?.getItem(LANGUAGE_KEY)
    return value === 'en' || value === 'de' ? value : 'auto'
  } catch {
    return 'auto'
  }
}

/** Storage can be full or blocked: the choice then lasts until the page is reloaded. */
export function writeLanguageChoice(store: KeyValueStore | null, choice: LanguageChoice): void {
  try {
    store?.setItem(LANGUAGE_KEY, choice)
  } catch {
    // Ignored on purpose.
  }
}

/** Reads the saved choice and sets the language; the plugin calls it before the app is shown. */
export function initLanguage(store: KeyValueStore | null, languages: readonly string[]): Locale {
  chosen.value = readLanguageChoice(store)
  current.value = resolveLocale(chosen.value, languages)
  return current.value
}

/** A person's choice: kept in this browser and applied at once. */
export function chooseLanguage(
  choice: LanguageChoice,
  store: KeyValueStore | null,
  languages: readonly string[],
): void {
  chosen.value = choice
  writeLanguageChoice(store, choice)
  current.value = resolveLocale(choice, languages)
}
