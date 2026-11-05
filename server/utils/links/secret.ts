// The address and the password of a calendar link, kept for showing them again (to its maker, and
// to admins on the access page). The visitor is still checked against the hashes (slug_hash and the
// scrypt hash); this copy is only for display. AES-256-GCM with a key derived from the token hash
// key (`HMAC(key, label)`, a label of its own so it never equals the session key or what app tokens
// hash), a fresh 12-byte nonce, and the slug hash as additional data, so a sealed secret opens only
// for its own row. `s1.<key version>.<base64url(nonce || ciphertext || tag)>`. After a rotation
// drops the key it was sealed with, `open` returns null: the link works on, but its secret cannot be
// shown any more. Nothing here logs; every failure is the same null.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { toKeyring, type TokenHashKeys } from '../../db/app-tokens'

export interface LinkSecret {
  slug: string
  password: string
}

const NONCE_BYTES = 12
const TAG_BYTES = 16
const SHAPE = /^s1\.([1-9]\d{0,5})\.([A-Za-z0-9_-]{40,1900})$/

function keyFor(hashKey: string): Buffer {
  return createHmac('sha256', hashKey).update('web-calendar calendar-link secret v1').digest()
}

const aadOf = (slugHash: string) => Buffer.from(`calendar-link|${slugHash}`, 'utf8')

export function sealLinkSecret(
  hashKeys: TokenHashKeys,
  slugHash: string,
  secret: LinkSecret,
): string {
  const { current } = toKeyring(hashKeys)
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keyFor(current.key), nonce, {
    authTagLength: TAG_BYTES,
  })
  cipher.setAAD(aadOf(slugHash))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()])
  const sealed = Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64url')
  return `s1.${current.version}.${sealed}`
}

export function openLinkSecret(
  hashKeys: TokenHashKeys,
  slugHash: string,
  sealed: string | null | undefined,
): LinkSecret | null {
  try {
    if (typeof sealed !== 'string') return null
    const parts = SHAPE.exec(sealed)
    if (!parts) return null
    const key = toKeyring(hashKeys).keys.find((item) => item.version === Number(parts[1]))
    if (!key) return null
    const bytes = Buffer.from(parts[2]!, 'base64url')
    if (bytes.length < NONCE_BYTES + TAG_BYTES + 2) return null
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFor(key.key),
      bytes.subarray(0, NONCE_BYTES),
      { authTagLength: TAG_BYTES },
    )
    decipher.setAAD(aadOf(slugHash))
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES))
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
    const value = JSON.parse(plain) as Partial<LinkSecret>
    if (typeof value.slug !== 'string' || typeof value.password !== 'string') return null
    return { slug: value.slug, password: value.password }
  } catch {
    return null
  }
}
