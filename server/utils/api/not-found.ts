// `/api/**` never answers with the SPA (L4). Nitro's router sends a request that no route handles
// (a method a route does not implement, `/api` itself) on to the page renderer, which returns the
// app shell with status 200 - a trap for a client that takes 200 for success. Two guards close it:
// the middleware refuses URLs with a trailing slash or an empty segment (a route has one spelling),
// and this hook answers JSON 404 instead of rendering the shell for anything under `/api`.

/** The path of a request without its query string. */
export function requestPathname(path: string): string {
  const end = path.search(/[?#]/)
  return end === -1 ? path : path.slice(0, end)
}

/** `/api` and everything below it. */
export function isApiPath(path: string): boolean {
  const pathname = requestPathname(path)
  return pathname === '/api' || pathname.startsWith('/api/')
}

/** A URL no route has: a trailing slash (`/api/views/`) or an empty segment (`/api//views`). */
export function isNonCanonicalApiPath(path: string): boolean {
  const pathname = requestPathname(path)
  return pathname.endsWith('/') || pathname.includes('//')
}

/** The same JSON shape and hardening headers Nitro's own error handler uses in production. */
export function apiNotFoundResponse(path: string) {
  return {
    statusCode: 404,
    statusMessage: 'Not Found',
    headers: {
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({
      error: true,
      url: requestPathname(path),
      statusCode: 404,
      statusMessage: 'Not Found',
      message: 'Not Found',
    }),
  }
}

/** The part of Nitro's `render:before` hook context this module uses. */
export interface RenderBeforeContext {
  event: { path: string }
  response?: unknown
}

/** The part of Nitro's hooks this module uses. */
export interface RenderHooks {
  hook(name: 'render:before', handler: (context: RenderBeforeContext) => void): unknown
}

/**
 * Registers the hook. A response set in `render:before` replaces the render, so the shell is not
 * even built for these requests.
 */
export function installApiFallback(hooks: RenderHooks): void {
  hooks.hook('render:before', (context) => {
    if (isApiPath(context.event.path)) context.response = apiNotFoundResponse(context.event.path)
  })
}
