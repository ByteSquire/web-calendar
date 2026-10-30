// Validation of the body of POST and PUT /api/categories.
import type { CategoryInput } from '../../db/categories'
import {
  FieldErrors,
  finish,
  readObject,
  readOptionalColor,
  readText,
  type Parsed,
} from './validation'

export const MAX_CATEGORY_NAME_LENGTH = 40

/** `{ name, color? }`; no color (omitted or `null`) means the app picks one when it draws. */
export function parseCategoryInput(body: unknown): Parsed<CategoryInput> {
  const errors = new FieldErrors()
  const source = readObject(body, errors)
  const name = readText(source.name, 'name', MAX_CATEGORY_NAME_LENGTH, errors)
  const color = readOptionalColor(source.color, 'color', errors)
  return finish(errors, () => ({ name: name!, color: color ?? null }))
}
