import { trackInputKind } from '~/utils/focus'

// What opened a dialog (a tap, the keyboard) decides whether it focuses a field (utils/focus.ts).
export default defineNuxtPlugin(() => {
  trackInputKind()
})
