// From a picked file to what the person is shown before importing it (FR-7, importing a file): the
// file is checked, read, split into events (utils/ical/split.ts) and described in a few counts. The
// file is untrusted, so everything that is echoed from it (its name, the calendar name, event
// titles) goes through `displayText`: control characters and the characters that reorder or hide
// text are removed and the length is capped. The UI shows the result through text bindings only.
import {
  splitCalendar,
  type SkippedComponent,
  type SkipReason,
  type SplitResource,
} from '../ical/split'
import { N_, t, tc, tv } from '~/utils/i18n'
import { checkFile, looksBinary, MAX_EVENTS, SNIFF_BYTES, type PickedFile } from './limits'

/** Shown for an event that has no title. */
export const NO_TITLE = N_('(no title)')

// C0 and C1 controls, line and paragraph separators, byte order mark and the bidirectional
// controls (embeddings, overrides, isolates, marks): none of them has a place in a title.
const UNSAFE = /[\p{Cc}\u2028\u2029\uFEFF\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu

/**
 * Text from a file, made fit to be shown on one line: unsafe characters become spaces, runs of
 * white space one space, and anything longer than `max` characters ends in an ellipsis. Empty when
 * nothing is left.
 */
export function displayText(value: string, max = 120): string {
  // Cut first: the value can be as long as the file.
  const clean = value
    .slice(0, max * 4)
    .normalize('NFC')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const characters = Array.from(clean)
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : clean
}

export interface SkippedGroup {
  /** For example `2 to-dos (only events are imported)`. */
  text: string
  count: number
}

export interface ImportPreview {
  fileName: string
  /** The calendar's name in the file, when it has one. */
  calendarName: string | null
  /** How many events are imported: one per UID, a series and its changed occurrences count once. */
  events: number
  /** The titles of the first few events. */
  sample: string[]
  skipped: SkippedGroup[]
  skippedCount: number
}

export interface ImportPlan {
  resources: SplitResource[]
  preview: ImportPreview
}

export type PrepareResult = { ok: true; plan: ImportPlan } | { ok: false; message: string }

const SAMPLE_SIZE = 5

const NOT_EVENTS = new Set(['VTODO', 'VJOURNAL', 'VFREEBUSY'])

/** The words for a number of skipped components of one kind. */
function skipText(reason: SkipReason, component: string, count: number): string {
  switch (reason) {
    case 'not-an-event': {
      switch (component) {
        case 'VTODO':
          return tc(
            '{count} to-do (only events are imported) | {count} to-dos (only events are imported)',
            count,
          )
        case 'VJOURNAL':
          return tc(
            '{count} journal entry (only events are imported) | {count} journal entries (only events are imported)',
            count,
          )
        case 'VFREEBUSY':
          return tc(
            '{count} free/busy block (only events are imported) | {count} free/busy blocks (only events are imported)',
            count,
          )
        default:
          return tc(
            '{count} other item (only events are imported) | {count} other items (only events are imported)',
            count,
          )
      }
    }
    case 'no-start':
      return tc('{count} event without a start time | {count} events without a start time', count)
    case 'damaged':
      return tc(
        '{count} damaged item that could not be read | {count} damaged items that could not be read',
        count,
      )
    case 'duplicate':
      return tc(
        '{count} repeated event (the same ID as an earlier one in the file) | {count} repeated events (the same ID as an earlier one in the file)',
        count,
      )
  }
}

/** One line per kind of skipped component, with its count. */
function groupSkipped(skipped: readonly SkippedComponent[]): SkippedGroup[] {
  const groups = new Map<string, { reason: SkipReason; component: string; count: number }>()
  for (const item of skipped) {
    // Only "not an event" depends on what the component is; unknown kinds are one group.
    const component = NOT_EVENTS.has(item.component) ? item.component : ''
    const key = item.reason === 'not-an-event' ? `${item.reason}:${component}` : item.reason
    const group = groups.get(key) ?? { reason: item.reason, component, count: 0 }
    group.count += 1
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({
    text: skipText(group.reason, group.component, group.count),
    count: group.count,
  }))
}

/** The title of an event as it is shown. */
export function titleOf(summary: string): string {
  return displayText(summary) || tv(NO_TITLE)
}

/** The plan for a file's text, or the words for why it cannot be imported. Pure. */
export async function planImport(fileName: string, text: string): Promise<PrepareResult> {
  const split = await splitCalendar(text)
  if (split.problem === 'not-icalendar') {
    return { ok: false, message: t('This is not an iCalendar (.ics) file.') }
  }
  if (split.problem === 'unsupported-version') {
    return {
      ok: false,
      message: t(
        'This file is in an old calendar format (vCalendar 1.0), which cannot be imported.',
      ),
    }
  }
  if (split.resources.length > MAX_EVENTS) {
    return {
      ok: false,
      message: t(
        'The file has {count} events, more than the {max} that can be imported at once. Split the calendar into smaller files.',
        { count: split.resources.length, max: MAX_EVENTS },
      ),
    }
  }
  const skipped = groupSkipped(split.skipped)
  return {
    ok: true,
    plan: {
      resources: split.resources,
      preview: {
        fileName: displayText(fileName, 80) || t('Calendar file'),
        calendarName: displayText(split.calendarName ?? '') || null,
        events: split.resources.length,
        sample: split.resources.slice(0, SAMPLE_SIZE).map((resource) => titleOf(resource.summary)),
        skipped,
        skippedCount: split.skipped.length,
      },
    },
  }
}

/**
 * Checks a picked file, reads it and plans the import. A file that is too large or no calendar
 * is refused without being read; a binary one after its first bytes. Never throws.
 */
export async function prepareImport(file: PickedFile & Blob): Promise<PrepareResult> {
  const refusal = checkFile(file)
  if (refusal) return { ok: false, message: refusal }
  try {
    if (looksBinary(await file.slice(0, SNIFF_BYTES).text())) {
      return {
        ok: false,
        message: t('This is not a text file. Choose an .ics file saved as UTF-8 text.'),
      }
    }
    return await planImport(file.name, await file.text())
  } catch {
    return { ok: false, message: t('The file could not be read.') }
  }
}
