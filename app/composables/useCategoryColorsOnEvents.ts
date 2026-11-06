// "Category colours on events" (the ⋮ menu): whether each entry shows a dot in the colour of every
// category it has, so categories work as coloured tags. It is a look of the calendar, like dark
// mode, so it is kept in this browser (localStorage) and is off until chosen.
import { browserStore } from '~/utils/browser-store'

export const CATEGORY_COLORS_KEY = 'web-calendar:category-colours'

function stored(): boolean {
  try {
    return browserStore()?.getItem(CATEGORY_COLORS_KEY) === 'on'
  } catch {
    return false
  }
}

export function useCategoryColorsOnEvents() {
  const shown = useState<boolean>('category-colours-on-events', stored)

  function set(value: boolean) {
    shown.value = value
    try {
      browserStore()?.setItem(CATEGORY_COLORS_KEY, value ? 'on' : 'off')
    } catch {
      // Storage may be full or blocked: the choice still holds for this visit.
    }
  }

  return { shown, set }
}
