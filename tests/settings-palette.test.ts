// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  COLOR_PALETTE,
  DEFAULT_COLOR,
  colorChoices,
  colorName,
  initialColor,
} from '../app/utils/settings/palette'

describe('palette', () => {
  it('has unique, named, #rrggbb colours', () => {
    expect(new Set(COLOR_PALETTE.map((color) => color.value)).size).toBe(COLOR_PALETTE.length)
    expect(new Set(COLOR_PALETTE.map((color) => color.name)).size).toBe(COLOR_PALETTE.length)
    for (const color of COLOR_PALETTE) {
      expect(color.value).toMatch(/^#[0-9a-f]{6}$/)
      expect(color.name).not.toBe('')
    }
  })

  it('has colours dark enough for white event text (contrast 4.5:1)', () => {
    const channel = (value: number) => {
      const s = value / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    for (const { value, name } of COLOR_PALETTE) {
      const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(value.slice(i, i + 2), 16)))
      const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
      expect(1.05 / (luminance + 0.05), name).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('colorName', () => {
  it.each([
    ['#1d4ed8', 'Blue'],
    ['#1D4ED8', 'Blue'],
    ['#123456', 'Custom colour'],
    [null, 'No colour'],
    ['', 'No colour'],
  ])('%s is %s', (value, name) => {
    expect(colorName(value)).toBe(name)
  })
})

describe('colorChoices', () => {
  it('offers the palette when adding', () => {
    expect(colorChoices(undefined, false)).toEqual(COLOR_PALETTE)
  })

  it('offers a "Default" for a subscription without colour, so saving does not invent one', () => {
    expect(colorChoices(null, true)[0]).toEqual({ value: '', name: 'Default' })
    expect(colorChoices(null, true)).toHaveLength(COLOR_PALETTE.length + 1)
  })

  it('leaves a colour the palette does not cover to the picker’s "Custom"', () => {
    expect(colorChoices('#ABCDEF', true)).toEqual(COLOR_PALETTE)
  })

  it('adds nothing for a palette colour', () => {
    expect(colorChoices('#047857', true)).toEqual(COLOR_PALETTE)
  })
})

describe('initialColor', () => {
  it('starts a new subscription on the first palette colour and an existing one on its own', () => {
    expect(initialColor(undefined, false)).toBe(DEFAULT_COLOR)
    expect(initialColor('#047857', true)).toBe('#047857')
    expect(initialColor('#ABCDEF', true)).toBe('#abcdef')
    expect(initialColor(null, true)).toBe('')
  })
})
