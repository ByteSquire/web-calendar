// Validation of the body of POST and PUT /api/filters.
import { FILTER_KINDS, FILTER_STATUSES, type FilterInput } from '../../db/filters'
import { FieldErrors, finish, readChoice, readObject, readText, type Parsed } from './validation'

export const MAX_FILTER_NAME_LENGTH = 80
export const MAX_FILTER_VALUE_LENGTH = 200

/** `{ name, kind, value }`; for the kind `status` the value is one of the iCal event statuses. */
export function parseFilterInput(body: unknown): Parsed<FilterInput> {
  const errors = new FieldErrors()
  const source = readObject(body, errors)
  const name = readText(source.name, 'name', MAX_FILTER_NAME_LENGTH, errors)
  const kind = readChoice(source.kind, 'kind', FILTER_KINDS, errors)
  const value = readText(source.value, 'value', MAX_FILTER_VALUE_LENGTH, errors)
  if (kind === 'status' && value !== undefined) {
    readChoice(value, 'value', FILTER_STATUSES, errors)
  }
  return finish(errors, () => ({ name: name!, kind: kind!, value: value! }))
}
