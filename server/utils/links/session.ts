// The session of a calendar link page: after the password was right, the page gets a short token it
// sends with every read (in a header, never in a cookie or the address). It names the link and when
// it ends, and is signed with a key of its own derived from the token hash key, so it cannot be made
// for another link or stretched. Revoking the link ends its sessions at once: every read looks the
// link up again.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { toKeyring, type TokenHashKeys } from '../../db/app-tokens'

/** How long a session lasts; then the page asks for the password again. */
export const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000
const PREFIX = 'cls1'

function keyFor(hashKey: string): Buffer {
  // Domain separation: the app-token hashes never share a key with these signatures.
  return createHmac('sha256', hashKey).update('web-calendar calendar-link session v1').digest()
}

function sign(hashKey: string, payload: string): string {
  return createHmac('sha256', keyFor(hashKey)).update(payload).digest('base64url')
}

export interface LinkSession {
  token: string
  expiresAt: string
}

/** A new session for `linkId`, signed with the current key of the keyring. */
export function createLinkSession(hashKeys: TokenHashKeys, linkId: number, now: Date): LinkSession {
  const keyring = toKeyring(hashKeys)
  const expires = now.getTime() + SESSION_LIFETIME_MS
  const payload = `${PREFIX}.${keyring.current.version}.${linkId}.${expires}`
  return {
    token: `${payload}.${sign(keyring.current.key, payload)}`,
    expiresAt: new Date(expires).toISOString(),
  }
}

const SHAPE = /^cls1\.([1-9]\d{0,5})\.([1-9]\d{0,14})\.([1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/

/** The link id of a valid, unexpired session token; null for anything else. */
export function readLinkSession(
  hashKeys: TokenHashKeys,
  token: string | null | undefined,
  now: Date,
): number | null {
  const keyring = toKeyring(hashKeys)
  if (typeof token !== 'string' || token.length > 200) return null
  const parts = SHAPE.exec(token)
  if (!parts) return null
  const [, version, linkId, expires, signature] = parts
  const key = keyring.keys.find((item) => item.version === Number(version))
  if (!key) return null
  const payload = `${PREFIX}.${version}.${linkId}.${expires}`
  const expected = Buffer.from(sign(key.key, payload), 'base64url')
  const given = Buffer.from(signature!, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  if (Number(expires) <= now.getTime()) return null
  return Number(linkId)
}
