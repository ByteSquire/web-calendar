import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * The password of a test user of the local Kanidm stack, from the stack's own secrets file
 * (dev/spike-s1/.local/secrets.env, created by `./spike.sh bootstrap`; never printed or logged).
 * The file is shell syntax (values may contain escapes), so it is read the way spike.sh reads it:
 * sourced by `sh`.
 */
export function testPassword(user: 'alice' | 'bob'): string {
  const name = `${user.toUpperCase()}_PASSWORD`
  const value = execFileSync('sh', ['-c', `. "$SECRETS_FILE" && printf %s "\${${name}:-}"`], {
    env: { PATH: process.env.PATH ?? '', SECRETS_FILE: resolve('dev/spike-s1/.local/secrets.env') },
    encoding: 'utf8',
  })
  if (!value) throw new Error(`${name} is not set in dev/spike-s1/.local/secrets.env`)
  return value
}
