// Fetching a subscription's .ics through the app's own proxy (FR-7). Browsers cannot read arbitrary
// URLs, so `/api/ical-subscriptions/:id/data` fetches them; it answers 502 with `data.reason` when
// the source cannot be read.

/** A failed answer of the proxy; `describeLoadError` words it from `status` and `reason`. */
export class IcsFetchError extends Error {
  readonly status: number
  readonly reason: string | null

  constructor(status: number, reason: string | null) {
    super(reason ? `subscription: ${reason}` : `subscription: HTTP ${status}`)
    this.name = 'IcsFetchError'
    this.status = status
    this.reason = reason
  }
}

async function reasonOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    const data =
      typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined
    const reason =
      typeof data === 'object' && data !== null ? (data as { reason?: unknown }).reason : undefined
    return typeof reason === 'string' ? reason : null
  } catch {
    return null
  }
}

/**
 * The raw iCalendar text of subscription `id`. `authFetch` adds the bearer token; its failure
 * (`AuthRequiredError`) passes through. Any non-2xx answer is an `IcsFetchError`.
 */
export async function fetchIcsText(
  authFetch: typeof fetch,
  id: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await authFetch(`/api/ical-subscriptions/${encodeURIComponent(id)}/data`, {
    headers: { Accept: 'text/calendar' },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new IcsFetchError(response.status, await reasonOf(response))
  return response.text()
}
