import type { TokenKey, TokenKeyring } from '../../db/app-tokens'

// The keys that hash app tokens (L7, FR-31), read from NUXT_TOKEN_HASH_KEY and
// NUXT_TOKEN_HASH_KEYS. Plain functions; server/utils/auth/nitro.ts reads the runtime config and
// calls them.
//
//   NUXT_TOKEN_HASH_KEY    the key every deployment has had so far. Key version 1.
//   NUXT_TOKEN_HASH_KEYS   optional, `version:key` entries separated by commas, the CURRENT key
//                          first: `2:<new key>,1:<old key>`. A key may contain ':' but not ','. It
//                          adds to NUXT_TOKEN_HASH_KEY, which stays version 1 unless the list
//                          names version 1.
//
// With only NUXT_TOKEN_HASH_KEY set nothing changes: its tokens are version 1 and new tokens use
// it. Each token records the version that hashed it; a login with an older version hashes the
// token again with the current key (db/app-tokens.ts).
//
// Rotating the key, for example after it leaked, without logging any client out:
//   1. Generate a key (`openssl rand -base64 48`) and set NUXT_TOKEN_HASH_KEYS=2:<new key>. Keep
//      NUXT_TOKEN_HASH_KEY as it is: it is version 1 and still verifies the existing tokens.
//      Restart.
//   2. New tokens are version 2, and every old token becomes version 2 the next time it is used.
//   3. See what is left on version 1 (unexpired tokens per version):
//        docker compose exec web-calendar sh -c 'cd .output/server && node -e "
//          const db = require(\"better-sqlite3\")(\"/data/web-calendar.db\", {readonly: true})
//          const sql = \"SELECT key_version, COUNT(*) AS tokens FROM app_tokens WHERE expires_at > ? GROUP BY key_version\"
//          console.log(db.prepare(sql).all(new Date().toISOString()))"'
//   4. Retire the old key by removing NUXT_TOKEN_HASH_KEY once those tokens are gone or you
//      accept that the unused ones stop working (their owners create a new one). A token whose
//      version is not configured is unknown; nothing else breaks.
//   The next rotation lists the new key first: NUXT_TOKEN_HASH_KEYS=3:<newer>,2:<new>.
//   To go back, list the old key first again (`1:<old>,2:<new>`) instead of deleting entries.
//
// Key values never appear in an error message.

/** Mirrors MIN_TOKEN_HASH_KEY_LENGTH in server/validate-config.mjs (a test keeps the two equal). */
export const MIN_TOKEN_HASH_KEY_LENGTH = 32
/** Hashing a token costs one HMAC per key, on every Basic login. */
export const MAX_TOKEN_HASH_KEYS = 10

const VERSION = /^[1-9][0-9]{0,8}$/

// Nitro reads an environment value with `destr`, so a key of only digits would arrive as a number
// (and lose digits): that is refused instead of hashing with the wrong key.
function text(name: string, value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`${name} must be text, not ${typeof value}`)
  return value
}

/**
 * The keyring for the two settings, or an `Error` that names the setting and entry that is wrong.
 * Empty values count as unset (Compose passes an empty string for a variable that is not set).
 */
export function parseTokenKeyring(settings: { key?: unknown; keys?: unknown }): TokenKeyring {
  const single = text('NUXT_TOKEN_HASH_KEY', settings.key)
  const list = text('NUXT_TOKEN_HASH_KEYS', settings.keys).trim()

  const keys: TokenKey[] = []
  // Where each key came from, for the message about it.
  const sources = new Map<TokenKey, string>()
  if (list !== '') {
    const entries = list.split(',').map((entry) => entry.trim())
    if (entries.length > MAX_TOKEN_HASH_KEYS) {
      throw new Error(`NUXT_TOKEN_HASH_KEYS lists more than ${MAX_TOKEN_HASH_KEYS} keys`)
    }
    entries.forEach((entry, index) => {
      const colon = entry.indexOf(':')
      const version = colon === -1 ? '' : entry.slice(0, colon).trim()
      if (!VERSION.test(version)) {
        throw new Error(
          `NUXT_TOKEN_HASH_KEYS entry ${index + 1} must look like <version>:<key>, with a whole number from 1 as the version`,
        )
      }
      if (keys.some((known) => known.version === Number(version))) {
        throw new Error(`NUXT_TOKEN_HASH_KEYS lists version ${version} twice`)
      }
      const key = { version: Number(version), key: entry.slice(colon + 1).trim() }
      keys.push(key)
      sources.set(key, `NUXT_TOKEN_HASH_KEYS: the key of version ${version}`)
    })
  }

  // The single key is used exactly as given: it hashed the tokens that exist.
  if (single.trim() !== '') {
    const listed = keys.find((known) => known.version === 1)
    if (listed && listed.key !== single) {
      throw new Error(
        'NUXT_TOKEN_HASH_KEY is key version 1, but NUXT_TOKEN_HASH_KEYS lists another key for version 1',
      )
    }
    if (!listed) {
      const key = { version: 1, key: single }
      keys.push(key)
      sources.set(key, 'NUXT_TOKEN_HASH_KEY')
    }
  }

  if (keys.length === 0) {
    throw new Error('NUXT_TOKEN_HASH_KEY is not set; app tokens cannot be hashed')
  }
  for (const key of keys) {
    if (key.key.trim().length < MIN_TOKEN_HASH_KEY_LENGTH) {
      throw new Error(
        `${sources.get(key)} must have at least ${MIN_TOKEN_HASH_KEY_LENGTH} characters`,
      )
    }
  }
  return { current: keys[0]!, keys }
}

/**
 * One line for the startup log when more than one key is configured, so that an operator sees that
 * a rotation took effect: which version hashes new tokens and which ones only verify old tokens.
 * Null for a single key. Versions only, never a key.
 */
export function describeTokenKeyring(keyring: TokenKeyring): string | null {
  if (keyring.keys.length < 2) return null
  const older = keyring.keys
    .filter((known) => known !== keyring.current)
    .map((known) => known.version)
  const only =
    older.length > 1
      ? `versions ${older.join(', ')} only verify`
      : `version ${older.join(', ')} only verifies`
  return (
    `app token hash keys: version ${keyring.current.version} hashes new tokens; ${only} earlier ` +
    'tokens, which move to the current key when used'
  )
}
