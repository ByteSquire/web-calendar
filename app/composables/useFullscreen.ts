import { onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '~/utils/i18n'

/**
 * Full screen for the whole page (the Fullscreen API). On a phone it hides the address bar and
 * the status bar until the person swipes down from the top edge or goes Back. `supported` is
 * false where the browser has no full screen for pages, as on iPhone Safari.
 */
export function useFullscreen() {
  const supported = ref(false)
  const active = ref(false)
  const toast = useToast()

  function update() {
    supported.value = Boolean(document.fullscreenEnabled)
    active.value = document.fullscreenElement !== null
  }

  onMounted(() => {
    update()
    document.addEventListener('fullscreenchange', update)
  })
  onBeforeUnmount(() => document.removeEventListener('fullscreenchange', update))

  /** Needs the transient activation of a tap or click: call it from the handler of one. */
  async function toggle() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    } catch (cause) {
      console.error('Full screen failed', cause)
      toast.add({
        title: t('Full screen is not available'),
        color: 'error',
        icon: 'i-lucide-triangle-alert',
      })
    }
  }

  return { supported, active, toggle }
}
