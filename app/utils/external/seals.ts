// The sealed credentials of external CalDAV accounts (FR-8, design §5 "Not stored on the server").
// The server turns a password into a SEALED text that only its proxy can open, and only for this
// user, this account and this origin. The browser keeps that text: in memory by default (gone when
// the tab closes or the user signs out), and, as an opt-in "Remember on this device", also in
// `localStorage` under a key made of the user's `sub` and the account id. A copy on the device is
// worth nothing to another user of the browser (their key differs) or to a script that sends it
// anywhere but the proxy, but it does let a script of this page use the account, which is why it
// is opt-in.
//
// The device storage can be missing, full, blocked or throw on any access (private windows,
// cleared site data): every access is wrapped, and the store works without it.
import { ref } from 'vue'

const KEY_PREFIX = 'web-calendar:external-seal:'

/** What the proxy accepts as a sealed text: visible ASCII only, so it is safe in a header. */
const SEALED_TEXT = /^[\x21-\x7e]{1,8192}$/

export interface SealStoreOptions {
  /** The signed-in user's `sub`; the copy on the device is keyed by it. Null: nobody is signed in. */
  userSub: () => string | null
  /** The device storage; null (or a getter that throws) when there is none. Default: `localStorage`. */
  storage?: () => Storage | null
}

export interface SealStore {
  /** The sealed credential of an account, or null when this browser has none. Reactive. */
  get: (accountId: number) => string | null
  has: (accountId: number) => boolean
  /** True when the credential of the account is also kept on this device. Reactive. */
  isRemembered: (accountId: number) => boolean
  /**
   * Keeps a sealed credential in memory and, with `remember`, on the device too (without it, a
   * copy on the device is removed). Returns whether it is now on the device: false when
   * `remember` is off or the device storage refused.
   */
  set: (accountId: number, sealed: string, remember: boolean) => boolean
  /** Drops the credential from memory and from the device. */
  forget: (accountId: number) => void
  /**
   * Matches the store to the user's accounts: loads this user's copies from the device for them,
   * and removes copies of accounts that are gone (deleted on another device).
   */
  sync: (accountIds: readonly number[]) => void
  /** Empties the memory (sign-out). Copies on the device stay: that is what "remember" means. */
  clearMemory: () => void
}

export function isSealedText(value: unknown): value is string {
  return typeof value === 'string' && SEALED_TEXT.test(value)
}

function defaultStorage(): Storage | null {
  return globalThis.localStorage ?? null
}

export function createSealStore(options: SealStoreOptions): SealStore {
  const memory = new Map<number, string>()
  const remembered = new Set<number>()
  // Bumped on every change; reading it inside `get` makes the answers reactive.
  const version = ref(0)

  const bump = () => {
    version.value++
  }

  /** Runs `work` on the device storage; null when there is none or it throws. */
  function onDevice<T>(work: (storage: Storage, prefix: string) => T): T | null {
    try {
      const sub = options.userSub()
      const storage = (options.storage ?? defaultStorage)()
      if (!sub || !storage) return null
      return work(storage, `${KEY_PREFIX}${encodeURIComponent(sub)}:`)
    } catch {
      return null
    }
  }

  function removeFromDevice(accountId: number) {
    onDevice((storage, prefix) => storage.removeItem(`${prefix}${accountId}`))
    remembered.delete(accountId)
  }

  return {
    get(accountId) {
      void version.value
      return memory.get(accountId) ?? null
    },

    has(accountId) {
      void version.value
      return memory.has(accountId)
    },

    isRemembered(accountId) {
      void version.value
      return remembered.has(accountId)
    },

    set(accountId, sealed, remember) {
      if (!isSealedText(sealed)) throw new TypeError('the sealed credential is malformed')
      memory.set(accountId, sealed)
      let onDisk = false
      if (remember) {
        onDisk =
          onDevice((storage, prefix) => {
            storage.setItem(`${prefix}${accountId}`, sealed)
            return true
          }) === true
      }
      if (onDisk) remembered.add(accountId)
      else removeFromDevice(accountId)
      bump()
      return onDisk
    },

    forget(accountId) {
      memory.delete(accountId)
      removeFromDevice(accountId)
      bump()
    },

    sync(accountIds) {
      const known = new Set(accountIds)
      for (const accountId of [...memory.keys()]) {
        if (!known.has(accountId)) memory.delete(accountId)
      }
      for (const accountId of [...remembered]) {
        if (!known.has(accountId)) remembered.delete(accountId)
      }
      onDevice((storage, prefix) => {
        // Collect first: removing while walking the keys would skip some.
        const keys: string[] = []
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index)
          if (key?.startsWith(prefix)) keys.push(key)
        }
        for (const key of keys) {
          const accountId = Number(key.slice(prefix.length))
          if (!known.has(accountId)) {
            storage.removeItem(key)
            continue
          }
          const sealed = storage.getItem(key)
          if (isSealedText(sealed)) {
            // What was entered in this session is newer than the copy on the device.
            if (!memory.has(accountId)) memory.set(accountId, sealed)
            remembered.add(accountId)
          } else {
            storage.removeItem(key)
          }
        }
      })
      bump()
    },

    clearMemory() {
      memory.clear()
      remembered.clear()
      bump()
    },
  }
}
