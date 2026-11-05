import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

// The tab icon: the page links the favicons of public/, and each one is served with its type and,
// for a PNG, the size its link says.

/** The width and height in the IHDR chunk of a PNG. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('links the favicons and serves each with its type and size', async ({ page }) => {
  const { errors } = await openApp(page)
  const links = await page
    .locator('head link[rel="icon"], head link[rel="apple-touch-icon"]')
    .evaluateAll((items) =>
      items.map((item) => ({
        rel: item.getAttribute('rel'),
        type: item.getAttribute('type'),
        sizes: item.getAttribute('sizes'),
        href: item.getAttribute('href'),
      })),
    )
  expect(links.map((link) => `${link.rel} ${link.sizes} ${link.href}`)).toEqual([
    'icon 32x32 /favicon-32x32.png',
    'icon any /favicon.svg',
    'apple-touch-icon 180x180 /apple-touch-icon.png',
  ])
  for (const link of links) {
    const response = await page.request.get(link.href!)
    expect(response.status(), link.href!).toBe(200)
    const body = await response.body()
    if (link.href!.endsWith('.svg')) {
      expect(response.headers()['content-type'], link.href!).toContain('image/svg+xml')
      expect(body.toString('utf8'), link.href!).toContain('<svg')
    } else {
      expect(response.headers()['content-type'], link.href!).toContain('image/png')
      const [width, height] = link.sizes!.split('x').map(Number)
      expect(pngSize(body), link.href!).toEqual({ width, height })
    }
  }
  expect(errors).toEqual([])
})

test('serves a real /favicon.ico for what asks for it by name', async ({ page }) => {
  await openApp(page)
  const response = await page.request.get('/favicon.ico')
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/image\/(x-icon|vnd\.microsoft\.icon)/)
  const body = await response.body()
  // an icon file: reserved 0, type 1, three images (16, 32 and 48 px), each a PNG
  expect([...body.subarray(0, 6)]).toEqual([0, 0, 1, 0, 3, 0])
  expect([0, 1, 2].map((index) => body.readUInt8(6 + 16 * index))).toEqual([16, 32, 48])
  for (const index of [0, 1, 2]) {
    const start = body.readUInt32LE(6 + 16 * index + 12)
    expect(body.subarray(start + 1, start + 4).toString('latin1')).toBe('PNG')
  }
})
