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
