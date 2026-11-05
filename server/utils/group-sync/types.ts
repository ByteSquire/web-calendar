// Shared shapes of the group sync (security review §7.2).

export type GroupSyncFailureKind =
  | 'unauthorized' // HTTP 401/403 from Kanidm: a loud alarm
  | 'null-answer' // Kanidm answered `null`: it hides the group or it does not exist
  | 'malformed'
  | 'http-error'
  | 'network'
  | 'timeout'
  | 'too-large'
  | 'unresolved-members'
  | 'invalid-content'
  | 'write-error'
  | 'extra-groups'

/** Why a run failed. `message` never contains the token. */
export interface GroupSyncFailure {
  kind: GroupSyncFailureKind
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; failure: GroupSyncFailure }

export function fail(
  kind: GroupSyncFailureKind,
  message: string,
): { ok: false; failure: GroupSyncFailure } {
  return { ok: false, failure: { kind, message } }
}

/** A Kanidm group as the sync needs it: its name and the SPNs of its direct members. */
export interface KanidmGroup {
  name: string
  members: string[]
}

/** A group from Kanidm's group list: `builtin` groups are Kanidm's own and never imported. */
export interface KanidmListedGroup extends KanidmGroup {
  builtin: boolean
}

/** A Kanidm group the sync imports: members are `sub` UUIDs of the persons Kanidm shows. */
export interface ImportedGroup {
  name: string
  members: string[]
  /**
   * True when the group has members in Kanidm but none could be read as a person this run (the
   * sync account most likely lacks `idm_people_pii_read`): the stored members stay as they are
   * instead of being replaced by an empty list.
   */
  keepMembers?: boolean
}

/** A group of the output file: members are `sub` UUIDs. */
export interface FileGroup {
  name: string
  members: string[]
}

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}
