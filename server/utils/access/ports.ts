// What the access administration tells the rest of the server. The integration sets the real
// port (the sharing writer's `requestSharingReconcile`); until then nothing is notified.

export interface AccessPorts {
  /** The rules of a calendar changed in the database; Radicale's shares should follow soon. */
  onAclChanged(): void
}

const NO_PORTS: AccessPorts = { onAclChanged: () => undefined }

let ports: AccessPorts = NO_PORTS

export function setAccessPorts(next: AccessPorts | undefined): void {
  ports = next ?? NO_PORTS
}

export function getAccessPorts(): AccessPorts {
  return ports
}

/**
 * Tells the sharing writer that rules, or what they depend on (a resource's name or state), changed.
 * Called after the commit, so the reconcile reads what was saved. Never throws: the change is saved,
 * and the periodic reconcile catches up if the request fails.
 */
export function notifyAclChanged(): void {
  try {
    ports.onAclChanged()
  } catch (error) {
    console.warn(
      '[access] the reconcile request failed:',
      error instanceof Error ? error.name : error,
    )
  }
}
