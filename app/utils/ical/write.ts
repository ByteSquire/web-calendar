// Creating and editing events as iCalendar text (design §7 "Writes", §12 "Recurring edits").
// Pure functions on strings: the caller fetches the resource, passes it in with the user's changes
// and PUTs what comes back with `If-Match`. An edit changes only what the user changed: every other
// line of the resource (attendees with their parameters, alarms, X- properties, unusual rules,
// VTIMEZONEs, overrides) is kept as it was read, see write-lines.ts.
import {
  cloneComp,
  firstProp,
  insertProp,
  insertPropAfter,
  makeProp,
  props,
  removeProps,
  replaceProps,
  serializeDocument,
  subcomponents,
  rewriteProps,
  type Comp,
  type Prop,
} from './write-lines'
import { t } from '../i18n'
import { X_BOOKING, X_BOOKING_STATUS, X_RESOURCE } from './x-properties'
import {
  editRule,
  excludedIds,
  hasOccurrence,
  identityMap,
  isConsistent,
  isRecurring,
  lookupSlot,
  makeSlotMap,
  mapUntilToken,
  masterWallOf,
  overrideId,
  ruleCount,
  ruleSlotsBefore,
  seriesContext,
  startWallOf,
  transformTimeList,
  truncateSeries,
  wallInInfo,
  type SeriesContext,
  type Slot,
  type SlotMap,
} from './recurrence-edit'
import {
  EditError,
  type EditResult,
  type EditScope,
  type EventChanges,
  type NewEventResource,
  type WriteContext,
} from './write-types'
import { makeTimeProp, readTime, sameInfo, withTime, type TimeInfo } from './write-zone'
import {
  type Doc,
  type Range,
  checkContext,
  parseRange,
  checkChanges,
  checkRecurrenceId,
  nowOf,
  openDocument,
  stampOf,
  touch,
  applyScalars,
  currentRange,
  lengthOf,
  addLength,
  resolveWhen,
  writeRange,
  ensureTimezone,
} from './write-core'

export { EditError } from './write-types'
export type {
  EditErrorCode,
  EditResult,
  EditScope,
  EventChanges,
  NewEventInput,
  NewEventRecurrence,
  NewEventResource,
  WallClockRange,
  WriteContext,
} from './write-types'
export { createEventResource } from './write-create'

// ---------------------------------------------------------------------------------------------
// Series scope

/** Shifts one override with its slot: RECURRENCE-ID always, DTSTART/DTEND when it follows the slot. */
function moveOverride(
  override: Comp,
  ctx: SeriesContext,
  startWall: string,
  map: SlotMap,
  oldLength: number,
  newLength: number,
  durationChanged: boolean,
): boolean {
  const ridProp = firstProp(override, 'RECURRENCE-ID')
  const rid = ridProp ? readTime(ridProp) : null
  if (!ridProp || !rid) return false
  const oldSlot = masterWallOf(rid, ctx, startWall)
  const newSlot = map.apply(oldSlot)
  const range = currentRange(override, ctx.resolver)
  const ownStart = masterWallOf({ info: range.info, wall: range.start }, ctx, startWall)
  const ownLength = lengthOf(range)
  if (!map.identity) {
    const info = map.kindChanged ? map.newInfo : rid.info
    const wall = map.kindChanged ? newSlot : wallInInfo(newSlot, rid.info, ctx)
    replaceProps(override, 'RECURRENCE-ID', [withTime(ridProp, rid.info, info, wall)])
  }
  let modified = !map.identity
  if (map.identity && !durationChanged) return false
  // An override whose start was never moved from its slot moves with it; a custom time stays
  // (unless the kind of time changes, which resets it to the slot). One whose own time is a date
  // while the series is timed (or the reverse) is left as written.
  const sameDateness = (range.info.kind === 'date') === (ctx.info.kind === 'date')
  if (!sameDateness && !map.kindChanged) return modified
  if (ownStart === oldSlot || map.kindChanged) {
    const info = map.kindChanged ? map.newInfo : range.info
    const start = map.kindChanged ? newSlot : wallInInfo(newSlot, range.info, ctx)
    const length = ownLength === oldLength || map.kindChanged ? newLength : ownLength
    writeRange(override, info, start, addLength(info, start, length))
    modified = true
  }
  return modified
}

/**
 * Edits the whole series (or a single event). With `anchorId`, `changes.when` describes that
 * occurrence and the series moves by the same wall-clock delta; without it `when` is the new range
 * of the first occurrence.
 */
