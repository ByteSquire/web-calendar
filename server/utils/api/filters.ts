// Validation of the body of POST and PUT /api/filters.
import { FILTER_KINDS, FILTER_MODES, FILTER_STATUSES, type FilterInput } from '../../db/filters'
import { FieldErrors, finish, readChoice, readObject, readText, type Parsed } from './validation'

export const MAX_FILTER_NAME_LENGTH = 80
export const MAX_FILTER_VALUE_LENGTH = 200
/** A person filter names at most this many people, each in at most `MAX_FILTER_VALUE_LENGTH`. */
export const MAX_FILTER_PEOPLE = 20
/** Room for the JSON list of a person filter, escapes included. */
export const MAX_PERSON_FILTER_VALUE_LENGTH = 8000

/**
 * The value of a person filter: a JSON list of 1 to `MAX_FILTER_PEOPLE` names or addresses (or
 * `Name <address>`), each once (letter case aside); stored as the list of the trimmed texts.
 */
function readPeople(text: string, errors: FieldErrors): string | undefined {
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    list = null
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_FILTER_PEOPLE) {
    errors.add('value', `must be a JSON list of 1 to ${MAX_FILTER_PEOPLE} names or addresses`)
    return undefined
  }
  const seen = new Set<string>()
  const people: string[] = []
  list.forEach((entry: unknown, index) => {
    const field = `value[${index}]`
    const person = typeof entry === 'string' ? entry.trim() : ''
    if (!person) errors.add(field, 'must be a name or an address')
    else if (person.length > MAX_FILTER_VALUE_LENGTH) {
      errors.add(field, `must have at most ${MAX_FILTER_VALUE_LENGTH} characters`)
    } else if (/\p{Cc}/u.test(person)) errors.add(field, 'must not hold control characters')
    else if (seen.has(person.toLowerCase())) errors.add(field, 'appears more than once')
    else {
      seen.add(person.toLowerCase())
      people.push(person)
    }
  })
  return people.length === list.length ? JSON.stringify(people) : undefined
}

/**
 * `{ name, kind, value, mode? }`; for the kind `status` the value is one of the iCal event statuses,
 * for `person` a JSON list of people (`readPeople`). Without a mode a status filter hides its status
 * and the other kinds show only what they match, which is what filters did before they had a mode.
 */
export function parseFilterInput(body: unknown): Parsed<FilterInput> {
  const errors = new FieldErrors()
  const source = readObject(body, errors)
  const name = readText(source.name, 'name', MAX_FILTER_NAME_LENGTH, errors)
  const kind = readChoice(source.kind, 'kind', FILTER_KINDS, errors)
  const max = kind === 'person' ? MAX_PERSON_FILTER_VALUE_LENGTH : MAX_FILTER_VALUE_LENGTH
  let value = readText(source.value, 'value', max, errors)
  if (kind === 'status' && value !== undefined) {
    readChoice(value, 'value', FILTER_STATUSES, errors)
  }
  if (kind === 'person' && value !== undefined) value = readPeople(value, errors)
  const mode = readChoice(
    source.mode,
    'mode',
    FILTER_MODES,
    errors,
    kind === 'status' ? 'hide' : 'only',
  )
  return finish(errors, () => ({ name: name!, kind: kind!, value: value!, mode: mode! }))
}
