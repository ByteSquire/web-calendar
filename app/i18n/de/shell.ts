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
  'New view name': 'Name der neuen Ansicht',
  'Add view': 'Ansicht hinzufügen',
  'New calendar name': 'Name des neuen Kalenders',
  'A calendar with this name already exists.': 'Ein Kalender mit diesem Namen gibt es schon.',
  'New category name': 'Name der neuen Kategorie',
  'Add category': 'Kategorie hinzufügen',
  'New filter name': 'Name des neuen Filters',
  'Add filter': 'Filter hinzufügen',
  'Arrange sections': 'Bereiche anordnen',
  'Move a section up or down. The order is saved for your account.':
    'Verschiebe einen Bereich nach oben oder nach unten. Die Reihenfolge wird in deinem Konto gespeichert.',
  'Move {name} up': '{name} nach oben verschieben',
  'Move {name} down': '{name} nach unten verschieben',
  '{name}: number {position} of {total}': '{name}: Platz {position} von {total}',
  'save the order of the sections': 'Das Speichern der Reihenfolge der Bereiche',
  'Rename view': 'Ansicht umbenennen',
  'Rename shared view': 'Geteilte Ansicht umbenennen',
  'Everybody sees the new name.': 'Alle sehen den neuen Namen.',
  'Only you see this view.': 'Nur du siehst diese Ansicht.',
  'The shared view disappears for everybody.': 'Die geteilte Ansicht verschwindet für alle.',
  'Only this view is deleted; the calendars stay.':
    'Nur diese Ansicht wird gelöscht; die Kalender bleiben.',
  '(copy)': '(Kopie)',
  '(copy {number})': '(Kopie {number})',

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
  'The filter "{name}" could not be saved: {reason}.':
    'Der Filter „{name}“ konnte nicht gespeichert werden: {reason}.',
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
}
