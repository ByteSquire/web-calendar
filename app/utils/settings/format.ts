// Dates and sizes as the settings screen shows them: 24-hour times in the viewer's display zone
// (FR-29), written like the rest of the app (`Thu, 29 Oct 2026, 10:00`, see event-display.ts).
// Built with Temporal instead of `Intl` so the text does not change with the ICU version.
import { Temporal } from 'temporal-polyfill'
import { formatEventDate } from '../event-display'

const pad = (value: number) => String(value).padStart(2, '0')

/**
 * `iso` (an instant such as `2026-10-29T09:00:00.000Z`) as date and time in `zone`. Anything that
 * is not a date comes back unchanged, so a surprising value from the server is visible, not blank.
 */
export function formatDateTime(iso: string, zone: string): string {
  try {
    const time = Temporal.Instant.from(iso).toZonedDateTimeISO(zone)
    return `${formatEventDate(time.toPlainDate())}, ${pad(time.hour)}:${pad(time.minute)}`
  } catch {
    return iso
  }
}

/** Just the date part of `formatDateTime`, for expiry dates. */
export function formatDate(iso: string, zone: string): string {
  try {
    return formatEventDate(Temporal.Instant.from(iso).toZonedDateTimeISO(zone).toPlainDate())
  } catch {
    return iso
  }
}

/** `0 bytes`, `1 byte`, `512 bytes`, `1.5 KB`, `12 KB`, `2.3 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes === 1) return '1 byte'
  if (bytes < 1024) return `${bytes} bytes`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${round(kilobytes)} KB`
  return `${round(kilobytes / 1024)} MB`
}

/** One decimal below 10, none above: `1.5`, `12`. */
function round(value: number): string {
  return value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value))
}

/** `1 event`, `3 events`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}
