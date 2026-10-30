// The app-token endpoints (FR-30, FR-31) as plain functions around server/db/app-tokens.ts: input
// validation and the mapping of the store's errors to API errors. The routes only call these.
import type { Database } from 'better-sqlite3'
import {
  AppTokenError,
  createAppToken,
  listAppTokens,
  MAX_APP_TOKENS_PER_USER,
  revokeAppToken,
  type AppTokenSummary,
} from '../../db/app-tokens'
import { conflict, notFound, toBadRequest } from './errors'
import {
  expectValid,
  finish,
  FieldErrors,
  parseId,
  readObject,
  readText,
  type Parsed,
} from './validation'

export const MAX_TOKEN_LABEL_LENGTH = 64

export interface AppTokenListItem extends AppTokenSummary {
  /** True once `expiresAt` has passed: such a token is useless, does not count against the limit and can be removed. */
  expired: boolean
}

export interface AppTokenList {
  tokens: AppTokenListItem[]
  /** Unexpired tokens one user may have. */
  limit: number
}

export interface CreatedToken {
  id: number
  label: string
  /** The secret, shown only in this response. */
  token: string
  expiresAt: string
}

export function parseTokenInput(body: unknown): Parsed<{ label: string }> {
  const errors = new FieldErrors()
  const label = readText(readObject(body, errors).label, 'label', MAX_TOKEN_LABEL_LENGTH, errors)
  return finish(errors, () => ({ label: label! }))
}

export function listTokens(db: Database, userId: number, now = new Date()): AppTokenList {
  const iso = now.toISOString()
  return {
    tokens: listAppTokens(db, userId).map((token) => ({
      ...token,
      expired: token.expiresAt <= iso,
    })),
    limit: MAX_APP_TOKENS_PER_USER,
  }
}

export function createToken(
  db: Database,
  hashKey: string,
  userId: number,
  body: unknown,
  now = new Date(),
): CreatedToken {
  const { label } = expectValid(parseTokenInput(body))
  try {
    const created = createAppToken(db, hashKey, userId, label, now)
    return { id: created.id, label, token: created.token, expiresAt: created.expiresAt }
  } catch (error) {
    if (!(error instanceof AppTokenError)) throw error
    if (error.code === 'limit_reached') throw conflict('limit_reached', error.message)
    throw toBadRequest([{ field: 'label', message: error.message }])
  }
}

/** 404 for a token that does not exist and for one that belongs to somebody else. */
export function revokeToken(db: Database, userId: number, rawId: unknown): void {
  const id = parseId(rawId)
  if (!revokeAppToken(db, userId, id)) throw notFound()
}
