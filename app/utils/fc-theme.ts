// FullCalendar's classic theme for markup the app draws itself (the split view with calendars as
// columns), so it looks like the calendars beside it: the theme is a plugin whose defaults are
// FullCalendar's documented class-name options (`dayCellClass`, `blockEventClass`, ...), as strings
// or as functions of what is drawn. The classes come with the theme's stylesheet, its print rules
// included. Should a later version drop an option, the name gives no class and the app's own rules
// for the table (SplitColumns.vue) still lay it out.
import classicTheme from '@fullcalendar/vue3/themes/classic'

type ClassOption = string | ((info: Record<string, unknown>) => string | false | null | undefined)

const defaults =
  (classicTheme as unknown as { optionDefaults?: Record<string, unknown> }).optionDefaults ?? {}

/** The classes the classic theme gives the option `name` for `info`; empty if it has none. */
export function themeClass(name: string, info: Record<string, unknown> = {}): string {
  const option = defaults[name] as ClassOption | undefined
  if (typeof option === 'string') return option
  if (typeof option === 'function') return option(info) || ''
  return ''
}
