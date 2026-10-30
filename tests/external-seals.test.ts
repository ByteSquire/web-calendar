// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { computed } from 'vue'
import { createSealStore, isSealedText } from '../app/utils/external/seals'

// The sealed credentials: memory by default, the device only on request, and the device storage may
// be missing or throw at any time without the store failing.

class MemoryStorage implements Storage {
  data = new Map<string, string>()
  get length() {
    return this.data.size
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null
  }
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  clear() {
    this.data.clear()
  }
  [name: string]: unknown
}

/** A storage that throws on the operations named. */
function brokenStorage(broken: ('getItem' | 'setItem' | 'removeItem' | 'key' | 'length')[]) {
  const inner = new MemoryStorage()
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (broken.includes(property as never)) throw new DOMException('blocked', 'SecurityError')
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as MemoryStorage
}

function setup(sub: string | null = 'sub-1', storage: MemoryStorage | null = new MemoryStorage()) {
  let current = sub
  const store = createSealStore({ userSub: () => current, storage: () => storage })
  return { store, storage, signIn: (next: string | null) => (current = next) }
}

describe('memory', () => {
  it('keeps a credential per account and forgets it', () => {
    const { store, storage } = setup()
    expect(store.get(1)).toBeNull()
    expect(store.has(1)).toBe(false)
    expect(store.set(1, 'sealed-one', false)).toBe(false)
    store.set(2, 'sealed-two', false)
    expect(store.get(1)).toBe('sealed-one')
    expect(store.get(2)).toBe('sealed-two')
    expect(store.has(1)).toBe(true)
    store.forget(1)
    expect(store.get(1)).toBeNull()
    expect(store.get(2)).toBe('sealed-two')
    // nothing was written to the device
    expect(storage!.length).toBe(0)
  })

  it('is emptied by clearMemory, which is what signing out does', () => {
    const { store } = setup()
    store.set(1, 'sealed-one', false)
    store.clearMemory()
    expect(store.get(1)).toBeNull()
    expect(store.isRemembered(1)).toBe(false)
  })

  it('is reactive: a computed over it follows the changes', () => {
    const { store } = setup()
    const has = computed(() => store.has(1))
    const remembered = computed(() => store.isRemembered(1))
    expect(has.value).toBe(false)
    store.set(1, 'sealed-one', true)
    expect(has.value).toBe(true)
    expect(remembered.value).toBe(true)
    store.forget(1)
    expect(has.value).toBe(false)
    expect(remembered.value).toBe(false)
  })

  it('refuses a malformed sealed text before it is kept or sent in a header', () => {
    const { store } = setup()
    for (const bad of ['', 'has space', 'line\nbreak', 'tab\t', 'ünïcode', 'x'.repeat(8193)]) {
      expect(isSealedText(bad)).toBe(false)
      expect(() => store.set(1, bad, true)).toThrow(TypeError)
    }
    expect(isSealedText('v1.AbC_-.123')).toBe(true)
    expect(store.get(1)).toBeNull()
  })
})

