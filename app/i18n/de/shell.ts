// German texts of the area "shell" (docs/i18n.md). One entry per English text: 'English': 'Deutsch'.
export const shell: Readonly<Record<string, string>> = {
  // Views and date navigation
  Day: 'Tag',
  '5 days': '5 Tage',
  Week: 'Woche',
  Month: 'Monat',
  Year: 'Jahr',
  Split: 'Aufgeteilt',
  List: 'Liste',
  Today: 'Heute',
  'Date navigation': 'Datumsnavigation',
  'Skip to main content': 'Zum Hauptinhalt springen',
  'Page not found': 'Seite nicht gefunden',
  'This address does not exist in Web Calendar.': 'Diese Adresse gibt es in Web Calendar nicht.',
  'Something went wrong': 'Etwas ist schiefgegangen',
  'Something went wrong. Try again; if it keeps happening, ask an administrator.':
    'Etwas ist schiefgegangen. Versuche es erneut; wenn es bleibt, frag einen Administrator.',
  'View type': 'Ansichtstyp',
  Period: 'Zeitraum',
  'Custom range': 'Eigener Zeitraum',
  'Swap rows and columns': 'Zeilen und Spalten tauschen',
  Date: 'Datum',
  From: 'Von',
  To: 'Bis',
  'Choose at most {count} days.': 'Wähle höchstens {count} Tage.',
  Calendars: 'Kalender',
  'Calendar, {range}': 'Kalender, {range}',
  'Split view, {range}': 'Aufgeteilte Ansicht, {range}',
  'No events for the selected calendars in this period':
    'Keine Termine für die gewählten Kalender in diesem Zeitraum',
  'Select more calendars in the sidebar, change the filters or move to another date.':
    'Wähle in der Seitenleiste weitere Kalender, ändere die Filter oder gehe zu einem anderen Datum.',
  'Loading calendars': 'Kalender werden geladen',

  // Top bar and menus
  'Close sidebar': 'Seitenleiste schließen',
  'Open sidebar': 'Seitenleiste öffnen',
  Add: 'Hinzufügen',
  'More options': 'Weitere Optionen',
  Refresh: 'Aktualisieren',
  'Full screen': 'Vollbild',
  'Exit full screen': 'Vollbild beenden',
  'Full screen is not available': 'Vollbild ist nicht verfügbar',
  Print: 'Drucken',
  'Printing is not available': 'Drucken ist nicht verfügbar',
  'Dark mode': 'Dunkelmodus',
  'Follow system': 'System folgen',
  Help: 'Hilfe',
  'Sign out': 'Abmelden',
  'Signed in': 'Angemeldet',
  'Signing out failed': 'Abmelden fehlgeschlagen',
  'Times in {zone}': 'Zeiten in {zone}',
  'Organization time: {zone}': 'Zeit der Organisation: {zone}',
  'Not available in the mock-up yet.': 'Im Entwurf noch nicht verfügbar.',

  // Sidebar
  'Views and calendars': 'Ansichten und Kalender',
  'Choose views, calendars, resources, categories and filters':
    'Wähle Ansichten, Kalender, Ressourcen, Kategorien und Filter',
  'Actions for view {name}': 'Aktionen für Ansicht {name}',
  'Copy to my views': 'In meine Ansichten kopieren',
  'Update from selection': 'Aus Auswahl aktualisieren',
  Unshare: 'Teilen beenden',
  'Share with everybody': 'Mit allen teilen',
  'Add view': 'Ansicht hinzufügen',
  'New calendar name': 'Name des neuen Kalenders',
  'A calendar with this name already exists.': 'Ein Kalender mit diesem Namen gibt es schon.',
  'New category name': 'Name der neuen Kategorie',
  'Add category': 'Kategorie hinzufügen',
  'Add filter': 'Filter hinzufügen',
  'Arrange sections': 'Bereiche anordnen',
  'Move a section up or down. The order is saved for your account.':
    'Verschiebe einen Bereich nach oben oder nach unten. Die Reihenfolge wird in deinem Konto gespeichert.',
  'Move {name} up': '{name} nach oben verschieben',
  'Move {name} down': '{name} nach unten verschieben',
  '{name}: number {position} of {total}': '{name}: Platz {position} von {total}',
  'save the order of the sections': 'Das Speichern der Reihenfolge der Bereiche',
  'The shared view disappears for everybody.': 'Die geteilte Ansicht verschwindet für alle.',
  'Only this view is deleted; the calendars stay.':
    'Nur diese Ansicht wird gelöscht; die Kalender bleiben.',
  '(copy)': '(Kopie)',
  '(copy {number})': '(Kopie {number})',

  // The view dialog
  'Edit view {name}': 'Ansicht {name} bearbeiten',
  'Edit shared view {name}': 'Geteilte Ansicht {name} bearbeiten',
  'Everybody sees this view. Selecting it shows the calendars chosen here.':
    'Alle sehen diese Ansicht. Wählst du sie aus, zeigt sie die hier gewählten Kalender.',
  'Only you see this view. Selecting it shows the calendars chosen here.':
    'Nur du siehst diese Ansicht. Wählst du sie aus, zeigt sie die hier gewählten Kalender.',
  'Choose all': 'Alle auswählen',
  'Choose none': 'Keinen auswählen',
  'There are no calendars to choose from.': 'Es gibt keine Kalender zur Auswahl.',
  'One more calendar of this view is not listed, as you cannot see it here; it stays in the view. | {count} more calendars of this view are not listed, as you cannot see them here; they stay in the view.':
    'Ein weiterer Kalender dieser Ansicht ist nicht aufgeführt, da du ihn hier nicht sehen kannst; er bleibt in der Ansicht. | {count} weitere Kalender dieser Ansicht sind nicht aufgeführt, da du sie hier nicht sehen kannst; sie bleiben in der Ansicht.',
  'Choose at least one calendar.': 'Wähle mindestens einen Kalender aus.',
  'Use at most {count} characters.': 'Verwende höchstens {count} Zeichen.',
  'Choose at least one calendar first.': 'Wähle zuerst mindestens einen Kalender aus.',

  // The filter dialog
  'Filters narrow down the events shown. Switch a filter on in the list to use it.':
    'Filter grenzen die gezeigten Termine ein. Schalte einen Filter in der Liste ein, um ihn zu verwenden.',
  'Follows what the filter looks for until you change it.':
    'Folgt dem, wonach der Filter sucht, bis du ihn änderst.',
  'Filter by': 'Filtern nach',
  Category: 'Kategorie',
  'Text to look for': 'Gesuchter Text',
  'Looks in the title, the place and the notes, without regard to case.':
    'Sucht im Titel, im Ort und in den Notizen, ohne auf Groß- und Kleinschreibung zu achten.',
  'Choose a category': 'Kategorie wählen',
  'There are no categories yet. Add one in the categories of the sidebar.':
    'Es gibt noch keine Kategorien. Füge eine bei den Kategorien in der Seitenleiste hinzu.',
  'Choose people, or type a name or an e-mail address':
    'Personen auswählen oder einen Namen bzw. eine E-Mail-Adresse eingeben',
  'Matches who organised or made the event; for an event that names nobody, the owner of its calendar.':
    'Grenzt auf die Person ein, die den Termin organisiert oder angelegt hat; bei einem Termin ohne Organisator auf die Person, der sein Kalender gehört.',
  'Matching events': 'Passende Termine',
  'Show only matching events': 'Nur passende Termine zeigen',
  'Hide matching events': 'Passende Termine ausblenden',
  'Hide: {what}': 'Ausblenden: {what}',
  'Hides the events whose title, place or notes contain "{what}".':
    'Blendet die Termine aus, deren Titel, Ort oder Notizen „{what}“ enthalten.',
  'Shows only the events whose title, place or notes contain "{what}".':
    'Zeigt nur die Termine, deren Titel, Ort oder Notizen „{what}“ enthalten.',
  'Hides the events in the category {what}.': 'Blendet die Termine der Kategorie {what} aus.',
  'Shows only the events in the category {what}.': 'Zeigt nur die Termine der Kategorie {what}.',
  'Hides the events with the status {what}.': 'Blendet die Termine mit dem Status {what} aus.',
  'Shows only the events with the status {what}.': 'Zeigt nur die Termine mit dem Status {what}.',
  'Hides the events of {what}.': 'Blendet die Termine von {what} aus.',
  'Shows only the events of {what}.': 'Zeigt nur die Termine von {what}.',
  'Choose a status.': 'Wähle einen Status.',
  'Choose a category.': 'Wähle eine Kategorie.',
  'Choose or enter at least one person.': 'Wähle mindestens eine Person aus oder gib eine ein.',
  'Choose at most {count} people.': 'Wähle höchstens {count} Personen aus.',
  'Enter the text to look for.': 'Gib den Text ein, nach dem gesucht wird.',

  // Messages about views, categories and filters
  'A view with this name already exists.': 'Eine Ansicht mit diesem Namen gibt es schon.',
  'A category with this name already exists.': 'Eine Kategorie mit diesem Namen gibt es schon.',
  'A filter with this name already exists.': 'Einen Filter mit diesem Namen gibt es schon.',
  'A shared view with this name already exists. Rename this view first.':
    'Eine geteilte Ansicht mit diesem Namen gibt es schon. Benenne diese Ansicht zuerst um.',
  'You already have a view with this name. Rename one of them first.':
    'Du hast schon eine Ansicht mit diesem Namen. Benenne eine der beiden zuerst um.',
  'Added {name} to your views': '{name} zu deinen Ansichten hinzugefügt',
  'Shared {name} with everybody': '{name} mit allen geteilt',
  'Shared {name}, but your own view could not be removed.':
    '{name} geteilt, aber deine eigene Ansicht konnte nicht entfernt werden.',
  'External calendars are not shared.': 'Externe Kalender werden nicht geteilt.',
  'Unshared {name}': 'Teilen von {name} beendet',
  'It is one of your own views now; other people no longer see it.':
    'Sie ist jetzt eine deiner eigenen Ansichten; andere sehen sie nicht mehr.',
  'Copied {name} to your views, but the shared view could not be removed.':
    '{name} in deine Ansichten kopiert, aber die geteilte Ansicht konnte nicht entfernt werden.',
  'Updated shared view {name}': 'Geteilte Ansicht {name} aktualisiert',
  'Updated view {name}': 'Ansicht {name} aktualisiert',
  'Only administrators can change shared views.':
    'Nur Administratoren können geteilte Ansichten ändern.',
  'This shared view no longer exists. Reload the page.':
    'Diese geteilte Ansicht gibt es nicht mehr. Lade die Seite neu.',
  'There are too many shared views.': 'Es gibt zu viele geteilte Ansichten.',
  'Too many changes in a short time. Try again in a moment.':
    'Zu viele Änderungen in kurzer Zeit. Versuche es gleich noch einmal.',
  'The server did not accept this shared view.':
    'Der Server hat diese geteilte Ansicht nicht angenommen.',
  'The shared view could not be saved. Check your connection and try again.':
    'Die geteilte Ansicht konnte nicht gespeichert werden. Prüfe deine Verbindung und versuche es erneut.',
  'This view no longer exists. Reload the page.':
    'Diese Ansicht gibt es nicht mehr. Lade die Seite neu.',
  'You have too many views. Delete one first.': 'Du hast zu viele Ansichten. Lösche zuerst eine.',
  'The server did not accept this view.': 'Der Server hat diese Ansicht nicht angenommen.',
  'The view could not be saved. Try again.':
    'Die Ansicht konnte nicht gespeichert werden. Versuche es erneut.',
  'The calendar setting could not be saved: {reason}.':
    'Die Kalendereinstellung konnte nicht gespeichert werden: {reason}.',
  'The category "{name}" could not be saved: {reason}.':
    'Die Kategorie „{name}“ konnte nicht gespeichert werden: {reason}.',
  'the server did not accept it': 'Der Server hat es nicht angenommen',

  // Problems list
  Problems: 'Probleme',
  'Enter password again': 'Passwort erneut eingeben',
  'Enter password again for {name}': 'Passwort für {name} erneut eingeben',
  'Retry {name}': '{name} erneut versuchen',
  'Password saved': 'Passwort gespeichert',
  '{count} entry could not be read and is not shown | {count} entries could not be read and are not shown':
    '{count} Eintrag konnte nicht gelesen werden und wird nicht angezeigt | {count} Einträge konnten nicht gelesen werden und werden nicht angezeigt',
  'Something could not be loaded': 'Etwas konnte nicht geladen werden',
  'Some things could not be loaded': 'Einiges konnte nicht geladen werden',
  'Open the sidebar to see what and to try again.':
    'Öffne die Seitenleiste, um zu sehen, was los ist, und es erneut zu versuchen.',

  // Sign-in pages
  'Signing in…': 'Anmeldung läuft …',
  'Signing in': 'Anmeldung läuft',
  'Details: {detail}': 'Details: {detail}',
  'Finishing the sign-in. This takes a moment.': 'Die Anmeldung wird abgeschlossen. Einen Moment.',
  'You are signed out': 'Du bist abgemeldet',
  'Signed out': 'Abgemeldet',
  'You have signed out of Web Calendar in this browser tab. Your sign-in provider may still remember you, so signing in again may not ask for your password.':
    'Du hast dich in diesem Browser-Tab von Web Calendar abgemeldet. Dein Anmeldedienst kennt dich vielleicht noch, daher fragt die erneute Anmeldung möglicherweise nicht nach deinem Passwort.',
  'Sign in again': 'Erneut anmelden',
  'Your sign-in has expired': 'Deine Anmeldung ist abgelaufen',
  'Sign in again to go on. Anything you have not saved yet is lost when you do: choose “Not now” to copy it first.':
    'Melde dich erneut an, um weiterzumachen. Was du noch nicht gespeichert hast, geht dabei verloren: Wähle „Nicht jetzt“, um es vorher zu kopieren.',
  'Not now': 'Nicht jetzt',

  // Events as read out and drawn
  Busy: 'Belegt',
  'Calendar {name}': 'Kalender {name}',
  to: 'bis',
  'details hidden': 'Details verborgen',

  // The page of a calendar link
  'A shared calendar': 'Ein geteilter Kalender',
  'Enter the password you were given to see this calendar.':
    'Gib das Passwort ein, das du bekommen hast, um diesen Kalender zu sehen.',
  'Open calendar': 'Kalender öffnen',
  'The password is not right.': 'Das Passwort stimmt nicht.',
  'This link does not exist, was removed or does not work at the moment.':
    'Diesen Link gibt es nicht, er wurde entfernt oder funktioniert gerade nicht.',
  'Enter the password again.': 'Gib das Passwort noch einmal ein.',
  'Too many tries. Wait a minute and try again.':
    'Zu viele Versuche. Warte eine Minute und versuche es dann noch einmal.',
  'The calendar could not be opened. Try again.':
    'Der Kalender konnte nicht geöffnet werden. Versuche es noch einmal.',

  // The menus of the sidebar's calendars, categories and filters
  'Actions for calendar {name}': 'Aktionen für Kalender {name}',
  'Actions for category {name}': 'Aktionen für Kategorie {name}',
  'Actions for filter {name}': 'Aktionen für Filter {name}',
  Text: 'Text',
  'Everybody sees this colour.': 'Alle sehen diese Farbe.',
  'Rename calendar {name}': 'Kalender {name} umbenennen',
  'Rename category {name}': 'Kategorie {name} umbenennen',
  'Edit filter {name}': 'Filter {name} bearbeiten',
  'Everybody who has this calendar sees the new name.':
    'Alle, die diesen Kalender haben, sehen den neuen Namen.',
  'The calendar keeps its events and whom it is shared with.':
    'Der Kalender behält seine Termine und mit wem er geteilt ist.',
  'Everybody sees the new name. Events that have the old name keep it.':
    'Alle sehen den neuen Namen. Termine mit dem alten Namen behalten ihn.',
  'Events that have the old name keep it.': 'Termine mit dem alten Namen behalten ihn.',
  'The calendar and all its events are deleted for everybody in the group and everybody it is shared with, and its links stop working.':
    'Der Kalender und alle seine Termine werden für alle in der Gruppe und alle, mit denen er geteilt ist, gelöscht, und seine Links funktionieren nicht mehr.',
  'The calendar and all its events are deleted, the people it is shared with lose it, and its links stop working.':
    'Der Kalender und alle seine Termine werden gelöscht, die Personen, mit denen er geteilt ist, verlieren ihn, und seine Links funktionieren nicht mehr.',
  'The shared category disappears for everybody. Events keep the category name.':
    'Die geteilte Kategorie verschwindet für alle. Termine behalten den Kategorienamen.',
  'Only the category is deleted; events keep the category name.':
    'Nur die Kategorie wird gelöscht; Termine behalten den Kategorienamen.',
  'Only this filter is deleted; no event changes.':
    'Nur dieser Filter wird gelöscht; kein Termin ändert sich.',
  'rename the calendar': 'den Kalender umbenennen',
  'rename the category': 'die Kategorie umbenennen',
  'change the filter': 'den Filter ändern',
  'add the filter': 'den Filter hinzufügen',
  'delete the calendar': 'den Kalender löschen',
  'delete the category': 'die Kategorie löschen',
  'delete the filter': 'den Filter löschen',

  // Resources and categories that events carry, in the sidebar; category colours on events
  'Actions for resource {name}': 'Aktionen für Ressource {name}',
  '{name} is saved as one of your categories, with this colour.':
    '{name} wird als eine deiner Kategorien gespeichert, mit dieser Farbe.',
  'Category colours on events': 'Kategoriefarben an Terminen',
  'category {names} | categories {names}': 'Kategorie {names} | Kategorien {names}',

  // Turning a category into a status
  'Turn into a status…': 'In einen Status umwandeln…',
  'Turn {name} into a status': '{name} in einen Status umwandeln',
  'Every event in your calendars that has this category gets the status you choose. Other calendar apps show a status, unlike a category.':
    'Jeder Termin in deinen Kalendern mit dieser Kategorie bekommt den Status, den du wählst. Andere Kalender-Apps zeigen einen Status an, anders als eine Kategorie.',
  'Looking for the events…': 'Die Termine werden gesucht…',
  'No event in a calendar you can change has this category.':
    'Kein Termin in einem Kalender, den du ändern kannst, hat diese Kategorie.',
  '{count} event has this category. | {count} events have this category.':
    '{count} Termin hat diese Kategorie. | {count} Termine haben diese Kategorie.',
  'In: {calendars}.': 'In: {calendars}.',
  'Remove {name} from these events': '{name} von diesen Terminen entfernen',
  'Changing the events: {done} of {total}': 'Die Termine werden geändert: {done} von {total}',
  '{count} event was changed. | {count} events were changed.':
    '{count} Termin wurde geändert. | {count} Termine wurden geändert.',
  'Change {count} event | Change {count} events': '{count} Termin ändern | {count} Termine ändern',
  '{calendar} could not be searched: {problem}':
    '{calendar} konnte nicht durchsucht werden: {problem}',
  '{count} event could not be changed: {reason} | {count} events could not be changed. The first: {reason}':
    '{count} Termin konnte nicht geändert werden: {reason} | {count} Termine konnten nicht geändert werden. Der erste: {reason}',

  // Deleting a category from the events that have it
  'The category is taken off every event in your calendars that has it; their other categories and everything else stay. This cannot be undone.':
    'Die Kategorie wird von jedem Termin in deinen Kalendern entfernt, der sie hat; seine anderen Kategorien und alles andere bleiben. Das lässt sich nicht rückgängig machen.',
  'Only the category itself is deleted.': 'Nur die Kategorie selbst wird gelöscht.',
  'The category was deleted.': 'Die Kategorie wurde gelöscht.',
  'Delete from {count} event | Delete from {count} events':
    'Von {count} Termin löschen | Von {count} Terminen löschen',

  // The admin dialogs opened from the sidebar
  'This calendar is not known to the server yet. Try again in a few minutes.':
    'Dieser Kalender ist dem Server noch nicht bekannt. Versuche es in ein paar Minuten erneut.',
}
