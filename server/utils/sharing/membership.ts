import { stat, readFile } from 'node:fs/promises'

// Who is in which group, as Radicale sees it: the group file the app writes. The gateway pre-check
// and the nightly audit use it so that they agree with Radicale about group shares.

export interface GroupMembership {
  /** The groups the user (a `sub`, case-sensitive like Radicale) is in; empty when the file cannot be read. */
  groupsOf(sub: string): Promise<ReadonlySet<string>>
  /** Every user in the file with their groups. */
  all(): Promise<ReadonlyMap<string, ReadonlySet<string>>>
}

/** Parses `group: member member` lines into member -> groups. Unreadable lines are skipped. */
export function parseGroupFile(text: string): Map<string, Set<string>> {
  const byMember = new Map<string, Set<string>>()
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const group = line.slice(0, colon).trim()
    for (const member of line.slice(colon + 1).split(/\s+/)) {
      if (member === '') continue
      const groups = byMember.get(member) ?? new Set<string>()
      groups.add(group)
      byMember.set(member, groups)
    }
  }
  return byMember
}

/** Reads the file when its mtime or size changed; a missing or unreadable file means no groups. */
export function createFileMembership(
  path: string,
  log?: (message: string) => void,
): GroupMembership {
  let cacheKey = ''
  let cached = new Map<string, Set<string>>()
  let warned = false

  async function load(): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    try {
      const info = await stat(path)
      const key = `${info.mtimeMs}:${info.size}`
      if (key !== cacheKey) {
        cached = parseGroupFile(await readFile(path, 'utf8'))
        cacheKey = key
      }
      warned = false
    } catch {
      cached = new Map()
      cacheKey = ''
      if (!warned) log?.('the group file cannot be read; group access is treated as empty')
      warned = true
    }
    return cached
  }

  return {
    all: load,
    async groupsOf(sub) {
      return (await load()).get(sub) ?? new Set<string>()
    },
  }
}
