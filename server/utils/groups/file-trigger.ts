// The running group file writer of this process, set by plugins/group-file.ts. Without it (demo
// mode, tests) the calls below do nothing.

interface ActiveGroupFile {
  /** Asks for a write soon (debounced). */
  request(): void
  /** Tells that `sub` is active now; a write is asked for when the file does not list them yet. */
  noteActive(sub: string): void
}

let active: ActiveGroupFile | undefined

export function setActiveGroupFile(handle: ActiveGroupFile | undefined): void {
  active = handle
}

/** The group file is stale: a change of groups or members, an import, an Import or Stop importing. */
export function requestGroupFileWrite(): void {
  active?.request()
}

/**
 * Called for every authenticated request: a person who is not in the line of everyone yet (new, or
 * back after the window) makes the file follow within the debounce, not within the hour.
 */
export function noteActiveUser(sub: string): void {
  active?.noteActive(sub)
}
