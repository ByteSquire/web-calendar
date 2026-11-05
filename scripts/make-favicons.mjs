#!/usr/bin/env node
// Renders the PNG favicons of public/ from public/favicon.svg with Chromium (the one Playwright
// installs): the 32 px icon for browsers that take no SVG, the 180 px apple-touch-icon, whose
// corners are square because iOS rounds them itself and fills transparency with black, and
// favicon.ico (16, 32 and 48 px, each stored as a PNG, which every current browser reads) for what
// asks for /favicon.ico by its name: browsers without a link tag, feed readers, link previews.
// Run it after changing the SVG, from the repository root, and commit the files:
//
//   node scripts/make-favicons.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const svg = readFileSync('public/favicon.svg', 'utf8')
const square = svg.replace('rx="7"', 'rx="0"')
if (square === svg) throw new Error('public/favicon.svg has no rounded background to square off')

/** An .ico file that holds these PNGs (a header, one 16-byte entry each, then the images). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index
    header.writeUInt8(size, entry) // width and height (0 would mean 256)
    header.writeUInt8(size, entry + 1)
    header.writeUInt16LE(1, entry + 4) // colour planes
    header.writeUInt16LE(32, entry + 6) // bits per pixel
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(({ png }) => png)])
}

const browser = await chromium.launch()
try {
  const render = async (markup, size) => {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
    )
    const png = await page.screenshot({ omitBackground: true })
    await page.close()
    return png
  }
  const small = await Promise.all(
    [16, 32, 48].map(async (size) => ({ size, png: await render(svg, size) })),
  )
  writeFileSync('public/favicon-32x32.png', small[1].png)
  writeFileSync('public/favicon.ico', ico(small))
  writeFileSync('public/apple-touch-icon.png', await render(square, 180))
  console.log('wrote public/favicon-32x32.png, public/favicon.ico and public/apple-touch-icon.png')
} finally {
  await browser.close()
}
