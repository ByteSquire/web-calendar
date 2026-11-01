// The running group sync of this process, set by plugins/group-sync.ts. Without it (no token,
// demo mode, tests) the calls below do nothing.

/** Remembers each user's groups and says when they changed since the last look. */
export function createGroupsTracker(onChange: () => void, maxUsers = 10_000) {
  const seen = new Map<string, string>()
  return {
    note(sub: string, groups: readonly string[]): void {
      const key = [...new Set(groups)].sort().join('\n')
      const before = seen.get(sub)
      if (before === key) return
      if (seen.size >= maxUsers) seen.clear()
      seen.set(sub, key)
      // The first look at a user is not a change; the startup run covers it.
      if (before !== undefined) onChange()
    },
  }
}

interface ActiveSync {
  request(): void
  note(sub: string, groups: readonly string[]): void
}

let active: ActiveSync | undefined

export function setActiveGroupSync(handle: ActiveSync | undefined): void {
  active = handle
}

/** Asks for a sync run soon (debounced). */
export function requestGroupSyncRun(): void {
  active?.request()
}

/** Called with the `groups` claim of a user; a change triggers a run. */
export function noteUserGroups(sub: string, groups: readonly string[]): void {
  active?.note(sub, groups)
}
