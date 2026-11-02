// App tokens (FR-30, FR-31): what the screen tells people to enter in their calendar apps and how
// many tokens count against the limit.
import { t } from '~/utils/i18n'
import type { TokenList, TokenListItem } from './types'

/** The CalDAV address of the gateway for an origin such as `https://calendar.example.org`. */
export function caldavAddress(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/caldav/`
}

/** Clients that discover the address themselves (Apple, DAVx5) start from here. */
export function caldavDiscoveryAddress(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/.well-known/caldav`
}

/** Expired tokens are useless and do not count against the limit (server: app-tokens.ts). */
export function activeTokens(tokens: readonly TokenListItem[]): TokenListItem[] {
  return tokens.filter((token) => !token.expired)
}

export interface TokenLimit {
  used: number
  limit: number
  reached: boolean
  /** One sentence, shown next to the form. */
  message: string
}

export function tokenLimit(list: Pick<TokenList, 'tokens' | 'limit'> | null): TokenLimit {
  if (!list) return { used: 0, limit: 0, reached: false, message: '' }
  const used = activeTokens(list.tokens).length
  const reached = used >= list.limit
  return {
    used,
    limit: list.limit,
    reached,
    message: reached
      ? t(
          'You have {used} of {limit} app tokens, which is the limit. Revoke a token to create another one.',
          { used, limit: list.limit },
        )
      : t('{used} of {limit} app tokens in use. Expired tokens do not count.', {
          used,
          limit: list.limit,
        }),
  }
}
