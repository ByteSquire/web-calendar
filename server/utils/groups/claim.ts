// The groups claim of an identity provider, read into the groups the app can import. Pure: no
// database, no network. The claim is data from outside, so everything here is bounded (200 groups,
// 255 characters per entry) and every name that comes out passes the group-file name rule.
//
// What providers send (plan 8.3): Kanidm `groups` is `[uuid, spn, uuid, spn, ...]`, and with
// `groups_name` also names; Keycloak writes paths (`/team/ops`) or plain names; Authentik, Authelia,
// Dex and Okta write names; Entra writes object ids (GUIDs); Zitadel writes an object keyed by
// role; Cognito's claim is `cognito:groups`; Auth0 uses a namespaced claim.

/** A group the claim names. `key` is how the provider identifies it, `name` what the app calls it. */
export interface ClaimGroup {
  /** The provider's key: its id where the claim has one, else its path, SPN or name. 1..255 characters. */
  key: string
  /** The file-safe name: 1..64 characters of `[A-Za-z0-9_.-]`, starting with a letter or digit. */
  name: string
}

export type ParsedClaim =
  | { absent: true }
  | {
      absent: false
      groups: ClaimGroup[]
      warnings: string[]
      /**
       * More groups than the cap were in the claim, so `groups` is a part of them: the import may add
       * the person to groups, but must not take them out of one it does not see.
       */
      truncated?: boolean
    }

export interface ClaimOptions {
  /** Names (exact, or `prefix*`) that never become candidates. Matched without regard to case. */
  ignore: readonly string[]
}

export const MAX_CLAIM_GROUPS = 200
export const MAX_ENTRY_LENGTH = 255
export const MAX_NAME_LENGTH = 64

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The text in a warning: short, on one line; the entry came from the provider. */
function quote(value: string): string {
  return JSON.stringify(value.slice(0, 60))
}

/**
 * A name the group file accepts, made from any text: blanks around it are dropped, runs of other
 * characters become one `_`, a leading non-alphanumeric is removed, at most 64 characters. Empty when nothing is left.
 */
export function sanitiseGroupName(text: string): string {
  return safeName(text.trim())
}

/** `sanitiseGroupName` without the trimming: blanks around the text become part of the name. */
function safeName(text: string): string {
  return text
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, MAX_NAME_LENGTH)
}

