/**
 * Set while the page of a calendar link is open (app/pages/link/[slug].vue): the calendar's name and
 * colour. The shared parts of the calendar view read it to be read-only: no sidebar, no adding, no
 * editing, and a menu that holds only the look (dark mode, language, full screen).
 */
export function useCalendarLinkView() {
  return useState<{ name: string; color: string | null } | null>('calendar-link-view', () => null)
}
