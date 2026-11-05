// Settings of the group file Radicale reads.

/** The built-in group of everyone who signed in within the window (`groups.source = 'everyone'`). */
export const USERS_GROUP = 'web_calendar_users'

/** The group file: the configured path, else /groups/htgroup in production and .data/htgroup. */
export function groupFilePath(configured: unknown, nodeEnv: string | undefined): string {
  const path = typeof configured === 'string' ? configured.trim() : ''
  if (path) return path
  return nodeEnv === 'production' ? '/groups/htgroup' : '.data/htgroup'
}
