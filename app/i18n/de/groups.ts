// German texts of the area "groups" (docs/i18n.md). One entry per English text: 'English': 'Deutsch'.
export const groups: Readonly<Record<string, string>> = {
  // The overflow menu, the page and its list
  Groups: 'Gruppen',
  'Not everybody is offered when you add members or share: the list shows the first {count} people, sorted by name.':
    'Beim Hinzufügen von Mitgliedern und beim Teilen wird nicht jede Person angeboten: Die Liste zeigt die ersten {count} Personen, nach Namen sortiert.',
  'Groups share calendars. Open a group to see its members and calendars, create calendars and share them with people or other groups.':
    'Gruppen teilen Kalender. Öffne eine Gruppe, um ihre Mitglieder und Kalender zu sehen, Kalender anzulegen und mit Personen oder anderen Gruppen zu teilen.',
  'Loading groups': 'Gruppen werden geladen',
  'There are no groups yet. Create the first one below.':
    'Es gibt noch keine Gruppen. Lege unten die erste an.',
  'You are not in a group yet. Ask an administrator to add you.':
    'Du bist noch in keiner Gruppe. Bitte einen Administrator, dich hinzuzufügen.',
  '{count} member | {count} members': '{count} Mitglied | {count} Mitglieder',
  'You are a member': 'Du bist Mitglied',
  'Open {name}': '{name} öffnen',
  Open: 'Öffnen',
  'Delete group {name}': 'Gruppe {name} löschen',
  'Loading the group': 'Gruppe wird geladen',
  'Delete {name}?': '{name} löschen?',
  'The group is deleted. Groups that still own calendars cannot be deleted; delete their calendars first. This cannot be undone.':
    'Die Gruppe wird gelöscht. Gruppen, die noch Kalender besitzen, lassen sich nicht löschen; lösche zuerst deren Kalender. Das lässt sich nicht rückgängig machen.',
  'save the change': 'Das Speichern der Änderung',
  'load the group': 'Das Laden der Gruppe',
  'load the groups': 'Das Laden der Gruppen',
  '{name} was created.': '{name} wurde angelegt.',
  '{name} was deleted.': '{name} wurde gelöscht.',
  'This group no longer exists. Reload the page.':
    'Diese Gruppe gibt es nicht mehr. Lade die Seite neu.',
  'Members of {name} were saved.': 'Mitglieder von {name} wurden gespeichert.',

  // Create a group (admins)
  'Create a group': 'Gruppe anlegen',
  'Members of a group can create and share its calendars. Its members are chosen here; groups from your identity provider cannot be changed here.':
    'Mitglieder einer Gruppe können deren Kalender anlegen und teilen. Die Mitglieder wählst du hier aus; Gruppen aus deinem Identitätsanbieter lassen sich hier nicht ändern.',
  'Letters, digits, dots, dashes and underscores. It cannot be changed later.':
    'Buchstaben, Ziffern, Punkte, Bindestriche und Unterstriche. Der Name lässt sich später nicht ändern.',
  'Create group': 'Gruppe anlegen',
  'Use up to 64 letters, digits, dots, dashes and underscores. Start with a letter or a digit.':
    'Bis zu 64 Buchstaben, Ziffern, Punkte, Bindestriche und Unterstriche. Beginne mit einem Buchstaben oder einer Ziffer.',

  // Members
  Members: 'Mitglieder',
  'From your identity provider': 'Aus deinem Identitätsanbieter',
  'Built in': 'Eingebaut',
  'This group is imported from your identity provider. Its members are changed there, not here. A person is added or removed when they sign in.':
    'Diese Gruppe wird aus deinem Identitätsanbieter übernommen. Ihre Mitglieder werden dort geändert, nicht hier. Eine Person wird beim Anmelden hinzugefügt oder entfernt.',
  'Everyone whose last sign-in was at most {days} ago is in this group. It is built by the app and cannot be changed.':
    'Alle, deren letzte Anmeldung höchstens {days} zurückliegt, sind in dieser Gruppe. Die App bildet sie selbst; sie lässt sich nicht ändern.',

  // Groups from the identity provider (admins)
  'Groups from your identity provider': 'Gruppen aus deinem Identitätsanbieter',
  'These are the groups your identity provider named when people signed in. A group appears here after one of its members signed in. Import a group to use it here: its members are then added and removed as they sign in.':
    'Das sind die Gruppen, die dein Identitätsanbieter bei Anmeldungen genannt hat. Eine Gruppe erscheint hier, sobald sich eines ihrer Mitglieder angemeldet hat. Importiere eine Gruppe, um sie hier zu verwenden: Ihre Mitglieder werden dann beim Anmelden hinzugefügt und entfernt.',
  'Loading the groups of your identity provider':
    'Gruppen deines Identitätsanbieters werden geladen',
  'load the groups of your identity provider': 'Das Laden der Gruppen deines Identitätsanbieters',
  'No groups have been seen yet.': 'Bisher wurden keine Gruppen gesehen.',
  Import: 'Importieren',
  'Import {name}': '{name} importieren',
  'Stop importing': 'Import beenden',
  'Stop importing {name}': 'Import von {name} beenden',
  'Stop importing {name}?': 'Import von {name} beenden?',
  'The group, its members and the access rules that name it are removed here. Groups that still own calendars cannot be removed; delete their calendars first. The group stays in the list and can be imported again.':
    'Die Gruppe, ihre Mitglieder und die Zugriffsregeln, die sie nennen, werden hier entfernt. Gruppen, die noch Kalender besitzen, lassen sich nicht entfernen; lösche zuerst deren Kalender. Die Gruppe bleibt in der Liste und lässt sich erneut importieren.',
  'Only the first groups are shown.': 'Nur die ersten Gruppen werden angezeigt.',
  'Imported · {count} member | Imported · {count} members':
    'Importiert · {count} Mitglied | Importiert · {count} Mitglieder',
  'Two groups of the identity provider have this name. One has to be renamed there first.':
    'Zwei Gruppen des Identitätsanbieters haben diesen Namen. Eine muss dort zuerst umbenannt werden.',
  'A group here has this name already.': 'Eine Gruppe hier hat diesen Namen schon.',
  '{name} was imported. Its members are added as they sign in.':
    '{name} wurde importiert. Die Mitglieder werden beim Anmelden hinzugefügt.',
  '{name} is not imported any more.': '{name} wird nicht mehr importiert.',
  'This group has no members yet.': 'Diese Gruppe hat noch keine Mitglieder.',
  'Remove {name} from {group}': '{name} aus {group} entfernen',
  'Add a member': 'Mitglied hinzufügen',
  'Save members': 'Mitglieder speichern',
  'Undo changes': 'Änderungen verwerfen',

  // Calendars of a group
  'Calendars of this group. Everybody in the group can create and share them; the people and groups you share with can view or edit their events.':
    'Kalender dieser Gruppe. Alle in der Gruppe können sie anlegen und teilen; die Personen und Gruppen, mit denen geteilt wird, können deren Termine ansehen oder bearbeiten.',
  'This group has no calendars yet.': 'Diese Gruppe hat noch keine Kalender.',
  Share: 'Teilen',
  'The calendar, its events and its sharing are deleted. This cannot be undone.':
    'Der Kalender, seine Termine und seine Freigaben werden gelöscht. Das lässt sich nicht rückgängig machen.',
  '{name} was added.': '{name} wurde angelegt.',
  'Sharing of {name} was saved.': 'Freigabe von {name} wurde gespeichert.',
  'Edit calendar': 'Kalender bearbeiten',
  'New calendar': 'Neuer Kalender',
  'Add calendar': 'Kalender hinzufügen',
  'Choose a colour from the list.': 'Wähle eine Farbe aus der Liste.',

  // Sharing a calendar
  'Share {name}': '{name} teilen',
  'The group keeps full access. Choose who else may see this calendar.':
    'Die Gruppe behält vollen Zugriff. Wähle, wer diesen Kalender sonst sehen darf.',
  'Who has access': 'Wer Zugriff hat',
  'Owner, {level}, cannot be changed here': 'Besitzer, {level}, ist hier nicht änderbar',
  'Stop sharing with {name}': 'Teilen mit {name} beenden',
  'Not shared with anybody else.': 'Mit niemand anderem geteilt.',
  'Shared with {names}.': 'Geteilt mit {names}.',
  'Share with': 'Teilen mit',
  'Use at most {max} characters.': 'Verwende höchstens {max} Zeichen.',
  'Remove the control characters from the name.': 'Entferne die Steuerzeichen aus dem Namen.',
  'Created in this app': 'In dieser App angelegt',
  'Sees all events and their details.': 'Sieht alle Termine und ihre Details.',
  'Choose a group': 'Gruppe auswählen',
  'Choose a group.': 'Wähle eine Gruppe aus.',
  'No group matches.': 'Keine Gruppe passt.',
  'Search groups': 'Gruppen suchen',
  'Save sharing': 'Freigabe speichern',
}
