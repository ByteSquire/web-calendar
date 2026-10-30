import { expect, test } from '@playwright/test'
import { openApp, press, switchView, VIEW_TYPES } from './helpers'

// Security review M2: the production build sends a strict Content-Security-Policy and the small
// headers, and the app works under that policy (no script, style, image or connection is refused).
declare global {
  interface Window {
    __cspViolations?: string[]
  }
}

test.describe('security headers', () => {
  test('the page and the API carry the policy and the small headers', async ({ request }) => {
    const page = await request.get('/')
    const policy = page.headers()['content-security-policy'] ?? ''
    expect(policy).toContain("default-src 'self'")
    expect(policy).toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+;/)
    expect(policy).not.toContain('unsafe-eval')
    expect(policy.match(/script-src[^;]*/)?.[0]).not.toContain('unsafe-inline')
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("connect-src 'self' https://idm.example.org;")
    expect(page.headers()['cache-control']).toBe('no-store')
    expect(page.headers()['x-powered-by']).toBeUndefined()

    const api = await request.get('/api/config')
    expect(api.headers()['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    )
    for (const reply of [page, api, await request.get('/api/nothing-here')]) {
      expect(reply.headers()['x-content-type-options']).toBe('nosniff')
      expect(reply.headers()['x-frame-options']).toBe('DENY')
      expect(reply.headers()['referrer-policy']).toBe('no-referrer')
    }
  })

  test('the app runs under the policy in every view and dialog without a violation', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.__cspViolations = []
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__cspViolations?.push(`${event.violatedDirective}: ${event.blockedURI}`)
      })
    })
    const { errors } = await openApp(page)
    for (const view of VIEW_TYPES) await switchView(page, view)
    await press(page.getByRole('button', { name: 'Quick add' }))
    await expect(page.getByRole('dialog', { name: 'Quick add' })).toBeVisible()
    await page.keyboard.press('Escape')
    await press(page.getByRole('button', { name: 'More options' }))
    await page.keyboard.press('Escape')

    expect(await page.evaluate(() => window.__cspViolations)).toEqual([])
    expect(errors).toEqual([])
  })

  test('an injected script and a connection to a foreign origin are refused', async ({ page }) => {
    await openApp(page)
    const result = await page.evaluate(async () => {
      const outcome: Record<string, string> = {}
      const inline = document.createElement('script')
      inline.textContent = 'window.__injected = true'
      document.body.append(inline)
      outcome.inline = String((window as unknown as { __injected?: boolean }).__injected)
      try {
        await fetch('https://example.org/', { mode: 'no-cors' })
        outcome.fetch = 'allowed'
      } catch {
        outcome.fetch = 'blocked'
      }
      return outcome
    })
    expect(result).toEqual({ inline: 'undefined', fetch: 'blocked' })
  })

  test('no request leaves for another origin (icons come from the app)', async ({ page }) => {
    const foreign: string[] = []
    page.on('request', (request) => {
      const origin = new URL(request.url()).origin
      if (
        origin !==
        new URL(page.url() === 'about:blank' ? 'http://127.0.0.1:3100' : page.url()).origin
      ) {
        foreign.push(request.url())
      }
    })
    await openApp(page)
    for (const view of VIEW_TYPES) await switchView(page, view)
    await press(page.getByRole('button', { name: 'More options' }))
    await page.keyboard.press('Escape')
    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    expect(foreign).toEqual([])
  })
})
