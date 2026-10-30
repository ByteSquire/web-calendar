// The two `WWW-Authenticate` challenges of a 401 (Basic and Bearer) must reach the client as two
// header lines. A web `Headers` cannot keep them apart: it joins repeated values with ", ", and h3
// writes that one line to the socket. `Basic realm="x", Bearer realm="x"` is legal but some CalDAV
// clients mis-parse it, so the gateway remembers the individual challenges next to the `Response`
// and the Nitro glue puts them on the Node response as separate lines.

const lines = new WeakMap<Response, readonly string[]>()

/** Remembers the challenges of a 401 `response`, in the order they are to be sent. */
export function rememberChallengeLines(response: Response, challenges: readonly string[]): void {
  if (challenges.length > 0) lines.set(response, [...challenges])
}

export function challengeLines(response: Response): readonly string[] {
  return lines.get(response) ?? []
}

/**
 * Writes the challenges of `response` to the Node response as separate `WWW-Authenticate` lines, and
 * removes the joined header from the web response, which h3 would otherwise write over them.
 */
export function emitChallengeLines(
  res: { setHeader(name: string, value: string[]): unknown },
  response: Response,
): void {
  const challenges = challengeLines(response)
  if (challenges.length === 0) return
  res.setHeader('www-authenticate', [...challenges])
  response.headers.delete('www-authenticate')
}
