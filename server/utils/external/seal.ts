import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Sealed credentials of external CalDAV accounts (FR-8, design §6). The server keeps no password:
// when a user adds an account it encrypts `username:password` with a key only the server has and
// hands the result, the SEAL, to the browser. The browser sends it back with every request to the
// proxy (`X-Upstream-Authorization: Sealed <text>`), the proxy opens it and uses the login for
// that account's origin and nowhere else. So the server stays stateless, and a seal that is copied
// out of the browser is useless to anyone who cannot also present a valid bearer token of the same
// user.
//
// AES-256-GCM, a fresh random 12-byte nonce per seal, output `base64url(version || nonce ||
// ciphertext || tag)`. The additional authenticated data names the version, the user, the account
// and the origin: `v1|<user sub>|<account id>|<origin>`. A seal therefore opens only for that
// user, that account and that origin; a seal replayed by another user, for another account or
// after the account moved to another origin does not open. (The sub is printable ASCII and may
// contain `|`; the id is digits and the origin has none, so the four parts cannot be re-cut.)
// The user name is NOT in the AAD, because the proxy compares it with the account's after opening.
//
// Rotating NUXT_EXTERNAL_SEAL_KEY voids every seal: users re-enter their passwords (the credential
// route makes a new seal on a device). There is no second key and no re-sealing by design.
//
// Nothing here logs, and `open` fails in exactly one way (null) for every cause: a bad encoding,
// a short text, an unknown version, a failed tag and a plaintext of the wrong shape all look the
// same to the caller and to anyone watching it.

export const SEAL_KEY_BYTES = 32
const SEAL_VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
/** Shortest possible plaintext: `a:b`. */
const MIN_PLAINTEXT_BYTES = 3

/**
 * Longest sealed text `open` looks at. A maximal login (256 + 1 + 1024 UTF-16 units, three UTF-8
 * bytes each) seals to about 5.2 KB; a larger value is not ours, and it is cut off before any
 * decoding.
 */
export const MAX_SEALED_LENGTH = 8192

/** The kind of malformed key, never the key. */
export class SealKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealKeyError'
  }
}

/**
 * The key from NUXT_EXTERNAL_SEAL_KEY: 64 hex characters, or base64 / base64url of 32 bytes
 * (`openssl rand -base64 32`). Hex is tried first: a 64-character hex string is also valid base64,
 * of 48 bytes. The message never contains the key.
 */
export function parseSealKey(text: string): Buffer {
  const value = text.trim()
  let key: Buffer | null = null
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex')
  } else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(value)) {
    key = Buffer.from(value, 'base64')
  }
  if (key === null || key.length !== SEAL_KEY_BYTES) {
    throw new SealKeyError(
      'NUXT_EXTERNAL_SEAL_KEY must be 32 random bytes written as 64 hex characters or as base64 ' +
        '(generate one with: openssl rand -base64 32)',
    )
  }
  // A placeholder such as 64 zeros is a typo, not a key.
  if (key.every((byte) => byte === key[0])) {
    throw new SealKeyError('NUXT_EXTERNAL_SEAL_KEY must be random, not one repeated byte')
  }
  return key
}

/** What a seal protects. The user name is checked by the caller against the account's. */
export interface SealedLogin {
  username: string
  password: string
}

/** What a seal is bound to. */
export interface SealContext {
  /** The app user's OIDC subject. */
  sub: string
  accountId: number
  /** `new URL(url).origin` of the account, the one spelling the database stores. */
  origin: string
}

export interface Sealer {
  /** Throws `TypeError` for a login that cannot be sealed (an empty part, a `:` in the user name). */
  seal(login: SealedLogin, context: SealContext): string
  /** The login, or null when `sealed` is not a valid seal for exactly this context. */
  open(sealed: unknown, context: SealContext): SealedLogin | null
}

function additionalData(version: number, context: SealContext): Buffer {
  return Buffer.from(`v${version}|${context.sub}|${context.accountId}|${context.origin}`, 'utf8')
}

export function createSealer(key: Buffer): Sealer {
  if (key.length !== SEAL_KEY_BYTES) throw new SealKeyError('the seal key must be 32 bytes')
  const secret = Buffer.from(key)

  return {
    seal(login, context) {
      if (login.username === '' || login.username.includes(':') || login.password === '') {
        throw new TypeError('a seal needs a user name without ":" and a password')
      }
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', secret, nonce, { authTagLength: TAG_BYTES })
      cipher.setAAD(additionalData(SEAL_VERSION, context))
      const encrypted = Buffer.concat([
        cipher.update(`${login.username}:${login.password}`, 'utf8'),
        cipher.final(),
      ])
      const sealed = Buffer.concat([Buffer.of(SEAL_VERSION), nonce, encrypted, cipher.getAuthTag()])
      return sealed.toString('base64url')
    },

    open(sealed, context) {
      try {
        if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_LENGTH) return null
        if (!/^[A-Za-z0-9_-]+$/.test(sealed)) return null
        const bytes = Buffer.from(sealed, 'base64url')
        // One spelling per seal: a text with stray trailing bits decodes to the same bytes.
        if (bytes.toString('base64url') !== sealed) return null
        if (bytes.length < 1 + NONCE_BYTES + MIN_PLAINTEXT_BYTES + TAG_BYTES) return null
        const version = bytes[0]!
        if (version !== SEAL_VERSION) return null

        const nonce = bytes.subarray(1, 1 + NONCE_BYTES)
        const tag = bytes.subarray(bytes.length - TAG_BYTES)
        const encrypted = bytes.subarray(1 + NONCE_BYTES, bytes.length - TAG_BYTES)
        const decipher = createDecipheriv('aes-256-gcm', secret, nonce, {
          authTagLength: TAG_BYTES,
        })
        decipher.setAAD(additionalData(version, context))
        decipher.setAuthTag(tag)
        const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])

        const text = new TextDecoder('utf-8', { fatal: true }).decode(plain)
        // The user name cannot contain ":" (RFC 7617), so the first one ends it.
        const colon = text.indexOf(':')
        if (colon < 1 || colon === text.length - 1) return null
        return { username: text.slice(0, colon), password: text.slice(colon + 1) }
      } catch {
        return null
      }
    },
  }
}

/** The text of `X-Upstream-Authorization: Sealed <text>`, or null for any other header value. */
export function sealedFromHeader(value: string | null): string | null {
  if (value === null || value.length > MAX_SEALED_LENGTH + 'Sealed '.length) return null
  const match = /^sealed ([A-Za-z0-9_-]+)$/i.exec(value.trim())
  return match ? match[1]! : null
}
