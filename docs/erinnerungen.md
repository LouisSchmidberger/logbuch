# Erinnerungen (Web Push)

Eine Edge Function `send-notifications` läuft **alle 15 Minuten** (pg_cron). Wer was
bekommt, entscheidet komplett die SQL-Funktion `public.get_due_notifications(p_now,
p_after, p_limit)` (aktuelle Fassung in Migration `20260928100000_add_section_reminders`,
Eingaben seit `20260929120000_harden_reminder_inputs` von der DB geprüft, siehe
[datenmodell.md](datenmodell.md) → Robustheit). Die Function übersetzt deren Zeilen nur in
Nachrichten (`PUSH_TEXTS`) und verschickt sie. `sw.js` macht nur Push-Empfang/-Klick (kein
Offline-Caching). Alle Zeiten/Daten gelten in der **Ortszeit des Nutzers**
(`user_settings.timezone`).

## Wann erinnert wird

- **Standardzeit** (`user_settings.default_reminder_minute`, Default 22:00, in den
  Einstellungen in 15-Minuten-Schritten änderbar): alle aktiven Felder OHNE eigene Zeit
  (unabhängig vom Typ) werden gemeinsam geprüft. Fehlt noch mindestens eines, gibt es EINE
  Sammel-Nachricht – bewusst generisch, ohne Feldnamen (sonst bei vielen Feldern sehr
  lang).
- **Übersichten** zur Standardzeit: sonntags "Wochenübersicht ist da", am Monatsletzten
  "Monatsübersicht ist da" – gemeinsam per `summary_notifications` abschaltbar (ein
  Schalter für beide, bewusst keine getrennten) und nur, wenn im Zeitraum (Montag bzw.
  Monatserster bis heute) mindestens ein Tag mit nicht-leeren `filled_slugs` existiert.
  Bewusst **keine Mindestquote** (z.B. "≥ 3 Tage"): würde in schwierigen Phasen eher Druck
  machen, passt nicht zum Psyche-Fokus der App. Keine Jahresübersicht-Benachrichtigung (in
  die Jahresansicht schaut man laufend, nicht nur zum Jahresende).
- **Eigene Zeit je Feld** (`reminder_minute`, Checkbox "Eigene Erinnerungszeit",
  standardmäßig aus): z.B. ein Feld, das man morgens einträgt. Nennt das konkrete Feld
  (`Erinnerung: <Namen> noch nicht eingetragen.`), da gezielt einzelne Felder hervorgehoben
  werden sollen.
- **Eigene Zeit je Gruppe** (`habit_sections.reminder_minute`, Klartext, DB-Check auf
  15-Minuten-Raster): Felder der Gruppe fallen aus der Sammel-Erinnerung heraus und werden
  gemeinsam zur Zeit der Gruppe erinnert – **eine Nachricht pro Gruppe** (auch wenn mehrere
  Gruppen oder die Standardzeit auf denselben Slot fallen, bewusst nicht zusammengefasst),
  nur wenn darin ein heute geplantes Feld fehlt. **Vorrang: Feld > Gruppe > Standard** –
  ein Feld mit eigener Zeit behält diese auch in einer Gruppe mit Zeit (Nutzer-Entscheidung,
  damit einzelne Felder heraushebbar bleiben). Text nennt nur den Gruppennamen ("In „…“
  fehlt noch etwas", `sectionId` im Payload); Deep-Link zum ersten fehlenden Feld (klappt
  die Gruppe auf). Eingestellt im Gruppen-Formular, in der Verwaltung an der Kopfzeile
  angezeigt; im Feld-Formular sagt der Hinweis unter "Eigene Erinnerungszeit", dass die
  Gruppe die Zeit regelt (`habitFormReminderNote`, wechselt beim Ändern der Gruppe mit).
  `get_due_notifications` liefert dafür `section_missing` (`[{id, fields}]`).
- Uhrzeiten überall (Feld, Gruppe, Standardzeit, Tutorial) als zwei Auswahllisten Stunde :
  Minute (00/15/30/45, `reminderTimeInputHtml`/`readTimeInput`) – bewusst kein natives
  `<input type="time">`, dessen `step` viele Browser/Betriebssysteme ignorieren.

## Feldnamen erst auf dem Gerät

Der Server kennt keine Feldnamen (verschlüsselt). `get_due_notifications` liefert nur
Feld-IDs, `send-notifications` schickt einen allgemeinen Text ("Ein Feld wartet noch …")
plus `fieldIds`, und `sw.js` ersetzt ihn durch den Namen aus einer lokalen Liste
(IndexedDB `logbuch-push`, Store `meta`, Key `fieldNames`: `{ names: {id: name}, template
}`, angelegt von `saveFieldNamesForPush`). Fehlt die Liste oder eine ID, bleibt der
allgemeine Text. Gruppen genauso über `sectionNames`/`sectionTemplate`. Die Function
protokolliert in ihrer Antwort (landet in `net._http_response`, 6 h aufbewahrt) nur Anzahlen
je Art und Fehlerursachen – nie Texte, IDs oder Empfänger.

## Abos und Geräte

**Abmelden beendet die Erinnerungen dieses Geräts** (`endPushForThisDevice`: Server-Zeile
löschen, Browser-Abo kündigen, lokale Namensliste leeren – sonst kämen sie samt Feldnamen
weiter, auch für die nächste Person am Gerät). `checkPushStatus` kündigt ein Browser-Abo,
zu dem das angemeldete Konto keine Server-Zeile hat.

