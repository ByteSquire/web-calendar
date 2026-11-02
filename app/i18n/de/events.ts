// German texts of the area "events" (docs/i18n.md). One entry per English text: 'English': 'Deutsch'.
export const events: Readonly<Record<string, string>> = {
  // Booking flow, reasons and messages
  'Busy (pending)': 'Belegt (ausstehend)',
  'Booked by {name}': 'Gebucht von {name}',
  Booked: 'Gebucht',
  'the calendar of the event cannot be booked from':
    'aus dem Kalender des Termins kann nicht gebucht werden',
  '{a} and {b}': '{a} und {b}',
  '{list} and {last}': '{list} und {last}',
  '{name} could not be booked: {reason}.': '{name} konnte nicht gebucht werden: {reason}.',
  '{names} booked': '{names} gebucht',
  '{names} requested, waiting for approval': '{names} angefragt, wartet auf Annahme',
  'it is already booked at that time': 'zu dieser Zeit schon gebucht',
  'you have reached the limit of bookings for that day':
    'du hast das Limit an Buchungen für diesen Tag erreicht',
  'you have reached the limit of bookings open at once':
    'du hast das Limit gleichzeitig offener Buchungen erreicht',
  'the booking is longer than allowed': 'die Buchung ist länger als erlaubt',
  'the booking is too far ahead': 'die Buchung liegt zu weit in der Zukunft',
  'the time has already started or passed': 'die Zeit hat schon begonnen oder ist vorbei',
  'the time slot is not valid': 'der Zeitraum ist ungültig',
  'the calendar of the event is not one of yours': 'der Kalender des Termins gehört dir nicht',
  'you cannot read the calendar of the event': 'du kannst den Kalender des Termins nicht lesen',
  'it is not available': 'nicht verfügbar',
  'its state has changed meanwhile': 'der Zustand hat sich inzwischen geändert',
  'you are signed out': 'du bist abgemeldet',
  'the server could not be reached': 'der Server ist nicht erreichbar',
  'you may not book it': 'keine Berechtigung zum Buchen',
  'it no longer exists or you may not see it':
    'existiert nicht mehr oder ist für dich nicht sichtbar',
  'too many requests, wait a moment': 'zu viele Anfragen, warte einen Moment',
  'the server did not accept the time': 'der Server hat die Zeit nicht akzeptiert',
  'the server did not accept the booking': 'der Server hat die Buchung nicht akzeptiert',
  'Could not accept the booking: {reason}.':
    'Die Buchung konnte nicht angenommen werden: {reason}.',
  'Could not decline the booking: {reason}.':
    'Die Buchung konnte nicht abgelehnt werden: {reason}.',
  'Could not cancel the booking: {reason}.': 'Die Buchung konnte nicht storniert werden: {reason}.',
  'Your booking for {name} moved, re-approval requested':
    'Deine Buchung für {name} wurde verschoben, erneute Annahme angefragt',
  'Your booking for {name} was cancelled: the event is gone':
    'Deine Buchung für {name} wurde storniert: Der Termin existiert nicht mehr',
  'Your booking for {name} was declined: another request was approved for that time':
    'Deine Buchung für {name} wurde abgelehnt: Für diese Zeit wurde eine andere Anfrage angenommen',
  'Your booking for {name} was approved': 'Deine Buchung für {name} wurde angenommen',
  'Your booking for {name} was declined': 'Deine Buchung für {name} wurde abgelehnt',
  'Your booking for {name} was cancelled': 'Deine Buchung für {name} wurde storniert',
  '{count} bookings changed': '{count} Buchungen geändert',
  'Booking of {name} declined.': 'Buchung von {name} abgelehnt.',
  'Booking of {name} cancelled.': 'Buchung von {name} storniert.',
  'Booking of {name} approved.': 'Buchung von {name} angenommen.',
  'Booking of {name} approved. {count} overlapping request was declined and the requesters were told. | Booking of {name} approved. {count} overlapping requests were declined and the requesters were told.':
    'Buchung von {name} angenommen. {count} überschneidende Anfrage wurde abgelehnt und die anfragende Person informiert. | Buchung von {name} angenommen. {count} überschneidende Anfragen wurden abgelehnt und die anfragenden Personen informiert.',
  View: 'Ansehen',

  // Repeat rule
  'Does not repeat': 'Keine Wiederholung',
  'Every day': 'Jeden Tag',
  'Every week': 'Jede Woche',
  'Every month': 'Jeden Monat',
  'Every year': 'Jedes Jahr',
  'On a date': 'An einem Datum',
  'After a number of times': 'Nach einer Anzahl',
  'Enter the last date of the repeat.': 'Gib das letzte Datum der Wiederholung ein.',
  'The repeat must not end before the event starts.':
    'Die Wiederholung darf nicht vor dem Beginn des Termins enden.',
  'Enter a number from 1 to {max}.': 'Gib eine Zahl von 1 bis {max} ein.',

  // Write errors and outcomes
  'This event was changed by someone else. It has been reloaded — try again.':
    'Dieser Termin wurde von jemand anderem geändert. Er wurde neu geladen – versuche es erneut.',
  'All events of this series can\'t be changed this way. Edit single occurrences, or choose "This and following events".':
    'Alle Termine dieser Serie lassen sich so nicht ändern. Bearbeite einzelne Termine oder wähle „Dieser und folgende Termine“.',
  'This event was already deleted. The calendar has been reloaded.':
    'Dieser Termin wurde schon gelöscht. Der Kalender wurde neu geladen.',
  'This event no longer exists. The calendar has been reloaded.':
    'Dieser Termin existiert nicht mehr. Der Kalender wurde neu geladen.',
  'The calendar service could not save the event because of a conflict. Try again.':
    'Der Kalenderdienst konnte den Termin wegen eines Konflikts nicht speichern. Versuche es erneut.',
  'An event with this id already exists. Try again.':
    'Ein Termin mit dieser ID existiert schon. Versuche es erneut.',
  'The calendar service is busy or down. Try again in a moment.':
    'Der Kalenderdienst ist ausgelastet oder nicht verfügbar. Versuche es gleich noch einmal.',
  'The calendar service is not reachable. Check your connection and try again.':
    'Der Kalenderdienst ist nicht erreichbar. Prüfe deine Verbindung und versuche es erneut.',
  'The request was cancelled. Try again.': 'Die Anfrage wurde abgebrochen. Versuche es erneut.',
  'The calendar service gave an unexpected answer. The calendar has been reloaded; check whether the change was saved.':
    'Der Kalenderdienst hat unerwartet geantwortet. Der Kalender wurde neu geladen; prüfe, ob die Änderung gespeichert wurde.',
  'The calendar service did not accept this change. Check the details and try again.':
    'Der Kalenderdienst hat diese Änderung nicht akzeptiert. Prüfe die Angaben und versuche es erneut.',
  'Something went wrong while saving. Try again.':
    'Beim Speichern ist etwas schiefgegangen. Versuche es erneut.',
  'This occurrence no longer exists. The calendar has been reloaded.':
    'Dieser Termin der Serie existiert nicht mehr. Der Kalender wurde neu geladen.',
  "This event is stored in a form this app can't read, so it can't be changed here.":
    'Dieser Termin ist in einer Form gespeichert, die die App nicht lesen kann. Er lässt sich hier nicht ändern.',
  'Part of this change was saved: the following events were copied into a new series, but the original could not be updated because someone else changed it. Some events may now appear twice. The calendar has been reloaded; delete the extra events.':
    'Ein Teil der Änderung wurde gespeichert: Die folgenden Termine wurden in eine neue Serie kopiert, aber das Original konnte nicht aktualisiert werden, weil jemand anderes es geändert hat. Einige Termine erscheinen jetzt eventuell doppelt. Der Kalender wurde neu geladen; lösche die überzähligen Termine.',
  'Part of this change was saved: the following events were copied into a new series, but the original could not be updated because the calendar service could not be reached. Some events may now appear twice. The calendar has been reloaded; delete the extra events.':
    'Ein Teil der Änderung wurde gespeichert: Die folgenden Termine wurden in eine neue Serie kopiert, aber das Original konnte nicht aktualisiert werden, weil der Kalenderdienst nicht erreichbar war. Einige Termine erscheinen jetzt eventuell doppelt. Der Kalender wurde neu geladen; lösche die überzähligen Termine.',
  'Part of this change was saved: the following events were copied into a new series, but the original could not be updated. Some events may now appear twice. The calendar has been reloaded; delete the extra events.':
    'Ein Teil der Änderung wurde gespeichert: Die folgenden Termine wurden in eine neue Serie kopiert, aber das Original konnte nicht aktualisiert werden. Einige Termine erscheinen jetzt eventuell doppelt. Der Kalender wurde neu geladen; lösche die überzähligen Termine.',
  'Something went wrong while deleting the event. Try again.':
    'Beim Löschen des Termins ist etwas schiefgegangen. Versuche es erneut.',
  'Something went wrong while saving the event. Try again.':
    'Beim Speichern des Termins ist etwas schiefgegangen. Versuche es erneut.',
  'Event added': 'Termin hinzugefügt',
  'Event updated': 'Termin aktualisiert',
  'Nothing to save': 'Nichts zu speichern',
  'Event deleted': 'Termin gelöscht',
  'Event was already deleted': 'Termin war schon gelöscht',
  'You can only see that you are busy, not the event itself.':
    'Du siehst nur, dass du belegt bist, nicht den Termin selbst.',
  "This event's calendar is not available.": 'Der Kalender dieses Termins ist nicht verfügbar.',
  'This calendar is a subscription and is read-only.':
    'Dieser Kalender ist ein Abonnement und schreibgeschützt.',
  'This calendar is read-only for you.': 'Dieser Kalender ist für dich schreibgeschützt.',
  "Events in this calendar can't be changed here.":
    'Termine in diesem Kalender lassen sich hier nicht ändern.',
  "This event can't be changed here.": 'Dieser Termin lässt sich hier nicht ändern.',
  'The calendar service is not available.': 'Der Kalenderdienst ist nicht verfügbar.',

  // Which events
  'This event': 'Dieser Termin',
  'This and following events': 'Dieser und folgende Termine',
  'All events': 'Alle Termine',
  'Delete repeating event': 'Wiederholten Termin löschen',
  'Edit repeating event': 'Wiederholten Termin bearbeiten',
  'Delete which events?': 'Welche Termine löschen?',
  'Change which events?': 'Welche Termine ändern?',
  Continue: 'Weiter',

  // Summary and validation
  '{day}, all day': '{day}, ganztägig',
  '{first} – {last}, all day': '{first} – {last}, ganztägig',
  'Enter a title.': 'Gib einen Titel ein.',
  'Choose a calendar.': 'Wähle einen Kalender.',
  'Enter a start date.': 'Gib ein Startdatum ein.',
  'Enter a start date and time.': 'Gib Startdatum und -uhrzeit ein.',
  'Enter an end date.': 'Gib ein Enddatum ein.',
  'Enter an end date and time.': 'Gib Enddatum und -uhrzeit ein.',
  'The end date must not be before the start date.':
    'Das Enddatum darf nicht vor dem Startdatum liegen.',
  'The end must be after the start.': 'Das Ende muss nach dem Beginn liegen.',

  // Event form and edit dialog
  'Edit event': 'Termin bearbeiten',
  'To book a resource for a repeating event, edit one occurrence ("This event").':
    'Um eine Ressource für einen wiederholten Termin zu buchen, bearbeite einen einzelnen Termin („Dieser Termin“).',
  'Changing this event only.': 'Nur dieser Termin wird geändert.',
  'Changing this and the following events.': 'Dieser und die folgenden Termine werden geändert.',
  'Changing all events of the series.': 'Alle Termine der Serie werden geändert.',
  'Change the details of this event.': 'Ändere die Details dieses Termins.',
  Title: 'Titel',
  'Start and end': 'Beginn und Ende',
  'Start date': 'Startdatum',
  Start: 'Beginn',
  'End date': 'Enddatum',
  End: 'Ende',
  'Times are in your time zone ({zone}).': 'Zeiten in deiner Zeitzone ({zone}).',
  Repeat: 'Wiederholung',
  'Months without a day {day} are skipped.': 'Monate ohne den {day}. werden übersprungen.',
  Ends: 'Endet',
  'Last day of the repeat': 'Letzter Tag der Wiederholung',
  'Number of times': 'Anzahl',
  Details: 'Details',
  Status: 'Status',

  // Event sheet
  When: 'Wann',
  'Organization time ({zone}): {date}, {time}': 'Zeit der Organisation ({zone}): {date}, {time}',
  Resource: 'Ressource',
  'Editing arrives with the real calendar service':
    'Bearbeiten kommt mit dem echten Kalenderdienst',
  'Events are read-only in this preview.': 'Termine sind in dieser Vorschau schreibgeschützt.',

  // Edit and delete flow
  'Only this event is deleted; the rest of the series stays.':
    'Nur dieser Termin wird gelöscht, der Rest der Serie bleibt.',
  'This event and all the events after it are deleted.':
    'Dieser Termin und alle folgenden werden gelöscht.',
  'The whole series is deleted.': 'Die ganze Serie wird gelöscht.',
  'The event is removed from the calendar.': 'Der Termin wird aus dem Kalender entfernt.',
  "This event can't be changed": 'Dieser Termin lässt sich nicht ändern',
  'The booking was made, but the event could not be marked with it.':
    'Die Buchung wurde gemacht, aber der Termin konnte nicht damit markiert werden.',
  'The event could not be saved': 'Der Termin konnte nicht gespeichert werden',
  'Nothing was booked. {reasons}': 'Es wurde nichts gebucht. {reasons}',
  'The event was saved, but not everything was booked':
    'Der Termin wurde gespeichert, aber nicht alles wurde gebucht',
  '"{title}" was deleted.': '„{title}“ wurde gelöscht.',
  '"{title}" and the events after it were deleted.':
    '„{title}“ und die folgenden Termine wurden gelöscht.',
  'All events of "{title}" were deleted.': 'Alle Termine von „{title}“ wurden gelöscht.',
  'The event could not be deleted': 'Der Termin konnte nicht gelöscht werden',
  'The calendar has been reloaded.': 'Der Kalender wurde neu geladen.',
  'This cannot be undone.': 'Das lässt sich nicht rückgängig machen.',
  'Delete "{title}"?': '„{title}“ löschen?',

  // Quick add and Add
  'Add event': 'Termin hinzufügen',
  'Create an event': 'Einen Termin erstellen',
  'This event repeats, so it is saved without booking. Open one occurrence afterwards and add the resource there.':
    'Dieser Termin wiederholt sich und wird deshalb ohne Buchung gespeichert. Öffne danach einen einzelnen Termin und füge die Ressource dort hinzu.',
  'The calendar': 'Der Kalender',
  '{name} is hidden, so the new event is not shown.':
    '{name} ist ausgeblendet, der neue Termin wird deshalb nicht angezeigt.',
  '{title} in {name}.': '{title} in {name}.',
  Show: 'Anzeigen',
  'Saved as a draft: nothing is booked yet.':
    'Als Entwurf gespeichert: Es ist noch nichts gebucht.',
  '{names} requested, waiting for approval.': '{names} angefragt, wartet auf Annahme.',
  'Choose a calendar you can write to.': 'Wähle einen Kalender mit Schreibrecht.',
  'The event could not be added': 'Der Termin konnte nicht hinzugefügt werden',
  'The event was saved. {reasons}': 'Der Termin wurde gespeichert. {reasons}',
  'Remove {name}': '{name} entfernen',
  'Add a resource': 'Ressource hinzufügen',
  pending: 'ausstehend',
  approved: 'angenommen',
  declined: 'abgelehnt',
  cancelled: 'storniert',
  'Book right away': 'Sofort buchen',
  'Loading the bookings': 'Buchungen werden geladen',
  'Pending requests': 'Offene Anfragen',
  'There are no pending requests.': 'Es gibt keine offenen Anfragen.',
  'Requested by {name}': 'Angefragt von {name}',
  'The event of this booking cannot be found right now. It may have been moved or deleted; check before you approve.':
    'Der Termin dieser Buchung wird gerade nicht gefunden. Er wurde vielleicht verschoben oder gelöscht; prüfe das vor dem Annehmen.',
  Accept: 'Annehmen',
  Decline: 'Ablehnen',
  'My bookings': 'Meine Buchungen',
  'You have no upcoming bookings.': 'Du hast keine anstehenden Buchungen.',
  'Waiting for approval': 'Wartet auf Annahme',
  Approved: 'Angenommen',
  'Cancel booking': 'Buchung stornieren',
  'Cancel booking of {resource}, {slot}': 'Buchung von {resource} stornieren, {slot}',
  'Overlaps another pending request | Overlaps {count} other pending requests':
    'Überschneidet sich mit einer anderen offenen Anfrage | Überschneidet sich mit {count} anderen offenen Anfragen',
  '{lead}: {names}. Approving this one declines the others.':
    '{lead}: {names}. Wenn du diese annimmst, werden die anderen abgelehnt.',
  '{lead}. Approving this one declines the others.':
    '{lead}. Wenn du diese annimmst, werden die anderen abgelehnt.',
  "Accept {requester}'s request for {resource}, {slot}":
    'Anfrage von {requester} für {resource} annehmen, {slot}',
  "Decline {requester}'s request for {resource}, {slot}":
    'Anfrage von {requester} für {resource} ablehnen, {slot}',
}
