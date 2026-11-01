/** Layout switches to the desktop sidebar column at this width; keep in sync with main.css. */
export const DESKTOP_MEDIA_QUERY = '(min-width: 768px)'

export function matchesDesktop(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DESKTOP_MEDIA_QUERY).matches
}

/** A phone in either orientation: narrow, or too short for a sidebar column beside the calendar. */
export const SMALL_SCREEN_MEDIA_QUERY = '(max-width: 767px), (max-height: 500px)'

export function matchesSmallScreen(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(SMALL_SCREEN_MEDIA_QUERY).matches
}

/**
 * Whether the sidebar starts open: on a wide screen, but not on a phone turned sideways, which is
 * wide enough for the column and has no height to spare for it.
 */
export function sidebarStartsOpen(): boolean {
  return matchesDesktop() && !matchesSmallScreen()
}
