import { setAccessPorts } from '../utils/access/ports'
import { requestSharingReconcile } from '../utils/sharing'

// After the access administration changes the rules of a calendar, Radicale's shares follow soon.
// requestSharingReconcile does nothing while the sharing writer is off (demo mode, no Radicale).
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  setAccessPorts({ onAclChanged: () => requestSharingReconcile() })
  nitroApp.hooks.hook('close', () => setAccessPorts(undefined))
})
