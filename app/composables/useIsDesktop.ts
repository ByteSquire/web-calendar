import { onBeforeUnmount, onMounted, ref } from 'vue'
import { DESKTOP_MEDIA_QUERY, matchesDesktop } from '~/utils/viewport'

/** Reactive "viewport is at least 768 px wide"; the same breakpoint main.css uses. */
export function useIsDesktop() {
  const isDesktop = ref(matchesDesktop())
  let query: MediaQueryList | undefined

  const update = (event: MediaQueryListEvent) => {
    isDesktop.value = event.matches
  }

  onMounted(() => {
    query = window.matchMedia(DESKTOP_MEDIA_QUERY)
    isDesktop.value = query.matches
    query.addEventListener('change', update)
  })

  onBeforeUnmount(() => query?.removeEventListener('change', update))

  return isDesktop
}
