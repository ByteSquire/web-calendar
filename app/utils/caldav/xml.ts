// Readers for the objects tsdav builds from a multistatus body. tsdav keys properties by their
// camel-cased local name (`calendar-data` -> `calendarData`) whatever prefix the server picked, and
// by `{namespace}name` only when the same name appears in two namespaces; text is a string, CDATA
// is `{ _cdata }`, attributes are `{ _attributes }`, and one child versus many is an object versus
// an array. These helpers hide that so the client reads like the protocol.

export type Dict = Record<string, unknown>

export function isRecord(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** A property by local name, also when tsdav had to qualify the key with its namespace. */
export function prop(props: Dict | undefined, name: string): unknown {
  if (!props) return undefined
  if (name in props) return props[name]
  const qualified = Object.keys(props).find((key) => key.endsWith(`}${name}`))
  return qualified === undefined ? undefined : props[qualified]
}

/** The local names of an object's keys (`{ns}name` -> `name`, `_attributes` and friends left out). */
export function localKeys(value: Dict): string[] {
  return Object.keys(value)
    .filter((key) => !key.startsWith('_'))
    .map((key) => key.replace(/^\{[^}]*\}/, ''))
}

/**
 * The text of an element's value; null when there is none. `trim: false` for iCalendar text, which
 * must reach the parser exactly as the server wrote it.
 */
export function textOf(value: unknown, options: { trim?: boolean } = {}): string | null {
  let text: unknown = value
  if (isRecord(value)) text = value._cdata ?? value._text
  if (typeof text === 'number') text = String(text)
  if (typeof text !== 'string') return null
  return options.trim === false ? text : text.trim()
}

/** The first `<href>` below an element such as `current-user-principal` or `calendar-home-set`. */
export function hrefIn(container: unknown): string | null {
  if (!isRecord(container)) return null
  for (const candidate of asArray(container.href)) {
    const href = textOf(candidate)
    if (href) return href
  }
  return null
}

// One token at a time, from a `<`: a comment, CDATA, a processing instruction or declaration, or
// a start/end/empty tag (quoted attribute values may contain `>`). Attributes must start with
// whitespace, so the name cannot hand characters back to them: without that, a long run of
// letters after `<` backtracks quadratically.
const MARKUP =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>!?][^\s/>]*)((?:\s(?:[^>"']|"[^"]*"|'[^']*')*?)?)(\/?)>/y

/**
 * Whether `text` is one well-nested XML element (plus an optional declaration). tsdav's parser
 * swallows XML errors and returns whatever it managed to read, so a truncated or garbled
 * multistatus would otherwise pass as a shorter list of events. Tags only: entity and attribute
 * syntax are not checked.
 */
export function isWellFormedXml(text: string): boolean {
  const stack: string[] = []
  let roots = 0
  let at = text.indexOf('<')
  if (at === -1) return false
  if (text.slice(0, at).trim() !== '') return false
  while (at !== -1) {
    MARKUP.lastIndex = at
    const match = MARKUP.exec(text)
    if (!match) return false
    const [token, closing, name, , selfClosing] = match
    if (name !== undefined) {
      if (closing) {
        if (stack.pop() !== name) return false
      } else if (selfClosing) {
        if (stack.length === 0) roots++
      } else {
        if (stack.length === 0) roots++
        stack.push(name)
      }
      if (roots > 1) return false
    }
    const next = at + token.length
    at = text.indexOf('<', next)
    const between = text.slice(next, at === -1 ? undefined : at)
    // Outside the root only whitespace may appear (tag order was checked above).
    if (stack.length === 0 && between.trim() !== '') return false
  }
  return stack.length === 0 && roots === 1
}
