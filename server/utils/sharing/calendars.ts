import type { Database } from 'better-sqlite3'
import { isUserSubject } from '../auth/subject'
import { groupPrincipal, isShareName } from './names'
import type { RadicaleClient } from './radicale-client'
import { sharingFail, type SharingResult } from './types'

// Mirrors the Radicale collections of the known users into the `calendars` table, because nothing
// else fills it and the access UI attaches rules to its rows. Rows are never deleted here: a
// vanished collection must not cascade away its rules.

/**
 * The calendar Radicale creates in every new home (`predefined_collections` of deploy/radicale/config).
 * A user keeps it as their personal calendar. A group's home is made by the app's first request as
 * the group principal, so the same default would appear there as a calendar nobody asked for, and
 * the group could not be deleted until someone removed it.
 */
const PREDEFINED_CALENDAR = 'def-calendar'

export interface RemoteCalendar {
  /** `/owner/name/`, decoded. */
  path: string
  owner: string
  name: string
  displayName: string
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Every calendar collection directly below `owner`'s home in a PROPFIND Depth 1 answer. */
export function parseHomeListing(xml: string, owner: string): RemoteCalendar[] {
  const calendars: RemoteCalendar[] = []
  for (const block of xml.split(/<(?:\w+:)?response[\s>]/).slice(1)) {
    const href = /<(?:\w+:)?href>([^<]*)<\/(?:\w+:)?href>/.exec(block)?.[1]
    const resourceType = /<(?:\w+:)?resourcetype\b[^>]*>([\s\S]*?)<\/(?:\w+:)?resourcetype>/.exec(
      block,
    )?.[1]
    if (href === undefined || resourceType === undefined) continue
    if (!/<(?:\w+:)?calendar\s*\/?>/.test(resourceType)) continue
    let path: string
    try {
      path = decodeURIComponent(decodeEntities(href.trim()))
    } catch {
      continue
    }
    const parts = /^\/([^/]+)\/([^/]+)\/$/.exec(path)
    if (!parts || parts[1] !== owner || parts[2]!.startsWith('.')) continue
    const displayName = /<(?:\w+:)?displayname>([^<]*)<\/(?:\w+:)?displayname>/.exec(block)?.[1]
    calendars.push({
      path,
      owner,
      name: parts[2]!,
      displayName: decodeEntities(displayName ?? '').trim() || parts[2]!,
    })
  }
  return calendars.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export interface DiscoveryResult {
  /** Owners whose home was listed. */
  listedOwners: string[]
  /** Every calendar path that exists, `/owner/name/`. */
  existing: Set<string>
  added: number
  renamed: number
}

interface UserIdRow {
  id: number
  oidc_sub: string
}

interface GroupIdRow {
  id: number
}

/**
 * Lists each known user's home (as that user), each group's home (as the group principal) and each
 * configured service principal's. A calendar found in a group's home belongs to that group.
 */
export async function discoverCalendars(
  db: Database,
  client: RadicaleClient,
  sharedOwners: readonly string[],
): Promise<SharingResult<DiscoveryResult>> {
  const users = db
    .prepare<[], UserIdRow>('SELECT id, oidc_sub FROM users ORDER BY id')
    .all()
    .filter((user) => isUserSubject(user.oidc_sub, sharedOwners))
  const groups = db.prepare<[], GroupIdRow>('SELECT id FROM groups ORDER BY id').all()
  const targets: { owner: string; userId: number | null; groupId: number | null }[] = [
    ...users.map((user) => ({
      owner: user.oidc_sub,
      userId: user.id as number | null,
      groupId: null,
    })),
    ...groups.map((group) => ({
      owner: groupPrincipal(group.id),
      userId: null,
      groupId: group.id,
    })),
    ...sharedOwners.map((owner) => ({ owner, userId: null, groupId: null })),
  ]
  const found: { remote: RemoteCalendar; userId: number | null; groupId: number | null }[] = []
  const listedOwners: string[] = []
  for (const target of targets) {
    const listing = await client.propfind(target.owner, `/${encodeURIComponent(target.owner)}/`, 1)
    if (!listing.ok) {
      // A user without a home yet is normal; anything else stops the run (sharingFail closed).
      if (listing.failure.status === 404) continue
      return sharingFail(
        listing.failure.kind,
        `listing the home of ${target.owner} failed: ${listing.failure.message}`,
        listing.failure.status,
      )
    }
    listedOwners.push(target.owner)
    for (const remote of parseHomeListing(listing.value, target.owner)) {
      if (isShareName(remote.name)) continue
      if (target.groupId !== null && remote.name === PREDEFINED_CALENDAR) continue
      found.push({ remote, userId: target.userId, groupId: target.groupId })
    }
  }

  const select = db.prepare<[string], { id: number; name: string }>(
    'SELECT id, name FROM calendars WHERE collection_path = ?',
  )
  const insert = db.prepare(
    'INSERT INTO calendars (name, kind, owner_id, collection_path, group_id) VALUES (?, ?, ?, ?, ?)',
  )
  const rename = db.prepare('UPDATE calendars SET name = ? WHERE id = ?')
  let added = 0
  let renamed = 0
  db.transaction(() => {
    for (const { remote, userId, groupId } of found) {
      const row = select.get(remote.path)
      if (!row) {
        const kind = userId !== null ? 'personal' : 'shared'
        insert.run(remote.displayName, kind, userId, remote.path, groupId)
        added += 1
      } else if (row.name !== remote.displayName) {
        rename.run(remote.displayName, row.id)
        renamed += 1
      }
    }
  })()
  return {
    ok: true,
    value: {
      listedOwners,
      existing: new Set(found.map((item) => item.remote.path)),
      added,
      renamed,
    },
  }
}