function editSeries(
  doc: Doc,
  anchorId: string | undefined,
  changes: EventChanges,
  ctx: WriteContext,
  now: Date,
): boolean {
  const master = doc.master
  if (!master)
    throw new EditError('unsupported', 'The resource has no series, only single occurrences.')
  const recurring = isRecurring(master)
  const series = seriesContext(master, doc.resolver)
  const startWall = startWallOf(master)
  const masterRange = currentRange(master, doc.resolver)
  let changed = applyScalars(master, changes)

  let map: SlotMap = identityMap(series.info)
  let newRange: { info: TimeInfo; start: string; end: string } | null = null
  const oldLength = lengthOf(masterRange)
  if (changes.when) {
    const resolved = resolveWhen(changes.when, series.info, ctx, doc.resolver)
    // The occurrence the editor was looking at, in the series' wall clock.
    let anchor: { start: string; end: string } = masterRange
    if (anchorId !== undefined && recurring) {
      const id = checkRecurrenceId(anchorId)
      const found = lookupSlot(master, series, id, excludedIds(master, series))
      if (!found || found.excluded)
        throw new EditError('unknown-instance', `No occurrence at ${id}.`)
      const override = doc.overrides.find((o) => overrideId(o, series) === id)
      if (override) {
        const own = currentRange(override, doc.resolver)
        anchor = {
          start: masterWallOf({ info: own.info, wall: own.start }, series, startWall),
          end: masterWallOf({ info: own.info, wall: own.end }, series, startWall),
        }
      } else {
        anchor = { start: found.slot.wall, end: addLength(series.info, found.slot.wall, oldLength) }
      }
    }
    const unchanged =
      sameInfo(resolved.info, series.info) &&
      resolved.start === anchor.start &&
      resolved.end === anchor.end
    if (!unchanged) {
      map = makeSlotMap(series.info, resolved.info, anchor.start, resolved.start)
      const start = map.apply(startWall)
      newRange = {
        info: resolved.info,
        start,
        end: addLength(resolved.info, start, lengthOf(resolved)),
      }
    }
  }

  const guarded =
    recurring &&
    !map.identity &&
    map.dayShift !== 0 &&
    isConsistent(master, doc.overrides, doc.resolver)
  if (newRange) {
    writeRange(master, newRange.info, newRange.start, newRange.end)
    ensureTimezone(doc.calendar, newRange.info, newRange.start)
    changed = true
  }
  if (newRange && recurring) {
    const newLength = lengthOf(newRange)
    const newZone = doc.resolver.zoneFor(newRange.info)
    if (!map.identity) {
      rewriteProps(master, 'RRULE', (prop) =>
        editRule(prop, {
          mapUntil: (token) => mapUntilToken(token, series, map, newZone),
          byDayShift: map.dayShift,
        }),
      )
      const edit = { map, newZone }
      rewriteProps(master, 'EXDATE', (prop) => transformTimeList(prop, series, startWall, edit))
      rewriteProps(master, 'RDATE', (prop) => transformTimeList(prop, series, startWall, edit))
    }
    const durationChanged = newLength !== oldLength || map.kindChanged
    for (const override of doc.overrides) {
      if (moveOverride(override, series, startWall, map, oldLength, newLength, durationChanged)) {
        touch(override, now)
      }
    }
  }
  if (guarded && !isConsistent(master, doc.overrides, doc.resolver)) throw moveRefused()
  if (changed) touch(master, now)
  return changed
}

/** A move by whole days that the recurrence rule does not follow (see `isConsistent`). */
function moveRefused(): EditError {
  return new EditError(
    'unsupported',
    t(
      'The recurrence rule does not follow a move to another day; edit single occurrences instead.',
    ),
  )
}

// ---------------------------------------------------------------------------------------------
// Instance scope

function findOverride(doc: Doc, id: string, series: SeriesContext): Comp | undefined {
  return doc.overrides.find((o) => overrideId(o, series) === id)
}

/** A new series made by a split is not what the booking was made for: it must not claim it. */
function dropBookingProps(comp: Comp): void {
  for (const name of [X_RESOURCE, X_BOOKING, X_BOOKING_STATUS]) removeProps(comp, name)
}

