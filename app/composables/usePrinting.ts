// Printing (design §9). FullCalendar's adaptive plugin lays the calendar out for paper between the
// browser's `beforeprint` and `afterprint`; main.css leaves only the calendar and the period it
// shows. Paper is light, so for that time the page uses the light scheme too: the scheme in use
// changes, the person's choice (the stored preference) does not. plugins/print.client.ts follows
// the browser's events, for its own Print command and for the ⋮ menu's (`print()`).
//
// Firefox copies the page for paper straight after `beforeprint`, before anything waiting for a
// microtask runs, and that includes every update Vue makes. So everything the printout needs is
// drawn during the event: the class of the scheme here, the calendars' options through
// `onPrintChange`, and the content of their entries by FullCalendar itself (not Vue slots).
import { onBeforeUnmount, readonly } from 'vue'
import { t } from '~/utils/i18n'

/** The scheme in use before printing, put back afterwards. */
let before: { value: string; forced: boolean } | null = null

/** The colour mode module shows the scheme as a class on the root element (`dark`, `light`). */
function showScheme(from: string, to: string) {
  const root = document.documentElement.classList
  root.remove(from)
  root.add(to)
}

export function usePrinting() {
  const printing = useState<boolean>('printing', () => false)
  // `value` is read-only in the colour mode module's types; the module writes it the same way for a
  // page that forces a scheme, and `forced` keeps the system's scheme from replacing it meanwhile.
  const colorMode: { value: string; forced: boolean } = useColorMode()
  const toast = useToast()

  function begin() {
    if (printing.value) return
    printing.value = true
    before = { value: colorMode.value, forced: colorMode.forced }
    colorMode.forced = true
    colorMode.value = 'light'
    // The module moves the class on its next update, too late for Firefox's copy.
    showScheme(before.value, 'light')
  }

  function end() {
    if (!printing.value) return
    printing.value = false
    if (before) {
      colorMode.forced = before.forced
      colorMode.value = before.value
      showScheme('light', before.value)
      before = null
    }
  }

  function print() {
    try {
      window.print()
    } catch (cause) {
      console.error('Printing failed', cause)
      // Back to the screen, for the calendars too: their print layout ends with this event.
      window.dispatchEvent(new Event('afterprint'))
      toast.add({
        title: t('Printing is not available'),
        color: 'error',
        icon: 'i-lucide-triangle-alert',
      })
    }
  }

  return { printing: readonly(printing), begin, end, print }
}

/**
 * Runs `apply` during the browser's `beforeprint` (`true`) and `afterprint` (`false`), so a calendar
 * takes its options for paper, and back, at once instead of with Vue's next update. Back matters
 * too: the menu's `window.print()` can run both events before Vue updates at all, and then the
 * options look unchanged to Vue. It runs after the plugin's listener (added at start-up; listeners
 * run in the order they were added), so the scheme is already switched.
 */
export function onPrintChange(apply: (printing: boolean) => void) {
  const before = () => apply(true)
  const after = () => apply(false)
  window.addEventListener('beforeprint', before)
  window.addEventListener('afterprint', after)
  onBeforeUnmount(() => {
    window.removeEventListener('beforeprint', before)
    window.removeEventListener('afterprint', after)
  })
}
