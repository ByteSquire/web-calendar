import { describe, it, expect, vi } from 'vitest'

// Basic test to verify Vitest + happy-dom environment works
describe('Test environment', () => {
  it('runs basic assertions', () => {
    expect(1 + 1).toBe(2)
    expect('hello').toContain('ell')
    expect(() => {
      throw new Error('test')
    }).toThrow('test')
  })

  it('supports async tests', async () => {
    await Promise.resolve()
    expect(true).toBe(true)
  })

  it('has access to DOM via happy-dom', () => {
    const div = document.createElement('div')
    div.textContent = 'Hello'
    expect(div.textContent).toBe('Hello')
  })

  it('supports vi mock functions', () => {
    const fn = vi.fn()
    fn('arg1', 'arg2')
    expect(fn).toHaveBeenCalledWith('arg1', 'arg2')
  })
})
