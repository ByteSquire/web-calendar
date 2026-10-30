// The real oidc-client-ts `UserManager` for the client in client.ts (kept apart so the rest of the
// login can be tested without the library). Browser only.
import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts'
import type { OidcManagerLike, OidcSettings } from './client'

export function createOidcUserManager(settings: OidcSettings): OidcManagerLike {
  return new UserManager({
    ...settings,
    // Tokens only in memory: they are gone on a reload, which then logs in again (silently if the
    // provider still has a session). A refresh token in storage would give an XSS bug long access.
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    // The login state (state, PKCE verifier, `returnTo`) has to survive the redirect, but only for
    // this tab; the library's default is the local storage, shared by all tabs.
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
  })
}
