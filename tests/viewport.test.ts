import { beforeEach, describe, expect, it } from 'vitest'
import { sidebarStartsOpen } from '../app/utils/viewport'

// The sidebar starts open on a desktop and closed on a phone, in either orientation.

function screen(width: number, height: number) {
  window.matchMedia = ((query: string) => {
    const wide = width >= 768
    const small = width <= 767 || height <= 500
    return { matches: query.includes('min-width: 768px') ? wide : small }
  }) as typeof window.matchMedia
}

describe('sidebarStartsOpen', () => {
  beforeEach(() => screen(1280, 800))

  it('is open on a desktop and on a tablet in either orientation', () => {
    screen(1280, 800)
    expect(sidebarStartsOpen()).toBe(true)
    screen(1024, 768)
    expect(sidebarStartsOpen()).toBe(true)
    screen(768, 1024)
    expect(sidebarStartsOpen()).toBe(true)
  })

  it('is closed on a phone in portrait, where the sidebar is a slideover', () => {
    screen(360, 640)
    expect(sidebarStartsOpen()).toBe(false)
  })

  it('is closed on a phone turned sideways, although it is wide enough for the column', () => {
    screen(640, 360)
    expect(sidebarStartsOpen()).toBe(false)
    screen(915, 412)
    expect(sidebarStartsOpen()).toBe(false)
  })
})
