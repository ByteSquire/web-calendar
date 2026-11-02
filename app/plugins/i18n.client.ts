import { browserStore } from '~/utils/browser-store'
import { initLanguage } from '~/utils/i18n'

// The language is known before the first screen is drawn: the saved choice, else the browser's
// (app/utils/i18n.ts). `pre` puts it before the plugins whose texts could come up while they start.
export default defineNuxtPlugin({
  name: 'i18n',
  enforce: 'pre',
  setup() {
    initLanguage(browserStore(), navigator.languages ?? [navigator.language])
  },
})
