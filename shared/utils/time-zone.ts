// Time zones (FR-29). Two zones matter and nothing else may name one:
// - the organization zone: one value for the deployment, read from `TZ` by the server and served in
//   `/api/config`. It is the zone floating times are read in, the fallback display zone and the
//   reference label ("organization time").
// - the display zone: the zone one viewer sees times in. It is the browser's own zone.

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

/** The zone a viewer sees times in: their own when it is a valid IANA name, else the organization's. */
export function resolveDisplayTimeZone(viewerZone: string | undefined, orgZone: string): string {
  const zone = viewerZone?.trim()
  return zone && isValidTimeZone(zone) ? zone : orgZone
}
