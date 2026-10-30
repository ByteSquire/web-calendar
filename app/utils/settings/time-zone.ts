// The choices of the time zone setting (FR-32): the browser's zone as the default, then every zone
// the browser knows. Pure, so it runs in plain Vitest.

/** The value of the choice "no zone of my own": the browser's zone. Not an IANA name. */
export const BROWSER_CHOICE = 'browser'

export interface TimeZoneChoice {
  /** What the list and the closed control show. */
  label: string
  /** An IANA name, or `BROWSER_CHOICE`. */
  value: string
  /** What the search looks in; see `searchText`. */
  search: string
}

/** Zone names as the browser lists them, sorted; none when the browser cannot list them. */
function supportedZones(): string[] {
  return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
}

/**
 * The name as it is, and with spaces instead of `/` and `_`, so that "new york" finds
 * `America/New_York` and "america/new" finds it too.
 */
export function searchText(zone: string): string {
  return `${zone} ${zone.replace(/[_/]/g, ' ')}`
}

export interface TimeZoneChoicesInput {
  /** The zone times are shown in without a choice: the browser's, else the organization's. */
  defaultZone: string
  orgZone: string
  /** The saved choice, if any. */
  current: string | null
  /** The zones to offer; the browser's list when left out. */
  zones?: readonly string[]
}

/**
 * The items of the control in two groups: the default first, then the zones. The list always holds
 * the saved choice, the default zone and the organization zone, because a browser may leave out
 * names such as `UTC` or an older spelling of a zone, and the closed control would show nothing.
 */
export function timeZoneChoices(input: TimeZoneChoicesInput): [TimeZoneChoice[], TimeZoneChoice[]] {
  const browserLabel = `Browser's zone (${input.defaultZone})`
  const names = new Set([...(input.zones ?? supportedZones()), input.defaultZone, input.orgZone])
  if (input.current) names.add(input.current)
  return [
    [{ label: browserLabel, value: BROWSER_CHOICE, search: browserLabel }],
    [...names].sort().map((zone) => ({
      label: zone === input.orgZone ? `${zone} (organization zone)` : zone,
      value: zone,
      search: searchText(zone),
    })),
  ]
}

/** What the live region says after a save. `displayZone` is the zone times are shown in now. */
export function describeZoneChange(chosen: string | null, displayZone: string): string {
  return chosen === null
    ? `Times are now shown in your browser's zone, ${displayZone}.`
    : `Times are now shown in ${displayZone}.`
}
