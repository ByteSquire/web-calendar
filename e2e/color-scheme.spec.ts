import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

// The page says which colour scheme it is in, on the root element and in a meta tag, so that
// browsers that darken pages on their own (Huawei Browser, Samsung Internet, Chrome's auto dark
// mode) do not darken the dark scheme a second time.

test('declares its colour scheme on the root element and in the head', async ({ page }) => {
  await openApp(page)
  const dark = test.info().project.use.colorScheme === 'dark'

  const root = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
  expect(root).toBe(dark ? 'dark' : 'light')
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'light dark')
})
