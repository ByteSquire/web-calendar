// A thin line model of an iCalendar text, used to patch a resource without losing anything the edit
// did not touch. ical.js round-trips most input, but it re-folds every line, moves parameters, drops
// `VALUE=DATE-TIME` and re-encodes parameter values (`X-ADDRESS="a\nb"` becomes `a^nb`). A calendar
// shared with Thunderbird, DAVx5 and iOS must come back from our edit as it went in, so every
// content line keeps its original text (folds included) until a function here replaces it.
// ical.js is still used where it is strong: expanding recurrence rules (recurrence-edit.ts).
import { EditError } from './write-types'

/** One content line (a property). `raw` is its text as read (folds included); null once changed. */
export interface Prop {
  kind: 'prop'
  /** Upper-case property name; empty for a line that is not `NAME[;params]:value`. */
  name: string
  /** The unfolded line. */
  text: string
  raw: string | null
}

export interface Comp {
  kind: 'comp'
  /** Upper-case component name; empty for the document root. */
  name: string
  beginRaw: string
  endRaw: string
  children: Node[]
}

export type Node = Prop | Comp

/** One `;NAME=value` parameter as written (the raw text still has its quotes). */
export interface Param {
  name: string
  /** The values without their quotes. */
  values: string[]
  raw: string
}

export interface ParsedLine {
  name: string
  params: Param[]
  /** The value as written (still escaped); everything after the first unquoted colon. */
  value: string
  /** Index of the value's first character in `text`. */
  valueStart: number
  valid: boolean
}

const CRLF = '\r\n'
const FOLD_OCTETS = 75

/** Splits a text into logical (unfolded) lines, keeping each line's original physical text. */
function unfold(text: string): Array<{ text: string; raw: string }> {
  const physical = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  const lines: Array<{ text: string; raw: string }> = []
  for (const line of physical) {
    if (line === '') continue
    const last = lines[lines.length - 1]
    if ((line.startsWith(' ') || line.startsWith('\t')) && last) {
      last.text += line.slice(1)
      last.raw += CRLF + line
    } else {
      lines.push({ text: line, raw: line })
    }
  }
  return lines
}

/** Folds a content line at 75 octets without splitting a character, as RFC 5545 §3.1 asks. */
export function foldLine(text: string): string {
  let out = ''
  let octets = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    // A continuation line starts with one space, which counts toward its 75 octets.
    if (octets + size > FOLD_OCTETS) {
      out += CRLF + ' '
      octets = 1
    }
    out += char
    octets += size
  }
  return out
}

function upper(value: string): string {
  return value.toUpperCase()
}

/** Reads a text as a tree of components. Text outside any component is kept as root properties. */
export function parseDocument(text: string): Comp {
  const root: Comp = { kind: 'comp', name: '', beginRaw: '', endRaw: '', children: [] }
  const stack: Comp[] = [root]
  for (const line of unfold(text)) {
    const top = stack[stack.length - 1]!
    const begin = /^BEGIN:(.*)$/i.exec(line.text)
    const end = /^END:(.*)$/i.exec(line.text)
    if (begin) {
      const comp: Comp = {
        kind: 'comp',
        name: upper(begin[1]!.trim()),
        beginRaw: line.raw,
        endRaw: '',
        children: [],
      }
      top.children.push(comp)
      stack.push(comp)
    } else if (end) {
      if (stack.length < 2 || top.name !== upper(end[1]!.trim())) {
        throw new EditError('unparseable', `Unbalanced END:${end[1]} in the calendar text.`)
      }
      top.endRaw = line.raw
      stack.pop()
    } else {
      top.children.push({
        kind: 'prop',
        name: propertyName(line.text),
        text: line.text,
        raw: line.raw,
      })
    }
  }
  if (stack.length !== 1) {
    throw new EditError(
      'unparseable',
      `Missing END:${stack[stack.length - 1]!.name} in the calendar text.`,
    )
  }
  return root
}

