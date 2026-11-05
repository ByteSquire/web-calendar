// OpenID Connect discovery (Discovery 1.0 §4): the provider's own description of where its signing
// keys and its userinfo endpoint are. The operator configures the issuer; every other URL is read
// from `<issuer>/.well-known/openid-configuration` and checked before anything uses it, so that a
// provider other than Kanidm needs no URL in the configuration.

/** What the app takes from a discovery document. */
export interface Discovery {
  /** The issuer as the provider writes it; it equals the configured one character by character. */
  issuer: string
  jwksUri: string
  /** null when the provider publishes none. */
  userinfoEndpoint: string | null
}

export interface DiscoveryOptions {
  fetch?: typeof globalThis.fetch
  /** Limit per request, in milliseconds (default 5000). */
  timeoutMs?: number
  /** The most bytes of an answer that are read (default 64 KiB). */
  maxBytes?: number
  /**
   * Host names, besides the issuer's own, that the signing keys may be fetched from
   * (`NUXT_OIDC_JWKS_HOSTS`). Exact names, any case; no wildcards. Google keeps its keys at
   * `www.googleapis.com` and Entra v1 at `login.microsoftonline.com`.
   */
  jwksHosts?: readonly string[]
}

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_BYTES = 64 * 1024

/**
 * Where the document is. The trailing slash of an issuer is dropped only for this join: the issuer
 * itself is compared and kept exactly as the provider publishes it (Authentik, Auth0 and Entra v1
 * publish one).
 */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
}

/** The text in a message, short and on one line: it came from the provider. */
function quote(value: unknown): string {
  return JSON.stringify(String(value).slice(0, 200))
}

/** Stops the download of an answer we will not read, so that the connection is not held open. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined)
}

/** The body as text, never reading more than `maxBytes` of it. */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new Error(`the answer is larger than ${maxBytes} bytes`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    discard(response)
    throw tooLarge()
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw tooLarge()
      chunks.push(value)
    }
  } finally {
    // Stops the download when we stopped reading; harmless after the last chunk.
    reader.cancel().catch(() => undefined)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new Error('the answer is not UTF-8 text')
  }
}

/** A URL of the document that this app will call: absolute, https for an https issuer, no secrets. */
function endpoint(name: string, value: unknown, issuerIsHttps: boolean): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is missing`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} is not an absolute URL`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !issuerIsHttps)) {
    throw new Error(
      issuerIsHttps ? `${name} is not an https URL` : `${name} is neither an http nor an https URL`,
    )
  }
  if (url.username !== '' || url.password !== '') throw new Error(`${name} carries credentials`)
  if (url.hash !== '') throw new Error(`${name} has a fragment`)
  return value
}

/**
 * Fetches and checks the discovery document of `issuer`. Throws an `Error` that says what is wrong;
 * the message holds no token and at most a short quote of what the provider sent.
 *
 * The answer must be HTTP 200 with a JSON object of at most `maxBytes`, no redirect followed, and
 * its `issuer` must be the configured one exactly (so that a document served for another issuer
 * cannot send us to another provider's keys, RFC 8414 §3.3). `jwks_uri` is required and must be on
 * the issuer's host; `userinfo_endpoint` is optional. For an https issuer both must be https URLs.
 */
export async function fetchDiscovery(
  issuer: string,
  options: DiscoveryOptions = {},
): Promise<Discovery> {
  const doFetch = options.fetch ?? globalThis.fetch
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  let issuerUrl: URL
  try {
    issuerUrl = new URL(issuer)
  } catch {
    throw new Error(`discovery: the issuer ${quote(issuer)} is not a URL`)
  }
  const issuerIsHttps = issuerUrl.protocol === 'https:'

  let text: string
  try {
    const response = await doFetch(discoveryUrl(issuer), {
      headers: { accept: 'application/json' },
      // The document decides where keys are fetched from; a redirect would hand that to whoever
      // answers on the way.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (response.status !== 200) {
      discard(response)
      throw new Error(`HTTP ${response.status}`)
    }
    text = await readLimited(response, maxBytes)
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    const reason = timedOut ? 'timed out' : error instanceof Error ? error.message : String(error)
    throw new Error(`discovery: the request failed (${reason})`, { cause: error })
  }

  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw new Error('discovery: the answer is not JSON')
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('discovery: the answer is not a JSON object')
  }
  const fields = document as Record<string, unknown>

  if (fields.issuer !== issuer) {
    throw new Error(
      `discovery: the document is for the issuer ${quote(fields.issuer)}, not ${quote(issuer)}`,
    )
  }
  try {
    const jwksUri = endpoint('jwks_uri', fields.jwks_uri, issuerIsHttps)
    // The keys decide who may sign in, so they come from the issuer's own host, or from a host the
    // operator named: whoever can change the document cannot send us to keys anywhere else. (The
    // userinfo endpoint may be elsewhere: Entra's is Microsoft Graph.)
    const keysHost = new URL(jwksUri).hostname
    const allowed = (options.jwksHosts ?? []).map((host) => host.trim().toLowerCase())
    if (keysHost !== issuerUrl.hostname && !allowed.includes(keysHost)) {
      throw new Error(
        `jwks_uri is on another host than the issuer (${quote(jwksUri)}); ` +
          'NUXT_OIDC_JWKS_HOSTS can name a host the keys may come from',
      )
    }
    return {
      issuer,
      jwksUri,
      userinfoEndpoint:
        fields.userinfo_endpoint === undefined
          ? null
          : endpoint('userinfo_endpoint', fields.userinfo_endpoint, issuerIsHttps),
    }
  } catch (error) {
    throw new Error(`discovery: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

/** The discovery documents fetched so far, one per issuer. */
export interface DiscoveryStore {
  /**
   * Fetches the document again and remembers it. Throws like `fetchDiscovery`; the document known
   * before stays in place then. `options` are applied over those the store was made with.
   */
  refresh(issuer: string, options?: Pick<DiscoveryOptions, 'jwksHosts'>): Promise<Discovery>
  /** The document of the last successful fetch, or undefined before there was one. */
  current(issuer: string): Discovery | undefined
  /** Puts a document in place without fetching (tests; `refresh` is the only way in production). */
  remember(document: Discovery): void
}

/**
 * When to fetch again is the caller's decision: the token verifier refreshes it together with the
 * signing keys (same maximum age, same cooldown, same back-off), which is why this keeps no timer.
 */
export function createDiscoveryStore(options: DiscoveryOptions = {}): DiscoveryStore {
  const documents = new Map<string, Discovery>()
  return {
    async refresh(issuer, extra) {
      const document = await fetchDiscovery(issuer, { ...options, ...extra })
      documents.set(issuer, document)
      return document
    },
    current: (issuer) => documents.get(issuer),
    remember: (document) => {
      documents.set(document.issuer, document)
    },
  }
}

let shared: DiscoveryStore | undefined

/**
 * The store of the process. The token verifier fills it as it refreshes the signing keys; the code
 * that calls the provider's other endpoints (userinfo) reads from it and never guesses a URL.
 */
export function processDiscoveryStore(): DiscoveryStore {
  shared ??= createDiscoveryStore()
  return shared
}
