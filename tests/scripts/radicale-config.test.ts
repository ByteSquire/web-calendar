// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Radicale has no quota (security review L8). What bounds a user is the size of one request, and
// that bound must be the same in both places, so that the gateway's 413 is the one a client sees.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('Radicale’s request size limit', () => {
  const config = read('../../deploy/radicale/config')
  const nuxtConfig = read('../../nuxt.config.ts')

  it('is set in deploy/radicale/config, in the [server] section', () => {
    const server = /^\[server\]\n([\s\S]*?)^\[/m.exec(config)?.[1] ?? ''
    expect(server).toMatch(/^max_content_length = \d+$/m)
  })

  it('equals the size the gateway accepts', () => {
    const radicale = Number(/^max_content_length = (\d+)$/m.exec(config)?.[1])
    const gateway = Number(/maxBodyBytes: '(\d+)'/.exec(nuxtConfig)?.[1])
    expect(radicale).toBe(10 * 1024 * 1024)
    expect(radicale).toBe(gateway)
  })

  it('is what docker-compose.yml defaults the gateway to', () => {
    const compose = read('../../docker-compose.yml')
    expect(compose).toContain(
      "NUXT_GATEWAY_MAX_BODY_BYTES: '${NUXT_GATEWAY_MAX_BODY_BYTES:-10485760}'",
    )
  })

  it('has its volume watched by the usage script, which compose names', () => {
    expect(read('../../docker-compose.yml')).toContain('scripts/radicale-usage.mjs')
  })
})
