// German texts of the area "settings" (docs/i18n.md). One entry per English text: 'English': 'Deutsch'.
export const settings: Readonly<Record<string, string>> = {
  'Demo mode': 'Demo-Modus',
  'Nothing is saved in demo mode. Changes you make here are not kept.':
    'Im Demo-Modus wird nichts gespeichert. Änderungen hier gehen verloren.',
  Account: 'Konto',
  Email: 'E-Mail',
  'User name': 'Benutzername',
  Administrator: 'Administrator',
  'Not set': 'Nicht gesetzt',
  'Loading account details': 'Kontodaten werden geladen',
  'Times are shown in {displayZone} ({source}). Organization time zone: {orgZone}.':
    'Zeiten erscheinen in {displayZone} ({source}). Zeitzone der Organisation: {orgZone}.',
  'your setting': 'deine Einstellung',
  "your browser's zone": 'die Zone deines Browsers',
  'Time zone': 'Zeitzone',
  "Times in the calendar are shown in the zone you choose here, by default your browser's zone. All-day events stay on their dates.":
    'Zeiten im Kalender erscheinen in der Zone, die du hier wählst, standardmäßig in der Zone deines Browsers. Ganztägige Termine bleiben an ihrem Datum.',
  'Show times in': 'Zeiten anzeigen in',
  'No time zone matches your search.': 'Keine Zeitzone passt zur Suche.',
  'Organization time zone: {zone}. Events without a zone use it.':
    'Zeitzone der Organisation: {zone}. Termine ohne Zone verwenden sie.',
  'Your time zone setting is not available because your account could not be loaded.':
    'Deine Zeitzone ist nicht verfügbar, weil dein Konto nicht geladen werden konnte.',
  'Loading your time zone': 'Deine Zeitzone wird geladen',
  'Search time zones': 'Zeitzonen suchen',
  "Browser's zone ({zone})": 'Zone des Browsers ({zone})',
  '{zone} (organization zone)': '{zone} (Zone der Organisation)',
  "Times are now shown in your browser's zone, {zone}.":
    'Zeiten erscheinen jetzt in der Zone deines Browsers, {zone}.',
  'Times are now shown in {zone}.': 'Zeiten erscheinen jetzt in {zone}.',
  'load your account': 'Das Laden deines Kontos',
  'save your time zone': 'Das Speichern deiner Zeitzone',
  'The server could not be reached. Check your connection and try again.':
    'Der Server ist nicht erreichbar. Prüfe deine Verbindung und versuche es erneut.',
  'It no longer exists. It may have been removed in another window.':
    'Es existiert nicht mehr. Vielleicht wurde es in einem anderen Fenster entfernt.',
  'The server did not accept the request.': 'Der Server hat die Anfrage nicht angenommen.',
  'The server answered with an error (HTTP {status}).':
    'Der Server hat mit einem Fehler geantwortet (HTTP {status}).',
  'The server answered with an error.': 'Der Server hat mit einem Fehler geantwortet.',
  'Could not {action}. {failure}': '{action} ist fehlgeschlagen. {failure}',
  'Could not {action}: {problems}.': '{action} ist fehlgeschlagen: {problems}.',
  'This address points to a private or reserved network, which is not allowed.':
    'Diese Adresse zeigt auf ein privates oder reserviertes Netzwerk. Das ist nicht erlaubt.',
  'The host name of this address cannot be found. Check it for typos.':
    'Der Hostname dieser Adresse wurde nicht gefunden. Prüfe sie auf Tippfehler.',
  '{name} {message}.': '{name} {message}.',
  'The label': 'Die Bezeichnung',
  'The name': 'Der Name',
  'The address': 'Die Adresse',
  'The colour': 'Die Farbe',
  'The user name': 'Der Benutzername',
  'The password': 'Das Passwort',
  'You have reached the limit of app tokens. Revoke one first.':
    'Du hast die Höchstzahl an App-Tokens erreicht. Widerrufe zuerst eines.',
  'The token was not created: {problems}.': 'Das Token wurde nicht erstellt: {problems}.',
  'create the token': 'Das Erstellen des Tokens',
  'You already subscribed to this address.': 'Du hast diese Adresse schon abonniert.',
  'You have reached the limit of subscriptions.': 'Du hast die Höchstzahl an Abonnements erreicht.',

  // ---- Check of a subscription
  'sign-in required': 'Anmeldung nötig',
  'access denied': 'Zugriff verweigert',
  'not found': 'nicht gefunden',
  gone: 'entfernt',
  'The address points to a private or reserved network, which is not allowed.':
    'Die Adresse zeigt auf ein privates oder reserviertes Netzwerk. Das ist nicht erlaubt.',
  'The server could not reach the address.': 'Der Server konnte die Adresse nicht erreichen.',
  'The address did not answer in time.': 'Die Adresse hat nicht rechtzeitig geantwortet.',
  'The file is too large.': 'Die Datei ist zu groß.',
  'The address does not return an iCal calendar file.':
    'Die Adresse liefert keine iCal-Kalenderdatei.',
  'The address answered with HTTP {status} ({hint}).':
    'Die Adresse hat mit HTTP {status} geantwortet ({hint}).',
  'The address answered with HTTP {status}.': 'Die Adresse hat mit HTTP {status} geantwortet.',
  'The calendar could not be fetched.': 'Der Kalender konnte nicht abgerufen werden.',
  'Works: {count} event, {size}. | Works: {count} events, {size}.':
    'Funktioniert: {count} Termin, {size}. | Funktioniert: {count} Termine, {size}.',
  'Check failed: {reason}': 'Prüfung fehlgeschlagen: {reason}',

  // ---- Colours
  Blue: 'Blau',
  Green: 'Grün',
  Purple: 'Violett',
  Amber: 'Bernstein',
  Red: 'Rot',
  Teal: 'Petrol',
  Pink: 'Pink',
  Olive: 'Oliv',
  Default: 'Standard',
  Current: 'Aktuell',
  'No colour': 'Keine Farbe',
  'Custom colour': 'Eigene Farbe',
  Colour: 'Farbe',
  'Colour: {colour}': 'Farbe: {colour}',
  'from the server': 'vom Server',

  // ---- Tokens
  'App tokens': 'App-Tokens',
  'An app token stops working if you do not sign in to this app for {days}. Signing in again makes it work again.':
    'Ein App-Token funktioniert nicht mehr, wenn du dich {days} lang nicht in dieser App angemeldet hast. Nach einer erneuten Anmeldung funktioniert es wieder.',
  '{count} day | {count} days': '{count} Tag | {count} Tage',
  'Calendar apps such as Thunderbird, DAVx5 or iOS Calendar cannot use single sign-on. Create an app token for each app and enter it as the {password}.':
    'Kalender-Apps wie Thunderbird, DAVx5 oder der iOS-Kalender können kein Single Sign-on nutzen. Erstelle für jede App ein App-Token und gib es als {password} ein.',
  password: 'Passwort',
  'Server address': 'Serveradresse',
  'Apps that find the server themselves start from {address}.':
    'Apps, die den Server selbst finden, starten bei {address}.',
  'Your user name (see Account)': 'Dein Benutzername (siehe Konto)',
  Password: 'Passwort',
  'An app token from this page': 'Ein App-Token von dieser Seite',
  'New token for “{label}”': 'Neues Token für „{label}“',
  'Copy it now': 'Jetzt kopieren',
  'This token is shown only once. After you press Done it cannot be shown again; if you lose it, revoke it and create a new one.':
    'Dieses Token wird nur einmal angezeigt. Nach „Fertig“ kann es nicht mehr angezeigt werden. Wenn du es verlierst, widerrufe es und erstelle ein neues.',
  Token: 'Token',
  Copy: 'Kopieren',
  'Expires on {date}.': 'Läuft am {date} ab.',
  Done: 'Fertig',
  Label: 'Bezeichnung',
  'Which app is this token for? Up to 64 characters.':
    'Für welche App ist dieses Token? Bis zu 64 Zeichen.',
  'Creating…': 'Wird erstellt …',
  'Create token': 'Token erstellen',
  'Revoke all': 'Alle widerrufen',
  'Your app tokens': 'Deine App-Tokens',
  Expired: 'Abgelaufen',
  Created: 'Erstellt',
  Expires: 'Läuft ab',
  'Last used': 'Zuletzt verwendet',
  Revoke: 'Widerrufen',
  'Revoke token {label}': 'Token {label} widerrufen',
  'You have no app tokens yet.': 'Du hast noch keine App-Tokens.',
  'Loading app tokens': 'App-Tokens werden geladen',
  'Revoke token “{label}”?': 'Token „{label}“ widerrufen?',
  'Apps that use this token can no longer sign in. This cannot be undone.':
    'Apps, die dieses Token verwenden, können sich nicht mehr anmelden. Das lässt sich nicht rückgängig machen.',
  'Revoke token': 'Token widerrufen',
  'Revoke all app tokens?': 'Alle App-Tokens widerrufen?',
  'Every calendar app that uses one of your tokens is signed out at once. This cannot be undone.':
    'Jede Kalender-App mit einem deiner Tokens wird sofort abgemeldet. Das lässt sich nicht rückgängig machen.',
  'load your app tokens': 'Das Laden deiner App-Tokens',
  'Copied to the clipboard.': 'In die Zwischenablage kopiert.',
  'Could not copy automatically. The token is selected: press Ctrl+C to copy it.':
    'Automatisches Kopieren nicht möglich. Das Token ist markiert: Drücke Strg+C zum Kopieren.',
  'revoke the token': 'Das Widerrufen des Tokens',
  'Token “{label}” revoked.': 'Token „{label}“ widerrufen.',
  'revoke your app tokens': 'Das Widerrufen deiner App-Tokens',
  'All app tokens revoked.': 'Alle App-Tokens widerrufen.',
  'You have {used} of {limit} app tokens, which is the limit. Revoke a token to create another one.':
    'Du hast {used} von {limit} App-Tokens. Das ist die Höchstzahl. Widerrufe ein Token, um ein neues zu erstellen.',
  '{used} of {limit} app tokens in use. Expired tokens do not count.':
    '{used} von {limit} App-Tokens in Verwendung. Abgelaufene Tokens zählen nicht.',
  'Working…': 'Wird ausgeführt …',

  // ---- Validation (subscriptions, tokens)
  'Enter a label, for example the name of the app.':
    'Gib eine Bezeichnung ein, zum Beispiel den Namen der App.',
  'The label can have at most {max} characters.':
    'Die Bezeichnung darf höchstens {max} Zeichen lang sein.',
  'Enter a name for the calendar.': 'Gib einen Namen für den Kalender ein.',
  'The name can have at most {max} characters.': 'Der Name darf höchstens {max} Zeichen lang sein.',
  'Enter the address of the calendar.': 'Gib die Adresse des Kalenders ein.',
  'The address can have at most {max} characters.':
    'Die Adresse darf höchstens {max} Zeichen lang sein.',
  'Enter a valid address, for example https://example.org/calendar.ics.':
    'Gib eine gültige Adresse ein, zum Beispiel https://example.org/calendar.ics.',
  'The address must start with http://, https:// or webcal://.':
    'Die Adresse muss mit http://, https:// oder webcal:// beginnen.',
  'The address must not contain a user name or password.':
    'Die Adresse darf keinen Benutzernamen und kein Passwort enthalten.',
  'The address needs a valid host name.': 'Die Adresse braucht einen gültigen Hostnamen.',
  'Show a calendar from a web address (an {ics} file) next to your own calendars. It is read-only: changes have to be made at its source. If you have a file instead of an address, you can import its events into one of your calendars.':
    'Zeige einen Kalender von einer Webadresse (eine {ics}-Datei) neben deinen eigenen Kalendern. Er ist schreibgeschützt: Änderungen müssen an der Quelle erfolgen. Hast du statt einer Adresse eine Datei, kannst du ihre Termine in einen deiner Kalender importieren.',
  'Add a subscription': 'Abonnement hinzufügen',
  'Add subscription': 'Abonnement hinzufügen',
  'Your calendar subscriptions': 'Deine Kalender-Abonnements',
  'Address: ': 'Adresse: ',
  'Shared with everyone. Only an administrator can change it.':
    'Mit allen geteilt. Nur ein Administrator kann es ändern.',
  'Checking…': 'Wird geprüft …',
  Check: 'Prüfen',
  'Check {name}': '{name} prüfen',
  'Delete {name}': '{name} löschen',
  'You have no calendar subscriptions yet.': 'Du hast noch keine Kalender-Abonnements.',
  'Loading calendar subscriptions': 'Kalender-Abonnements werden geladen',
  'Edit subscription': 'Abonnement bearbeiten',
  'Change the name, address or colour of {name}': 'Name, Adresse oder Farbe von {name} ändern',
  'Delete “{name}”?': '„{name}“ löschen?',
  'The calendar is removed from your subscriptions. The calendar at its source is not affected.':
    'Der Kalender wird aus deinen Abonnements entfernt. Der Kalender an der Quelle bleibt unverändert.',
  'Delete subscription': 'Abonnement löschen',
  'load your calendar subscriptions': 'Das Laden deiner Kalender-Abonnements',
  'Subscription “{name}” added.': 'Abonnement „{name}“ hinzugefügt.',
  'add the subscription': 'Das Hinzufügen des Abonnements',
  'Subscription “{name}” saved.': 'Abonnement „{name}“ gespeichert.',
  'save the subscription': 'Das Speichern des Abonnements',
  'delete the subscription': 'Das Löschen des Abonnements',
  'Subscription “{name}” deleted.': 'Abonnement „{name}“ gelöscht.',
  'Checking the address…': 'Adresse wird geprüft …',
  'Saving…': 'Wird gespeichert …',
  'Address of the .ics file': 'Adresse der .ics-Datei',
  'An http://, https:// or webcal:// link to a calendar file.':
    'Ein http://-, https://- oder webcal://-Link zu einer Kalenderdatei.',

  // ---- External accounts
  'External CalDAV accounts': 'Externe CalDAV-Konten',
  'Show the calendars of another CalDAV server next to your own, for example from your company or a hosting provider. They are read-only: changes have to be made on their server.':
    'Zeige die Kalender eines anderen CalDAV-Servers neben deinen eigenen, zum Beispiel von deiner Firma oder einem Hosting-Anbieter. Sie sind schreibgeschützt: Änderungen müssen auf ihrem Server erfolgen.',
  "Your browser cannot talk to other servers directly, so this app's server passes each request on. It does not keep your password. An account with a login needs an {https} address.":
    'Dein Browser kann nicht direkt mit anderen Servern sprechen, darum leitet der Server dieser App jede Anfrage weiter. Dein Passwort behält er nicht. Ein Konto mit Login braucht eine {https}-Adresse.',
  'Add an account': 'Konto hinzufügen',
  'Add account': 'Konto hinzufügen',
  'You have reached the limit of {max} external accounts. Delete one to add another.':
    'Du hast die Höchstzahl von {max} externen Konten erreicht. Lösche eines, um ein neues hinzuzufügen.',
  'Your external accounts': 'Deine externen Konten',
  'Login: ': 'Login: ',
  'User name {name}': 'Benutzername {name}',
  'No login': 'Kein Login',
  'Check connection': 'Verbindung prüfen',
  'Check connection of {name}': 'Verbindung von {name} prüfen',
  'Enter password': 'Passwort eingeben',
  'Enter the password of {name}': 'Passwort von {name} eingeben',
  'You have no external accounts yet.': 'Du hast noch keine externen Konten.',
  'Loading external accounts': 'Externe Konten werden geladen',
  'Edit account': 'Konto bearbeiten',
  'Change the name, address, login or colour of {name}':
    'Name, Adresse, Login oder Farbe von {name} ändern',
  'The account is removed from this app, together with the sealed password this browser keeps for it. The calendars on its server are not affected.':
    'Das Konto wird aus dieser App entfernt, samt dem versiegelten Passwort, das dieser Browser dafür aufbewahrt. Die Kalender auf seinem Server bleiben unverändert.',
  'Delete account': 'Konto löschen',
  'load your external accounts': 'Das Laden deiner externen Konten',
  'Account “{name}” added.': 'Konto „{name}“ hinzugefügt.',
  'add the account': 'Das Hinzufügen des Kontos',
  'Account “{name}” saved.': 'Konto „{name}“ gespeichert.',
  'save the account': 'Das Speichern des Kontos',
  'delete the account': 'Das Löschen des Kontos',
  'Account “{name}” deleted.': 'Konto „{name}“ gelöscht.',
  'Password of “{name}” saved.': 'Passwort von „{name}“ gespeichert.',
  'Checking the connection…': 'Verbindung wird geprüft …',
  '{problem}. The problems list in the sidebar has more.':
    '{problem}. Die Problemliste in der Seitenleiste zeigt mehr.',
  'This browser has no password for the account yet.':
    'Dieser Browser hat noch kein Passwort für das Konto.',
  'Connected: {count} calendar shown. | Connected: {count} calendars shown.':
    'Verbunden: {count} Kalender angezeigt. | Verbunden: {count} Kalender angezeigt.',
  'Not checked yet.': 'Noch nicht geprüft.',

  // ---- External account form and password dialog
  'Address of the CalDAV server': 'Adresse des CalDAV-Servers',
  "A calendar, a folder of calendars or the account's start address, for example https://dav.example.org/.":
    'Ein Kalender, ein Ordner mit Kalendern oder die Startadresse des Kontos, zum Beispiel https://dav.example.org/.',
  Login: 'Login',
  'The administrator has not enabled logins for external accounts, so only accounts without a login can be added.':
    'Der Administrator hat Logins für externe Konten nicht aktiviert, darum können nur Konten ohne Login hinzugefügt werden.',
  'It is sent to this app’s server once, which seals it. Only the seal is kept.':
    'Es wird einmal an den Server dieser App gesendet, der es versiegelt. Nur das Siegel wird aufbewahrt.',
  'Leave it empty to keep the password you entered before.':
    'Lass es leer, um das bisherige Passwort zu behalten.',
  'Remember on this device': 'Auf diesem Gerät merken',
  'What is kept is a sealed credential, not your password. It works only through this app and only for this server. Leave this off on a shared computer.':
    'Aufbewahrt wird eine versiegelte Zugangsberechtigung, nicht dein Passwort. Sie funktioniert nur über diese App und nur für diesen Server. Lass das auf einem gemeinsam genutzten Computer aus.',
  'User name and password': 'Benutzername und Passwort',
  'Password for “{name}”': 'Passwort für „{name}“',
  'Enter the password of the account.': 'Gib das Passwort des Kontos ein.',
  'Save password': 'Passwort speichern',
  'Enter the password of {username}. It is sent to your calendar server through this app.':
    'Gib das Passwort von {username} ein. Es wird über diese App an deinen Kalenderserver gesendet.',
  'Enter the password of the account. It is sent to your calendar server through this app.':
    'Gib das Passwort des Kontos ein. Es wird über diese App an deinen Kalenderserver gesendet.',

  // ---- External accounts: messages
  'You have reached the limit of {max} external accounts. Delete one first.':
    'Du hast die Höchstzahl von {max} externen Konten erreicht. Lösche zuerst eines.',
  'The administrator has not allowed this server. Ask them to add its host name to the list of allowed hosts.':
    'Der Administrator hat diesen Server nicht erlaubt. Bitte ihn, den Hostnamen zur Liste der erlaubten Hosts hinzuzufügen.',
  'This address cannot be used. Check that it starts with https:// and names a public server.':
    'Diese Adresse kann nicht verwendet werden. Prüfe, ob sie mit https:// beginnt und einen öffentlichen Server nennt.',
  'The account conflicts.': 'Das Konto steht im Konflikt mit einem anderen.',
  'Enter a name for the account.': 'Gib einen Namen für das Konto ein.',
  'Enter the address of the CalDAV server.': 'Gib die Adresse des CalDAV-Servers ein.',
  'Enter a valid address, for example https://dav.example.org/calendars/me/.':
    'Gib eine gültige Adresse ein, zum Beispiel https://dav.example.org/calendars/me/.',
  'The address must start with http:// or https://.':
    'Die Adresse muss mit http:// oder https:// beginnen.',
  'The address must not contain a user name or password. Enter them below.':
    'Die Adresse darf keinen Benutzernamen und kein Passwort enthalten. Gib sie unten ein.',
  'An account with a login needs an https:// address, so that the password is encrypted.':
    'Ein Konto mit Login braucht eine https://-Adresse, damit das Passwort verschlüsselt wird.',
  'Enter the user name of the account.': 'Gib den Benutzernamen des Kontos ein.',
  'The user name can have at most {max} characters.':
    'Der Benutzername darf höchstens {max} Zeichen lang sein.',
  'The user name must not contain a colon.': 'Der Benutzername darf keinen Doppelpunkt enthalten.',
  'The user name must not contain control characters.':
    'Der Benutzername darf keine Steuerzeichen enthalten.',
  'The password can have at most {max} characters.':
    'Das Passwort darf höchstens {max} Zeichen lang sein.',
  'The password must not contain control characters.':
    'Das Passwort darf keine Steuerzeichen enthalten.',
  'The administrator has not enabled logins for external accounts.':
    'Der Administrator hat Logins für externe Konten nicht aktiviert.',
  'The server answered, but no calendar was found at this address.':
    'Der Server hat geantwortet, aber unter dieser Adresse wurde kein Kalender gefunden.',
  'Works: {count} calendar found. | Works: {count} calendars found.':
    'Funktioniert: {count} Kalender gefunden. | Funktioniert: {count} Kalender gefunden.',
  'The connection failed.': 'Die Verbindung ist fehlgeschlagen.',
  'The server rejected the login. Check the user name and enter the password again.':
    'Der Server hat den Login abgelehnt. Prüfe den Benutzernamen und gib das Passwort erneut ein.',
  'This browser has no password for the account. Enter it first.':
    'Dieser Browser hat kein Passwort für das Konto. Gib es zuerst ein.',
  'The administrator has not allowed this server.':
    'Der Administrator hat diesen Server nicht erlaubt.',
  'Too many requests. Try again in a moment.': 'Zu viele Anfragen. Versuche es gleich noch einmal.',
  'The server could not be reached.': 'Der Server ist nicht erreichbar.',
  'Nothing was found at this address.': 'Unter dieser Adresse wurde nichts gefunden.',
  'The server denied access.': 'Der Server hat den Zugriff verweigert.',
  'The server is not available right now.': 'Der Server ist gerade nicht verfügbar.',
  'The address did not answer like a CalDAV server.':
    'Die Adresse hat nicht wie ein CalDAV-Server geantwortet.',
  'The server refused the request.': 'Der Server hat die Anfrage abgelehnt.',
  ' This browser did not allow keeping it on this device, so it is kept until you close this tab.':
    ' Dieser Browser erlaubt kein Speichern auf diesem Gerät, darum bleibt es nur bis zum Schließen dieses Tabs erhalten.',
  'The server did not return a credential. Try again.':
    'Der Server hat keine Zugangsberechtigung zurückgegeben. Versuche es erneut.',
  'save the password': 'Das Speichern des Passworts',
  'Could not save the password.': 'Das Passwort konnte nicht gespeichert werden.',

  // ---- Import
  'Import a calendar file': 'Kalenderdatei importieren',
  'Add the events of an {ics} file to one of your calendars. The file is read in your browser. Events the calendar already has are left as they are, so importing a file twice does not make copies. To follow a calendar that keeps changing, add an iCal subscription instead.':
    'Füge die Termine einer {ics}-Datei zu einem deiner Kalender hinzu. Die Datei wird in deinem Browser gelesen. Termine, die der Kalender schon hat, bleiben unverändert, ein doppelter Import erzeugt also keine Kopien. Um einem Kalender zu folgen, der sich ändert, füge stattdessen ein iCal-Abonnement hinzu.',
  'Events that could not be imported': 'Termine, die nicht importiert werden konnten',
  '… and {count} more': '… und {count} weitere',
  'You can import the file again: events that are already in the calendar are left alone.':
    'Du kannst die Datei erneut importieren: Termine, die schon im Kalender sind, bleiben unverändert.',
  'Import again': 'Erneut importieren',
  'Calendar file': 'Kalenderdatei',
  'An .ics file of up to {size} and {max} events.':
    'Eine .ics-Datei mit bis zu {size} und {max} Terminen.',
  'Calendar name': 'Kalendername',
  Events: 'Termine',
  'Not imported': 'Nicht importiert',
  'The first events in the file': 'Die ersten Termine in der Datei',
  'What is not imported': 'Was nicht importiert wird',
  'Import into': 'Importieren in',
  'New calendar…': 'Neuer Kalender …',
  'Name of the new calendar': 'Name des neuen Kalenders',
  'Creating the calendar…': 'Kalender wird angelegt …',
  'The calendar “{name}” was created.': 'Der Kalender „{name}“ wurde angelegt.',
  'The calendar could not be created: {problem}':
    'Der Kalender konnte nicht angelegt werden: {problem}',
  'Import progress': 'Importfortschritt',
  '{done} of {total}': '{done} von {total}',
  'Importing…': 'Wird importiert …',
  'Import {count} event | Import {count} events':
    '{count} Termin importieren | {count} Termine importieren',
  'Cancel import': 'Import abbrechen',
  'Reading the file…': 'Datei wird gelesen …',
  'File read: {count} event can be imported. | File read: {count} events can be imported.':
    'Datei gelesen: {count} Termin kann importiert werden. | Datei gelesen: {count} Termine können importiert werden.',
  'File read: it has no events to import.':
    'Datei gelesen: Sie enthält keine Termine zum Importieren.',
  'Importing {count} event… | Importing {count} events…':
    '{count} Termin wird importiert … | {count} Termine werden importiert …',
  'The import could not be run. Try again.':
    'Der Import konnte nicht ausgeführt werden. Versuche es erneut.',
  'Cancelling…': 'Wird abgebrochen …',
  'Import cancelled': 'Import abgebrochen',
  'Import stopped': 'Import gestoppt',
  'Import finished': 'Import abgeschlossen',

  // ---- Import: messages
  'Already in the calendar.': 'Schon im Kalender.',
  'Not imported: the import was cancelled.': 'Nicht importiert: Der Import wurde abgebrochen.',
  'Cancelled while it was being sent. It may have been saved.':
    'Beim Senden abgebrochen. Er wurde vielleicht gespeichert.',
  'Not imported: the import stopped before it got here.':
    'Nicht importiert: Der Import wurde vorher gestoppt.',
  'Something went wrong while saving this event.':
    'Beim Speichern dieses Termins ist etwas schiefgegangen.',
  'The calendar service could not save this event because of a conflict.':
    'Der Kalenderdienst konnte diesen Termin wegen eines Konflikts nicht speichern.',
  'Too large for the calendar service.': 'Zu groß für den Kalenderdienst.',
  'The calendar service did not accept this event.':
    'Der Kalenderdienst hat diesen Termin nicht angenommen.',
  'The calendar service is busy or down.':
    'Der Kalenderdienst ist überlastet oder nicht verfügbar.',
  'The calendar service is not reachable.': 'Der Kalenderdienst ist nicht erreichbar.',
  'The calendar service gave an unexpected answer. The event may have been saved: import again to check.':
    'Der Kalenderdienst hat unerwartet geantwortet. Der Termin wurde vielleicht gespeichert: Importiere erneut, um das zu prüfen.',
  'Imported {count} event. | Imported {count} events.':
    '{count} Termin importiert. | {count} Termine importiert.',
  'Nothing was imported.': 'Es wurde nichts importiert.',
  '{count} event was already in the calendar. | {count} events were already in the calendar.':
    '{count} Termin war schon im Kalender. | {count} Termine waren schon im Kalender.',
  '{count} event could not be imported. | {count} events could not be imported.':
    '{count} Termin konnte nicht importiert werden. | {count} Termine konnten nicht importiert werden.',
  '{count} event was not imported because the import was cancelled. | {count} events were not imported because the import was cancelled.':
    '{count} Termin wurde nicht importiert, weil der Import abgebrochen wurde. | {count} Termine wurden nicht importiert, weil der Import abgebrochen wurde.',
  '{count} event was not imported because the import stopped. | {count} events were not imported because the import stopped.':
    '{count} Termin wurde nicht importiert, weil der Import gestoppt wurde. | {count} Termine wurden nicht importiert, weil der Import gestoppt wurde.',
  '{count} event was being sent when the import was cancelled and may have been saved. | {count} events were being sent when the import was cancelled and may have been saved.':
    '{count} Termin wurde gerade gesendet, als der Import abgebrochen wurde, und wurde vielleicht gespeichert. | {count} Termine wurden gerade gesendet, als der Import abgebrochen wurde, und wurden vielleicht gespeichert.',
  '(no title)': '(kein Titel)',
  '{count} to-do (only events are imported) | {count} to-dos (only events are imported)':
    '{count} Aufgabe (nur Termine werden importiert) | {count} Aufgaben (nur Termine werden importiert)',
  '{count} journal entry (only events are imported) | {count} journal entries (only events are imported)':
    '{count} Journaleintrag (nur Termine werden importiert) | {count} Journaleinträge (nur Termine werden importiert)',
  '{count} free/busy block (only events are imported) | {count} free/busy blocks (only events are imported)':
    '{count} Frei/Belegt-Block (nur Termine werden importiert) | {count} Frei/Belegt-Blöcke (nur Termine werden importiert)',
  '{count} other item (only events are imported) | {count} other items (only events are imported)':
    '{count} anderer Eintrag (nur Termine werden importiert) | {count} andere Einträge (nur Termine werden importiert)',
  '{count} event without a start time | {count} events without a start time':
    '{count} Termin ohne Beginn | {count} Termine ohne Beginn',
  '{count} damaged item that could not be read | {count} damaged items that could not be read':
    '{count} beschädigter Eintrag, der nicht gelesen werden konnte | {count} beschädigte Einträge, die nicht gelesen werden konnten',
  '{count} repeated event (the same ID as an earlier one in the file) | {count} repeated events (the same ID as an earlier one in the file)':
    '{count} wiederholter Termin (dieselbe ID wie ein früherer in der Datei) | {count} wiederholte Termine (dieselbe ID wie ein früherer in der Datei)',
  'This is not an iCalendar (.ics) file.': 'Das ist keine iCalendar-Datei (.ics).',
  'This file is in an old calendar format (vCalendar 1.0), which cannot be imported.':
    'Diese Datei hat ein altes Kalenderformat (vCalendar 1.0), das nicht importiert werden kann.',
  'The file has {count} events, more than the {max} that can be imported at once. Split the calendar into smaller files.':
    'Die Datei hat {count} Termine, mehr als die {max}, die auf einmal importiert werden können. Teile den Kalender in kleinere Dateien.',
  'This is not a text file. Choose an .ics file saved as UTF-8 text.':
    'Das ist keine Textdatei. Wähle eine .ics-Datei, die als UTF-8-Text gespeichert ist.',
  'The file could not be read.': 'Die Datei konnte nicht gelesen werden.',
  'The file is empty.': 'Die Datei ist leer.',
  'The file is too large ({size}). Files up to {max} can be imported; split the calendar into smaller files.':
    'Die Datei ist zu groß ({size}). Dateien bis {max} können importiert werden. Teile den Kalender in kleinere Dateien.',
  'This does not look like a calendar file. Choose an .ics file.':
    'Das sieht nicht nach einer Kalenderdatei aus. Wähle eine .ics-Datei.',
  'Stopped after {count} failures in a row. {message}':
    'Nach {count} Fehlern in Folge gestoppt. {message}',

  // Calendar links
  'Calendar links': 'Kalenderlinks',
  'Give people without an account a read-only view of one of your calendars. They open the link and enter the password you choose here.':
    'Gib Menschen ohne Konto Lesezugriff auf einen deiner Kalender. Sie öffnen den Link und geben das Passwort ein, das du hier wählst.',
  'The link shows the title, time and place of each event, never descriptions or the people invited; private events show as busy. It shows what you can see, and stops working when you lose access to the calendar or do not sign in to this app for {days}.':
    'Der Link zeigt Titel, Zeit und Ort jedes Termins, nie Beschreibungen oder Eingeladene; private Termine erscheinen als belegt. Er zeigt, was du sehen kannst, und funktioniert nicht mehr, wenn du den Zugriff auf den Kalender verlierst oder dich {days} lang nicht in dieser App anmeldest.',
  'New link to “{name}”': 'Neuer Link zu „{name}“',
  'This address is shown only once. Send it with the password, ideally on different ways. If you lose it, withdraw the link and make a new one.':
    'Diese Adresse wird nur einmal angezeigt. Schicke sie zusammen mit dem Passwort, am besten auf verschiedenen Wegen. Wenn du sie verlierst, ziehe den Link zurück und erstelle einen neuen.',
  Address: 'Adresse',
  'Who is the link for? Optional; the calendar name if empty.':
    'Für wen ist der Link? Optional; leer bleibt der Name des Kalenders.',
  'At least {min} characters. Visitors need it to open the link.':
    'Mindestens {min} Zeichen. Besucher brauchen es, um den Link zu öffnen.',
  'Show password': 'Passwort anzeigen',
  'Making…': 'Wird erstellt…',
  'Make link': 'Link erstellen',
  'Your calendar links': 'Deine Kalenderlinks',
  'Last opened': 'Zuletzt geöffnet',
  Withdraw: 'Zurückziehen',
  'Withdraw link {label}': 'Link {label} zurückziehen',
  'You have no calendar links yet.': 'Du hast noch keine Kalenderlinks.',
  'Loading calendar links': 'Kalenderlinks werden geladen',
  'Withdraw the link “{label}”?': 'Den Link „{label}“ zurückziehen?',
  'The address stops working at once, also for pages that are open. This cannot be undone.':
    'Die Adresse funktioniert sofort nicht mehr, auch auf geöffneten Seiten. Das lässt sich nicht rückgängig machen.',
  'Withdraw link': 'Link zurückziehen',
  'load your calendar links': 'Das Laden deiner Kalenderlinks',
  'Could not copy automatically. The address is selected: press Ctrl+C to copy it.':
    'Automatisches Kopieren ging nicht. Die Adresse ist markiert: Drücke Strg+C, um sie zu kopieren.',
  'withdraw the link': 'Das Zurückziehen des Links',
  'Link “{label}” withdrawn.': 'Link „{label}“ zurückgezogen.',
  'Choose a password of at least {min} characters.':
    'Wähle ein Passwort mit mindestens {min} Zeichen.',
  'The link was not made: {problems}.': 'Der Link wurde nicht erstellt: {problems}.',
  'The link was not made.': 'Der Link wurde nicht erstellt.',
  'make the link': 'Das Erstellen des Links',
}
