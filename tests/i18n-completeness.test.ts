// Every text of the app that is translated has a German text (docs/i18n.md). The test reads the
// source: each `t('…')`, `tc('…')`, `N_('…')` and `tv('…')` with a string literal is a text.
// I18N_ONLY=app/components/settings,app/utils/settings limits the "missing" and "not a literal"
// checks to those paths (a worklist while one area is being done); the other checks then skip.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AREAS, de } from '../app/i18n/de'

// Vitest runs from the root of the repository.
const ROOT = process.cwd()
const ONLY = (process.env.I18N_ONLY ?? '')
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean)

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return listFiles(path)
    return /\.(ts|vue)$/.test(entry.name) ? [path] : []
  })
}

// The code that is read: the app and the shared code, not the German texts themselves, the
// helper (its comments hold examples), the demo's sample data or anything that is not shipped.
const FILES = [...listFiles(join(ROOT, 'app')), ...listFiles(join(ROOT, 'shared'))]
  .map((path) => relative(ROOT, path))
  .filter(
    (path) =>
      !path.startsWith('app/i18n/') && path !== 'app/utils/i18n.ts' && path !== 'app/data/mock.ts',
  )
  .sort()

/** Lines of comments are not code: they may quote `t('…')` as an example. */
function codeOf(text: string): string {
  let inHtmlComment = false
  let inBlockComment = false
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (inHtmlComment) {
        if (trimmed.includes('-->')) inHtmlComment = false
        return ''
      }
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false
        return ''
      }
      if (trimmed.startsWith('<!--')) {
        if (!trimmed.includes('-->')) inHtmlComment = true
        return ''
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true
        return ''
      }
      return trimmed.startsWith('//') || trimmed.startsWith('*') ? '' : line
    })
    .join('\n')
}

const LITERAL_CALL =
  /(?<![\w.$])(t|tc|N_|tv|tparts)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`$\\]*)`)/g
const ANY_CALL = /(?<![\w.$])(t|tc|N_|tparts)\(\s*(?!\))/g

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, char: string) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char,
  )
}

interface Found {
  file: string
  text: string
}

// The "action" of a failure message ("load the people") is passed to these functions as plain
// text and translated later with `tv`: it must be marked with `N_` or the test above cannot see it.
const ACTION_CALL =
  /(?<![\w.$])(?:createResource|describeError|describeExternalSaveError|describe\w*SaveError)\(/g
const BARE_ACTION = /(?<!N_\(\s*)'([a-z][a-z’ ]*[a-z])'/g

/** The text of a call from its `(` to the matching `)`, quotes taken into account. */
function callText(code: string, open: number): string {
  let depth = 0
  let quote = ''
  for (let at = open; at < code.length; at++) {
    const char = code[at]!
    if (quote) {
      if (char === '\\') at++
      else if (char === quote) quote = ''
    } else if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(') depth++
    else if (char === ')' && --depth === 0) return code.slice(open, at + 1)
  }
  return code.slice(open)
}

const used: Found[] = []
const notLiteral: string[] = []
const bareActions: string[] = []
for (const file of FILES) {
  const code = codeOf(readFileSync(join(ROOT, file), 'utf8'))
  const literalCalls = new Set<number>()
  for (const match of code.matchAll(LITERAL_CALL)) {
    literalCalls.add(match.index)
    used.push({ file, text: unescape(match[2] ?? match[3] ?? match[4] ?? '') })
  }
  for (const match of code.matchAll(ACTION_CALL)) {
    const call = callText(code, match.index + match[0].length - 1)
    for (const bare of call.matchAll(BARE_ACTION)) {
      if (!bare[1]!.includes(' ')) continue
      const line = code.slice(0, match.index).split('\n').length
      bareActions.push(`${file}:${line}  '${bare[1]}'`)
    }
  }
  for (const match of code.matchAll(ANY_CALL)) {
    // Calls with a literal were read above; `tv` takes anything, so it is not in this pattern.
    if (literalCalls.has(match.index)) continue
    const line = code.slice(0, match.index).split('\n').length
    notLiteral.push(`${file}:${line}  ${code.split('\n')[line - 1]!.trim().slice(0, 100)}`)
  }
}

const inScope = (file: string) =>
  ONLY.length === 0 || ONLY.some((prefix) => file.startsWith(prefix))
const placeholders = (text: string) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort()

describe('the German texts', () => {
  it('read the source: there is something to check', () => {
    expect(FILES.length).toBeGreaterThan(50)
    expect(used.length).toBeGreaterThan(0)
  })

  it('are asked for with a string literal (a text that is built cannot be checked)', () => {
    expect(notLiteral.filter((entry) => inScope(entry.split(':')[0]!))).toEqual([])
  })

  it('are marked with N_ where a message is told what failed ("load the people")', () => {
    expect(bareActions.filter((entry) => inScope(entry.split(':')[0]!))).toEqual([])
  })

  it('exist for every text of the app', () => {
    const missing = used
      .filter((entry) => inScope(entry.file) && !(entry.text in de))
      .map((entry) => `${entry.file}: ${entry.text}`)
    const unique = [...new Set(missing)]
    expect(unique.slice(0, 60), `${unique.length} texts have no German text yet`).toEqual([])
  })

  it('have no empty entry, and the same {values} and plural forms as the English text', () => {
    const wrong = Object.entries(de).flatMap(([text, german]) => {
      if (german.trim() === '') return [`${text}: empty`]
      const problems: string[] = []
      if (placeholders(text).join() !== placeholders(german).join()) {
        problems.push(`${text}: values ${placeholders(text)} against ${placeholders(german)}`)
      }
      if (text.split(' | ').length !== german.split(' | ').length) {
        problems.push(`${text}: number of forms`)
      }
      return problems
    })
    expect(wrong).toEqual([])
  })

  it('are all used, and each is in one area only', () => {
    if (ONLY.length > 0) return
    const known = new Set(used.map((entry) => entry.text))
    expect(Object.keys(de).filter((text) => !known.has(text))).toEqual([])

    const seen = new Map<string, string>()
    const twice: string[] = []
    for (const [area, entries] of Object.entries(AREAS)) {
      for (const text of Object.keys(entries)) {
        if (seen.has(text)) twice.push(`${text}: ${seen.get(text)} and ${area}`)
        seen.set(text, area)
      }
    }
    expect(twice).toEqual([])
  })
})
