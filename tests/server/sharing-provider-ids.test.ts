// @vitest-environment node
// Ids the identity provider chooses end up in Radicale paths, JSON bodies and the group file. The
// shape rule lets through `#`, `%`, `&`, `|`, `+` and capitals, so discovery, the share writer and
// the booking reader must carry them: percent-encoded in a URL, decoded in the database.
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addCalendarAcl } from '../../server/db/calendar-acl'
import { openDatabase } from '../../server/db/connection'
import { loadMigrationsFromDir, runMigrations } from '../../server/db/migrate'
import { isValidSubject } from '../../server/utils/auth/subject'
import { createBookingEventReader } from '../../server/utils/resources/reconcile-reader'
import { createRadicaleClient } from '../../server/utils/sharing/radicale-client'
import { createSharingReconciler } from '../../server/utils/sharing/reconcile'
import { startFakeRadicale, type FakeRadicale } from './sharing-fake-radicale'

const OWNER = 'a#b'
const GRANTEE = 'a%41b'
const MEMBERS = ['Ab', 'ab', 'auth0|5f7c', 'a&b;c', '[x]{y}(z)$^!<>']
// Case-sensitive ids are distinct people; every one is also a legal user name for the app.
const IDS = [OWNER, GRANTEE, ...MEMBERS]

let db: Database
let radicale: FakeRadicale

beforeEach(async () => {
  db = openDatabase(':memory:')
  runMigrations(
    db,
    loadMigrationsFromDir(fileURLToPath(new URL('../../server/db/migrations', import.meta.url))),
  )
  IDS.forEach((sub, index) => {
    db.prepare('INSERT INTO users (oidc_sub, username) VALUES (?, ?)').run(sub, `user${index}`)
  })
  radicale = await startFakeRadicale()
  radicale.calendars.set(OWNER, new Set(['work']))
  radicale.groups.set('team', new Set(MEMBERS))
})

afterEach(async () => {
  db.close()
  await radicale.close()
})

function reconciler() {
  return createSharingReconciler({
    db,
    client: createRadicaleClient({ baseUrl: radicale.url }),
    log: { warn: () => {}, error: () => {} },
  })
}

describe('ids from the identity provider in the sharing writer', () => {
  it('are all valid user ids', () => {
    for (const sub of IDS) expect(isValidSubject(sub), sub).toBe(true)
  })

  it('finds the calendars in their homes and shares them to the id a rule names', async () => {
    expect((await reconciler().run()).ok).toBe(true)
    const calendar = db
      .prepare<[], { id: number; collection_path: string }>(
        'SELECT id, collection_path FROM calendars',
      )
      .all()
    // Radicale answers `/a%23b/work/`; the database holds the decoded path.
    expect(calendar.map((row) => row.collection_path)).toEqual([`/${OWNER}/work/`])

    const id = calendar[0]!.id
    addCalendarAcl(db, id, { principalType: 'user', principal: GRANTEE, permission: 'read' })
    addCalendarAcl(db, id, { principalType: 'group', principal: 'team', permission: 'write' })
    expect((await reconciler().run()).ok).toBe(true)

    const shares = radicale.shares
      .filter((s) => s.owner !== '_resources') // the availability share is not about these ids
      .map((s) => `${s.owner}|${s.pathMapped}|${s.user}|${s.pathOrToken}|${s.permissions}`)
      .sort()
    expect(shares).toEqual(
      [
        `${OWNER}|/${OWNER}/work/|${GRANTEE}|/${GRANTEE}/shared-${id}/|r`,
        `${OWNER}|/${OWNER}/work/|:team|/{user}/shared-${id}-team/|rw`,
      ].sort(),
    )
  })
})

describe('ids from the identity provider in the booking reader', () => {
  it.each(IDS)('lists the home of %j under its percent-encoded path', async (sub) => {
    const urls: string[] = []
    const reader = createBookingEventReader({
      baseUrl: 'http://radicale:5232',
      fetch: (async (url: string) => {
        urls.push(url)
        return new Response('', { status: 207 })
      }) as unknown as typeof fetch,
    })
    expect(await reader.listCalendars(sub)).toEqual({ kind: 'ok', paths: [] })
    expect(urls).toEqual([`http://radicale:5232/${encodeURIComponent(sub)}/`])
  })
})
