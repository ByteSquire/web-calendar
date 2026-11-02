// The colours a subscription can be given. A small fixed set instead of a free colour picker: each
// colour has a name (so the choice is not colour-only information, WCAG 1.4.1), and all of them are
// dark enough for white event text. The values are the 700 shades also used by the mock calendars.

import { N_, t, tv } from '~/utils/i18n'

export interface ColorChoice {
  /** `#rrggbb`, or '' for "no colour chosen" (the server then stores null). */
  value: string
  name: string
}

export const COLOR_PALETTE: readonly ColorChoice[] = [
  { value: '#1d4ed8', name: N_('Blue') },
  { value: '#047857', name: N_('Green') },
  { value: '#6d28d9', name: N_('Purple') },
  { value: '#b45309', name: N_('Amber') },
  { value: '#b91c1c', name: N_('Red') },
  { value: '#0f766e', name: N_('Teal') },
  { value: '#9d174d', name: N_('Pink') },
  { value: '#4d7c0f', name: N_('Olive') },
]

export const DEFAULT_COLOR = COLOR_PALETTE[0]!.value

/** The name of a stored colour, for assistive technology: `Blue`, `Custom colour`, `No colour`. */
export function colorName(value: string | null): string {
  if (!value) return t('No colour')
  const found = COLOR_PALETTE.find((color) => color.value === value.toLowerCase())
  return found ? tv(found.name) : t('Custom colour')
}

/**
 * The choices of the picker. Adding offers the palette. Changing also keeps what the subscription
 * has now when the palette does not cover it (no colour, or one set through the API), so saving
 * the form without touching the colour never changes it.
 */
export function colorChoices(current: string | null | undefined, editing: boolean): ColorChoice[] {
  const choices = [...COLOR_PALETTE]
  if (!editing) return choices
  const value = current?.toLowerCase() ?? ''
  if (value === '') return [{ value: '', name: N_('Default') }, ...choices]
  if (choices.some((color) => color.value === value)) return choices
  return [...choices, { value, name: N_('Current') }]
}

/** The choice a form starts with: the stored colour, else the first palette colour for a new one. */
export function initialColor(current: string | null | undefined, editing: boolean): string {
  if (!editing) return DEFAULT_COLOR
  return current?.toLowerCase() ?? ''
}
