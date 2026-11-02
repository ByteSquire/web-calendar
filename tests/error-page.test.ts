// @vitest-environment nuxt
// The error page (app/error.vue) and the skip link of the layout (WCAG 2.4.1).
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ErrorPage from '../app/error.vue'

describe('error page', () => {
  it('says "Page not found" for a 404 and offers the way back', async () => {
    const page = await mountSuspended(ErrorPage, {
      props: { error: { statusCode: 404, message: 'secret detail' } },
    })
    expect(page.find('h1').text()).toBe('Page not found')
    expect(page.text()).toContain('Back to calendar')
    expect(page.text()).not.toContain('secret detail')
  })

  it('says "Something went wrong" for other errors', async () => {
    const page = await mountSuspended(ErrorPage, {
      props: { error: { statusCode: 500, message: 'stack' } },
    })
    expect(page.find('h1').text()).toBe('Something went wrong')
    expect(page.text()).not.toContain('stack')
  })
})

describe('layout skip link', () => {
  it('points at the main landmark', () => {
    const layout = readFileSync('app/layouts/default.vue', 'utf8')
    expect(layout).toContain('href="#main-content"')
    expect(layout).toMatch(/<main\s+id="main-content"\s+tabindex="-1"/)
  })
})