/** `NUXT_OIDC_GROUPS_IGNORE`: a comma-separated list of names, each optionally ending in `*`. */
export function parseIgnoreList(setting: unknown): string[] {
  return String(setting ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** Whether a group name is on the ignore list (exact name or `prefix*`, any case). */
export function isIgnored(name: string, ignore: readonly string[]): boolean {
  const lower = name.toLowerCase()
  return ignore.some((pattern) => {
    const wanted = pattern.toLowerCase()
    return wanted.endsWith('*') ? lower.startsWith(wanted.slice(0, -1)) : lower === wanted
  })
}

/**
 * The entries of a claim value: an array of strings stays, an object becomes its keys (Zitadel),
 * one string becomes one entry. Anything else is not a groups claim (undefined). Entries that are
 * not strings are dropped; the count is reported.
 */
function entriesOf(value: unknown): { entries: string[]; dropped: number } | undefined {
  if (typeof value === 'string') return { entries: [value], dropped: 0 }
  const items = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null
      ? // An object is a map of names to what they stand for (Zitadel roles). A name that stands
        // for false, null, 0 or '' is not one the person has.
        Object.entries(value)
          .filter(([, flag]) => flag !== false && flag !== null && flag !== 0 && flag !== '')
          .map(([name]) => name)
      : undefined
  if (items === undefined) return undefined
  const entries = items.filter((item): item is string => typeof item === 'string')
  return { entries, dropped: items.length - entries.length }
}

/**
 * The entries of a claim value as text: an array of strings stays, an object gives its keys, one
 * string is one entry (an object's keys whose value is not false, null, 0 or empty); entries that
 * are not text are left out. Undefined when the value is none of
 * those, i.e. the claim is not there.
 */
export function claimEntries(value: unknown): string[] | undefined {
  return entriesOf(value)?.entries
}

/**
 * Whether one of the entries is the admin group. An entry counts when it is the setting exactly as
 * written, or when the setting is what the entry reduces to by a rule that cannot make two
 * different groups one: the part before the one `@` of an SPN, or the segments of a path joined by
 * dots. Case counts; blanks and symbols count too, so "calendar admins" is not "calendar_admins"
 * (a provider where people can name groups would otherwise hand out admin). This looks at every
 * entry, the ignore list does not apply.
 */
export function matchesAdminGroup(entries: readonly string[], adminGroup: string): boolean {
  if (adminGroup === '') return false
  return entries.some((entry) => {
    if (entry === adminGroup) return true
    const parts = entry.split('@')
    if (parts.length === 2 && parts[0] === adminGroup) return true
    return entry.startsWith('/') && entry.split('/').filter(Boolean).join('.') === adminGroup
  })
}

/** `name@domain`: one `@`, text on both sides, not a path. */
function isSpn(entry: string): boolean {
  const parts = entry.split('@')
  return parts.length === 2 && parts[0] !== '' && parts[1] !== '' && !entry.startsWith('/')
}

/** A short group name after an SPN: no `@`, not a path, not an id. */
function isShortName(entry: string): boolean {
  return !entry.includes('@') && !entry.startsWith('/') && !UUID.test(entry)
}

/** One group as it is read, before names are made safe and the groups are limited. */
interface Draft {
  key: string
  /** The raw text the name is made from. */
  nameFrom: string
}

/**
 * Reads the value of the groups claim. `undefined`, `null` or any value that is not an array, an
 * object or a string means the claim is not there (`absent`): the caller then leaves the stored
 * memberships alone. An empty array is a claim: the person is in no group.
 *
 * Per entry, in order:
 * 1. a UUID is a group (its key). If an SPN follows it, the SPN belongs to it, and so does a short
 *    name after the SPN; the name is the short name, else the part of the SPN before `@` (Kanidm
 *    `[uuid, spn]` and `[uuid, spn, name]`). A UUID with no SPN after it stands alone and is its own
 *    name (Entra `[guid]`, or a group of a plain-name provider called like an id);
 * 2. an entry starting with `/` is a path (Keycloak): the key is the path, the name its segments
 *    joined with `.`;
 * 3. an entry with `@` is an SPN: the key is the entry, the name the part before `@`;
 * 4. any other entry is a name: key and name are the text.
 * Names are made safe (`sanitiseGroupName`); a group whose name matches the ignore list, or is
 * empty after that, is dropped. A key seen twice counts once.
 */
export function parseGroupsClaim(value: unknown, options: ClaimOptions): ParsedClaim {
  const read = entriesOf(value)
  if (read === undefined) return { absent: true }
  const warnings: string[] = []
  if (read.dropped > 0) warnings.push(`${read.dropped} entries of the groups claim are not text`)

  const drafts: Draft[] = []
  const entries = read.entries
  const usable = (entry: string | undefined): entry is string =>
    entry !== undefined && entry !== '' && entry.length <= MAX_ENTRY_LENGTH
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    if (!usable(entry)) {
      warnings.push(
        entry === ''
          ? 'an empty entry of the groups claim was skipped'
          : `an entry of the groups claim is longer than ${MAX_ENTRY_LENGTH} characters and was skipped`,
      )
      continue
    }
    if (UUID.test(entry)) {
      // Kanidm writes a group as its id and its SPN, with the short name after them when the scope
      // for names is asked too. Only that shape makes the entries after an id its names; an id
      // that is not followed by an SPN stands alone (Entra's object ids, or a group of a provider
      // with plain names that happens to be called like an id).
      const spn = entries[i + 1]
      if (usable(spn) && isSpn(spn)) {
        const alias = entries[i + 2]
        const named = usable(alias) && isShortName(alias)
        drafts.push({ key: entry, nameFrom: named ? alias : spn.split('@')[0]! })
        i += named ? 2 : 1
      } else {
        drafts.push({ key: entry, nameFrom: entry })
      }
    } else if (entry.startsWith('/')) {
      drafts.push({ key: entry, nameFrom: entry.split('/').filter(Boolean).join('.') })
    } else if (entry.includes('@')) {
      drafts.push({ key: entry, nameFrom: entry.split('@')[0]! })
    } else {
      drafts.push({ key: entry, nameFrom: entry })
    }
  }

  const groups: ClaimGroup[] = []
  const seen = new Set<string>()
  let truncated = false
  for (const draft of drafts) {
    if (seen.has(draft.key)) continue
    seen.add(draft.key)
    const name = sanitiseGroupName(draft.nameFrom)
    if (name === '') {
      warnings.push(`the group ${quote(draft.key)} has no usable name and was skipped`)
      continue
    }
    if (isIgnored(name, options.ignore)) continue
    if (groups.length >= MAX_CLAIM_GROUPS) {
      warnings.push(
        `the groups claim has more than ${MAX_CLAIM_GROUPS} groups; the rest was skipped`,
      )
      truncated = true
      break
    }
    groups.push({ key: draft.key, name })
  }
  return { absent: false, groups, warnings, truncated }
}

/**
 * Whether the token says its groups were left out because there are too many (Entra: more than 200
 * groups put a pointer in `_claim_names` instead of the claim). The groups are then unknown, not
 * empty: the caller treats the claim as absent.
 */
export function claimIsOverage(payload: Record<string, unknown>, claimName: string): boolean {
  const names = payload._claim_names
  return (
    typeof names === 'object' &&
    names !== null &&
    !Array.isArray(names) &&
    Object.hasOwn(names, claimName)
  )
}
