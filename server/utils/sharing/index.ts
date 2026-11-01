import type { ReconcileState } from './reconcile'

// The running sharing writer of this process, set by plugins/sharing.ts. Without it (demo mode, no
// Radicale URL, tests) the calls below do nothing.

interface ActiveSharing {
  request(): void
  state(): ReconcileState
}

let active: ActiveSharing | undefined

export function setActiveSharing(handle: ActiveSharing | undefined): void {
  active = handle
}

/** Asks for a reconcile soon (debounced). Call it after every change to `calendar_acl`. */
export function requestSharingReconcile(): void {
  active?.request()
}

/** The state of the last reconcile, or null when the sharing writer is not running. */
export function getSharingState(): ReconcileState | null {
  return active?.state() ?? null
}
