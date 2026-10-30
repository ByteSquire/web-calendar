// Wires the security headers into Nitro: the `render:html` hook sees the page the renderer built
// (to hash its inline scripts), `beforeResponse` sets the headers. In development the policy is
// off: Vite's client and hot reload need inline scripts and a websocket.
import { getResponseHeader, setResponseHeader, type H3Event } from 'h3'
import {
  buildDocumentCsp,
  COMMON_HEADERS,
  DOCUMENT_HEADERS,
  inlineScripts,
  isHtmlContentType,
  RESOURCE_CSP,
  scriptHash,
} from './headers'

/** The context key under which `render:html` leaves the hashes for `beforeResponse`. */
export const SCRIPT_HASHES_KEY = 'cspScriptHashes'

/** The page the renderer built: the parts of the document as HTML strings. */
export interface RenderedHtml {
  head: string[]
  bodyPrepend: string[]
  body: string[]
  bodyAppend: string[]
}

/** The part of Nitro's hooks this module uses. */
export interface SecurityHooks {
  hook(
    name: 'render:html',
    handler: (html: RenderedHtml, context: { event: H3Event }) => void,
  ): unknown
  hook(name: 'beforeResponse', handler: (event: H3Event) => void): unknown
}

export interface SecurityHeaderOptions {
  /** The identity provider's origin (and any other origin scripts may call). */
  connectOrigins: readonly string[]
  /** False in development: no Content-Security-Policy. */
  enforcePolicy: boolean
}

function setIfMissing(event: H3Event, name: string, value: string): void {
  if (getResponseHeader(event, name) === undefined) setResponseHeader(event, name, value)
}

export function installSecurityHeaders(hooks: SecurityHooks, options: SecurityHeaderOptions): void {
  hooks.hook('render:html', (html, { event }) => {
    const page = [...html.head, ...html.bodyPrepend, ...html.body, ...html.bodyAppend].join('\n')
    event.context[SCRIPT_HASHES_KEY] = inlineScripts(page).map(scriptHash)
  })

  hooks.hook('beforeResponse', (event) => {
    for (const [name, value] of Object.entries(COMMON_HEADERS)) setIfMissing(event, name, value)

    const document = isHtmlContentType(String(getResponseHeader(event, 'content-type') ?? ''))
    if (document) {
      for (const [name, value] of Object.entries(DOCUMENT_HEADERS)) setIfMissing(event, name, value)
    }
    if (!options.enforcePolicy) return

    // A policy a handler or Nitro's error page set itself stays.
    const hashes = (event.context[SCRIPT_HASHES_KEY] as string[] | undefined) ?? []
    setIfMissing(
      event,
      'content-security-policy',
      document
        ? buildDocumentCsp({ connectOrigins: options.connectOrigins, scriptHashes: hashes })
        : RESOURCE_CSP,
    )
  })
}
