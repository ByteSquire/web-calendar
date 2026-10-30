// Class names the settings screen uses where the stock Nuxt UI colours miss WCAG AA (4.5:1) in the
// light scheme: its error, success and warning text is the 500 shade (red-500 on white is 3.8:1).
// The 700 shades below pass on the page background and on cards, and the dark scheme keeps the
// lighter 400 shades. Until app.config.ts or main.css fix the tokens for the whole app (as
// main.css already does for the primary colour), the settings screen applies them itself.

/** Text for a problem or a failed check. */
export const ERROR_TEXT = 'text-red-700 dark:text-red-400'

/** Text for something that worked. */
export const SUCCESS_TEXT = 'text-green-700 dark:text-green-400'

/** For `UFormField :ui`: the message under an input. */
export const FIELD_UI = { error: `mt-2 ${ERROR_TEXT}` }

/** For `UAlert color="error" variant="outline" :ui`. */
export const ERROR_ALERT_UI = {
  root: 'text-red-800 ring-red-300 dark:text-red-200 dark:ring-red-800',
}
