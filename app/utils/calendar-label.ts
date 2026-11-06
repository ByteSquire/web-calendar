// The name of a calendar where calendars of several people are listed together. Pure (no imports),
// so the sidebar's calendar builder (app/utils/live/calendars.ts) and the access page share it.

/**
 * How a calendar is named in a drop-down. Every person's own calendar has the name Radicale gave it
 * ("Personal Calendar"), so a personal calendar carries its owner: "Personal Calendar (Bob Builder)".
 * The name of an organization's calendar is enough. Without an owner's name the calendar keeps its own.
 */
export function calendarLabel(calendar: {
  name: string
  kind: 'personal' | 'shared' | 'resource'
  owner: string | null
}): string {
  // A calendar named after its owner ("Jane Doe", the app names a person's first one so) needs no
  // second mention of them.
  return calendar.kind === 'personal' && calendar.owner && calendar.owner !== calendar.name
    ? `${calendar.name} (${calendar.owner})`
    : calendar.name
}
