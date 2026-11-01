import type { Locator, Page } from '@playwright/test'

// Contrast measured from what the browser painted, for what a rule-based scan cannot judge
// (text over hatching, placeholders, the edge of a control).

/** WCAG 2.x contrast ratio of two sRGB colours, each `[r, g, b]` in 0..255. */
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const luminance = (rgb: readonly number[]) => {
    const [r = 0, g = 0, bl = 0] = rgb.map((value) => {
      const scaled = value / 255
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** A CSS custom property as `[r, g, b]`, whatever colour space it is written in. */
export async function tokenColor(page: Page, token: string): Promise<number[]> {
  return page.evaluate((name) => {
    // An unknown variable would fall back to the text colour and pass any test.
    if (!getComputedStyle(document.documentElement).getPropertyValue(name).trim()) {
      throw new Error(`${name} is not defined`)
    }
    const probe = document.createElement('div')
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('no canvas')
    context.fillStyle = '#000'
    context.fillStyle = getComputedStyle(probe).color
    context.fillRect(0, 0, 1, 1)
    probe.remove()
    return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3))
  }, token)
}

/**
 * The colours around the left edge of a control, in one row through its middle: outside it, on its
 * edge and inside it, as painted. Wait for animations before calling.
 */
export async function edgeColors(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded()
  const box = await control.boundingBox()
  if (!box) throw new Error('the control has no box')
  const margin = 6
  const left = Math.min(margin, box.x)
  const png = await page.screenshot({
    clip: { x: box.x - left, y: box.y, width: box.width + left + margin, height: box.height },
  })
  return page.evaluate(
    async ({ base64, left, width, height, inside }) => {
      const image = new Image()
      image.src = `data:image/png;base64,${base64}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('no canvas')
      context.drawImage(image, 0, 0)
      const at = (x: number, y: number) =>
        Array.from(context.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3))
      const middle = height / 2
      return {
        outside: at(Math.max(left - 3, 0), middle),
        edge: at(left, middle),
        inside: at(left + width * inside, middle),
      }
    },
    { base64: png.toString('base64'), left, width: box.width, height: box.height, inside: 0.08 },
  )
}

/** The colour of the text of `locator`, from its computed style (or of its placeholder). */
export async function textColor(locator: Locator, pseudo?: '::placeholder'): Promise<number[]> {
  return locator.evaluate((element, which) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('no canvas')
    context.fillStyle = '#000'
    context.fillStyle = getComputedStyle(element, which ?? null).color
    context.fillRect(0, 0, 1, 1)
    return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3))
  }, pseudo)
}

/**
 * The worst contrast between the text colour of `locator` and the colours it is painted on: every
 * colour that covers at least 8% of the element's box and is not the text colour. Hatching has two.
 */
export async function worstTextContrast(page: Page, locator: Locator): Promise<number | null> {
  const png = await locator.screenshot({ timeout: 4000 })
  const text = await textColor(locator)
  const backgrounds = await page.evaluate(
    async ({ base64, text }) => {
      const image = new Image()
      image.src = `data:image/png;base64,${base64}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('no canvas')
      context.drawImage(image, 0, 0)
      const { data } = context.getImageData(0, 0, image.width, image.height)
      const counts = new Map<string, number>()
      for (let at = 0; at < data.length; at += 4) {
        const key = `${data[at]},${data[at + 1]},${data[at + 2]}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const total = data.length / 4
      return [...counts]
        .filter(([, count]) => count / total >= 0.08)
        .map(([key]) => key.split(',').map(Number))
        .filter((color) => color.some((part, index) => Math.abs(part - (text[index] ?? 0)) > 24))
    },
    { base64: png.toString('base64'), text },
  )
  if (backgrounds.length === 0) return null
  return Math.min(...backgrounds.map((color) => contrastRatio(text, color)))
}
