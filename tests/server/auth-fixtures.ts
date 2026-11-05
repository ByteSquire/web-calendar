import {
  SignJWT,
  base64url,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose'
import type { AllowedClient } from '../../server/utils/auth/clients'

export const ISSUER_BASE = 'https://idm.example.test/oauth2/openid'
export const CLIENT: AllowedClient = {
  clientId: 'web-calendar',
  issuer: `${ISSUER_BASE}/web-calendar`,
}
/** A fixed clock, in milliseconds; tokens are minted relative to it. */
export const NOW_MS = 1_800_000_000_000
export const NOW = NOW_MS / 1000

export interface TestKey {
  kid: string
  privateKey: CryptoKey
  /** The public key as the provider publishes it. */
  jwk: JWK
  /** The algorithm it signs with (ES256 when absent). */
  alg?: string
}

/**
 * A key pair for `alg` (ES256, ES384, ES512, RS256..512, PS256..512, EdDSA). The published key
 * names its algorithm like Kanidm's does; `labelled: false` leaves `alg` out, as some providers do,
 * which lets an RSA key verify the whole RS and PS family.
 */
export async function makeKey(kid: string, alg = 'ES256', labelled = true): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair(alg)
  const published = { ...(await exportJWK(publicKey)), kid, use: 'sig' }
  return { kid, alg, privateKey, jwk: labelled ? { ...published, alg } : published }
}

export interface MintOptions {
  client?: AllowedClient
  /** Claims merged over the defaults; `undefined` removes a default. */
  claims?: Record<string, unknown>
  /** Header merged over the defaults; `undefined` removes a default. */
  header?: Record<string, unknown>
}

const defined = (bag: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(bag).filter(([, value]) => value !== undefined))

/** A token shaped like the ones Kanidm issues (checked against a real one, see auth-kanidm-fixture). */
export async function mintAccessToken(key: TestKey, options: MintOptions = {}): Promise<string> {
  const client = options.client ?? CLIENT
  const claims: Record<string, unknown> = {
    iss: client.issuer,
    sub: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
    aud: client.clientId,
    client_id: client.clientId,
    exp: NOW + 900,
    nbf: NOW,
    iat: NOW,
    scope: 'caldav email groups openid profile',
    ...options.claims,
  }
  const header: Record<string, unknown> = {
    alg: key.alg ?? 'ES256',
    kid: key.kid,
    typ: 'at+jwt',
    ...options.header,
  }
  return new SignJWT(defined(claims) as JWTPayload)
    .setProtectedHeader(defined(header) as never)
    .sign(key.privateKey)
}

/** `alg: none`, the signature part empty. */
export function unsignedToken(claims: Record<string, unknown>, kid = 'k1'): string {
  const encode = (value: unknown) => base64url.encode(JSON.stringify(value))
  return `${encode({ alg: 'none', typ: 'at+jwt', kid })}.${encode(claims)}.`
}