/** The text of a document: CRLF line endings, every untouched line exactly as it was read. */
export function serializeDocument(root: Comp): string {
  const out: string[] = []
  const walk = (comp: Comp): void => {
    for (const child of comp.children) {
      if (child.kind === 'prop') {
        out.push(child.raw ?? foldLine(child.text))
      } else {
        out.push(child.beginRaw || `BEGIN:${child.name}`)
        walk(child)
        out.push(child.endRaw || `END:${child.name}`)
      }
    }
  }
  walk(root)
  return out.join(CRLF) + CRLF
}

function propertyName(text: string): string {
  const match = /^([^;:]+)[;:]/.exec(text)
  return match ? upper(match[1]!.trim()) : ''
}

const parsedCache = new WeakMap<Prop, { text: string; parsed: ParsedLine }>()

/** Splits a content line into name, parameters and value (parameter values may be quoted). */
export function parseLine(prop: Prop): ParsedLine {
  const cached = parsedCache.get(prop)
  if (cached && cached.text === prop.text) return cached.parsed
  const parsed = splitContentLine(prop.text)
  parsedCache.set(prop, { text: prop.text, parsed })
  return parsed
}

function splitContentLine(text: string): ParsedLine {
  let i = 0
  while (i < text.length && text[i] !== ';' && text[i] !== ':') i++
  const name = upper(text.slice(0, i).trim())
  const params: Param[] = []
  while (i < text.length && text[i] === ';') {
    const start = i + 1
    let j = start
    let quoted = false
    while (j < text.length && (quoted || (text[j] !== ';' && text[j] !== ':'))) {
      if (text[j] === '"') quoted = !quoted
      j++
    }
    const raw = text.slice(start, j)
    const eq = raw.indexOf('=')
    params.push({
      name: upper(eq < 0 ? raw : raw.slice(0, eq)),
      values: eq < 0 ? [] : splitParamValues(raw.slice(eq + 1)),
      raw,
    })
    i = j
  }
  if (text[i] !== ':') return { name, params, value: '', valueStart: text.length, valid: false }
  return { name, params, value: text.slice(i + 1), valueStart: i + 1, valid: true }
}

function splitParamValues(raw: string): string[] {
  const values: string[] = []
  let current = ''
  let quoted = false
  for (const char of raw) {
    if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) {
      values.push(current)
      current = ''
    } else current += char
  }
  values.push(current)
  return values
}

/** The first value of the named parameter, or undefined. */
export function paramValue(prop: Prop, name: string): string | undefined {
  return parseLine(prop).params.find((p) => p.name === upper(name))?.values[0]
}

/** The property's value as written (still escaped). */
export function rawValue(prop: Prop): string {
  return parseLine(prop).value
}

// ---------------------------------------------------------------------------------------------
// Building lines

/** Removes control characters that would break a content line or smuggle one in. */
export function stripControl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/** Escapes a TEXT value (RFC 5545 §3.3.11); line breaks become `\n`, so a value is always one line. */
export function escapeText(value: string): string {
  return stripControl(value.replace(/\r\n|\r/g, '\n'))
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

/** The reverse of `escapeText`: the text a TEXT value stands for. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\s\S])/g, (_, char: string) =>
    char === 'n' || char === 'N' ? '\n' : char,
  )
}

/** Splits a list of TEXT values (`CATEGORIES`) at unescaped commas and unescapes each one. */
export function splitTextList(value: string): string[] {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (char === '\\' && i + 1 < value.length) {
      current += char + value[i + 1]
      i++
    } else if (char === ',') {
      parts.push(current)
      current = ''
    } else current += char
  }
  parts.push(current)
  return parts.map(unescapeText)
}

