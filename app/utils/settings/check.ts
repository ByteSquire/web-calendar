// The "Check" button of a subscription: fetch the .ics through the server and say in words whether
// it works. The file is not parsed (the calendar view does that); the answer is "works", how many
// events it seems to hold and how big it is, or why the server could not get it.
import { describeFailure, parseApiError } from './api-errors'
import { N_, t, tc, tv } from '~/utils/i18n'
import { formatBytes } from './format'

const HTTP_HINTS: Record<number, string> = {
  401: N_('sign-in required'),
  403: N_('access denied'),
  404: N_('not found'),
  410: N_('gone'),
}

/** Why the iCal proxy could not fetch the file (`data.reason` of the 502). */
export function describeCheckReason(reason: string): string {
  switch (reason) {
    case 'blocked':
      return t('The address points to a private or reserved network, which is not allowed.')
    case 'unreachable':
      return t('The server could not reach the address.')
    case 'timeout':
      return t('The address did not answer in time.')
    case 'too-large':
      return t('The file is too large.')
    case 'not-ical':
      return t('The address does not return an iCal calendar file.')
  }
  const http = /^http-(\d{3})$/.exec(reason)
  if (http) {
    const status = Number(http[1])
    const hint = HTTP_HINTS[status]
    return hint
      ? t('The address answered with HTTP {status} ({hint}).', { status, hint: tv(hint) })
      : t('The address answered with HTTP {status}.', { status })
  }
  return t('The calendar could not be fetched.')
}

/** One sentence for a failed check, from whatever the `/data` call threw. */
export function describeCheckError(error: unknown): string {
  const info = parseApiError(error)
  if (info.status === 502 && info.reason) return describeCheckReason(info.reason)
  if (info.kind === 'server') return t('The calendar could not be fetched.')
  return describeFailure(info)
}

/** What a fetched .ics says about itself without parsing it: how many events and how big. */
export function summarizeIcs(document: string): { events: number; bytes: number } {
  const events = document.match(/^BEGIN:VEVENT[ \t]*$/gim)?.length ?? 0
  return { events, bytes: new TextEncoder().encode(document).length }
}

/** `Works: 14 events, 12 KB.` */
export function describeCheckSuccess(document: string): string {
  const { events, bytes } = summarizeIcs(document)
  return tc('Works: {count} event, {size}. | Works: {count} events, {size}.', events, {
    size: formatBytes(bytes),
  })
}
