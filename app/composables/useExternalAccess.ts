// What the app needs to work with external CalDAV accounts (FR-8): the API of the accounts, the
// store of their sealed credentials and the source the live loader reads. One set per app, created
// on first use. The sealed credentials are kept in memory and only forgotten here when the user
// signs out (the copies on the device are the user's choice and stay).
import { effectScope, watch } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { useAuthFetch } from '~/composables/useAuthFetch'
import { createExternalApi, type ExternalApi } from '~/utils/external/api'
import { createSealStore, type SealStore } from '~/utils/external/seals'
import { createExternalSource, type ExternalSource } from '~/utils/external/source'
import { davFetchFrom } from '~/utils/live/dav-fetch'

export interface ExternalAccess {
  api: ExternalApi
  seals: SealStore
  source: ExternalSource
}

const accesses = new WeakMap<object, ExternalAccess>()

export function useExternalAccess(): ExternalAccess {
  const nuxtApp = useNuxtApp()
  let access = accesses.get(nuxtApp)
  if (!access) {
    const auth = useAuth()
    const api = createExternalApi(useAuthFetch())
    const seals = createSealStore({ userSub: () => auth.user.value?.sub ?? null })
    // A failed token renewal becomes `unauthorized`, which the sidebar words as "Sign-in expired".
    const source = createExternalSource({ fetch: davFetchFrom(auth.authFetch), api, seals })
    // Not tied to the component that asked first: the store lives as long as the app.
    effectScope(true).run(() =>
      watch(auth.status, (status) => {
        if (status !== 'authenticated') seals.clearMemory()
      }),
    )
    access = { api, seals, source }
    accesses.set(nuxtApp, access)
  }
  return access
}
