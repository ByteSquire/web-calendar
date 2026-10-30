// `$fetch` for the app's own API: adds the bearer token and, on a 401, renews it and sends the
// request once more (the same logic as `authFetch`). Use it for every `/api/**` call:
//   const api = useAuthFetch()
//   const me = await api<MeResponse>('/api/me')
//
// When there is no session (signed out, or the renewal failed) no request is sent. ofetch wraps
// what `fetch` throws, so the caller gets a `FetchError` whose `cause` is the `AuthRequiredError`
// (check `error.cause`), and ofetch tries a GET once more before giving up (the second try fails
// at once). A 401 that survives the retry is an ordinary `FetchError` with `statusCode` 401.
import { useAuth } from '~/composables/useAuth'

// ofetch's `create` takes a replacement for the `fetch` it calls as a second argument (its JSON
// handling, base URL and error behaviour stay); Nuxt's type for `$fetch.create` leaves it out.
type CreateWithFetch = (defaults: object, global: { fetch: typeof fetch }) => typeof $fetch

export function useAuthFetch(): typeof $fetch {
  return ($fetch.create as unknown as CreateWithFetch)({}, { fetch: useAuth().authFetch })
}