/** A parameter value as it has to be written: quoted when it holds `;`, `:` or `,` (RFC 6868 escapes). */
export function paramText(value: string): string {
  const clean = stripControl(value).replace(/\^/g, '^^').replace(/"/g, "^'")
  return /[;:,]/.test(clean) ? `"${clean}"` : clean
}

/** A new property. `params` are `NAME=value` segments already in their written form. */
export function makeProp(name: string, params: string[], value: string): Prop {
  const text = `${upper(name)}${params.map((p) => `;${p}`).join('')}:${value}`
  return { kind: 'prop', name: upper(name), text, raw: null }
}

/** The same property with another value and the parameters it had. */
export function withValue(prop: Prop, value: string): Prop {
  const parsed = parseLine(prop)
  return {
    kind: 'prop',
    name: prop.name,
    text: prop.text.slice(0, parsed.valueStart) + value,
    raw: null,
  }
}

/** The same property with its parameters replaced (`drop` removes by name, `add` appends). */
export function withParams(prop: Prop, drop: string[], add: string[]): Prop {
  const parsed = parseLine(prop)
  const dropped = new Set(drop.map(upper))
  const kept = parsed.params.filter((p) => !dropped.has(p.name)).map((p) => p.raw)
  return makeProp(prop.name, [...kept, ...add], parsed.value)
}

// ---------------------------------------------------------------------------------------------
// Tree helpers

export function props(comp: Comp, name: string): Prop[] {
  const wanted = upper(name)
  return comp.children.filter((c): c is Prop => c.kind === 'prop' && c.name === wanted)
}

export function firstProp(comp: Comp, name: string): Prop | undefined {
  return props(comp, name)[0]
}

export function subcomponents(comp: Comp, name: string): Comp[] {
  const wanted = upper(name)
  return comp.children.filter((c): c is Comp => c.kind === 'comp' && c.name === wanted)
}

export function removeProps(comp: Comp, name: string): boolean {
  const before = comp.children.length
  const wanted = upper(name)
  comp.children = comp.children.filter((c) => !(c.kind === 'prop' && c.name === wanted))
  return comp.children.length !== before
}

/** Where a new property goes: after the last property, before the first sub-component. */
function insertionIndex(comp: Comp): number {
  const firstComp = comp.children.findIndex((c) => c.kind === 'comp')
  return firstComp < 0 ? comp.children.length : firstComp
}

export function insertProp(comp: Comp, prop: Prop, before?: Prop): void {
  const at = before ? comp.children.indexOf(before) : -1
  comp.children.splice(at >= 0 ? at : insertionIndex(comp), 0, prop)
}

/** Inserts right after `anchor` (or like `insertProp` when the anchor is gone). */
export function insertPropAfter(comp: Comp, prop: Prop, anchor: Prop | undefined): void {
  const at = anchor ? comp.children.indexOf(anchor) : -1
  if (at < 0) insertProp(comp, prop)
  else comp.children.splice(at + 1, 0, prop)
}

/**
 * Makes `replacement` the only property of its name: it takes the place of the first existing one
 * (so the property order is kept) and the others go. With no existing one it is inserted.
 */
export function replaceProps(comp: Comp, name: string, replacement: Prop[]): void {
  const wanted = upper(name)
  const first = comp.children.findIndex((c) => c.kind === 'prop' && c.name === wanted)
  if (first < 0) {
    for (const prop of replacement) insertProp(comp, prop)
    return
  }
  const before = comp.children.slice(0, first)
  const after = comp.children
    .slice(first + 1)
    .filter((c) => !(c.kind === 'prop' && c.name === wanted))
  comp.children = [...before, ...replacement, ...after]
}

/**
 * Applies `fn` to every property of that name: a different property replaces it, null removes it.
 * Returns true when anything changed.
 */
export function rewriteProps(comp: Comp, name: string, fn: (prop: Prop) => Prop | null): boolean {
  const wanted = upper(name)
  let changed = false
  comp.children = comp.children.flatMap((child) => {
    if (child.kind !== 'prop' || child.name !== wanted) return [child]
    const next = fn(child)
    if (next !== child) changed = true
    return next ? [next] : []
  })
  return changed
}

/** A deep copy; untouched lines keep their original text. */
export function cloneComp(comp: Comp): Comp {
  return {
    ...comp,
    children: comp.children.map((c) => (c.kind === 'prop' ? { ...c } : cloneComp(c))),
  }
}

/** The text of one component (for readers such as ical.js), with CRLF line ends. */
export function componentText(comp: Comp): string {
  return serializeDocument({ kind: 'comp', name: '', beginRaw: '', endRaw: '', children: [comp] })
}
