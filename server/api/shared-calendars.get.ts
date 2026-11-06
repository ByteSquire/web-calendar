import { defineApiHandler } from '../utils/api/handler'
import { listCalendarsSharedWith } from '../utils/access/service'

// The calendars an access rule shares with the caller, with the owner of a person's calendar, so
// the sidebar and the pickers can name "Personal Calendar (Alice)" apart from the caller's own.
// Radicale maps each share into the caller's home as `shared-<id>…` with the owner's name only.
export default defineApiHandler((_event, { db, user, identity }) => ({
  calendars: listCalendarsSharedWith(db, { id: user.id, sub: identity.sub }),
}))
