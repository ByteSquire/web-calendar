// Replaces Radicale's group file atomically: the new content is validated, written to a temp file
// in the same directory, fsynced and renamed over the file; the old file stays as `<file>.prev`.
// Radicale never sees a half-written file, and a failure leaves the file as it was.
import { constants } from 'node:fs'
import * as nodeFs from 'node:fs/promises'
import { dirname } from 'node:path'
import { validateGroupFileContent } from './format'
import { fail, type Result } from './types'

/** The file operations used, so a test can make one of them fail. */
export interface GroupFileFs {
  readFile(path: string): Promise<string>
  writeSynced(path: string, content: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  syncDir(path: string): Promise<void>
}

export const nodeGroupFileFs: GroupFileFs = {
  readFile: (path) => nodeFs.readFile(path, 'utf8'),
  async writeSynced(path, content) {
    // Readable by Radicale's user, which is not the app's.
    const handle = await nodeFs.open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      0o644,
    )
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  copyFile: (from, to) => nodeFs.copyFile(from, to),
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (path) => nodeFs.unlink(path),
  async syncDir(path) {
    const handle = await nodeFs.open(path, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

/** 'unchanged' when the file already has this content; nothing is written then. */
export async function writeGroupFile(
  path: string,
  content: string,
  fs: GroupFileFs = nodeGroupFileFs,
): Promise<Result<'written' | 'unchanged'>> {
  const valid = validateGroupFileContent(content)
  if (!valid.ok) return valid

  let current: string | null = null
  try {
    current = await fs.readFile(path)
  } catch (error) {
    if (!isMissing(error))
      return fail('write-error', `cannot read the group file: ${errorCode(error)}`)
  }
  if (current === content) return { ok: true, value: 'unchanged' }

  const temp = `${path}.tmp`
  const prev = `${path}.prev`
  const prevTemp = `${prev}.tmp`
  try {
    await fs.writeSynced(temp, content)
    if (current !== null) {
      await fs.copyFile(path, prevTemp)
      await fs.rename(prevTemp, prev)
    }
    await fs.rename(temp, path)
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined)
    await fs.unlink(prevTemp).catch(() => undefined)
    return fail('write-error', `cannot write the group file: ${errorCode(error)}`)
  }
  // The rename is done; making it durable is best effort.
  await fs.syncDir(dirname(path)).catch(() => undefined)
  return { ok: true, value: 'written' }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'unknown error'
}
