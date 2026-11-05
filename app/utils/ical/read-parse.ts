// Parsing the text of an .ics resource with ical.js for read.ts, and the helpers that report
// what went wrong.
import ICAL from 'ical.js'
import type { ReadIssue } from './read-types'

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function issue(uid: string | undefined, message: string, severity?: 'warning'): ReadIssue {
  const result: ReadIssue = { message }
  if (uid) result.uid = uid
  if (severity) result.severity = severity
  return result
}

export interface Parsed {
  vevents: ICAL.Component[]
  vtimezones: ICAL.Component[]
}

function addRoot(parsed: Parsed, root: ICAL.Component): void {
  if (root.name === 'vevent') parsed.vevents.push(root)
  else if (root.name === 'vtimezone') parsed.vtimezones.push(root)
  else {
    parsed.vevents.push(...root.getAllSubcomponents('vevent'))
    parsed.vtimezones.push(...root.getAllSubcomponents('vtimezone'))
  }
}

/**
 * When ical.js rejects the whole text (one line without a colon is enough), parse the VEVENT and
 * VTIMEZONE blocks one by one so the readable ones survive. Returns how many blocks there were.
 */
function salvage(ics: string, parsed: Parsed, errors: ReadIssue[]): number {
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r\n|\r|\n/)
  const blocks: { kind: 'vevent' | 'vtimezone'; lines: string[] }[] = []
  let current: { kind: 'vevent' | 'vtimezone'; lines: string[] } | null = null
  let depth = 0
  for (const line of lines) {
    const upper = line.trim().toUpperCase()
    if (!current) {
      if (upper === 'BEGIN:VEVENT') current = { kind: 'vevent', lines: [line] }
      else if (upper === 'BEGIN:VTIMEZONE') current = { kind: 'vtimezone', lines: [line] }
      continue
    }
    current.lines.push(line)
    if (upper.startsWith('BEGIN:')) depth++
    else if (upper.startsWith('END:')) {
      if (depth === 0) {
        blocks.push(current)
        current = null
      } else depth--
    }
  }
  const uidOf = (block: string[]): string | undefined =>
    block.map((line) => /^UID(?:;[^:]*)?:(.*)$/i.exec(line)?.[1]?.trim()).find(Boolean)
  if (current) {
    errors.push(issue(uidOf(current.lines), `Incomplete ${current.kind}: no END line`))
  }
  const parse = (kind: string, block: string[]): ICAL.Component | null => {
    const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...block, 'END:VCALENDAR'].join('\r\n')
    return new ICAL.Component(ICAL.parse(text)).getFirstSubcomponent(kind)
  }
  for (const block of blocks) {
    const uid = uidOf(block.lines)
    let component: ICAL.Component | null = null
    try {
      component = parse(block.kind, block.lines)
    } catch (error) {
      // A line ical.js cannot read (a stray line, an RRULE with a number out of range) is the usual
      // cause. Leave those lines out and read the rest of the component.
      const dropped: string[] = []
      const kept = block.lines.filter((line) => {
        if (/^(BEGIN|END):/i.test(line.trim())) return true
        try {
          ICAL.parse.property(line.trim())
          return true
        } catch {
          dropped.push(line.trim().split(/[;:]/)[0]?.slice(0, 40) ?? '')
          return false
        }
      })
      try {
        component = parse(block.kind, kept)
        errors.push(
          issue(
            uid,
            `Ignored unreadable line(s) in a ${block.kind}: ${dropped.join(', ')}`,
            'warning',
          ),
        )
      } catch {
        errors.push(issue(uid, `Unreadable ${block.kind}: ${messageOf(error)}`))
      }
    }
    if (component) addRoot(parsed, component)
  }
  return blocks.length
}

export function parseIcs(ics: string, errors: ReadIssue[]): Parsed {
  const parsed: Parsed = { vevents: [], vtimezones: [] }
  try {
    const jcal: unknown = ICAL.parse(ics)
    const roots: unknown[] =
      Array.isArray(jcal) && typeof jcal[0] === 'string' ? [jcal] : (jcal as unknown[])
    if (!roots.length) errors.push({ message: 'No iCalendar data found' })
    for (const root of roots) addRoot(parsed, new ICAL.Component(root as unknown[]))
  } catch (error) {
    const blocks = salvage(ics, parsed, errors)
    errors.push(
      blocks
        ? {
            message: `The calendar data is damaged (${messageOf(error)}); read what could be read`,
            severity: 'warning',
          }
        : { message: `Not iCalendar data: ${messageOf(error)}` },
    )
  }
  return parsed
}
