// The Apache htgroup text Radicale reads: `group: member member`, members are Kanidm `sub` UUIDs.
import { fail, type FileGroup, type Result } from './types'

const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isGroupName(name: string): boolean {
  return GROUP_NAME.test(name)
}

export function isUuid(value: string): boolean {
  return UUID.test(value)
}

/** The file for these groups: sorted by name, members sorted and unique, one line each. */
export function renderGroupFile(groups: FileGroup[]): Result<string> {
  if (groups.length === 0) return fail('invalid-content', 'no groups to write')
  const lines: string[] = []
  const seen = new Set<string>()
  for (const group of [...groups].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (!isGroupName(group.name) || seen.has(group.name)) {
      return fail('invalid-content', `group name "${group.name}" is invalid or repeated`)
    }
    seen.add(group.name)
    const members = [...new Set(group.members.map((member) => member.toLowerCase()))].sort()
    const bad = members.find((member) => !isUuid(member))
    if (bad !== undefined) {
      return fail('invalid-content', `a member of "${group.name}" is not a UUID`)
    }
    lines.push(members.length > 0 ? `${group.name}: ${members.join(' ')}` : `${group.name}:`)
  }
  return { ok: true, value: `${lines.join('\n')}\n` }
}

/** Whether a text is a file `renderGroupFile` could have produced; checked before every write. */
export function validateGroupFileContent(content: string): Result<true> {
  if (!content.endsWith('\n'))
    return fail('invalid-content', 'the content does not end with a newline')
  const lines = content.slice(0, -1).split('\n')
  const names = new Set<string>()
  for (const line of lines) {
    const colon = line.indexOf(':')
    const name = colon < 0 ? '' : line.slice(0, colon)
    if (!isGroupName(name) || names.has(name)) {
      return fail('invalid-content', 'a line has an invalid or repeated group name')
    }
    names.add(name)
    const rest = line.slice(colon + 1)
    const members = rest === '' ? [] : rest.startsWith(' ') ? rest.slice(1).split(' ') : null
    if (!members || !members.every(isUuid)) {
      return fail('invalid-content', `the members of "${name}" are not space-separated UUIDs`)
    }
  }
  return { ok: true, value: true }
}
