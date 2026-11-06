// A category turned into a status, or taken away, in one resource: every event of it (a single
// event, a series and its changed occurrences) that has the category gets that STATUS, which every
// calendar app understands, and loses the category when asked; without a status it only loses the
// category (deleting a category). For people whose old system had "Tentative" or "Confirmed" as a
// category. Names compare as the app compares categories: trimmed, without regard
// to case. Everything else in the resource stays as it was (the same lossless writer as an edit).
import type { EventStatusValue, WriteContext } from './write-types'
import { applyScalars, openDocument, touch } from './write-core'
import { props, rawValue, serializeDocument, splitTextList, type Comp } from './write-lines'

const keyOf = (name: string) => name.trim().toLowerCase()

function categoriesOf(comp: Comp): string[] {
  return props(comp, 'CATEGORIES')
    .flatMap((prop) => splitTextList(rawValue(prop)))
    .map((name) => name.trim())
    .filter(Boolean)
}

function eventsOf(ics: string, ctx: WriteContext): { root: Comp; events: Comp[] } {
  const doc = openDocument(ics, ctx)
  return {
    root: doc.root,
    events: [...(doc.master ? [doc.master] : []), ...doc.overrides],
  }
}

/** Whether an event of the resource has the category (exactly the name, in any letter case). */
export function hasCategory(ics: string, name: string, ctx: WriteContext): boolean {
  const key = keyOf(name)
  return eventsOf(ics, ctx).events.some((comp) =>
    categoriesOf(comp).some((category) => keyOf(category) === key),
  )
}

/**
 * The resource with `status` on every event that has the category (none when null), and the
 * category gone from them when `removeCategory`. Null when no event has it, or when nothing would
 * change. Throws `EditError` (`unparseable`) for a text that is no event.
 */
export function categoryToStatus(
  ics: string,
  name: string,
  status: EventStatusValue | null,
  options: { removeCategory: boolean },
  ctx: WriteContext,
): string | null {
  const key = keyOf(name)
  const { root, events } = eventsOf(ics, ctx)
  const now = ctx.now ?? new Date()
  let changed = false
  for (const comp of events) {
    const categories = categoriesOf(comp)
    if (!categories.some((category) => keyOf(category) === key)) continue
    const kept = categories.filter((category) => keyOf(category) !== key)
    const touched = applyScalars(comp, {
      ...(status ? { status } : {}),
      ...(options.removeCategory ? { categoryNames: kept } : {}),
    })
    if (touched) {
      touch(comp, now)
      changed = true
    }
  }
  return changed ? serializeDocument(root) : null
}
