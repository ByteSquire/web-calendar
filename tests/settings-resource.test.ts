// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createResource } from '../app/utils/settings/resource'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createResource', () => {
  it('loads, and reports pending while it does', async () => {
    const gate = deferred<string>()
    const resource = createResource(() => gate.promise, 'load things')
    expect(resource.data.value).toBeNull()
    const loading = resource.reload()
    expect(resource.pending.value).toBe(true)
    gate.resolve('data')
    await loading
    expect(resource.data.value).toBe('data')
    expect(resource.pending.value).toBe(false)
    expect(resource.error.value).toBeNull()
  })

  it('words a failure with the action and keeps the data that was there', async () => {
    let fail = false
    const resource = createResource(async () => {
      if (fail) throw new TypeError('Failed to fetch')
      return 'old'
    }, 'load things')
    await resource.reload()
    fail = true
    await resource.reload()
    expect(resource.error.value).toMatch(/^Could not load things\. The server could not be reached/)
    expect(resource.data.value).toBe('old')
    expect(resource.pending.value).toBe(false)

    fail = false
    await resource.reload()
    expect(resource.error.value).toBeNull()
  })

  it('lets only the newest load write', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const answers = [first, second]
    const resource = createResource(() => answers.shift()!.promise, 'load things')
    const slow = resource.reload()
    const fresh = resource.reload()
    second.resolve('fresh')
    await fresh
    first.resolve('stale')
    await slow
    expect(resource.data.value).toBe('fresh')
    expect(resource.pending.value).toBe(false)
  })

  it('ignores the failure of an older load too', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const answers = [first, second]
    const resource = createResource(() => answers.shift()!.promise, 'load things')
    const slow = resource.reload()
    const fresh = resource.reload()
    second.resolve('fresh')
    await fresh
    first.reject(new Error('late'))
    await slow
    expect(resource.error.value).toBeNull()
  })

  it('changes the loaded value in place, and nothing before it is loaded', async () => {
    const resource = createResource(async () => [1, 2, 3], 'load things')
    resource.update((list) => [...list, 4])
    expect(resource.data.value).toBeNull()
    await resource.reload()
    resource.update((list) => list.filter((item) => item !== 2))
    expect(resource.data.value).toEqual([1, 3])
  })
})
