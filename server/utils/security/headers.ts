// Security headers for every response (security review M2, NFR-2): a strict Content-Security-Policy
// for the app's pages, a locked-down one for everything else, and the usual small headers. Pure
// functions here; the Nitro wiring is in install.ts.
import { createHash } from 'node:crypto'

/** Script types a browser runs from the page; each needs a hash in `script-src`. */
const EXECUTABLE_SCRIPT_TYPES = new Set([
  '',
  'module',
  'importmap',
  'speculationrules',
  'text/javascript',
  'application/javascript',
])

/** Inline `<script>` blocks of a rendered page that the browser would execute. */
export function inlineScripts(html: string): string[] {
  const scripts: string[] = []
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1] ?? ''
    if (/\bsrc\s*=/i.test(attributes)) continue
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes)
    const value = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim().toLowerCase()
    if (EXECUTABLE_SCRIPT_TYPES.has(value)) scripts.push(match[2] ?? '')
  }
  return scripts
}

/** A CSP source expression that allows exactly this script text. */
export function scriptHash(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`
}

/** `https://idm.example.org` for an issuer URL; null when it is not an http(s) URL. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

export interface DocumentPolicyOptions {
  /** Origins besides the app's own that scripts may talk to: the identity provider. */
  connectOrigins: readonly string[]
  /** Hashes of the page's inline scripts (`scriptHash`). */
  scriptHashes: readonly string[]
}

/**
 * The policy of the app's HTML pages. No `unsafe-inline` and no `unsafe-eval` for scripts: an
 * injected script cannot run, and it cannot reach any server but the app and the identity
 * provider. Styles keep `unsafe-inline` because FullCalendar and Nuxt UI set style attributes.
 */
export function buildDocumentCsp(options: DocumentPolicyOptions): string {
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...options.scriptHashes].join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${["'self'", ...options.connectOrigins].join(' ')}`,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ')
}

/** Everything that is not an HTML page (API answers, calendar data, assets) has nothing to run. */
export const RESOURCE_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox"

/** Headers every response gets unless a handler already set them. */
export const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
}

/** Extra headers of HTML pages. `no-store` keeps a signed-out page out of the back/forward cache. */
export const DOCUMENT_HEADERS: Readonly<Record<string, string>> = {
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-store',
}

export function isHtmlContentType(contentType: string): boolean {
  return /^text\/html\b/i.test(contentType.trim())
}
