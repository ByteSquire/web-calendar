// Why a subscription cannot be fetched. The reason goes to the browser (`data.reason` of the 502)
// and into the log; it never carries the URL, which may hold a secret.

export type IcalFailureReason =
  'blocked' | 'unreachable' | 'timeout' | 'too-large' | 'not-ical' | `http-${number}`

export class IcalFetchError extends Error {
  /** Set so that Node's own error handling and our request code can tell this error apart. */
  readonly code = 'ERR_ICAL_PROXY'
  /**
   * `blocked` because the administrator's host list (NUXT_OUTBOUND_ALLOWED_HOSTS) does not name
   * the host, not because of its address. The reason stays `blocked`: that is what the app words.
   */
  readonly notListed: boolean

  constructor(
    readonly reason: IcalFailureReason,
    /** For the log only: what exactly went wrong, without the URL. */
    readonly detail?: string,
    options?: { cause?: unknown; notListed?: boolean },
  ) {
    super(detail ? `${reason}: ${detail}` : reason, options)
    this.name = 'IcalFetchError'
    this.notListed = options?.notListed === true
  }
}
