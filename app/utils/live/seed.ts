// What the calendar state starts with, and which mode the app runs in.
import type { MockData } from '../../data/mock'

/** The slice of `/api/config` that decides the mode. */
interface ModeConfig {
  demo?: boolean
  oidc?: { issuer?: string }
}

/**
 * Live mode shows the user's own data from the API and CalDAV. It is off in demo mode (mock data)
 * and when the server has no sign-in provider (an empty issuer): such an app cannot log in, the
 * route guard shows its error page, and the component tests that mount single components without
 * a server run on the mock data.
 */
export function isLiveConfig(config: ModeConfig | null | undefined): boolean {
  return config != null && config.demo !== true && (config.oidc?.issuer ?? '') !== ''
}

/** No calendars and no events; the loader fills the state once the user is signed in. */
export function emptySeed(): MockData {
  return {
    currentUser: { id: '', name: '', email: '' },
    views: [],
    calendars: [],
    resources: [],
    categories: [],
    filters: [],
    events: [],
  }
}
