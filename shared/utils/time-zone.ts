// Time zones (FR-29, FR-32). Two zones matter and nothing else may name one:
// - the organization zone: one value for the deployment, read from `TZ` by the server and served in
//   `/api/config`. It is the zone floating times are read in, the fallback display zone and the
//   reference label ("organization time").
// - the display zone: the zone one viewer sees times in. It is the zone the user chose in the
//   settings (`users.time_zone`, served in `/api/me`), by default the browser's own zone.

/** The organization zone when `TZ` is not set. */
export const DEFAULT_TIME_ZONE = 'Europe/Berlin'

/** True for an IANA zone name the runtime knows, such as `Europe/Berlin` or `UTC`. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The configured organization zone, or the default when the value is empty or not a zone. */
export function resolveTimeZone(value: string | undefined): string {
  const zone = value?.trim()
  return zone && isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE
}

/**
 * The zone a viewer sees times in: the one they chose (`userZone`), else the browser's
 * (`viewerZone`), else the organization's. A zone that is not a valid IANA name is skipped, so a
 * stored choice this browser does not know does not break the calendar.
 */
export function resolveDisplayTimeZone(
  viewerZone: string | undefined,
  orgZone: string,
  userZone?: string | null,
): string {
  for (const candidate of [userZone, viewerZone]) {
    const zone = candidate?.trim()
    if (zone && isValidTimeZone(zone)) return zone
  }
  return orgZone
}
