// A value loaded from the API with its loading and error state, for the sections of the settings
// screen. Plain Vue refs (no Nuxt), so it runs in plain Vitest. Reloading keeps the old data on
// screen: a failed refresh shows the error above the list that is still there.
import { ref, type Ref } from 'vue'
import { describeError } from './api-errors'

export interface Resource<T> {
  data: Ref<T | null>
  /** True while a load is running. */
  pending: Ref<boolean>
  /** Worded for people; null after a successful load. */
  error: Ref<string | null>
  reload: () => Promise<void>
  /** Change the loaded value in place, for example to drop a deleted row at once. */
  update: (change: (current: T) => T) => void
}

/** `action` completes "Could not ...": for example `load your app tokens`. */
export function createResource<T>(load: () => Promise<T>, action: string): Resource<T> {
  const data = ref<T | null>(null) as Ref<T | null>
  const pending = ref(false)
  const error = ref<string | null>(null)
  // Only the newest load may write: a slow answer must not replace a fresher one.
  let latest = 0

  async function reload() {
    const run = ++latest
    pending.value = true
    try {
      const value = await load()
      if (run !== latest) return
      data.value = value
      error.value = null
    } catch (cause) {
      if (run !== latest) return
      error.value = describeError(cause, action)
    } finally {
      if (run === latest) pending.value = false
    }
  }

  function update(change: (current: T) => T) {
    if (data.value !== null) data.value = change(data.value)
  }

  return { data, pending, error, reload, update }
}
