// Colours for calendars and categories that bring none of their own. All are dark enough for
// white text (the event colours derive their text colour from the background anyway) and
// distinguishable from each other.

export const PALETTE = [
  '#1d4ed8',
  '#047857',
  '#6d28d9',
  '#b45309',
  '#0f766e',
  '#b91c1c',
  '#9d174d',
  '#4d7c0f',
  '#0e7490',
  '#4338ca',
] as const

/** The palette colour for the n-th item of a list; wraps around. */
export function paletteColor(index: number): string {
  const size = PALETTE.length
  return PALETTE[((Math.trunc(index) % size) + size) % size]!
}

/**
 * A palette colour that depends on the text only (FNV-1a over the lower-cased name), so the same
 * category name keeps its colour between reloads and sessions and whatever else is on screen.
 */
export function colorForName(name: string): string {
  let hash = 0x811c9dc5
  for (const char of name.trim().toLowerCase()) {
    hash ^= char.codePointAt(0)!
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return paletteColor(hash)
}

/** `#rrggbb` (any case) -> lower case; anything else -> null. */
export function normalizeHexColor(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null
}