/** A new override for `slot`: a copy of the master without its recurrence properties. */
function buildOverride(master: Comp, slot: Slot, series: SeriesContext, doc: Doc): Comp {
  const copy = cloneComp(master)
  for (const name of ['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'RECURRENCE-ID'])
    removeProps(copy, name)
  const range = currentRange(master, doc.resolver)
  const length = lengthOf(range)
  const dtend = firstProp(copy, 'DTEND')
  writeRange(copy, series.info, slot.wall, null)
  if (dtend) {
    const endInfo = readTime(dtend)?.info ?? series.info
    const end = addLength(series.info, slot.wall, length)
    replaceProps(copy, 'DTEND', [
      withTime(dtend, endInfo, endInfo, wallInInfo(end, endInfo, series)),
    ])
  }
  insertProp(
    copy,
    makeTimeProp('RECURRENCE-ID', series.info, slot.wall),
    firstProp(copy, 'DTSTART'),
  )
  return copy
}

function insertAfterLastEvent(calendar: Comp, comp: Comp): void {
  let last = -1
  calendar.children.forEach((c, i) => {
    if (c.kind === 'comp' && c.name === 'VEVENT') last = i
  })
  calendar.children.splice(last + 1, 0, comp)
}

function editInstance(
  doc: Doc,
  recurrenceId: string,
  changes: EventChanges,
  ctx: WriteContext,
  now: Date,
): boolean {
  const id = checkRecurrenceId(recurrenceId)
  const first = doc.master ?? doc.overrides[0]
  if (!first) throw new EditError('unparseable', 'The calendar has no VEVENT.')
  const series = seriesContext(first, doc.resolver)
  let override = findOverride(doc, id, series)
  let created = false
  if (!override) {
    if (!doc.master) throw new EditError('unknown-instance', `No occurrence at ${id}.`)
    const found = lookupSlot(doc.master, series, id, excludedIds(doc.master, series))
    if (!found || found.excluded) throw new EditError('unknown-instance', `No occurrence at ${id}.`)
    override = buildOverride(doc.master, found.slot, series, doc)
    created = true
  }
  let changed = applyScalars(override, changes)
  if (changes.when) {
    const current = currentRange(override, doc.resolver)
    const resolved = resolveWhen(changes.when, current.info, ctx, doc.resolver)
    if (
      !sameInfo(resolved.info, current.info) ||
      resolved.start !== current.start ||
      resolved.end !== current.end
    ) {
      writeRange(override, resolved.info, resolved.start, resolved.end)
      ensureTimezone(doc.calendar, resolved.info, resolved.start)
      changed = true
    }
  }
  if (!changed) return false
  touch(override, now)
  if (created) insertAfterLastEvent(doc.calendar, override)
  return true
}

// ---------------------------------------------------------------------------------------------
// This and following

function editThisAndFollowing(
  doc: Doc,
  recurrenceId: string,
  changes: EventChanges,
  ctx: WriteContext,
  now: Date,
): { changed: boolean; created: NewEventResource | null } {
  const master = doc.master!
  const id = checkRecurrenceId(recurrenceId)
  const series = seriesContext(master, doc.resolver)
  const startWall = startWallOf(master)
  const found = lookupSlot(master, series, id, excludedIds(master, series))
  if (!found || found.excluded) throw new EditError('unknown-instance', `No occurrence at ${id}.`)
  // Nothing before the slot: the whole series is meant.
  if (!found.hasEarlierOccurrence) {
    return { changed: editSeries(doc, id, changes, ctx, now), created: null }
  }

  const slot = found.slot
  const masterRange = currentRange(master, doc.resolver)
  const oldLength = lengthOf(masterRange)
  const target = findOverride(doc, id, series)
  let anchor = { start: slot.wall, end: addLength(series.info, slot.wall, oldLength) }
  if (target) {
    const own = currentRange(target, doc.resolver)
    anchor = {
      start: masterWallOf({ info: own.info, wall: own.start }, series, startWall),
      end: masterWallOf({ info: own.info, wall: own.end }, series, startWall),
    }
  }
  let map: SlotMap = identityMap(series.info)
  let resolved: Range | null = null
  if (changes.when) {
    const candidate = resolveWhen(changes.when, series.info, ctx, doc.resolver)
    const unchanged =
      sameInfo(candidate.info, series.info) &&
      candidate.start === anchor.start &&
      candidate.end === anchor.end
    if (!unchanged) {
      resolved = candidate
      map = makeSlotMap(series.info, candidate.info, anchor.start, candidate.start)
    }
  }
  // Nothing to change, nothing to split.
  if (!resolved && !applyScalars(cloneComp(master), changes)) {
    return { changed: false, created: null }
  }
  const guarded =
    !map.identity && map.dayShift !== 0 && isConsistent(master, doc.overrides, doc.resolver)
  const newInfo = map.newInfo
  const newLength = resolved ? lengthOf(resolved) : oldLength
  const newStart = map.apply(slot.wall)
  const newZone = doc.resolver.zoneFor(newInfo)

  // The new series, from a copy of the master as it was.
  const uid = globalThis.crypto.randomUUID()
  const successor = cloneComp(master)
  replaceProps(successor, 'UID', [makeProp('UID', [], uid)])
  dropBookingProps(successor)
  writeRange(
    successor,
    newInfo,
    newStart,
    resolved || firstProp(master, 'DTEND') ? addLength(newInfo, newStart, newLength) : null,
  )
  const sourceRules = props(master, 'RRULE')
  const targetRules = props(successor, 'RRULE')
  targetRules.forEach((rule, index) => {
    const source = sourceRules[index]!
    const count = ruleCount(source)
    const edit: Parameters<typeof editRule>[1] = {}
    if (!map.identity) {
      edit.mapUntil = (token) => mapUntilToken(token, series, map, newZone)
      edit.byDayShift = map.dayShift
    }
    if (count !== null) {
      const remaining = count - ruleSlotsBefore(master, series, source, slot.wall)
      if (remaining <= 0) {
        removeRule(successor, rule)
        return
      }
      edit.count = remaining
    }
    rewriteProps(successor, 'RRULE', (prop) => (prop === rule ? editRule(prop, edit) : prop))
  })
  const fromSlot = (_wall: string, slotId: string): boolean => slotId >= slot.id
  const listEdit = { keep: fromSlot, map, newZone }
  rewriteProps(successor, 'EXDATE', (prop) => transformTimeList(prop, series, startWall, listEdit))
  rewriteProps(successor, 'RDATE', (prop) => transformTimeList(prop, series, startWall, listEdit))
  applyScalars(successor, changes)
  replaceProps(successor, 'CREATED', [makeProp('CREATED', [], stampOf(now))])
  touch(successor, now, true)

  // The overrides from the slot on move with it; the one at the slot gets the edit as well.
  const moved: Comp[] = []
  for (const override of doc.overrides) {
    const overrideSlot = overrideId(override, series)
    if (overrideSlot === null || overrideSlot < slot.id) continue
    const copy = cloneComp(override)
    replaceProps(copy, 'UID', [makeProp('UID', [], uid)])
    dropBookingProps(copy)
    moveOverride(
      copy,
      series,
      startWall,
      map,
      oldLength,
      newLength,
      newLength !== oldLength || map.kindChanged,
    )
    if (overrideSlot === slot.id) {
      applyScalars(copy, changes)
      if (resolved && changes.when) {
        const own = resolveWhen(
          changes.when,
          currentRange(copy, doc.resolver).info,
          ctx,
          doc.resolver,
        )
        writeRange(copy, own.info, own.start, own.end)
      }
    }
    touch(copy, now, true)
    moved.push(copy)
  }

  if (guarded && !isConsistent(successor, moved, doc.resolver)) throw moveRefused()

  // The original series ends before the slot and loses what moved.
  truncateSeries(master, slot, series)
  const leaving = doc.overrides.filter((o) => isMoved(o, series, slot))
  doc.calendar.children = doc.calendar.children.filter(
    (c) => !(c.kind === 'comp' && leaving.includes(c)),
  )
  touch(master, now)

  // The new resource: the calendar's own properties and VTIMEZONEs, the new master, its overrides.
  const calendar = cloneComp(doc.calendar)
  calendar.children = [
    ...calendar.children.filter(
      (c) => c.kind === 'prop' || (c.kind === 'comp' && c.name === 'VTIMEZONE'),
    ),
    successor,
    ...moved,
  ]
  ensureTimezone(calendar, newInfo, newStart)
  const root: Comp = { kind: 'comp', name: '', beginRaw: '', endRaw: '', children: [calendar] }
  return { changed: true, created: { uid, ics: serializeDocument(root) } }
}

function isMoved(override: Comp, series: SeriesContext, slot: Slot): boolean {
  const id = overrideId(override, series)
  return id !== null && id >= slot.id
}

function removeRule(comp: Comp, rule: Prop): void {
  comp.children = comp.children.filter((c) => c !== rule)
}

// ---------------------------------------------------------------------------------------------
// Public: edit

/**
 * Applies `changes` to the resource `ics` and returns its new text. `scope` says which part of a
 * recurring event the change is about (a single event is always its own series). `created` is set
 * when "this and following" split the series: that text is a new resource with a new UID.
 *
 * Throws `EditError` (`invalid-input`, `unknown-instance`, `unparseable`, `unsupported`).
 */
export function editEventResource(
  ics: string,
  scope: EditScope,
  changes: EventChanges,
  ctx: WriteContext,
): EditResult {
  checkContext(ctx)
  checkChanges(changes)
  if (changes.when) parseRange(changes.when)
  const doc = openDocument(ics, ctx)
  const now = nowOf(ctx)
  const recurring = !!doc.master && isRecurring(doc.master)

  let changed: boolean
  let created: NewEventResource | null = null
  if (!doc.master) {
    if (scope.kind === 'series') {
      throw new EditError(
        'unsupported',
        'The resource has single occurrences but no series to edit.',
      )
    }
    changed = editInstance(doc, scope.recurrenceId, changes, ctx, now)
  } else if (!recurring || scope.kind === 'series') {
    changed = editSeries(
      doc,
      scope.kind === 'series' ? scope.recurrenceId : undefined,
      changes,
      ctx,
      now,
    )
  } else if (scope.kind === 'instance') {
    changed = editInstance(doc, scope.recurrenceId, changes, ctx, now)
  } else {
    const result = editThisAndFollowing(doc, scope.recurrenceId, changes, ctx, now)
    changed = result.changed
    created = result.created
  }
  if (!changed) return { updated: ics, created: null }
  return { updated: serializeDocument(doc.root), created }
}

// ---------------------------------------------------------------------------------------------
// Public: delete

/**
 * Removes part of an event. `updated` is the new text of the resource, or null when nothing is left
 * of it (delete the resource): a single event, a whole series, a series cut at its first occurrence
 * or emptied.
 */
export function deleteFromEventResource(
  ics: string,
  scope: EditScope,
  ctx: WriteContext,
): { updated: string | null } {
  checkContext(ctx)
  const doc = openDocument(ics, ctx)
  const now = nowOf(ctx)
  const master = doc.master
  if (scope.kind === 'series') return { updated: null }

  if (!master) {
    const id = checkRecurrenceId(scope.recurrenceId)
    const series = seriesContext(doc.overrides[0]!, doc.resolver)
    const override = findOverride(doc, id, series)
    if (!override) throw new EditError('unknown-instance', `No occurrence at ${id}.`)
    doc.calendar.children = doc.calendar.children.filter((c) => c !== override)
    return {
      updated:
        subcomponents(doc.calendar, 'VEVENT').length === 0 ? null : serializeDocument(doc.root),
    }
  }
  if (!isRecurring(master)) return { updated: null }

  const id = checkRecurrenceId(scope.recurrenceId)
  const series = seriesContext(master, doc.resolver)
  const excluded = excludedIds(master, series)
  const found = lookupSlot(master, series, id, excluded)
  const override = findOverride(doc, id, series)

  if (scope.kind === 'instance') {
    if ((!found || found.excluded) && !override) {
      throw new EditError('unknown-instance', `No occurrence at ${id}.`)
    }
    if (override) doc.calendar.children = doc.calendar.children.filter((c) => c !== override)
    if (found && !found.excluded) {
      const exdate = makeTimeProp('EXDATE', series.info, found.slot.wall)
      const anchor = [
        ...props(master, 'EXDATE'),
        ...props(master, 'RRULE'),
        ...props(master, 'RDATE'),
      ].pop()
      insertPropAfter(master, exdate, anchor ?? firstProp(master, 'DTSTART'))
      excluded.add(id)
      touch(master, now)
    }
    if (!hasOccurrence(master, series, excluded)) return { updated: null }
    return { updated: serializeDocument(doc.root) }
  }

  if (!found || found.excluded) throw new EditError('unknown-instance', `No occurrence at ${id}.`)
  if (!found.hasEarlierOccurrence) return { updated: null }
  truncateSeries(master, found.slot, series)
  doc.calendar.children = doc.calendar.children.filter(
    (c) => !(c.kind === 'comp' && doc.overrides.includes(c) && isMoved(c, series, found.slot)),
  )
  touch(master, now)
  return { updated: serializeDocument(doc.root) }
}
