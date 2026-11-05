// German texts of the area "groups" (docs/i18n.md). One entry per English text: 'English': 'Deutsch'.
export const groups: Readonly<Record<string, string>> = {
  // The overflow menu, the page and its list
  Groups: 'Gruppen',
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
  'Members of a group can create and share its calendars. Its members are chosen here; Kanidm groups are imported and cannot be changed here.':
    'Mitglieder einer Gruppe können deren Kalender anlegen und teilen. Die Mitglieder wählst du hier aus; Gruppen aus Kanidm werden übernommen und lassen sich hier nicht ändern.',
  'Letters, digits, dots, dashes and underscores. It cannot be changed later.':
    'Buchstaben, Ziffern, Punkte, Bindestriche und Unterstriche. Der Name lässt sich später nicht ändern.',
  'Create group': 'Gruppe anlegen',
  'Use up to 64 letters, digits, dots, dashes and underscores. Start with a letter or a digit.':
    'Bis zu 64 Buchstaben, Ziffern, Punkte, Bindestriche und Unterstriche. Beginne mit einem Buchstaben oder einer Ziffer.',

  // Members
  Members: 'Mitglieder',
  'From Kanidm': 'Aus Kanidm',
  'This group is imported from Kanidm. Its members are changed there, not here. The list is updated from Kanidm regularly.':
    'Diese Gruppe wird aus Kanidm übernommen. Ihre Mitglieder werden dort geändert, nicht hier. Die Liste wird regelmäßig aus Kanidm aktualisiert.',
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
