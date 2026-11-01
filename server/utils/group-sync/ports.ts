// What the group sync needs from the rest of the app. The defaults work on their own; the
// integration replaces them (the ACL's group names, the audit_log table).

export interface GroupSyncAuditEvent {
  action: string
  target?: string
  details?: Record<string, unknown>
}

export interface GroupSyncPorts {
  /** Names of the groups, besides the admin and user groups, that the access rules reference. */
  listExtraGroups(): string[] | Promise<string[]>
  audit(event: GroupSyncAuditEvent): void
}

/** No extra groups; the audit event is one structured log line. Events carry no secrets. */
export function createDefaultPorts(log: (line: string) => void = console.info): GroupSyncPorts {
  return {
    listExtraGroups: () => [],
    audit: (event) => {
      log(`[group-sync] audit ${JSON.stringify(event)}`)
    },
  }
}
