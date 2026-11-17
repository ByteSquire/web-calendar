// How the calendar of a resource is named in the home of a person who may see the resource:
// `resource-<id>` for a share with the person, `resource-<id>-<group>` for one with a group (the
// sharing writer, server/utils/sharing/desired.ts). Radicale maps at most one share onto a path in
// a home, so a person with a rule of their own and a group rule gets two names, as for calendars
// (shared-calendar-name.ts). The id is the resource's: the gateway's check reads its rules by it,
// and the browser leaves these collections out of the person's own calendars.

const RESOURCE_NAME = /^resource-([1-9][0-9]{0,14})(?:-[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?$/

/** The name of the single availability share of all resources, before each resource had its own. */
export const LEGACY_AVAILABILITY_NAME = 'resource-availability'

/** The resource id a home collection name refers to, or null for any other collection. */
export function resourceCalendarId(name: string): number | null {
  const match = RESOURCE_NAME.exec(name)
  return match ? Number(match[1]) : null
}

/** A collection of the resources in a person's home: a resource's calendar or the old share. */
export function isResourceCollectionName(name: string): boolean {
  return resourceCalendarId(name) !== null || name === LEGACY_AVAILABILITY_NAME
}
