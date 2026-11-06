// German texts of the area "admin" (docs/i18n.md). One entry per English text: 'English': 'Deutsch'.
export const admin: Readonly<Record<string, string>> = {
  'Checking your permissions': 'Deine Berechtigungen werden geprüft',
  'There are no calendars to manage yet.': 'Es gibt noch keine Kalender zu verwalten.',
  'Search calendars': 'Kalender suchen',
  'Who has access to {name}': 'Wer Zugriff auf {name} hat',
  Links: 'Links',
  'A link gives people without an account a view of this calendar, behind a password, at the access level you choose.':
    'Ein Link gibt Menschen ohne Konto Einblick in diesen Kalender, geschützt durch ein Passwort, mit der Zugriffsstufe, die du wählst.',
  'People and groups': 'Personen und Gruppen',
  'Owner: {name} (always has full access).': 'Besitzer: {name} (hat immer vollen Zugriff).',
  '{count} rule is pending. They are sent to the calendar server shortly; reload to see when they are applied. | {count} rules are pending. They are sent to the calendar server shortly; reload to see when they are applied.':
    '{count} Regel steht aus. Sie wird gleich an den Kalenderserver gesendet; lade die Seite neu, um zu sehen, wann sie gilt. | {count} Regeln stehen aus. Sie werden gleich an den Kalenderserver gesendet; lade die Seite neu, um zu sehen, wann sie gelten.',
  'Group {name}': 'Gruppe {name}',
  'This person': 'Diese Person',
  'Access for {label} is now: {level}.': 'Zugriff für {label}: {level}.',
  '{label} no longer has access.': '{label} hat keinen Zugriff mehr.',

  // Add access form and rule lists
  'Add access': 'Zugriff hinzufügen',
  'Give access to': 'Zugriff geben für',
  Person: 'Person',
  'Choose a person': 'Person auswählen',
  'Nobody matches. People appear here after they signed in once.':
    'Niemand passt. Personen erscheinen hier, nachdem sie sich einmal angemeldet haben.',
  'Group name': 'Gruppenname',
  'Everyone who can sign in to this calendar app gets this access.':
    'Alle, die sich in dieser Kalender-App anmelden können, erhalten diesen Zugriff.',
  'Access level': 'Zugriffsstufe',
  'Search people': 'Personen suchen',
  'Choose a person.': 'Wähle eine Person aus.',
  'Everyone signed in': 'Alle Angemeldeten',
  'Access rules of {name}': 'Zugriffsregeln für {name}',
  Applied: 'Gilt',
  Pending: 'Ausstehend',
  'The calendar server has this rule.': 'Der Kalenderserver hat diese Regel.',
  'Saved, but the calendar server does not have it yet.':
    'Gespeichert, aber der Kalenderserver hat sie noch nicht.',
  'Remove {who} from {name}': '{who} von {name} entfernen',
  Remove: 'Entfernen',
  'Nobody else has access to {name}. Only the owner can see it.':
    'Niemand sonst hat Zugriff auf {name}. Nur der Besitzer kann ihn sehen.',
  'Nobody has access to {name}.': 'Niemand hat Zugriff auf {name}.',

  // Levels, rights, kinds (tables)
  'Busy times only': 'Nur Belegt-Zeiten',
  'Sees when the calendar is busy, but no titles or details.':
    'Sieht, wann der Kalender belegt ist, aber keine Titel oder Details.',
  'Can view': 'Kann ansehen',
  'Sees all events and their details. Cannot change them.':
    'Sieht alle Termine mit Details. Kann sie nicht ändern.',
  'Can edit': 'Kann bearbeiten',
  'Sees, adds, changes and deletes events.': 'Sieht, erstellt, ändert und löscht Termine.',
  'A person': 'Eine Person',
  'A group': 'Eine Gruppe',
  Group: 'Gruppe',
  Everyone: 'Alle',
  'Unnamed person': 'Person ohne Namen',
  'Can see': 'Kann sehen',
  'Sees the resource and when it is busy.': 'Sieht die Ressource und wann sie belegt ist.',
  'Can book': 'Kann buchen',
  'Sees it and asks to book it.': 'Sieht sie und fragt eine Buchung an.',
  'Can manage': 'Kann verwalten',
  'Also accepts or declines booking requests. Administrators are not managers by default.':
    'Nimmt Buchungsanfragen auch an oder lehnt sie ab. Administratoren sind standardmäßig keine Verwalter.',
  Room: 'Raum',
  Car: 'Auto',
  Equipment: 'Ausstattung',
  'The server could not be reached. Nothing was changed.':
    'Der Server ist nicht erreichbar. Es wurde nichts geändert.',
  'This calendar no longer exists. Reload the page.':
    'Dieser Kalender existiert nicht mehr. Lade die Seite neu.',
  'You are not allowed to manage access.': 'Du darfst den Zugriff nicht verwalten.',
  'Nothing was changed. {details}': 'Es wurde nichts geändert. {details}',
  'Nothing was changed. Try again.': 'Es wurde nichts geändert. Versuche es erneut.',
  'This resource no longer exists. Reload the page.':
    'Diese Ressource existiert nicht mehr. Lade die Seite neu.',
  'You are not allowed to manage resources.': 'Du darfst Ressourcen nicht verwalten.',
  'Could not check whether you may manage resources. Try again.':
    'Es konnte nicht geprüft werden, ob du Ressourcen verwalten darfst. Versuche es erneut.',
  'Rooms, cars and equipment that people can book. Deactivated resources take no new bookings; existing bookings stay.':
    'Räume, Autos und Ausstattung, die man buchen kann. Deaktivierte Ressourcen nehmen keine neuen Buchungen an; bestehende bleiben.',
  'There are no resources yet.': 'Es gibt noch keine Ressourcen.',
  Inactive: 'Inaktiv',
  Access: 'Zugriff',
  'Access for {name}': 'Zugriff für {name}',
  'Deactivate {name}': '{name} deaktivieren',
  'Reactivate {name}': '{name} reaktivieren',
  Deactivate: 'Deaktivieren',
  Reactivate: 'Reaktivieren',
  'Who may use {name}': 'Wer {name} nutzen darf',
  'Change the resource, or choose who may use it.':
    'Ändere die Ressource oder lege fest, wer sie nutzen darf.',
  'Nobody can manage {name} yet, so nobody can accept booking requests. Administrators are not managers by default.':
    'Noch kann niemand {name} verwalten, also kann niemand Buchungsanfragen annehmen. Administratoren sind standardmäßig keine Verwalter.',
  '{count} place | {count} places': '{count} Platz | {count} Plätze',
  'load the bookings': 'Das Laden der Buchungen',
  'load the calendars': 'Das Laden der Kalender',
  'load the people': 'Das Laden der Personen',
  'load the resources': 'Das Laden der Ressourcen',
  'load the rules': 'Das Laden der Regeln',
  '{name} was added. Everyone signed in can book it; choose who manages it.':
    '{name} wurde hinzugefügt. Alle Angemeldeten können sie buchen; lege fest, wer sie verwaltet.',
  '{name} was saved.': '{name} wurde gespeichert.',
  '{name} is active again.': '{name} ist wieder aktiv.',
  '{name} is deactivated.': '{name} ist deaktiviert.',
  '{label} can now: {right}.': 'Neue Berechtigung für {label}: {right}.',
  'Edit resource': 'Ressource bearbeiten',
  'Add resource': 'Ressource hinzufügen',
  Type: 'Typ',
  'Type {problem}.': 'Typ {problem}.',
  Capacity: 'Kapazität',
  'Leave empty for no limit.': 'Leer lassen für keine Begrenzung.',
  'Enter a name.': 'Gib einen Namen ein.',
  'Enter a whole number, or leave it empty.': 'Gib eine ganze Zahl ein oder lass das Feld leer.',

  // Date navigation
  'Previous day': 'Vorheriger Tag',
  'Previous 5 days': 'Vorherige 5 Tage',
  'Previous week': 'Vorherige Woche',
  'Previous month': 'Vorheriger Monat',
  'Previous year': 'Vorheriges Jahr',
  'Next day': 'Nächster Tag',
  'Next 5 days': 'Nächste 5 Tage',
  'Next week': 'Nächste Woche',
  'Next month': 'Nächster Monat',
  'Next year': 'Nächstes Jahr',

  // Sign-in errors
  'Sign-in is not set up': 'Anmeldung nicht eingerichtet',
  'This server has no sign-in provider configured. Ask an administrator.':
    'Dieser Server hat keinen Anmeldedienst eingerichtet. Frag einen Administrator.',
  'Sign-in was cancelled': 'Anmeldung abgebrochen',
  'The sign-in was cancelled or you do not have access to this app. You can try again.':
    'Die Anmeldung wurde abgebrochen oder du hast keinen Zugriff auf diese App. Du kannst es erneut versuchen.',
  'Sign-in failed': 'Anmeldung fehlgeschlagen',
  'The sign-in server did not accept the request. Try again.':
    'Der Anmeldeserver hat die Anfrage nicht angenommen. Versuche es erneut.',
  'This sign-in has expired': 'Diese Anmeldung ist abgelaufen',
  'The sign-in could not be matched to this browser tab. This happens when the page was reloaded, opened twice or left waiting for too long. Try again.':
    'Die Anmeldung konnte diesem Browser-Tab nicht zugeordnet werden. Das passiert, wenn die Seite neu geladen, doppelt geöffnet oder zu lange offen gelassen wurde. Versuche es erneut.',
  'Cannot reach the sign-in server': 'Anmeldeserver nicht erreichbar',
  'Check your connection and try again.': 'Prüfe deine Verbindung und versuche es erneut.',
  'Something went wrong while signing in. Try again; if it keeps happening, ask an administrator.':
    'Bei der Anmeldung ist etwas schiefgegangen. Versuche es erneut; wenn es bleibt, frag einen Administrator.',

  // Loader problems
  'Your profile': 'Dein Profil',
  'Calendar settings': 'Kalendereinstellungen',
  Filters: 'Filter',
  Views: 'Ansichten',
  'Calendar list': 'Kalenderliste',
  'Resource availability': 'Verfügbarkeit der Ressourcen',
  'External account': 'Externes Konto',
  'External accounts': 'Externe Konten',
  'Sign-in expired': 'Anmeldung abgelaufen',
  'Access denied': 'Zugriff verweigert',
  'Not found': 'Nicht gefunden',
  'Changed on the server': 'Auf dem Server geändert',
  'Already exists': 'Existiert bereits',
  'Server unavailable': 'Server nicht verfügbar',
  'Not reachable': 'Nicht erreichbar',
  'Unexpected answer from the server': 'Unerwartete Antwort vom Server',
  'Request refused by the server': 'Anfrage vom Server abgelehnt',
  'Login rejected': 'Login abgelehnt',
  'Password needed': 'Passwort nötig',
  'Server not allowed': 'Server nicht erlaubt',
  'Too many requests': 'Zu viele Anfragen',
  'Address not allowed': 'Adresse nicht erlaubt',
  'Source took too long': 'Die Quelle hat zu lange gebraucht',
  'File too large': 'Datei zu groß',
  'Not a calendar file': 'Keine Kalenderdatei',
  'The source answered with HTTP {code}': 'Die Quelle antwortete mit HTTP {code}',
  'Could not be loaded': 'Konnte nicht geladen werden',
  'Could not create the first calendar: {problem}':
    'Der erste Kalender konnte nicht erstellt werden: {problem}',
  'No calendars found at this address': 'Unter dieser Adresse wurden keine Kalender gefunden',
  'Request cancelled': 'Anfrage abgebrochen',

  // Admin › Calendars
  'Could not check whether you may manage calendars. Try again.':
    'Es konnte nicht geprüft werden, ob du Kalender verwalten darfst. Versuche es erneut.',
  'Every calendar of the app. Rename it, change its colour or delete it, and choose who may see or change it. The calendar server enforces these rules for every app, not only this one.':
    'Alle Kalender der App. Benenne sie um, ändere ihre Farbe oder lösche sie, und lege fest, wer sie sehen oder ändern darf. Der Kalenderserver setzt diese Regeln für jede App durch, nicht nur für diese.',
  'No calendar matches.': 'Kein Kalender passt.',
  'Change the calendar, or choose who may see or change it.':
    'Ändere den Kalender, oder lege fest, wer ihn sehen oder ändern darf.',
  'The name and colour are the calendar’s own: everybody who has the calendar sees them, unless they picked a colour of their own.':
    'Name und Farbe gehören zum Kalender: Alle, die den Kalender haben, sehen sie, außer sie haben eine eigene Farbe gewählt.',
  'Delete calendar': 'Kalender löschen',
  'This is the default calendar of {name}. It is kept, so they always have a calendar to write to: it can be renamed, not deleted.':
    'Das ist der Standardkalender von {name}. Er bleibt, damit immer ein Kalender zum Eintragen da ist: Er kann umbenannt, aber nicht gelöscht werden.',
  'A resource calendar is deleted with its resource, on the Resources page.':
    'Ein Ressourcenkalender wird mit seiner Ressource gelöscht, auf der Seite Ressourcen.',
  'This calendar belongs to the organization: only the people and groups below see it.':
    'Dieser Kalender gehört der Organisation: Nur die Personen und Gruppen unten sehen ihn.',
  'A calendar of the organization: it belongs to nobody, and nobody sees it until you give people or groups access.':
    'Ein Kalender der Organisation: Er gehört niemandem, und niemand sieht ihn, bis du Personen oder Gruppen Zugriff gibst.',
  All: 'Alle',
  Organization: 'Organisation',
  'Calendar of {name}': 'Kalender von {name}',
  'Calendar of a person': 'Kalender einer Person',
  'Calendar of the organization': 'Kalender der Organisation',
  'Calendar of the group {name}': 'Kalender der Gruppe {name}',
  'Calendar of a resource': 'Kalender einer Ressource',
  '{count} access rule | {count} access rules': '{count} Zugriffsregel | {count} Zugriffsregeln',
  'The calendar of {name} and all its events are deleted, the people it is shared with lose it, and its links stop working.':
    'Der Kalender von {name} und alle seine Termine werden gelöscht, die Personen, mit denen er geteilt ist, verlieren ihn, und seine Links funktionieren nicht mehr.',
  'a person': 'einer Person',
  'The calendar and all its events are deleted for everybody who has it, and its links stop working.':
    'Der Kalender und alle seine Termine werden für alle gelöscht, die ihn haben, und seine Links funktionieren nicht mehr.',
  'Another change is still being saved. Try again in a moment.':
    'Eine andere Änderung wird noch gespeichert. Versuche es gleich noch einmal.',
  '{name} was added. Nobody sees it until you give people or groups access.':
    '{name} wurde hinzugefügt. Niemand sieht ihn, bis du Personen oder Gruppen Zugriff gibst.',
  'add the calendar': 'den Kalender hinzufügen',
  'save the calendar': 'den Kalender speichern',

  // Admin › People
  People: 'Personen',
  'Could not check whether you may see the people. Try again.':
    'Es konnte nicht geprüft werden, ob du die Personen sehen darfst. Versuche es erneut.',
  'Everybody who has signed in once: their groups, their calendars, the calendars shared with them and the links they made. Change access on the Calendars and Groups pages.':
    'Alle, die sich einmal angemeldet haben: ihre Gruppen, ihre Kalender, die mit ihnen geteilten Kalender und die Links, die sie erstellt haben. Den Zugriff änderst du auf den Seiten Kalender und Gruppen.',
  'Only the first {count} people are listed, sorted by name.':
    'Nur die ersten {count} Personen werden aufgeführt, nach Namen sortiert.',
  'Nobody has signed in yet.': 'Noch hat sich niemand angemeldet.',
  'Nobody matches.': 'Niemand passt.',
  Loading: 'Wird geladen',
  Admin: 'Admin',
  'An administrator at their last sign-in. Whether they still are is asked of the identity provider each time.':
    'Bei der letzten Anmeldung Administrator. Ob das noch gilt, wird jedes Mal beim Identitätsanbieter erfragt.',
  'In no group.': 'In keiner Gruppe.',
  'Own calendars': 'Eigene Kalender',
  'No calendar of their own yet.': 'Noch kein eigener Kalender.',
  'Calendars shared with them': 'Mit ihnen geteilte Kalender',
  'No calendar is shared with them.': 'Kein Kalender ist mit ihnen geteilt.',
  'Links they made': 'Ihre Links',
  'No links.': 'Keine Links.',
  '{label}: {calendar}, {level}': '{label}: {calendar}, {level}',
  'Last signed in {date}': 'Zuletzt angemeldet am {date}',
  'No sign-in recorded': 'Keine Anmeldung gespeichert',
  'load the person': 'die Person laden',

  // Admin › Resources: deleting
  'The resource and the rules of who may use it are deleted. A resource with bookings cannot be deleted; deactivate it instead.':
    'Die Ressource und die Regeln, wer sie nutzen darf, werden gelöscht. Eine Ressource mit Buchungen kann nicht gelöscht werden; deaktiviere sie stattdessen.',
}
