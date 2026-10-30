// What a subscription URL may look like. The same rules apply when a user enters one and when
// the fetcher follows a redirect, so a redirect cannot lead somewhere a user could not subscribe.

export const MAX_URL_LENGTH = 2000
const MAX_HOSTNAME_LENGTH = 253

export type SourceUrlResult = { ok: true; url: URL } | { ok: false; error: string }

/**
 * Why a parsed URL is not an acceptable source (worded to follow the field name: "url must ..."),
 * or null. `new URL` has already normalised the
 * host (decimal, octal and hex IPv4 forms become dotted quads, names are lower-cased and
 * punycoded), so the address checks later work on the normalised form.
 */
export function sourceUrlProblem(url: URL): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'must start with http://, https:// or webcal://'
  }
  if (url.username !== '' || url.password !== '') {
    return 'must not contain a user name or password'
  }
  if (url.hostname === '' || url.hostname.length > MAX_HOSTNAME_LENGTH) {
    return 'must have a valid host name'
  }
  return null
}

/**
 * Parses what a user typed. `webcal:` is only a hint for the calendar application to open, the
 * file itself is fetched over https. The fragment is dropped (it is never sent) and the result
 * is the normalised `href`, which is what gets stored and compared for duplicates.
 */
export function parseSourceUrl(raw: string): SourceUrlResult {
  const text = raw.trim()
  if (text === '') return { ok: false, error: 'must not be empty' }
  if (text.length > MAX_URL_LENGTH) {
    return { ok: false, error: `must have at most ${MAX_URL_LENGTH} characters` }
  }

  // `webcal:` is not a special scheme, so the parser would leave its host alone (no IPv4
  // normalisation); the scheme has to be swapped on the text, before parsing.
  const swapped = text.replace(/^webcal:/i, 'https:')
  let url: URL
  try {
    url = new URL(swapped)
  } catch {
    return { ok: false, error: 'must be a valid address' }
  }
  const problem = sourceUrlProblem(url)
  if (problem) return { ok: false, error: problem }

  url.hash = ''
  if (url.href.length > MAX_URL_LENGTH) {
    return { ok: false, error: `must have at most ${MAX_URL_LENGTH} characters` }
  }
  return { ok: true, url }
}