describe('the device', () => {
  it('keeps a credential there only when asked, under a key of user and account', () => {
    const { store, storage } = setup('sub-1')
    expect(store.set(7, 'sealed-seven', true)).toBe(true)
    expect(store.isRemembered(7)).toBe(true)
    expect([...storage!.data.entries()]).toEqual([
      ['web-calendar:external-seal:sub-1:7', 'sealed-seven'],
    ])
  })

  it('encodes the user’s sub in the key, so no sub can reach another’s entries', () => {
    const { store, storage } = setup('a:b/c d')
    store.set(1, 'sealed', true)
    expect([...storage!.data.keys()]).toEqual(['web-calendar:external-seal:a%3Ab%2Fc%20d:1'])
    // "a" must not see what "a:b" stored
    const other = createSealStore({ userSub: () => 'a', storage: () => storage })
    other.sync([1])
    expect(other.get(1)).toBeNull()
  })

  it('removes the copy when the credential is set again without remember, and on forget', () => {
    const { store, storage } = setup()
    store.set(1, 'first', true)
    store.set(1, 'second', false)
    expect(storage!.length).toBe(0)
    expect(store.get(1)).toBe('second')
    expect(store.isRemembered(1)).toBe(false)

    store.set(1, 'third', true)
    store.forget(1)
    expect(storage!.length).toBe(0)
  })

  it('survives a sign-out: memory goes, the device copy comes back with sync', () => {
    const { store, storage } = setup()
    store.set(1, 'sealed-one', true)
    store.set(2, 'sealed-two', false)
    store.clearMemory()
    expect(store.get(1)).toBeNull()
    expect(storage!.length).toBe(1)

    store.sync([1, 2])
    expect(store.get(1)).toBe('sealed-one')
    expect(store.isRemembered(1)).toBe(true)
    expect(store.get(2)).toBeNull()
  })

  it('does not load another user’s copies', () => {
    const { store, storage, signIn } = setup('alice')
    store.set(1, 'alice-seal', true)
    store.clearMemory()
    signIn('bob')
    store.sync([1])
    expect(store.get(1)).toBeNull()
    // and bob’s sign-in leaves alice’s copy where it is
    expect(storage!.length).toBe(1)
    signIn('alice')
    store.sync([1])
    expect(store.get(1)).toBe('alice-seal')
  })

  it('sync drops copies of accounts that are gone, and entries that are not a sealed text', () => {
    const { store, storage } = setup()
    store.set(1, 'keep-me', true)
    store.set(2, 'gone', true)
    storage!.setItem('web-calendar:external-seal:sub-1:3', 'not a sealed text')
    storage!.setItem('web-calendar:other-key', 'unrelated')
    store.clearMemory()
    store.sync([1, 3])
    expect(store.get(1)).toBe('keep-me')
    expect(store.get(2)).toBeNull()
    expect(store.get(3)).toBeNull()
    expect([...storage!.data.keys()].sort()).toEqual([
      'web-calendar:external-seal:sub-1:1',
      'web-calendar:other-key',
    ])
  })

  it('sync keeps what was entered in this session over the copy on the device', () => {
    const { store, storage } = setup()
    store.set(1, 'older', true)
    store.set(1, 'newer', false)
    storage!.setItem('web-calendar:external-seal:sub-1:1', 'older')
    store.sync([1])
    expect(store.get(1)).toBe('newer')
  })

  it('sync also drops memory entries of accounts that are gone', () => {
    const { store } = setup()
    store.set(1, 'one', false)
    store.set(2, 'two', false)
    store.sync([2])
    expect(store.get(1)).toBeNull()
    expect(store.get(2)).toBe('two')
  })

  it('keeps nothing on the device while nobody is signed in', () => {
    const { store, storage } = setup(null)
    expect(store.set(1, 'sealed', true)).toBe(false)
    expect(store.get(1)).toBe('sealed')
    expect(storage!.length).toBe(0)
  })
})

describe('without a usable device storage', () => {
  it('works from memory when there is no storage at all', () => {
    const { store } = setup('sub-1', null)
    expect(store.set(1, 'sealed', true)).toBe(false)
    expect(store.get(1)).toBe('sealed')
    expect(store.isRemembered(1)).toBe(false)
    expect(() => store.sync([1])).not.toThrow()
    store.forget(1)
    expect(store.get(1)).toBeNull()
  })

  it('works when the storage getter itself throws (blocked site data)', () => {
    const store = createSealStore({
      userSub: () => 'sub-1',
      storage: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    expect(store.set(1, 'sealed', true)).toBe(false)
    expect(store.get(1)).toBe('sealed')
    expect(() => store.sync([1])).not.toThrow()
    expect(() => store.forget(1)).not.toThrow()
  })

  it('keeps the credential in memory when writing fails (full or blocked)', () => {
    const { store } = setup('sub-1', brokenStorage(['setItem']))
    expect(store.set(1, 'sealed', true)).toBe(false)
    expect(store.get(1)).toBe('sealed')
    expect(store.isRemembered(1)).toBe(false)
  })

  it('forgets from memory even when removing from the device fails', () => {
    const { store } = setup('sub-1', brokenStorage(['removeItem']))
    store.set(1, 'sealed', false)
    expect(() => store.forget(1)).not.toThrow()
    expect(store.get(1)).toBeNull()
  })

  it('survives a storage that throws while it is read', () => {
    for (const broken of ['getItem', 'key', 'length'] as const) {
      const { store } = setup('sub-1', brokenStorage([broken]))
      store.set(1, 'sealed', false)
      expect(() => store.sync([1])).not.toThrow()
      expect(store.get(1)).toBe('sealed')
    }
  })

  it('falls back to the global localStorage, whatever the page has', () => {
    // No `storage` option: the default is `localStorage` when the page has one. Either way, no throw.
    const store = createSealStore({ userSub: () => 'sub-1' })
    expect(() => store.set(1, 'sealed', true)).not.toThrow()
    expect(store.get(1)).toBe('sealed')
    store.forget(1)
  })
})
