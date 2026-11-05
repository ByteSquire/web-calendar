#!/usr/bin/env node
// Renders the PNG favicons of public/ from public/favicon.svg with Chromium (the one Playwright
// installs): the 32 px icon for browsers that take no SVG, and the 180 px apple-touch-icon, whose
// corners are square because iOS rounds them itself and fills transparency with black. Run it after
// changing the SVG, from the repository root, and commit the PNGs:
//
//   node scripts/make-favicons.mjs
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const svg = readFileSync('public/favicon.svg', 'utf8')
const square = svg.replace('rx="7"', 'rx="0"')
if (square === svg) throw new Error('public/favicon.svg has no rounded background to square off')

const browser = await chromium.launch()
try {
  for (const [markup, size, out] of [
    [svg, 32, 'public/favicon-32x32.png'],
    [square, 180, 'public/apple-touch-icon.png'],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
    )
    await page.screenshot({ path: out, omitBackground: true })
    await page.close()
    console.log(`wrote ${out}`)
  }
} finally {
  await browser.close()
}
