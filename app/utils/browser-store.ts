// The browser's localStorage as a `KeyValueStore`, or null where there is none (blocked, private
// mode). Reading and writing still go through try / catch at the call site: storage can be full.
import type { KeyValueStore } from '~/utils/resources/updates'

export function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
