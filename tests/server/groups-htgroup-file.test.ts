// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  nodeGroupFileFs,
  writeGroupFile,
  type GroupFileFs,
} from '../../server/utils/groups/htgroup-file'
import { renderGroupFile, validateGroupFileContent } from '../../server/utils/groups/htgroup'

const A = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
const B = '6f9f0e2d-0000-4000-8000-000000000002'

describe('renderGroupFile', () => {
  it('writes sorted htgroup lines, members unique and exactly as given', () => {
    const out = renderGroupFile([
      { name: 'web_calendar_users', members: [B, A, A.toUpperCase(), A] },
      { name: 'calendar_admins', members: [A] },
      { name: 'empty', members: [] },
    ])
    // Radicale compares members case-sensitively, so the upper-case id is a different person.
    expect(out).toEqual({
      ok: true,
      value: `calendar_admins: ${A}\nempty:\nweb_calendar_users: ${A.toUpperCase()} ${A} ${B}\n`,
    })
  })

  it('writes the ids other providers send: mixed case, symbols, an @', () => {
    const members = ['Zx9_-Qw', 'auth0|5f7c', 'Alice@Example.org', 'u+1=2', 'abc123', 'ABC123']
    expect(renderGroupFile([{ name: 'g', members }])).toEqual({
      ok: true,
      value: `g: ${[...members].sort().join(' ')}\n`,
    })
  })

  it.each(['two words', 'a:b', 'a/b', '.hidden', 'tilde~', 'a@b@c', '', 'x'.repeat(256), 'ü'])(
    'refuses a member that is not a valid user id (%j)',
    (member) => {
      expect(renderGroupFile([{ name: 'g', members: [member] }]).ok).toBe(false)
    },
  )

  it('refuses a bad or repeated group name, and no groups', () => {
    expect(renderGroupFile([{ name: 'bad name', members: [] }]).ok).toBe(false)
    expect(
      renderGroupFile([
        { name: 'g', members: [] },
        { name: 'g', members: [] },
      ]).ok,
    ).toBe(false)
    expect(renderGroupFile([]).ok).toBe(false)
  })

  it('validates content: empty text and loose lines are invalid', () => {
    expect(validateGroupFileContent('').ok).toBe(false)
    expect(validateGroupFileContent(`g: ${A}`).ok).toBe(false)
    expect(validateGroupFileContent(`g: ${A}  ${B}\n`).ok).toBe(false)
    expect(validateGroupFileContent(`g: ${A} ${B}\nh:\n`).ok).toBe(true)
  })

  it('accepts members of any valid shape and refuses an invalid one', () => {
    expect(validateGroupFileContent('g: Ab ab auth0|1 Alice@Example.org\n').ok).toBe(true)
    // `a:b` has the group separator in a member, `.x` is a dot name.
    expect(validateGroupFileContent('g: a:b\n').ok).toBe(false)
    expect(validateGroupFileContent('g: ok .x\n').ok).toBe(false)
    expect(validateGroupFileContent(`g: ${'x'.repeat(256)}\n`).ok).toBe(false)
  })
})

describe('writeGroupFile', () => {
  let dir: string
  let file: string
  const content = `g: ${A}\n`

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'htgroup-file-'))
    file = join(dir, 'htgroup')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('creates the file', async () => {
    expect(await writeGroupFile(file, content)).toEqual({ ok: true, value: 'written' })
    expect(await readFile(file, 'utf8')).toBe(content)
    expect(await readdir(dir)).toEqual(['htgroup'])
  })

  it('replaces it atomically and keeps the previous version as .prev', async () => {
    await writeFile(file, `g: ${B}\n`)
    const seen: string[] = []
    const fs: GroupFileFs = {
      ...nodeGroupFileFs,
      async rename(from, to) {
        // Until the final rename the real file still has the old content.
        if (to === file) seen.push(await readFile(file, 'utf8'), await readFile(from, 'utf8'))
        await nodeGroupFileFs.rename(from, to)
        if (to === file) seen.push(await readFile(file, 'utf8'))
      },
    }
    expect(await writeGroupFile(file, content, fs)).toEqual({ ok: true, value: 'written' })
    expect(seen).toEqual([`g: ${B}\n`, content, content])
    expect(await readFile(`${file}.prev`, 'utf8')).toBe(`g: ${B}\n`)
    expect((await readdir(dir)).sort()).toEqual(['htgroup', 'htgroup.prev'])
  })

  it('writes nothing when the content is unchanged', async () => {
    await writeFile(file, content)
    const calls: string[] = []
    const fs: GroupFileFs = {
      ...nodeGroupFileFs,
      writeSynced: (path, text) => (calls.push(path), nodeGroupFileFs.writeSynced(path, text)),
    }
    expect(await writeGroupFile(file, content, fs)).toEqual({ ok: true, value: 'unchanged' })
    expect(calls).toEqual([])
    expect(await readdir(dir)).toEqual(['htgroup'])
  })

  it('leaves the file untouched and cleans up when the rename fails', async () => {
    await writeFile(file, `g: ${B}\n`)
    const fs: GroupFileFs = {
      ...nodeGroupFileFs,
      rename: async (from, to) => {
        if (to === file) throw Object.assign(new Error('boom'), { code: 'EIO' })
        await nodeGroupFileFs.rename(from, to)
      },
    }
    const result = await writeGroupFile(file, content, fs)
    expect(result.ok).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(`g: ${B}\n`)
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses invalid content without touching the disk', async () => {
    await writeFile(file, content)
    expect((await writeGroupFile(file, '')).ok).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(content)
  })
})