**Blockierte Mitteilungen** (`pushStatus: 'blocked'`, `pushOffStatus`, `pushBlockedHelp`):
wer im Erlaubnis-Dialog "Blockieren" tippt, wird vom Browser nie wieder gefragt – statt
einer Fehlermeldung (Sackgasse) zeigen Einstellungen und Tutorial eine kurze Anleitung je
Gerät (iPhone, Android installiert/im Browser, sonst), wie man es wieder erlaubt, plus
"Nochmal versuchen"; im Tutorial geht es mit [Weiter] ohne Erinnerungen weiter. Beim
Zurückkehren in die App wird die Erlaubnis neu geprüft.

**iOS**: Web-Push geht nur in der zum Home-Bildschirm hinzugefügten App (seit iOS 16.4) –
deshalb ist die Installation dort Voraussetzung, siehe [onboarding.md](onboarding.md).

## Deep-Links

Jede Benachrichtigung trägt ihr Ziel als URL
(`./logbuch.html?view=today|week|month&date=YYYY-MM-DD`, `deepLink()` in der Function) – `date` ist der gemeinte Tag, damit z.B. eine
erst Montagmorgen angetippte Wochenübersicht die gemeinte Woche zeigt. `sw.js` öffnet die
App mit dieser URL oder schickt einer offenen App das Ziel per `postMessage`
(`logbuch-navigate`, bewusst kein Neuladen – das würde ggf. erneutes Entsperren erzwingen).
`parseDeepLink`/`applyDeepLink` setzen Ansicht + Zeitraum (auch vor dem Entsperren) und
entfernen die Parameter per `history.replaceState`. Erinnerungen an ein Feld tragen
zusätzlich `&field=<Feld-ID>` (bei mehreren das erste): "Heute" scrollt zum Feld und hebt es
hervor (`pendingFieldFocus`, eingelöst am Ende von `render()`, sobald "Heute" mit geladenen
Feldern angezeigt wird – beim Kaltstart kann davor Entsperren/Laden liegen).

## Zeitzone pro Nutzer

`get_due_notifications` rechnet per `p_now AT TIME ZONE timezone` das lokale Datum und den
lokalen Viertelstunden-Slot (auf 15 Minuten **abgerundet**, damit ein verspäteter Cron-Lauf
keine Erinnerung verpasst). Die App gleicht `timezone` still mit dem Gerät ab
(`syncTimezone`, beim Laden der Einstellungen und bei `visibilitychange`; in den
Einstellungen als Hinweis unter der Standardzeit). Entscheidung "folgt dem Gerät" statt
manueller Einstellung: die App speichert Einträge unter dem **lokalen Gerätedatum** – nur
wenn die Erinnerung derselben Zeitzone folgt, prüfen beide denselben Tag. Grenzen
(akzeptiert): umgestellt wird erst, wenn die App am neuen Ort einmal geöffnet wurde; bei
zwei Geräten in verschiedenen Zeitzonen gilt das zuletzt geöffnete. `pg_cron` läuft in UTC –
das 15-Minuten-Raster passt für alle realen Zeitzonen (Offsets liegen auf Viertelstunden,
z.B. +5:30, +5:45), inkl. Sommer-/Winterzeit.

Bekannte Kleinigkeit: in der Nacht der Zeitumstellung kann ein 15-Minuten-Fenster doppelt
oder gar nicht auftreten (entspricht der Wanduhr). Vernachlässigbar, nicht behandelt.

## Skalierung

Die SQL-Funktion siebt früh auf Nutzer aus, bei denen im Slot überhaupt etwas fällig sein
kann, und liefert nur fällige Abos – die Function lädt nie alle Nutzer. Abruf per
**Keyset-Pagination** (`p.id > p_after`, `PAGE_SIZE` 500), da PostgREST bei `api.max_rows`
(1000) still kappt; Keyset statt Offset, damit eine zwischen zwei Seiten wegfallende Zeile
kein Abo überspringen lässt. `p_now` wird einmal pro Lauf festgelegt und macht die Funktion
testbar (`select * from get_due_notifications(timestamptz '...')` per `supabase db query
--linked`). Liefert Endpoints aller Nutzer – deshalb nur für `service_role` ausführbar.
Versand parallel mit max. `SEND_CONCURRENCY` (25), je Zustellung höchstens
`SEND_TIMEOUT_MS` (10 s). Bei Tausenden gleichzeitig fälligen Nutzern (Ballung am
22-Uhr-Default) stößt eher das Zeit-/CPU-Limit pro Function-Aufruf an (jede Nachricht wird
einzeln verschlüsselt/signiert). Jede Antwort misst `due`/`sent`/`failed`/`duration_ms`
(in `net._http_response`). Nächster Schritt bei Bedarf: Fan-out (Pakete auf eigene Aufrufe
bzw. `pgmq`-Queue verteilen, die Keyset-Seiten passen dafür) – fällig, sobald ein
22-Uhr-Lauf regelmäßig > 30 s braucht oder ~1.000 Push-Abos erreicht sind.

## Sprache

`send-notifications` hat eine eigene, bewusst simple `PUSH_TEXTS`-Tabelle (kein Teilen der
`t()`-Maschinerie über die Browser/Deno-Grenze) und liest `user_settings.locale` pro Nutzer.
