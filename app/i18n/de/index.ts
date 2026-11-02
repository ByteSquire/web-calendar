// The German texts, one file per area so that several people can work at the same time. The key is
// the English text as it is written in the code (docs/i18n.md has the rules and the glossary).
import { admin } from './admin'
import { common } from './common'
import { data } from './data'
import { dates } from './dates'
import { events } from './events'
import { settings } from './settings'
import { shell } from './shell'

/** Every area by name. A text may be in one area only (tests/i18n-completeness.test.ts). */
export const AREAS: Record<string, Readonly<Record<string, string>>> = {
  common,
  dates,
  shell,
  events,
  settings,
  admin,
  data,
}

export const de: Readonly<Record<string, string>> = Object.assign({}, ...Object.values(AREAS))
