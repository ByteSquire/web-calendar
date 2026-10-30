// Nuxt's renderer labels every page `X-Powered-By: Nuxt`: a free hint for anyone scanning for
// software to attack. Dropping it costs nothing.
import { removeResponseHeader, type H3Event } from 'h3'

/** The part of Nitro's hooks this module uses. */
export interface BeforeResponseHooks {
  hook(name: 'beforeResponse', handler: (event: H3Event) => void): unknown
}

/** `beforeResponse` runs after the handler (renderer included) and before the head is sent. */
export function installPoweredByRemoval(hooks: BeforeResponseHooks): void {
  hooks.hook('beforeResponse', (event) => {
    removeResponseHeader(event, 'x-powered-by')
  })
}
