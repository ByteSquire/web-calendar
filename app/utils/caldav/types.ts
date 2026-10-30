// Shapes the CalDAV transport hands to the rest of the app. Hrefs are in the form the server gave
// (usually a path such as `/caldav/<sub>/<uuid>/`); the iCalendar text is never altered here.

export interface DavCalendar {
  /** The collection's href, with a trailing slash, as the server gave it. */
  url: string
  /** `displayname`, or the last path segment when the server has none. */
  displayName: string
  /** `#rrggbb` (an alpha part is dropped) or null when absent or not a hex colour. */
  color: string | null
  /** `getctag`, an opaque change marker; null when the server has none. */
  ctag: string | null
  /** `supported-calendar-component-set`, upper case; empty when the server does not say. */
  components: string[]
  /** True when the server lists privileges for the user and none of them allows writing items. */
  readOnly: boolean
}

export interface DavObject {
  /** The object's href as the server gave it. */
  url: string
  /**
   * The entity tag as a quoted string, without a weak `W/` prefix. Compare it opaquely. Empty when
   * the server sent none, which `putObject` and `deleteObject` refuse as a condition.
   */
  etag: string
  /** The raw iCalendar text, exactly as the server sent it. */
  data: string
}

export interface DavRange {
  start: Date
  end: Date
}
