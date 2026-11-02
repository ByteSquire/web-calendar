// German texts of the area "data" (docs/i18n.md). One entry per English text: 'English': 'Deutsch'.
export const data: Readonly<Record<string, string>> = {
  'Unknown time zone: {zone}': 'Unbekannte Zeitzone: {zone}',
  'The start is not a date or date-time: {value}':
    'Der Beginn ist kein gültiges Datum (mit oder ohne Uhrzeit): {value}',
  'The end is not a date or date-time: {value}':
    'Das Ende ist kein gültiges Datum (mit oder ohne Uhrzeit): {value}',
  'The end of the series is not a date or date-time: {value}':
    'Das Ende der Serie ist kein gültiges Datum (mit oder ohne Uhrzeit): {value}',
  'The start is not a valid date or time: {value}':
    'Der Beginn ist kein gültiges Datum oder keine gültige Uhrzeit: {value}',
  'The end is not a valid date or time: {value}':
    'Das Ende ist kein gültiges Datum oder keine gültige Uhrzeit: {value}',
  'The end of the series is not a valid date or time: {value}':
    'Das Ende der Serie ist kein gültiges Datum oder keine gültige Uhrzeit: {value}',
  'The time zone {tzid} is not an IANA zone and the calendar has no usable VTIMEZONE for it.':
    'Die Zeitzone {tzid} ist keine IANA-Zone und der Kalender enthält dafür keine brauchbare VTIMEZONE.',
  'The display time zone is not a time zone: {zone}':
    'Die Anzeige-Zeitzone ist keine Zeitzone: {zone}',
  'The organisation time zone is not a time zone: {zone}':
    'Die Zeitzone der Organisation ist keine Zeitzone: {zone}',
  'An all-day event needs dates, not times.':
    'Ein ganztägiger Termin braucht Daten, keine Uhrzeiten.',
  'An all-day event ends (exclusive) after the day it starts.':
    'Ein ganztägiger Termin endet (exklusiv) nach dem Tag, an dem er beginnt.',
  'A timed event needs a start and an end time.': 'Ein Termin mit Uhrzeit braucht Beginn und Ende.',
  'The event ends before it starts.': 'Der Termin endet, bevor er beginnt.',
  'The title is empty.': 'Der Titel ist leer.',
  'Unknown status: {status}': 'Unbekannter Status: {status}',
  'The recurrence id is not a date or a UTC instant: {id}':
    'Die Wiederholungs-ID ist kein Datum und kein UTC-Zeitpunkt: {id}',
  'The recurrence rule does not follow a move to another day; edit single occurrences instead.':
    'Die Wiederholungsregel folgt einer Verschiebung auf einen anderen Tag nicht; bearbeite stattdessen einzelne Termine.',
  'Unknown frequency: {freq}': 'Unbekannte Häufigkeit: {freq}',
  'The interval must be a whole number of 1 or more: {value}':
    'Das Intervall muss eine ganze Zahl ab 1 sein: {value}',
  'A month must be 1 to 12: {value}': 'Ein Monat muss zwischen 1 und 12 liegen: {value}',
  'Not a weekday: {day}': 'Kein Wochentag: {day}',
  'A numbered weekday ({day}) needs a monthly or yearly rule.':
    'Ein nummerierter Wochentag ({day}) braucht eine monatliche oder jährliche Regel.',
  'BYSETPOS needs another BY part (a weekday, day of month or month).':
    'BYSETPOS braucht einen weiteren BY-Teil (Wochentag, Tag im Monat oder Monat).',
  'A rule has a count or an end date, not both.':
    'Eine Regel hat eine Anzahl oder ein Enddatum, nicht beides.',
  'The count must be a whole number of 1 or more: {value}':
    'Die Anzahl muss eine ganze Zahl ab 1 sein: {value}',
  'Days of the month must be whole numbers from {min} to {max} (or negative): {value}':
    'Tage im Monat müssen ganze Zahlen von {min} bis {max} sein (oder negativ): {value}',
  'Set positions must be whole numbers from {min} to {max} (or negative): {value}':
    'Positionen müssen ganze Zahlen von {min} bis {max} sein (oder negativ): {value}',
  'The series ends before it starts.': 'Die Serie endet, bevor sie beginnt.',
}
