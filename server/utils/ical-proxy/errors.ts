// Why a subscription cannot be fetched. The reason goes to the browser (`data.reason` of the 502)
// and into the log; it never carries the URL, which may hold a secret.

export type IcalFailureReason =
  'blocked' | 'unreachable' | 'timeout' | 'too-large' | 'not-ical' | `http-${number}`

export class IcalFetchError extends Error {
  /** Set so that Node's own error handling and our request code can tell this error apart. */
  readonly code = 'ERR_ICAL_PROXY'

  constructor(
    readonly reason: IcalFailureReason,
    /** For the log only: what exactly went wrong, without the URL. */
    readonly detail?: string,
    options?: { cause?: unknown },
  ) {
    super(detail ? `${reason}: ${detail}` : reason, options)
    this.name = 'IcalFetchError'
  }
}
