/** Layout switches to the desktop sidebar column at this width; keep in sync with main.css. */
export const DESKTOP_MEDIA_QUERY = '(min-width: 768px)'

export function matchesDesktop(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DESKTOP_MEDIA_QUERY).matches
}
