# Logbuch – Projektkontext

Habit-/Gewichts-Tracker, standalone gebaut (bewusst unabhängig von Claude.ai, läuft
komplett eigenständig). Ursprünglich als reiner Einzelnutzer-Tracker in einem
Claude.ai-Chat konzipiert, seitdem in Claude Code weitergeführt; seit der
`habit_definitions`-Umstellung (siehe Datenmodell) mehrnutzerfähig – jeder Nutzer
verwaltet seine eigenen Felder. Registrierung ist offen (kein Invite-System).

**Zielbild seit 2026-09-14**: langfristig breite Öffentlichkeit + eingeschränkt
kommerzielle Nutzung (Kurswechsel weg vom ursprünglichen "nur Freundeskreis"-Rahmen).
Rechtlicher/geschäftlicher Rahmen (Impressum, Datenschutzerklärung, AGB, Gewerbe-/
Kleinunternehmer-Status) klärt der Nutzer selbst außerhalb dieses Repos — hier laufen
nur die technischen Vorbereitungen (Sicherheit/Datenschutz zuerst, siehe unten). Bis
diese Rechtstexte stehen, weiterhin nur informelles Testen mit bekannten Personen.

## Stack

- **Frontend**: `logbuch.html` (Markup + CSS) und `logbuch.js` (die ganze App-Logik, als
  ES-Modul eingebunden), Vanilla JS (kein Framework, kein Build-Step). Seit 2026-09-29
  getrennt statt einer einzigen Datei – nur so kann die Content-Security-Policy (`<meta>`
  in `logbuch.html`) Inline-Skripte komplett verbieten (`script-src 'self'`): eingeschleuster
  Code liefe nicht, und `connect-src` lässt Daten nur zum eigenen Supabase-Projekt. Neue
  externe Quellen müssen dort ergänzt werden. **Keine Drittanbieter zur Laufzeit**:
  `supabase-js` liegt in fester Version gebündelt unter `vendor/` (Neu-Bauen siehe
  Dateikopf; bewusst nicht von einem CDN – wer das CDN kontrolliert, könnte Passwort und
  Schlüssel mitlesen), die Schriften (Fraunces, IBM Plex Sans, SIL OFL) unter `fonts/`
  (bewusst nicht Google Fonts – übermittelte bei jedem Öffnen die IP an Google).
  Rendering per Template-Strings +
  Event-Delegation auf `#app` (kein virtuelles DOM, bewusst einfach gehalten).
- **Service Worker**: `sw.js` – nur für Web-Push-Empfang/-Klick, sonst nichts (kein Offline-
  Caching gebaut).
- **Backend**: Supabase (Projekt-Ref `qdadoqcnqmrauhshvcts`, Region Europe) – Postgres-Tabellen,
  Auth (E-Mail/Passwort), Edge Function für Push-Versand.
  **Bekannter Supabase-Fehler "JWT issued at future" (PGRST303)**: PostgREST lehnt ein
  frisch ausgestelltes Token gelegentlich ab (Uhren-Abweichung Auth↔PostgREST bzw.
  Zeit-Cache-Bug, behoben erst in PostgREST 14.18/16.3 – Projekt am 2026-09-27 auf v14.5,
  Version prüfbar per `npx supabase services`). Trat v.a. beim Öffnen der App auf.
  Abgefangen zentral im Supabase-Client (`fetchWithJwtFutureRetry` in `logbuch.js`:
  REST-Anfragen mit genau diesem Fehler werden bis zu zweimal nach 1 s/2 s wiederholt –
  sicher auch für Schreibzugriffe, da PostgREST sie vor der Ausführung abweist).
- **Hosting**: GitHub Pages, statisch. `logbuch.html`, `logbuch.js` und `sw.js` (plus
  `vendor/`, `fonts/`) müssen im selben
  Wurzelverzeichnis des gehosteten Pfads liegen.
- **PWA-Installationshinweis** (`renderInstallHint` in `logbuch.js`): erscheint direkt
  im App-Bereich (nicht auf den Auth-Screens), solange die Seite nicht als PWA läuft
  (`display-mode: standalone` bzw. `navigator.standalone`) und nicht per
  `localStorage`-Flag dauerhaft weggeklickt wurde. Auf iOS ist "zum Home-Bildschirm
  hinzufügen" keine reine Komfortsache, sondern **Voraussetzung** dafür, dass
  Web-Push überhaupt funktioniert (Safari liefert Push sonst gar nicht aus, seit
  iOS 16.4) — Hinweistext ist deshalb iOS-spezifisch dringlicher formuliert.
- **Installation vor dem Anmelden** (`renderInstallGate`, seit 2026-09-29): auf dem Handy
  im Browser kommt noch VOR Registrieren/Anmelden eine eigene Seite "Erst mal ein Zuhause
  für Logbuch" mit Begründung ("Warum?"-Kasten, iOS: sonst keine Erinnerungen) und
  Anleitung mit gezeichneten Symbolen; auf Android/Chrome zusätzlich ein echter
  Installieren-Knopf (`beforeinstallprompt`). So registriert man sich gleich in der
  installierten App – vorher kam der Hinweis erst nach dem Anmelden (zweites Anmelden in
  der App nötig) und wurde oft einfach weggeklickt. "Ich bleib erst mal im Browser" merkt
  sich das Gerät (`localStorage` `installGateSkipped`). Weil der Bestätigungslink aus der
  Registrierungs-Mail im Browser aufgeht, nicht in der App: kommt man darüber
  (`#…type=signup`, vor dem Start von supabase-js gemerkt, `ARRIVED_VIA_SIGNUP_CONFIRM`)
  auf dem Handy im Browser an, zeigt `renderConfirmLanding` "E-Mail bestätigt – zurück zur
  App" statt der Anmeldung (Weitermachen im Browser bleibt möglich).
- **iOS-Zoom beim Antippen von Eingabefeldern**: Safari auf iOS/iPadOS zoomt bei Feldern mit
  < 16px Schrift automatisch heran und nie wieder heraus – deshalb bekommen dort alle
  Eingabefelder 16px (`@supports (-webkit-touch-callout: none)` im CSS, nur Apple-Touch-
  Geräte). Bewusst nicht per `maximum-scale=1` gelöst (sperrt auf Android das Zoomen mit
  zwei Fingern – schlecht für Menschen mit Sehschwäche).

## Datenmodell

Tabelle `habit_definitions`: eine Zeile pro Nutzer und Feld – **ersetzt die frühere feste
`HABITS`-Konstante**. Jeder Nutzer verwaltet seine Felder selbst über "Felder verwalten"
im Burger-Menü der App (anlegen, umbenennen, archivieren, reaktivieren; siehe
`renderManage` in `logbuch.js` – kein eigener Tab mehr, siehe Abschnitt "Design").
**Seit 2026-09-27 größtenteils verschlüsselt** (siehe Abschnitt "Verschlüsselung" →
Feld-Definitionen): die folgenden Eigenschaften stehen bei umgestellten Zeilen nicht mehr
in ihren Klartext-Spalten, sondern verschlüsselt in `enc` – im Klartext bleiben nur
`kind`, `reminder_minute`, `schedule`, `archived_at`, `sort_order`. Die Beschreibung der
Eigenschaften unten gilt inhaltlich unverändert (im Client heißen sie gleich).
- `slug` (Key in `habit_entries.data`; verschlüsselt als `key`, bei neuen Feldern ein
  zufälliger Schlüssel aus `newHabitKey` statt aus dem Namen abgeleitet), `name`, `kind` (`'scale'`, `'number'`,
  `'computed'` ("Berechnet") oder `'text'`, siehe Skalen-/Farblogik unten), `min`/`max` (int, nur bei `kind='scale'`;
  neue Felder immer `min=1`, `max=<Stufenzahl>`; ältere können eine andere Basis haben), `labels` (jsonb, nur bei
  `kind='scale'`; `null` = nummerierte Stufen, sonst Array von Strings der Länge
  `max-min+1`), `good` (`'high'`/`'low'`, nur bei `kind='scale'`), `unit` (text, nur bei
  `kind='number'`, z.B. `'kg'`), `display_style` (`'buttons'`/`'slider'`, nur bei
  `kind='scale'` mit `labels=null` relevant), `slider_show_value` (bool, nur bei
  `display_style='slider'` relevant – steuert nur die Sichtbarkeit des aktuellen Werts
  während der Eingabe, der Regler zeigt **nie** eine Min/Max-Beschriftung),
  `group_members` (jsonb, nur bei `kind='computed'`: Array von Schlüsseln anderer
  `kind='scale'`-Felder dieses Nutzers), `reminder_minute` (Minuten seit Mitternacht,
  0–1439, 15-Minuten-Raster, oder `null` = Standardzeit, siehe Erinnerungen – bei
  `kind='computed'` immer `null`, ein berechnetes Feld kann nie "fehlen"), `schedule` (jsonb,
  Wiederholung, `null` = täglich, bei `kind='computed'` immer `null` – siehe Abschnitt
  "Wiederholung" unten), `sort_order`,
  `archived_at` (Soft-Delete – archivierte Felder
  verschwinden aus der Tageseingabe und sind seit 2026-09-27 auch in der Auswertung
  standardmäßig ausgeblendet – pro Feld in der Verwaltung wieder einblendbar (Checkbox "In
  der Auswertung anzeigen" an der archivierten Zeile, `archivedInStats`), dann sichtbar,
  solange sie im Zeitraum Daten haben; lassen sich reaktivieren). Ein archiviertes Feld
  **endgültig löschen** (`habit-delete`) geht auch mit vorhandenen historischen
  Einträgen – dann aber erst nach explizitem zweiten Bestätigungsklick in der App
  (`state.habitDeleteConfirm`), da die Rohwerte danach nicht mehr auswertbar sind.
  Löscht zuerst die `habit_definitions`-Zeile, räumt danach zusätzlich per
  `purgeKeyFromEntries` (in `logbuch.js`) best effort den zugehörigen Schlüssel
  aus jedem betroffenen Tages-Eintrag (`habit_entries.data`) weg, statt ihn als
  verwaisten Key im verschlüsselten JSON liegen zu lassen (passend zur Zero-Access-/
  Löschrecht-Ausrichtung der App – "Löschen" soll möglichst wenig übrig lassen).
  Läuft im Hintergrund über die bereits im Speicher gehaltenen, entschlüsselten
  `state.entries` – kein zusätzlicher Fetch nötig.
- **Feld-Typ (`kind`) und Skala (`min`/`max`/`labels`) sind nur änderbar, solange das
  Feld noch keine Daten hat** (App-seitig gesperrt, siehe `habitHasData`/`f.locked`) –
  sonst würden alte Werte plötzlich etwas anderes bedeuten. Für eine neue Skala: altes
  Feld archivieren, neues anlegen. `name`, `unit` und `reminder_minute` bleiben davon
  unberührt, da sie keine historischen Werte umdeuten. Gilt **nicht** für `kind='computed'`:
  ein berechnetes Feld hält nie einen eigenen Eintrag in `habit_entries.data` (ihr Slug taucht
  dort nie als Key auf), ist deshalb nie "locked" – die Mitgliederliste (`group_members`)
  lässt sich jederzeit ändern, auch mit bestehender Historie. Das wirkt sich rückwirkend
  auf die gesamte bisherige Auswertung aus (der Durchschnitt wird bei jedem Rendern live
  aus den aktuellen Mitgliedern neu berechnet, nie gespeichert) – beabsichtigtes
  Verhalten, kein Bug.
- **Kein automatisches Seeding mehr** (bis 2026-09-15: 13 feste Standardfelder +
  "Gewicht" vorbelegt). Neue Nutzer starten komplett leer und werden stattdessen durch
  das Onboarding-Tutorial (siehe Abschnitt unten) zu ihren eigenen, selbst gewählten
  Feldern geführt.
- RLS aktiv: jede Zeile nur für den eigenen `user_id` sicht-/änderbar – Felder eines
  Nutzers beeinflussen keinen anderen.

Tabelle `habit_entries`: eine Zeile pro Nutzer und Kalendertag.
- `entry_date` (date), `data` (jsonb) – **clientseitig verschlüsselt** (siehe Abschnitt
  "Verschlüsselung" unten): kein Klartext mehr, sondern `{iv: "<base64>", ciphertext:
  "<base64>"}`. Im entschlüsselten Zustand enthält das Objekt die Werte des Tages,
  Keys entsprechen den `slug`s aus `habit_definitions` des jeweiligen Nutzers (Gewicht
  ist ein ganz normaler `slug='weight'`-Eintrag darin, kein Sonderfall mehr).
  **Notizen** (seit 2026-09-27) liegen im selben verschlüsselten Objekt unter dem
  einzigen reservierten Schlüssel `_notes`: `{ mood: 3, _notes: { mood: "…", _day:
  "…" } }` – je Feld-Slug eine Notiz, `_day` für die Notiz zum ganzen Tag
  (`NOTES_KEY`/`DAY_NOTE_KEY`, `getNote`/`withNote` in `logbuch.js`). Kollidiert nie
  mit einem Feld, da `slugify()` nur `a-z0-9` erzeugt; **Konvention: Schlüssel mit `_`
  am Anfang sind nie Feldwerte**. Ohne verbleibende Notiz verschwindet `_notes` wieder.
- `filled_slugs` (jsonb, Array von Strings) – bewusst **unverschlüsselt**, nur die
  **IDs** (`habit_definitions.id`) der an dem Tag befüllten Felder, keine Werte und seit
  2026-09-27 auch keine aus dem Namen abgeleiteten slugs mehr (Spaltenname historisch).
  Wird ausschließlich von `get_due_notifications` für die Vollständigkeits-Prüfung
  gebraucht, da der Server `data` nicht entschlüsseln kann. Notizen (`_`-Schlüssel)
  zählen nicht – eine Notiz allein gilt für die Erinnerungen nicht als eingetragen.
  Keine Speicher-Uhrzeit (die frühere `updated_at`-Spalte wurde entfernt, sie verriet,
  wann jemand typischerweise einträgt).
  Der Trigger `habit_entries_normalize_filled_slugs` übersetzt beim Speichern noch
  auftauchende slugs (alte App-Version) in Feld-IDs, solange die Definition
  unverschlüsselt ist; nicht Zuordenbares fällt weg.
- RLS aktiv: jede Zeile nur für den eigenen `user_id` sicht-/änderbar (schützt Nutzer
  voreinander, nicht vor dem DB-Owner — dafür ist ja gerade die Verschlüsselung da).
- **Speichern eines Tages** (`saveDay`, seit 2026-09-29): ein Tag ist ein einziges
  verschlüsseltes Objekt – ein zweites Gerät mit veraltetem Stand würde sonst die
  inzwischen anderswo eingetragenen Werte überschreiben. Deshalb holt jede Speicherung
  zuerst die aktuelle Zeile; hat sie sich seit dem zuletzt bekannten Stand geändert
  (`syncedEntries`, erkannt am IV), führt `mergeDay` beide Schlüssel für Schlüssel zusammen
  (eigene Änderungen gewinnen, sonst der Server-Stand, Notizen einzeln). Speicherungen
  eines Tages laufen nacheinander (`daySaveChains`) und schreiben immer den dann aktuellen
  `state.entries`-Stand – Aufrufer ändern `state.entries` vorher und rufen nur
  `saveDay(dateKey)`. Nicht entschlüsselbare Tage werden nie überschrieben
  (`undecryptableEntryDates`, Meldung statt Speichern). Einträge laden seitenweise
  (`fetchAllRows`, PostgREST kappt bei 1000 Zeilen).
- **Rückkehr in die App** (`visibilitychange`): Schlüssel-Prüfung (`checkDekStillCurrent`),
  Tageswechsel (`rollOverToNewDay`: wer auf dem damaligen "heute" bzw. dem laufenden
  Zeitraum stand, landet auf dem neuen – sonst trüge man nach einer Nacht im Hintergrund in
  den Vortag ein) und nach ≥ 5 Min. Abwesenheit Neuladen von Einträgen, Feldern und
  Gruppen (`refreshAfterReturn`, nicht bei offenem Formular/Editor; verwirft das Ergebnis,
  falls währenddessen schon etwas geändert wurde).

Tabelle `push_subscriptions`: eine Zeile pro Browser/Gerät mit aktivierten Erinnerungen
(Web-Push-Endpoint + Schlüssel). RLS wie oben. Endpoint nur `https://`, begrenzte Längen,
höchstens 10 Abos pro Konto (Trigger `push_subscriptions_limit`) – `send-notifications`
schickt an jeden Endpoint eine Anfrage, ohne Grenzen könnte ein Konto den Versand für alle
ausbremsen. **Abmelden beendet die Erinnerungen dieses Geräts** (`endPushForThisDevice`:
Server-Zeile löschen, Browser-Abo kündigen, lokale Namensliste leeren – sonst kämen sie samt
Feldnamen weiter, auch für die nächste Person am Gerät); `checkPushStatus` kündigt ein
Browser-Abo, zu dem das angemeldete Konto keine Server-Zeile hat.

**Robustheit von `get_due_notifications`** (Review 2026-09-29): die Abfrage läuft über alle
Nutzer in einem Rutsch – ein einziger Wert, an dem sie scheitert, ließ vorher den ganzen Lauf
abbrechen. Deshalb prüft die DB die Form aller dort gelesenen, vom Nutzer schreibbaren
Spalten selbst: `schedule` über `habit_schedule_valid` (CHECK, spiegelt `formToSchedule`),
`filled_slugs` muss ein Array sein, `timezone` per Trigger, Erinnerungsminuten per Bereich.
Neue solche Spalten brauchen dieselbe Prüfung.

Tabelle `user_settings`: eine Zeile pro Nutzer. `default_reminder_minute` (Minuten
seit Mitternacht, 0–1439, 15-Minuten-Raster, Default 1320 = 22:00) ist die
Standard-Erinnerungszeit für alle Felder ohne eigene `reminder_minute` (siehe
Erinnerungen), im Burger-Menü der App änderbar. `onboarding_completed` (bool, Default
`false`) steuert, ob der Account noch das Onboarding-Tutorial sieht (siehe Abschnitt
unten). `summary_notifications` (bool, Default `true`) schaltet die Wochen-/
Monatsübersicht-Benachrichtigungen ab (siehe Erinnerungen, im Burger-Menü änderbar).
`timezone` (IANA-Name, Default `'Europe/Berlin'`, per Trigger gegen
`pg_timezone_names` validiert) ist die Zeitzone, in der alle Erinnerungen dieses
Nutzers ausgewertet werden – folgt still dem Gerät (siehe Erinnerungen → Zeitzone).
Die Zeile wird bei Registrierung automatisch angelegt (Trigger
`on_auth_user_created_seed_settings`). RLS wie oben.

Tabelle `user_encryption`: eine Zeile pro Nutzer, hält den zweifach "verpackten"
Data Encryption Key (DEK) — nie den Schlüssel selbst im Klartext. Details siehe
Abschnitt "Verschlüsselung". **Kein** automatischer Seed-Trigger bei Registrierung
(anders als `habit_definitions`/`user_settings`) — die Einrichtung passiert bewusst
erst beim ersten echten Login, da sie das Passwort im Klartext braucht. RLS wie oben.

**Der Reminder-Check** (SQL-Funktion `get_due_notifications`, siehe Erinnerungen)
fragt dafür live die aktiven (nicht archivierten) `habit_definitions` je Nutzer ab –
keine hartkodierte Liste mehr, kein manuelles Synchronhalten nötig. `kind='computed'`-Felder werden dabei ausgeschlossen
(berechnete Felder sind nie direkt befüllbar, tauchen nie in `filled_slugs` auf – ohne den
Ausschluss würden sie die Sammel-Erinnerung dauerhaft fälschlich als "fehlend" auslösen).
Erinnert wird, sobald mindestens ein zur jeweiligen Zeit fälliges aktives Feld an dem
Tag noch fehlt, nicht erst wenn alles leer ist (Details siehe Abschnitt "Erinnerungen").
Felder, die an dem (lokalen) Tag laut Wiederholung nicht dran sind, zählen dabei weder
als fehlend noch lösen sie ihre eigene Erinnerungszeit aus (`habit_scheduled_on`).

## Wiederholung (`habit_definitions.schedule`, seit 2026-09-27)

Pro Feld einstellbar, an welchen Tagen es "dran" ist (Formular "Wiederholung": Typ als
Auswahlliste, Wochentage als 7 runde Buttons in einer Zeile; nicht für
berechnete Felder – die sind dran, sobald eines ihrer aktiven Mitglieder dran ist). `null` =
täglich, sonst `{type:'weekly', days:[0..6]}` (0 = Montag), `{type:'monthly', day:1..31
| -1}` (-1 = letzter Tag), `{type:'yearly', month, day}` oder `{type:'interval', every:
1..365, unit:'day'|'week', start:'YYYY-MM-DD'}` (alle X Tage/Wochen ab Start, davor nie
dran). Einen Tag, den es im Monat nicht gibt (31.4., 29.2. außerhalb von Schaltjahren),
behandeln beide Seiten als Monatsletzten statt ihn ausfallen zu lassen; ungültige Pläne
gelten als dran (die DB lässt sie per CHECK gar nicht erst zu, siehe `push_subscriptions` →
Robustheit). Alle 7 Wochentage bzw. "alle 1 Tage" werden als `null` gespeichert
(eine einzige Darstellung von täglich). **Zwei Implementierungen derselben Regeln, die
synchron bleiben müssen**: `isScheduledOn`/`isPlannedOn` in `logbuch.js` und die
SQL-Funktion `public.habit_scheduled_on(schedule, date)` (plpgsql, aktuelle Fassung in
Migration `20260929120000_harden_reminder_inputs`, von `get_due_notifications` genutzt). Bewusst **nicht**
unterstützt: Kalender-Regeln wie "jeder erste Montag im Monat" (Nutzer: unübersichtlich
und eher irrelevant) und Häufigkeits-Ziele ohne feste Tage ("3x pro Woche" – anderes
Konzept, eher Richtung Ziel-Quote).

- **"Heute"**: nicht geplante Felder stehen eingeklappt unter "Heute nicht geplant (N)"
  (`<details class="unplanned">`) – ausnahmsweise eintragen geht dort trotzdem. Die
  Einteilung richtet sich nur nach dem Plan, nicht nach vorhandenen Werten (sonst spränge
  ein Feld beim ersten Antippen heraus); dafür ist der Bereich automatisch offen, sobald
  dort an dem Tag ein Wert oder eine Notiz steht. Offen/zu übersteht einen Re-Render
  über `state.unplannedOpenFor` (dateKey). Ein Sprung aus der Auswertung zu einem Feld
  darin klappt ihn auf (`focusTodayField`).
- **Woche**: Zellen an nicht geplanten Tagen ohne Wert sind gestrichelt schraffiert
  (`.grid-cell--unplanned`), damit "nicht dran" nicht wie "vergessen" aussieht. Die
  Zellfarbe steht deshalb inline als `background-color`, nicht als Kurzschreibweise
  `background:` – die setzte die Schraffur (`background-image`) wieder zurück.
  Durchschnitte/Quoten sind unberührt – die rechnen ohnehin nur mit eingetragenen Werten.
- **Verwaltungsliste**: Kurzform des Plans neben einer ggf. eigenen Erinnerungszeit
  (`manageFieldMeta`/`scheduleSummary`, z.B. "Mo, Mi, Fr · Erinnerung 08:00").

## Skalen-/Farblogik

Vier Feld-Typen: `kind='scale'` (Stufen mit Gut/Schlecht-Bewertung – der Normalfall),
`kind='number'` (freier Zahlenwert wie Gewicht, bewusst **ohne** Gut/Schlecht-Bewertung,
dafür mit optionaler Einheit), `kind='computed'` ("Berechnet", nicht direkt befüllbar, zeigt den live
berechneten Durchschnitt seiner Mitglieder-Felder – siehe `habitScore` unten) und
`kind='text'` (freie Text-Antwort, siehe unten).

**Text-Felder (`kind='text'`, seit 2026-09-27)**: für Fragen wie "Wofür bin ich heute
dankbar?". Der Wert ist ein String unter dem Slug im verschlüsselten Tagesobjekt, zählt
normal für `filled_slugs`/Erinnerungen (auch eigene Erinnerungszeit möglich) und fließt
nie in Scores/Heatmaps ein. In "Heute" bewusst ein **immer offenes Textfeld**
(`renderTextBox`, Nutzer-Entscheidung: wer so ein Feld anlegt, will täglich
hineinschreiben – anders als die Notizen, die Ausnahme bleiben). Speichert automatisch:
jeder Tastendruck aktualisiert sofort `state.entries` (ohne `render()`), der verschlüsselte
Upsert läuft erst nach 1 s Tipp-Pause (`updateTextValue`/`TEXT_SAVE_DELAY_MS`), sofort beim
Verlassen des Feldes, beim Wechsel in eine andere App und vor dem Abmelden
(`flushAllDaySaves`). Keine Notizen im Zeilen-Menü (wären doppelt), kein Mitglied berechneter Felder.
**Rückblick** (`renderTextReviews`): in Woche/Monat/Jahr/Gesamt pro Feld eine
Liste Datum + Text (jeder Eintrag öffnet seinen Tag), überall gleich: eingeklappt
(`<details>`, Anzahl im Titel) und neueste zuerst – eine je nach Ansicht umgekehrte
Reihenfolge war verwirrend. Felder ohne Antwort im Zeitraum erscheinen nicht.
Sprünge aus der Auswertung zu einem bestimmten Feld (Rückblick-Eintrag, Punkt im
Zahlen-Graphen, Feld-Zelle in der Woche; `data-focus-habit` an `open-day`) scrollen in
"Heute" zusätzlich zum Feld, heben es kurz hervor (`.field-highlight`, bei
`prefers-reduced-motion` ohne Animation) und fokussieren dessen ⋮-Button
(`focusTodayField`). Erklärt
in "Über Logbuch" (`about.tip.textFields`). DB-Constraints `habit_definitions_kind_check`/
`habit_definitions_kind_fields_check` erlauben `text` seit Migration
`20260927120000_add_text_habit_kind`.

`normalize(habit, value)` bildet den Wert eines `scale`-Felds auf 0 (schlecht) bis 1 (gut)
ab, unabhängig von der Richtung (`good: 'high'` vs. `good: 'low'`, z.B. bei
"Gekifft"/"Gevaped"). `scoreColor(score)` färbt danach rot→grau→grün. `number`-Felder
laufen nie durch `normalize`/`scoreColor` (kein "gut/schlecht" bei einem Zahlenwert wie
Gewicht) – sie bekommen stattdessen in "Heute" eine eigene Eingabebox und in den
Auswertungs-Tabs einen Verlaufs-Graphen (`renderNumberChart`), statt in die Score-/
Heatmap-Logik einzufließen. Es gibt keinen separaten Bool-Typ mehr – ein Ja/Nein-Feld ist
einfach eine `scale` mit `min:0, max:1, labels:['Nein','Ja']`.

**Darstellung von `scale`-Feldern (`display_style`)**: `buttons` (Standard) zeigt
Auswahl-Buttons, `slider` einen Schieberegler (`renderHabitSlider`) – dafür wird beim
Anlegen keine freie Von/Bis-Spanne eingegeben, sondern nur eine Stufenzahl (wie bei
Buttons, Grenzen siehe unten), intern als `min=1`/`max=<Stufenzahl>` gespeichert. Der Regler zeigt **nie** eine Min/Max-Beschriftung im Eingabe-UI –
`slider_show_value` steuert nur, ob der aktuell gewählte Wert während der Eingabe
sichtbar ist. Live-Vorschau (Wert + Farbe)
läuft beim Ziehen rein über einen `input`-Listener ohne Re-Render; gespeichert wird erst
beim Loslassen, über `handleSetValue` (setzt immer – nicht das Umschalten von
`handleSelect` der Buttons, wo derselbe Wert den Eintrag wieder entfernt; entfernen
geht beim Regler über das ×). Zwei Wege dorthin: `change`, plus ein eigener
`pointerup`-Listener für den Fall, den `change` nicht abdeckt (ein leerer Regler steht
schon mittig – zog man ihn und ließ ihn genau dort los, sah er eingetragen aus, war
aber nicht gespeichert und hatte kein ×).

**Bezeichnungen (`labels`) sind seit 2026-09-18 kein eigener Modus mehr, sondern ein
optionaler Text-Overlay über denselben Stufen** – vorher waren "Nummerierte Stufen" und
"Eigene Bezeichnungen" im Formular zwei sich ausschließende Zustände (`f.mode`), obwohl
die DB nie zwischen ihnen unterschieden hat (`labels` ist einfach `null` oder ein Array
über demselben `min`/`max`-Bereich). **Neue (bzw. noch unbefüllte) Skala-Felder starten
immer bei `min=1`** (kein frei wählbares "Von" mehr, unabhängig von Buttons/Schieberegler
– wer andere Bezeichnungen will, nutzt dafür eigene Bezeichnungen statt eines
verschobenen Zahlenbereichs). Das Formular (`scaleBody` in `renderHabitForm`) fragt
jetzt in dieser Reihenfolge: Darstellung (Buttons/Schieberegler) → **eine** gemeinsame
"Anzahl Stufen"-Eingabe → Checkbox "Eigene Bezeichnungen
verwenden", darunter
bei Buttons immer, beim Schieberegler nur bei aktivierten Bezeichnungen eine Zeile pro
Stufe (deaktiviertes Textfeld mit der Zahl, oder editierbar mit der Zahl als Startwert)
→ Live-Vorschau (rendert `renderHabitOptions`/`renderHabitSlider` mit einem
synthetischen Habit-Objekt aus dem Formular-Stand, `previewHabitFromForm`; seit
2026-09-28 zum Ausprobieren bedienbar, verhält sich exakt wie in "Heute" – der Wert lebt nur
in `f.previewValue`, eigene Aktionen `preview-select`/`preview-slider`/`preview-clear` via
`setPreviewValue`, nie echte Daten; Hinweis "wird nicht gespeichert") → Bewertung/Ziel-Quote. `habitFormStepCount(f)` (`max-min+1`) und
`habitFormStepValue(f, i)` (`min+i`) sind seit diesem Umbau für beide Darstellungen
identisch (kein Sonderfall mehr für den Schieberegler) – `resizeLabels(labels,
newLength, defaultForIndex)` hält die Bezeichnungs-Liste bei jeder Änderung der
Stufenzahl auf der richtigen Länge, unabhängig davon ob die Checkbox gerade an ist, und
befüllt neue/leere Positionen beim Aktivieren mit der Zahl als Text statt leer. Der
Schieberegler kann seit diesem Umbau ebenfalls Bezeichnungen anzeigen
(`habitSliderValueText`) – vorher eine unbeabsichtigte Lücke, keine bewusste
Einschränkung.

**Stufenzahl-Grenzen (seit 2026-09-28, eine Regel statt vorher 12/8/1000)**: jede Stufe mit
eigener Bedeutung muss man sehen und gezielt treffen können. Buttons (mit oder ohne
Bezeichnungen) und Schieberegler mit Bezeichnungen: 2 bis `CHOICE_STEP_CAP` (7) – mehr
Abstufungen machen Antworten eher beliebiger als genauer. Schieberegler ohne Bezeichnungen
("ungefähr wie viel"): 2 bis `SLIDER_STEP_CAP` (100) – mehr lässt sich auf dem Handy nicht
einzeln treffen. `habitFormStepCap(f)` liefert die jeweils gültige Grenze. Die +/−-Knöpfe
(`stepperInput`) zählen beim Gedrückthalten weiter, immer schneller (`stepperHold`, seit
2026-09-29); gespeichert/neu gerendert wird erst beim Loslassen, der Klick danach wird
verschluckt. Begründung für
Nutzer im ⓘ an "Anzahl Stufen" (`habitForm.stepsExplain`: in Fragebögen haben sich 5–7
Stufen bewährt – bewusst so vorsichtig formuliert, die Studienlage ist nicht eindeutiger). Am Deckel von 7
zeigt das Formular einen Hinweis mit Umschalt-Knopf ("Zum Schieberegler wechseln" bzw.
"Eigene Bezeichnungen abschalten", `habit-steps-to-slider`), statt das Hochzählen stumm
enden zu lassen. Bestehende Felder mit mehr Stufen bleiben unverändert nutzbar; ist so
ein Feld gesperrt, sind nur Buttons/Bezeichnungen gesperrt, die es vorher noch nicht hatte
(`lockedChoiceBlocked`, mit Erklärung am Formular). **Vorschau** zeigt Buttons wie in
"Heute" in einer Zeile und blendet einen Hinweis ein, wenn sie auf dem aktuellen Gerät
nicht hineinpassen (`syncPreviewFitHint`, gemessen nach jedem Rendern/Drehen/Laden der
Schrift). **In "Heute"** rutschen die Buttons in eine eigene Zeile unter den Namen, sobald
Name (mind. 40 %) und Buttons nicht nebeneinander passen (`.habit-row--buttons`, reines
CSS über `flex-wrap`) – vorher waren sie auf 60 % der Breite begrenzt und scrollten
seitlich (auf 360 px breiten Handys nur 5 nummerierte sichtbar); seitlich gescrollt wird
nur noch, was selbst in der vollen Breite nicht passt.

**Bearbeiten mit vorhandenen Daten (`f.locked`, siehe `habitHasData`)**: nur die
Stufenzahl (bzw. das historische `min`/`max` dahinter) bleibt gesperrt (das wäre eine
rückwirkende Neuinterpretation bestehender Werte – bewusst NICHT gebaut, siehe unten).
Ein bereits bestehendes `min` ungleich 1 (z.B. alte Schieberegler-Felder mit historischer
Basis 0) bleibt dabei unangetastet erhalten, die "immer Basis 1"-Regel gilt nur für neue
Felder. Darstellung, die Bezeichnungen-Checkbox und der Bezeichnungs-Text selbst bleiben
dagegen auch mit vorhandenen Daten änderbar, da sich dabei nur die Beschriftung ändert,
nie die zugrundeliegende Zahl/Position. Ausnahme: ein gesperrtes Feld mit mehr als
`CHOICE_STEP_CAP` Stufen kann nicht neu auf Buttons oder Bezeichnungen umgestellt werden
(`lockedChoiceBlocked`, siehe Stufenzahl-Grenzen) – die Stufenzahl lässt sich ja nicht
mehr verkleinern.
**Bewusst nicht umgesetzt**: eine rückwirkende Umrechnung bei einer echten
Anzahl-Änderung (z.B. 3 Stufen → 5 Stufen) eines Feldes mit vorhandenen Daten –
mathematisch bei rein nummerierten Stufen unproblematisch (linear, Score/Farbe bleibt
exakt erhalten), bei Text-Bezeichnungen aber riskant (ein altes "Ja" bei 2 Stufen bekäme
nachträglich eine Intensität zugeschrieben, die so nie gemeint war). Für eine andere
Skala bleibt der Weg: archivieren und neu anlegen.

**Skala-Felder ohne Wertung (`good = null`, seit 2026-09-18)**: `good` ist bei
`kind='scale'` nicht mehr zwingend `'high'`/`'low'` – ein dritter Zustand "Keine
Wertung" (Formular-Pill neben Hoch/Niedrig, `habit-good`-Action mit `data-good=""`)
erlaubt reines Tracken ohne Gut/Schlecht-Urteil (z.B. für Dinge, die man beobachten,
aber nicht bewerten will). `isNeutralScale(h)` erkennt diesen Fall. **Keine Färbung
nach Wert** (Nutzer-Entscheidung 2026-09-28): `habitColor(habit, score)` ist die zentrale
Weiche und liefert für unbewertete Felder nur "eingetragen" (`NEUTRAL_FILL` = `--sand`)
bzw. `transparent`; gewählte Buttons und der Schieberegler in "Heute" nutzen die übliche
Auswahl-Farbe (`NEUTRAL_SELECTED` = `--ink`, Text `--paper`, wie `.pill-toggle--active`).
Im Wochen-Grid kein Streifenmuster und eine leere Ø-Zelle, in Monat/Jahr/Gesamt nur die
Anzahl ("12×") statt eines %-Durchschnitts. Verworfen: eine Graustufen-Skala hell→dunkel
nach Position (bis 2026-09-28) – setzt eine Reihenfolge der Stufen voraus, die es bei
vielen solchen Feldern nicht gibt ("sonnig/bewölkt/Regen"), und wirkte trotzdem wie eine
Wertung; die Ausprägung soll stattdessen die Überarbeitung der Auswertung zeigen (z.B.
Verteilung pro Stufe). Unbewertete Felder
fließen NICHT in `dayOverallScore` (Monats-/Jahres-Heatmap) und nicht als
Mitglied berechneter Felder ein (im Formular als Kandidat ausgeschlossen, in `habitScore`
zusätzlich defensiv gefiltert) – beides baut auf einem Gut/Schlecht-Urteil auf, das
hier fehlt. Ziel-Quote (`goal_threshold`) ist bei `good=null` immer `null` (DB-Check
`habit_definitions_kind_fields_check` erzwingt das, Formular blendet das Feld aus).

**Begriffe (seit 2026-09-27 neu geordnet – wichtig beim Lesen von Code/DB)**: In der App
heißt **"Gruppe"** eine einklappbare Überschrift, unter der Felder angeordnet sind – im
Code/in der DB heißt das **`section`** (`habit_sections`, `state.sections`,
`renderBySection` …). Was bis 2026-09-27 "Gruppe" hieß (ein Feld, das aus anderen Feldern
einen Wert berechnet), ist jetzt der **Feldtyp "Berechnet"**, intern **`kind='computed'`**
(vorher `kind='group'`, per Migration `20260927220000_rename_group_kind_to_computed`
umbenannt, damit "group" im Code nicht dauerhaft etwas anderes meint als "Gruppe" in der
App). Einzige Altlast: in der verschlüsselten payload heißt die Mitgliederliste weiterhin
`groupMembers` (bzw. Klartext-Spalte `group_members` bei noch unverschlüsselten Zeilen) –
am Feld-Objekt im Client heißt sie `members`.

**Berechnete Felder (`kind='computed'`)**: ganz normale Felder (in Gruppen einsortierbar,
in der Auswertung ausblendbar), die man nur nicht selbst ausfüllen kann – im Feld-Formular
der vierte Typ neben Skala/Zahl/Text ("Berechnet"), mit Art der Mitglieder, ggf.
Berechnung und Mitglieder-Auswahl. **Aus Skalen**: fassen mehrere `kind='scale'`-Felder
zu einem Durchschnittswert zusammen (z.B. "Sport gemacht" = Ø aus "Ausdauersport" +
"Kraftsport"). Kein Eintrag in `habit_entries.data`, kein eigener `good`, keine
Erinnerungszeit, keine Wiederholung (dran, sobald ein Mitglied dran ist). Notizen gehen
(liegen ohnehin getrennt unter `_notes`, brauchen keinen eigenen Wert).
Der zentrale Helfer `habitScore(h, dateKey)` liefert dafür den Durchschnitt aus
`normalize(member, ...)` über alle Mitglieder mit Wert an dem Tag (null, wenn keins
befüllt ist) und ersetzt damit in `renderWeek`/`computeHabitStats` (Monat/Jahr/Gesamt)
die direkten `normalize`-Aufrufe; für normale `scale`-Felder ist er ein reiner
Durchreicher. In "Heute" erscheinen berechnete Felder als nicht-editierbare Info-Zeile
(`renderComputedInfo`). `habitVisibleInRange(h, dateKeys)` ersetzt die
Sichtbarkeits-Prüfung archivierter Felder, da berechnete Felder nie einen Entry-Key haben.
In der Tagesfarbe (`dayOverallScore`) zählen sie seit 2026-09-27 nicht mehr mit – ihre
Mitglieder sind schon selbst drin (vorher unbeabsichtigt doppelt).

**Aus Zahlen** (seit 2026-09-27): ein berechnetes Feld kann statt Skalen auch
`kind='number'`-Felder zusammenfassen, per Summe, Durchschnitt, Minimum oder Maximum
(`aggregate` in der verschlüsselten payload: gesetzt = aus Zahlen, `null` = aus Skalen).
Helfer: `isNumberComputed`, `isScoredKind` (Felder mit Gut/Schlecht-Score, in
Woche/Monat/Jahr/Gesamt), `hasNumericSeries`, `numberComputedDay`/`habitNumericValue`.
Regeln: Mitglieder nur Zahlenwert-Felder mit **derselben Einheit** (Formular sperrt andere,
sobald eins gewählt ist, mit kurzem Hinweis; beim Speichern nochmal geprüft) – das Feld
übernimmt diese Einheit (`computedUnit`). Gerechnet wird mit den an dem Tag eingetragenen
Mitgliedern (bei der Summe zählt ein fehlendes also als 0), ist gar keins eingetragen, gibt
es keinen Wert statt 0. Keine Bewertung: kein Score, keine Farbe, keine Ziel-Quote; in
"Heute" eine neutrale Info-Zeile mit Wert + Einheit, in der Auswertung ein Verlaufsgraph wie
bei Zahlenwert-Feldern. Werte werden auf 2 Nachkommastellen gerundet (gegen
Gleitkomma-Reste).

**Gruppen (intern `sections`, seit 2026-09-27)**: Tabelle `habit_sections` (`id`,
`user_id`, `enc` = verschlüsselter `{name}`, `sort_order`, `reminder_minute` = eigene
Erinnerungszeit der Gruppe oder `null`, siehe Erinnerungen); Zuordnung über die
Klartext-Spalte `habit_definitions.section_id` → FK `ON DELETE SET NULL`, Trigger
`habit_definitions_check_section_owner` erzwingt eine Gruppe desselben Nutzers. Rechte
genau auf SELECT/INSERT/UPDATE/DELETE für `authenticated` zurückgeschnitten (Supabases
Default-Privilegien hatten auch `anon`/TRUNCATE vergeben; seit 2026-09-29 für alle Tabellen
so). Einklappbare Abschnitte zum
Anordnen von Feldern (auch berechneten) – reine Anordnung, bewusst **keine eigene
Berechnung** (wer einen Wert will, kombiniert Gruppe + berechnetes Feld). Die Zuordnung ist
absichtlich unverschlüsselt (nur zwei zufällige IDs): die DB löst sie beim Löschen selbst,
Umhängen braucht kein Neu-Verschlüsseln – steht so auch im Datenschutz-Text ("welches Feld
in welcher Gruppe steht"). **Anlegen/Bearbeiten** über ein eigenes Formular (eigene Ebene der
Verwaltung wie das Feld-Formular, `openSectionForm`/`renderSectionForm`/
`saveSectionForm`): Name + Liste aller aktiven Felder zum Ankreuzen, beliebig gemischt;
**jedes Feld in höchstens einer Gruppe** – Felder einer anderen Gruppe erscheinen ausgegraut
mit deren Namen. Neu angekreuzte Felder landen am Ende der Gruppe, abgewählte am Ende der
obersten Ebene. Zusätzlich lässt sich ein Feld im Feld-Formular über die Auswahl "Gruppe"
einsortieren (nur wenn es Gruppen gibt). **Anordnung** (`layoutBlocks`): auf oberster Ebene
Felder ohne Gruppe und Gruppen gemeinsam nach `sort_order`, frei untereinander
verschiebbar; Felder einer Gruppe darin nach ihrem eigenen `sort_order` (gilt nur innerhalb
ihres Behälters). **Verwaltung**: eine Gruppe ist ein Block (Kopfzeile mit
Bearbeiten/Löschen + eingerückte Felder), der sich wie ein Feld verschieben lässt;
Ziehen/↑↓ jeweils innerhalb des Behälters (`commitLayoutOrder`; die Zieh-Rechnung arbeitet
mit den echten Positionen der Geschwister und tauscht, sobald die in Zugrichtung vordere
Kante – nach unten die Unterkante, nach oben die Oberkante – die Mitte eines Geschwisters
überquert; mit der Mitte des gezogenen Elements blieb ein großer Block einen Platz vor dem
Ende hängen). Eine gezogene Gruppe wird dabei auf ihre Kopfzeile zusammengeklappt
(`.manage-section--drag-collapsed`).
Umhängen zwischen Gruppen bewusst nur über die Formulare, nicht per Ziehen (einfach und für
Tastatur/Screenreader gleich gut bedienbar; Ziehen zwischen Gruppen wäre ein möglicher
späterer Zusatz). Löschen (zweistufig) löscht keine Felder: sie rücken an die Stelle der
Gruppe; Notizen zur Gruppe werden mitgelöscht (Hinweis in der Bestätigung, falls es welche
gibt). Ein **reaktiviertes Feld** kommt ans Ende seines Bereichs (`handleHabitArchive`) –
sonst landete z.B. ein archiviertes Feld aus einer inzwischen gelöschten Gruppe mit seiner
alten Position aus der Gruppe irgendwo auf der obersten Ebene. **Anzeige überall** (Nutzer-Entscheidung): "Heute" und alle Auswertungs-Ansichten
ordnen nach Gruppen (`renderBySection`, leere Gruppen werden ausgelassen), jeweils mit
einklappbarer Überschrift (`section-toggle`, `aria-expanded`) und eingerücktem Inhalt
(`.section-content`, bewusst ohne senkrechte Linie links – wirkte überladen, auch in der
Verwaltung entfernt; im Wochen-Raster nur der Feldname eingerückt,
sonst stünden die Tageskästchen nicht mehr unter den Wochentagen); der Eingeklappt-Zustand
gilt pro Gerät und getrennt für "Heute" und die Auswertung (`localStorage`
`sectionCollapsed:<today|stats>:<id>`). Der Bereich "Heute nicht geplant" bleibt
ungegliedert. Ein Sprung zu einem Feld in einer eingeklappten Gruppe klappt sie auf.

**"In der Auswertung anzeigen"** (seit 2026-09-27, `hideInStats` in der verschlüsselten
payload, Checkbox in jedem Feld-Formular, standardmäßig an): ausgeblendete Felder
erscheinen nur in "Heute", nicht in Woche/Monat/Jahr/Gesamt (`inStats`). **Archivierte
Felder** sind dort standardmäßig ausgeblendet (Nutzer-Entscheidung, Übersicht aufgeräumt),
lassen sich aber einzeln wieder einblenden (`archivedInStats`, Checkbox an der archivierten
Zeile in der Verwaltung, gespeichert über `updateHabitPayload`) – damit die Vorgeschichte
eines abgelösten Felds (Skala ändern = archivieren + neu anlegen) nicht verloren ist.
Verworfen: archivierte Felder komplett und ohne Ausnahme ausblenden. Wirkt nur auf die
Anzeige – Tagesfarbe (`dayOverallScore`) und berechnete Felder, in denen das Feld Mitglied
ist, rechnen unverändert mit (Nutzer-Entscheidung).

**Ziel-Quote (`goal_threshold`, `kind='scale'`/`kind='computed'` aus Skalen)**: bei manchen Feldern ist
eine 100%-Quote unrealistisch/gar nicht das eigentliche Ziel (z.B. "Kraftsport gemacht"
jeden Tag). Pro Feld einstellbar (Formular "Ziel für volle Bewertung (%)", Standard 100 =
`goal_threshold: null`), ab welcher normalisierten Quote (0–1) ein Wert farblich als voll
erreicht gilt. `applyGoal(habit, score)` staucht dafür den Score auf
`min(1, score/threshold)`, bei Standard (1) unverändert (exakter Durchreicher). Wird NUR
auf die Farbgebung angewendet (`dayOverallScore`, Wochen-Grid-Zellen inkl. Ø,
`renderStatsRows` in Monat/Jahr/Gesamt) — nie auf angezeigte Prozentzahlen, und bewusst
NICHT in `renderHabitOptions`/`renderHabitSlider` ("Heute"-Tab bleibt unverändert, dort
zählt der rohe Wert des Tages, keine Quote).

## Verschlüsselung (Zero-Access-Architektur)

Seit 2026-09-14: `habit_entries.data` (die eigentlichen Werte — Gewicht, Stimmung,
Sex, Drogenkonsum etc.) ist clientseitig verschlüsselt. Der Betreiber (auch über
Supabase-Dashboard/CLI) kann diese Werte grundsätzlich nicht einsehen — RLS schützt
nur Nutzer voreinander, das hier zusätzlich vor dem DB-Owner selbst. Seit 2026-09-27
zusätzlich die **Feld-Definitionen** (siehe unten) – der Betreiber soll auch nicht sehen,
WORÜBER jemand Buch führt. Bewusst unverschlüsselt bleibt nur, was der Server für die
Erinnerungen braucht: `habit_definitions.kind`/`reminder_minute`/`schedule`/`archived_at`
und `habit_entries.filled_slugs` (nur Feld-IDs der befüllten Felder, keine Werte/Namen).
Alle verschlüsselten Daten (Einträge wie Felder) werden vor dem Verschlüsseln auf ein
Vielfaches von 256 Byte aufgefüllt (`encryptData`, Leerzeichen am JSON-Ende), damit die
Länge nicht verrät, wie viel jemand eingetragen/geschrieben hat. Vorher gespeicherte Einträge
verschlüsselt die App beim Öffnen einmalig neu (`repadOldEntries`, nur Tage ≥ 2 Tage
zurück – ein gleichzeitiges normales Speichern desselben Tages könnte sonst überschrieben
werden –, übersprungen wird jeder seit dem Laden geänderte Tag, Upsert nur mit `data`).

**Feld-Definitionen verschlüsselt** (seit 2026-09-27): `habit_definitions.enc` =
`{iv, ciphertext}` mit demselben DEK, Inhalt `{key, name, unit, min, max, labels, good,
displayStyle, sliderShowValue, groupMembers, goalThreshold, aggregate, hideInStats}` (`habitFromParts` baut
daraus das gewohnte Feld-Objekt). Die DB-Schutzregel
`habit_definitions_enc_no_plaintext_check` lehnt eine verschlüsselte Zeile mit
Klartext-Resten ab (`DEF_PLAINTEXT_CLEARED` = die geleerten Spalten). Bestehende Zeilen
stellt die App beim Laden im Hintergrund um (`migrateHabitDefinitions`: verschlüsseln,
lokal kontroll-entschlüsseln und vergleichen, erst dann in einem Schritt speichern +
Klartext leeren; nur wenn noch kein `enc` da ist) – Konten, die die App nicht mehr
öffnen, behalten ihren Klartext, bis sie es tun (akzeptiert). Erinnerungen nennen
Feldnamen trotzdem: siehe "Erinnerungen" → Name wird erst auf dem Gerät eingesetzt
(`saveFieldNamesForPush`, lokale Liste in IndexedDB `logbuch-push`). Nutzern
erklärt in "Über Logbuch" → "Deine Daten und deine Privatsphäre" (siehe Präferenzen
unten: muss mit der Technik übereinstimmen). Nicht
zuordenbare/nicht entschlüsselbare Zeilen werden nicht angezeigt (Meldung
`notice.habitsUndecryptable`). Migrationen `20260927180000_encrypt_habit_definitions_prep`
und `20260927183000_normalize_filled_slugs`.

**Zweistufiger Schlüssel** (Crypto-Helfer + Lebenszyklus-Funktionen in `logbuch.js`,
alles native Web Crypto API, keine Library):
- **DEK** (Data Encryption Key): pro Nutzer ein zufälliger AES-256-GCM-Schlüssel
  (`generateDek`), verschlüsselt/entschlüsselt `habit_entries.data`
  (`encryptData`/`decryptData`). Ändert sich nie mehr, nachdem er einmal erzeugt
  wurde — auch nicht bei einem Passwort-Reset.
- **KEK** (Key Encryption Key): aus dem Passwort abgeleitet (`deriveKek`, PBKDF2-
  SHA256, 250.000 Iterationen, individueller Salt), "verpackt" (wrapped) den DEK
  (`wrapDek`/`unwrapDek`). Nur das verpackte Ergebnis (`wrapped_dek` in
  `user_encryption`) liegt serverseitig — nutzlos ohne Passwort.
- **Recovery-Key** (in der App seit 2026-09-29 **"Ersatzschlüssel"**, englisch "spare
  key"; im Code weiter `recoveryKey`): ein zweiter, zufälliger 256-Bit-Schlüssel, der den
  DEK ein zweites Mal verpackt (`wrapped_dek_recovery`). Wird dem Nutzer **einmalig**
  angezeigt (`renderRecoveryKeyDisplay`, Kopieren-/Download-Button, muss per Checkbox
  bestätigt werden) und nirgends serverseitig im Klartext gespeichert. **Wann**: nicht
  mehr gleich bei der Einrichtung (erster Eindruck wäre eine Sicherheitswarnung), sondern
  als eigener Schritt nach dem Tutorial – auch wenn es übersprungen wurde. Dafür merkt
  sich `user_encryption.recovery_key_confirmed`, ob der aktuelle Schlüssel bestätigt ist
  (Migration `20260929100000_add_recovery_key_confirmed`, bestehende Konten `true`):
  `setupEncryption` und `regenerateRecoveryKey` setzen `false` (`spareKeyPending`),
  `maybeShowSpareKey` erzeugt nach dem Laden bzw. nach dem Tutorial einen frischen und
  zeigt ihn, `confirmSpareKey` setzt `true`. Wer vorher schließt, bekommt beim nächsten
  Öffnen einen neuen (der ungesehene ist damit ungültig). Löst
  den Zielkonflikt "Passwortverlust soll nicht Datenverlust bedeuten, aber der
  Server darf trotzdem nie Zugriff haben" — funktioniert nur, solange der Nutzer
  diesen Code noch besitzt. Verliert er Passwort UND Recovery-Key, sind die Daten
  tatsächlich unwiederbringlich weg (unumgehbare Konsequenz, kein Bug — jeder auch
  dann noch funktionierende Mechanismus wäre zwangsläufig ein serverseitiger
  Zugriffsweg). Im Burger-Menü jederzeit neu erzeugbar (`regenerateRecoveryKey`,
  macht den alten Code ungültig, braucht kein Passwort, da der DEK ja schon im
  Speicher liegt).

**Schlüssel-Lebenszyklus** (`currentDek`, Modul-Variable, nie Teil von `state`/
`render()`):
- `unlockEncryption(userId, password)`, aufgerufen aus `completeAuthFlow` direkt
  nach erfolgreichem `signIn`/`signUp` (Passwort ist dort im Klartext verfügbar):
  prüft zuerst den lokalen IndexedDB-Cache (`loadCachedDek`, schneller Pfad ohne
  erneute PBKDF2-Ableitung); ohne Treffer wird die `user_encryption`-Zeile geladen —
  existiert keine (Neu-Signup oder Bestandskonto vor diesem Umbau), richtet
  `setupEncryption` alles neu ein (DEK, beide Wrappings, `migrateExistingEntries`
  für schon vorhandene Klartext-Zeilen, Recovery-Key-Anzeige).
- Bei bestehender Supabase-Session ohne frisches Passwort (Browser-Reload): erst der
  IndexedDB-Cache, sonst `renderUnlockPrompt()` (Passwort erneut abfragen, unabhängig
  vom Supabase-Login — falsches Passwort erkennt man daran, dass `unwrapDek`
  fehlschlägt).
- `authFlowInFlight`-Flag verhindert, dass `onAuthStateChange` (feuert bei jedem
  `signIn`/`signUp`/`updateUser` zusätzlich) parallel einen zweiten, redundanten
  Entsperr-Versuch startet — muss VOR dem jeweiligen Supabase-Auth-Aufruf gesetzt
  werden, nicht erst danach (Race Condition sonst möglich).
- Passwort-Reset über den E-Mail-Link (`renderPasswordRecovery`) verlangt zusätzlich
  den Recovery-Key, um den DEK zu erben und neu (mit dem neuen Passwort) zu
  verpacken — ohne Bestandsdaten neu zu verschlüsseln. Fallback "Recovery-Key auch
  verloren" nur mit expliziter zweiter Bestätigung: neuer DEK (`setupEncryption`),
  danach löscht `deleteUndecryptableData` alles mit dem alten DEK Verschlüsselte
  (alle Einträge, Feld-Definitionen mit `enc`, alle Gruppen) – best effort, das neue
  Passwort ist dann schon gesetzt; bei einem Fehler Meldung `recovery.cleanupFailed`.
  Bewusst erst nach `setupEncryption`: scheitert die, bleibt der alte Stand samt
  Recovery-Wrapping erhalten.
- Logout: `currentDek = null` (der IndexedDB-Cache bleibt für den nächsten Login auf
  demselben Gerät), Erinnerungen des Geräts enden (`endPushForThisDevice`). Konto-Löschung
  räumt den Cache zusätzlich explizit auf.
- **Kennung des DEK** (`user_encryption.dek_id`, seit 2026-09-28): zufällige UUID, nicht
  geheim, neu nur wenn ein neuer DEK entsteht (`setupEncryption` – Einrichtung bzw. Reset
  "Recovery-Key auch verloren"). Der IndexedDB-Cache speichert sie neben dem DEK
  (`{key, dekId}`), und vor jeder Nutzung des Caches wird sie mit der Zeile verglichen
  (`usableCachedDek`) – sonst würde ein anderes Gerät nach so einem Reset mit dem alten
  DEK weiter speichern (für alle übrigen Geräte unlesbar). Passt sie nicht: Cache löschen,
  Passwort abfragen (`unlock.keyChanged`). Ohne Verbindung beim Start wird ebenfalls das
  Passwort abgefragt statt dem Cache ungeprüft zu vertrauen. Zusätzlich prüft
  `checkDekStillCurrent` beim Zurückkehren in die App (`visibilitychange`), da ein schon
  entsperrtes Gerät nach dem Reset bis zum Ablauf seines Zugangs-Tokens (bis 1 h)
  angemeldet bleibt; ausstehende Speicherungen werden dabei ungesendet verworfen. Caches
  von vor der Kennung (reiner base64-String) werden einmalig übernommen und bekommen sie
  nachgetragen (Nutzer-Entscheidung: kein erneutes Passwort für alle nach dem Update).
  Migration `20260928120000_add_user_encryption_dek_id`.

**Was das für Änderungen an anderer Stelle bedeutet**: `state.entries` hält nach dem
Laden (`loadEntries`) immer schon entschlüsselte Klartext-Objekte — die gesamte
übrige App (Scores, Graphen, Statistiken, `saveDay`, Export) arbeitet unverändert
damit. `currentDek` fassen nur `loadEntries`/`saveDay`/`handleExportData` (Einträge) sowie
`loadHabits`/`migrateHabitDefinitions`/`handleHabitSaveInner` (Feld-Definitionen) direkt an.

## Design

Ledger/Logbuch-Ästhetik: Parchment-Hintergrund (`--paper`), warmes Schwarz (`--ink`),
Fraunces (Serif, kursiv für Überschriften) + IBM Plex Sans. Farb-Tokens als CSS-Variablen
im `<style>`-Block von `logbuch.html`. Bei Erweiterungen an diesem Stil festhalten,
nicht auf generische Tailwind-/Card-Optik wechseln.

Tab-Leiste zeigt nur noch die Auswertungs-Ansichten (Heute/Woche/Monat/Jahr/Gesamt,
`.tabs` bereits horizontal scrollbar für künftig weitere Views). Alles Konfigurative
sitzt im **Burger-Menü** (☰-Button oben rechts, `renderMenu` in `logbuch.js`), intern
in drei Gruppen unterteilt: Navigation ("Felder verwalten", "Über Logbuch", "Feedback geben") oben,
Einstellungen (Push/Erinnerungszeit/Sprache/Darstellung/Streifenmuster) in der Mitte,
Konto (Export/Recovery-Key/Löschen/Abmelden) unten. Jede Gruppe steckt in einem eigenen
`.menu-group` (kleines, dezentes Caps-Label, `menu.groupNavigation`/`menu.groupSettings`/
`menu.groupAccount`) mit `.menu-group-divider` dazwischen – seit 2026-09-19 (vorher nur
eine dünne Trennlinie ohne Beschriftung, wirkte trotz Gruppierung noch zu wenig
strukturiert/zu eng). `.menu-item-btn` nutzt `--input-bg` (auf Hell weiß, deutlich
gegen `--surface`/`--paper` abgesetzt – dieselbe Fläche wie `<select>`/Textfelder in
der App) statt randlos/transparent zu sein – ein kurzer randloser Zwischenstand am
selben Tag wirkte nicht mehr klickbar genug, zurückgerudert. `.menu-panel` selbst hebt
sich seitdem außerdem über einen kräftigeren Rand (`var(--ink)` statt `var(--line)`)
und stärkeren Schlagschatten vom Hintergrund ab – `--surface` ist im Hellmodus
bewusst identisch mit `--paper` (siehe Dark-Mode-Abschnitt, wichtig für nahtlose
`.sticky-top`-Header), reichte für ein freischwebendes Popover wie das Menü aber nicht
als Abgrenzung. Deshalb seit 2026-09-19 eigener Farb-Token `--popover-bg` (in beiden
Themes leicht heller/anders als `--surface`), aktuell nur vom Menü-Panel genutzt, aber
bewusst allgemein benannt für künftige weitere Popovers. Zwei unterschiedliche Fälle beim Scrollen mit offenem Menü: Scrollen NEBEN dem Panel
(Hintergrund/Fenster) soll das Menü schließen, Scrollen AUF dem Panel selbst (falls
dessen Inhalt z.B. bei Zoom nicht mehr auf den Bildschirm passt) soll dagegen gar
nichts am Hintergrund auslösen, aber innerhalb des Panels normal funktionieren. Löst
sich rein über CSS + einen `scroll`-Listener am `window` (`logbuch.js`, direkt nach
`syncLayerHistory()`): `.menu-panel` hat ein eigenes `max-height`/`overflow-y: auto`
(scrollt bei Bedarf in sich selbst) und `overscroll-behavior: contain` (verhindert
Scroll-Chaining zum Hintergrund, sobald das Panel selbst an sein Scroll-Ende kommt).
`scroll`-Events bubbeln nicht – ein Scroll innerhalb des Panels feuert nur dort, nie am
`window`, der window-weite Listener sieht deshalb ausschließlich echte
Hintergrund-Scrolls und schließt dann das Menü. Keine Body-Scroll-Sperre nötig.

**Unterseiten statt Tab-Swap** (seit 2026-09-18): "Felder verwalten", "Über Logbuch" und
"Feedback geben" (seit 2026-09-25) sind `state.view`-Werte wie die Tabs, aber keine Tabs — sie werden über
`enterSubpage(view)` betreten (merkt sich in `state.previousTabView`, von welchem Tab
aus man kam, außer man wechselt direkt zwischen zwei Unterseiten übers Menü) und
ersetzen Header **und** Tab-Leiste komplett durch einen eigenen `renderSubpageHeader()`
(← Zurück-Button + Seitentitel + derselbe ☰-Button/`renderMenu()` rechts) —
`isSubpageView(view)` steuert diese Verzweigung in `renderApp()`. Kein "Tab ohne
Highlight unter totem Header" mehr wie vorher. Der ←-Button und Android-/Browser-Zurück
(`closeTopLayer()`, siehe unten) führen zum gemerkten `previousTabView` zurück, nie
hart zu "Heute". Beim Betreten einer Unterseite bzw. Wechsel ihrer Ebene (Liste ↔
Feld-Formular) wird deren `<h1>` fokussiert (`tabindex="-1"`, screenreaderfreundliche
Bestätigung der Navigation) – bewusst nur dann (`lastFocusedSubpageLevel`), nicht bei
jedem `render()`, sonst warf jede Umschaltung im Formular den Tastatur-Fokus nach oben. Header (+ bei
Tab-Ansichten auch die Tab-Leiste) sind über `.sticky-top` (`position: sticky`)
angepinnt, damit Menü/Zurück/Tab-Wechsel beim Scrollen immer erreichbar bleiben. In "Über Logbuch" sind alle aufklappbaren
Abschnitte (hervorgehobene Bereiche und Tipp-Gruppen) bei **jedem** Öffnen der Seite
zugeklappt (Nutzer-Wunsch 2026-09-27, `openAboutSections`, von `enterSubpage` zurückgesetzt) –
was man aufklappt, bleibt nur für die Dauer des Besuchs offen, kein dauerhaftes Merken.
Tipps, die auf eine Stelle in der App verweisen ("im Menü", "in Felder verwalten"), haben
darunter einen Link dorthin (`renderTip` mit drittem Element `{ menu: '<ziel>' }` bzw.
`{ manage: true }`; seit 2026-09-28): "Im Menü zeigen" öffnet das ☰-Menü, scrollt nur
innerhalb des Panels zum Eintrag (`data-menu-target`), hebt ihn kurz hervor und fokussiert
ihn (`focusMenuTarget`). Bewusst nur diese Richtung – keine Sprünge zwischen Tipps und
keine Links von der App zurück in die Erklärungen (Nutzer-Entscheidung). Neue Tipps mit
Ortsangabe bekommen denselben Link.

**History-Layer-Zähler statt einfacher An/Aus-Prüfung**: Overlay (z.B. Burger-Menü) und
Unterseite können gleichzeitig offen sein (z.B. Menü öffnen innerhalb von "Verwalten"),
`currentLayerCount()`/`syncLayerHistory()` zählen deshalb 0–2 statt nur zu schließen/
nicht zu schließen. `syncLayerHistory()` gleicht dabei um die volle Differenz ab, nicht
nur um einen Schritt: öffnen sich zwei Ebenen auf einmal (Shortcut "+ Neues Feld" in
"Heute": Verwaltung + Formular), entsteht ein `pushState` pro Ebene; schließen sich
mehrere auf einmal (z.B. Speichern im Shortcut-Formular, Deep-Link, Verlassen der
Verwaltung mit offenem Formular), geht es per `history.go(-Differenz)` zurück – mit
nur einem Schritt blieb sonst ein toter Eintrag stehen bzw. ging das gemeinsame
Schließen einen Schritt zu weit (App verlassen). Eine Falle dabei: so ein selbst
ausgelöstes `history.go()` feuert asynchron ein `popstate`, das ohne Gegenmaßnahme vom
`popstate`-Listener fälschlich als echter Zurück-Druck interpretiert worden wäre und
dabei eine weitere Ebene mitgeschlossen hätte. `closingLayerViaPopstate` wird deshalb
vor jedem selbst ausgelösten `history.go()` gesetzt, und der `popstate`-Listener
konsumiert dieses "eigene" Pop-Event ohne weitere Aktion. Schließt ein echter
Zurück-Druck mehr als eine Ebene (Shortcut-Formular nimmt die Verwaltung mit), räumt
das anschließende `render()` → `syncLayerHistory()` den übrigen Eintrag weg.
**Verlassen der Verwaltung schließt deren Overlays** (`leaveSubpage`/
`closeManageOverlays`, beim Wechsel zu einer anderen Unterseite übers Menü) – sonst
bliebe ein offenes Feld-Formular unsichtbar im State und zählte weiter als History-Ebene.

**Feld-Formular als eigene Ebene der Verwaltung** (seit 2026-09-27): solange
`state.habitForm` offen ist, zeigt `renderManage` NUR das Formular (keine Feldliste
darunter, kein Hinscrollen zu anderen Feldern), der Titel ("Neues Feld"/"Feld
bearbeiten"/…, `habitFormTitleKey`) steht im Seitenkopf statt im Formular (im Tutorial
bleibt er als `<h2>` im Formular, `renderHabitForm({ titleInHeader })`). ←-Button und
Wischen führen dort zurück zur Liste statt aus der Verwaltung (`subpageBack`), bzw. zum
Tab bei `returnToTab`. Geöffnet wird immer über `openHabitForm` (merkt sich die
Scroll-Position; fokussiert nur beim Neuanlegen direkt das Namensfeld – beim Bearbeiten
will man meist etwas anderes ändern, dort bleibt der Fokus auf der Überschrift), `closeHabitForm` stellt sie wieder her (`pendingScrollRestore`, am
Ende von `render()` eingelöst) – man landet nach Speichern/Abbrechen wieder an der
Stelle der Liste bzw. von "Heute", von der man kam.

**"+ Neues Feld"-Shortcut in "Heute"** (seit 2026-09-25): dezenter Text-Button unter der
Feldliste (bewusst kein ausgefüllter Button – "Heute" ist die tägliche Eintrags-Ansicht,
nicht die Verwaltung). Öffnet die Verwaltung mit schon offenem "Neues Feld"-Formular
(Typ-Auswahl wie immer). Das Formular trägt dabei `returnToTab: true` im eigenen
Zustand – `closeHabitForm()` (einziger Schließ-Weg: Speichern, Abbrechen,
Android-Zurück) springt dann direkt zurück zum Tab statt in der Verwaltung zu bleiben,
da die Absicht beim Shortcut "jetzt tracken" ist, nicht "verwalten".

**"Noch offen" in "Heute"** (seit 2026-09-29, `isOpenToday`/`openMarkerHtml`/
`todayAllDone`): ein kleiner Punkt (`.open-dot`, Moos, Form statt Farbe als Unterscheidung)
hinter dem Namen jedes heute geplanten, direkt ausfüllbaren Felds (nicht berechnet) ohne
Wert – dieselbe Logik wie die Erinnerungen, Notizen zählen nicht; im Bereich "Heute nicht
geplant" keiner. Bei eingeklappten Gruppen trägt die Überschrift den Punkt, falls darin
etwas offen ist. Screenreader: "(noch offen)" als versteckter Text am Namen. Ist alles
eingetragen, steht unter der Liste still "Alles eingetragen für heute/diesen Tag"
(`.today-complete`). Text-Felder speichern beim Tippen ohne `render()`, deshalb zieht
`syncTodayOpenMarkers` Punkt und Hinweis dort direkt nach. Nutzer-Entscheidung: markiert
wird nur das Offene, eingetragene Zeilen bleiben unverändert; **bewusst kein Zähler**
("5 von 8" würde eher Druck machen, wie die verworfene Mindestquote bei den Übersichten).
Verworfen: eingetragene Felder nach unten schieben/einklappen (Zeilen sprängen beim
Antippen weg); eingetragene Namen blasser (zu wenig Kontrast für kleinen Text). Erklärt in
"Über Logbuch" (`about.tip.openDot`).

**Zeilen-Menü in "Heute"** (seit 2026-09-27, ⋮-Button seit 2026-09-28;
`renderRowMenuButton`/`renderRowHead`/`renderRowMenuPanel`/`renderSectionMenuPanel`/
`openRowMenu`/`closeRowMenu` in `logbuch.js`, `state.rowMenu` bzw. `data-menu` = Feld-id
oder `section:<id>`): kleines Popover. Bei Feldern "Bearbeiten" (öffnet das Feld-Formular in
der Verwaltung mit `returnToTab: true`, gleiches Muster wie der "+ Neues Feld"-Shortcut) und
"Archivieren" (danach Meldung, wo sich das Feld reaktivieren lässt), bei nicht berechneten
Feldern zusätzlich "Notiz hinzufügen/bearbeiten" (siehe "Notizen in Heute" unten); bei
Gruppen "Notiz" und "Bearbeiten" (Gruppen-Formular, ebenfalls mit `returnToTab`; Löschen
bewusst nicht aus "Heute"). **Auslöser ist ein senkrechtes ⋮ links vor jedem Feld und jeder
Gruppen-Überschrift** (Nutzer-Entscheidung: einheitlich für Felder und Gruppen – bei Gruppen
ist ein Tipp auf die Überschrift schon Auf-/Zuklappen; links statt hinter dem Namen, damit
die ⋮ eine ruhige Spalte bilden). Vorher war der Feldname selbst der einzige Auslöser –
verworfen, weil man einem Namen nicht ansieht, dass er antippbar ist, und es für Gruppen
nicht passte; ein waagerechtes ⋯ hinter jedem Namen wirkte kurz davor zu überladen. Der ⋮
ist das einzige Bedienelement für Tastatur/Screenreader (Disclosure-Muster mit
`aria-expanded`, "Optionen für …", Escape schließt und gibt den Fokus zurück). Abkürzungen
für Zeige-Geräte: Tipp auf den Feldnamen (`row-menu-name`, kein Button) sowie Long-Press
(Touch, eigener 500-ms-Timer, da iOS kein `contextmenu` feuert) bzw. Rechtsklick (Maus) auf
die Zeile bzw. Gruppen-Überschrift. Zahlenwert-/Text-Felder: der Name ist kein `<label>`
(Antippen würde sonst zusätzlich das Eingabefeld fokussieren), das Eingabefeld trägt seinen
Namen per `aria-label`. Vom Long-Press ausgenommen sind Eingabefelder, der Schieberegler und
das Menü selbst, nicht aber der Name (Android macht aus langem Drücken keinen Klick mehr);
der Klick beim Loslassen nach einem Long-Press wird verschluckt (`suppressNextClick`), sonst
würde er auf einem Wert-Button den Wert setzen bzw. die Gruppe auf-/zuklappen. Zählt als
Overlay für die Android-Zurück-Logik. **Light-Dismiss**: bei offenem Menü schließt ein Tipp außerhalb
davon nur das Menü und löst nichts anderes aus (kein direktes Umspringen zum Menü eines
anderen Feldes, kein versehentlich gesetzter Wert) – nur für Zeige-Geräte
(`e.detail > 0`), per Tastatur ausgelöste Klicks laufen nach bewusstem Wegnavigieren
normal durch. Scrollen, Wischen und Deep-Links schließen es ebenfalls.

**Notizen in "Heute"** (seit 2026-09-27, Datenformat siehe Datenmodell →
`habit_entries`): freier Text pro Feld (auch berechnete; nur Text-Felder nicht, dort wäre es
doppelt), pro Gruppe (Schlüssel `section:<id>`, `SECTION_NOTE_PREFIX`, seit 2026-09-28) und
für den ganzen Tag, bewusst **kein Teil der Auswertung**. Gedacht als
Ausnahme ("heute erst nach dem Frühstück gewogen"), nicht als tägliche Eingabe – deshalb
nur über das Zeilen-Menü erreichbar statt über ein eigenes Symbol pro Zeile. Eine
vorhandene Notiz steht als kleiner kursiver Text unter dem Feld bzw. der
Gruppen-Überschrift (`renderNote`, antippbar → Editor; bei Gruppen auch eingeklappt
sichtbar, aber nur an Tagen, an denen die Gruppe in "Heute" steht, d.h. mindestens ein
Feld darin geplant ist – `sectionShownToday`), die Tagesnotiz unter der Feldliste (`renderDayNote`, ohne Notiz ein
gestrichelter Platzhalter-Button). Editor mit explizitem Speichern/Abbrechen, leer
speichern = Notiz löschen, max. `NOTE_MAX_LENGTH` (2000) Zeichen. `state.noteEditor`
(`{dateKey, key, draft, original}`) gehört zu einem Tag und zählt nur dort als Overlay
(`isNoteEditorOpen`). **Getipptes geht nie still verloren**: wird der Editor unsichtbar
(Tag-/Tab-Wechsel, anderer Editor geöffnet), speichert und schließt ihn `render()`
zentral (`commitPendingNoteDraft`); beim Wechsel in eine andere App sichert ein
`visibilitychange`-Listener den Entwurf schon mal (`persistNoteDraft`, Editor bleibt
offen). Nur "Abbrechen" und Android-Zurück verwerfen bewusst (`discardNoteDraft`,
stellt dabei `original` wieder her, falls zwischendurch schon gesichert wurde). Beim
Abmelden wird ein offener Editor verworfen (sonst sähe ihn das nächste Konto auf dem
Gerät). Ein Re-Render beim Tippen behält Fokus/Cursor (`renderApp`).
`ensureNoteEditorVisible` hält den Editor beim Öffnen der Bildschirmtastatur sichtbar:
auf Android verkleinert die Tastatur dank `interactive-widget=resizes-content` (Meta-
Viewport) den Layout-Viewport statt ihn nur zu überdecken; zusätzlich wird gegen
`window.visualViewport` (iOS ignoriert das Attribut) und den angepinnten Header
gerechnet – sofort und nochmal nach Ende der Tastatur-Animation. Wählt man über das
Zeilen-Menü die Notiz eines Feldes, deren Editor schon offen ist, springt der Fokus
zurück ins Textfeld. Ein Feld, das mit offener Notiz archiviert wird, speichert und
schließt deren Editor (`isNoteEditorOpen` prüft auch, ob das Feld noch in "Heute"
steht). Endgültiges Löschen eines Feldes räumt auch dessen Notizen weg
(`purgeKeyFromEntries`). **Übersicht**: Woche – Punkt in der Feld-Zelle (Notiz zu
diesem Feld) und am Wochentag (irgendeine Notiz an dem Tag, auch Tagesnotiz);
Zahlenwert-Felder – Ring um den Datenpunkt im Verlaufsgraphen (alle Ansichten mit
Graph; als HTML über dem SVG, da das SVG nur waagerecht gestreckt wird und ein Kreis
darin zur Ellipse würde), plus "davon X mit Notiz" in der Screenreader-Zusammenfassung;
in Woche/Monat sind die Datenpunkte außerdem antippbar (ganze senkrechte Spalte um den
Punkt → dieser Tag in "Heute", `interactive` in `renderNumberCharts`; nur Zeige-Geräte,
per Tastatur ist derselbe Tag über Wochentage/Monatszellen erreichbar; in Jahr/Gesamt
bewusst nicht, dort läge ~1px pro Tag);
Monat – Punkt in der Tageszelle; Jahr – bewusst keiner (Zellen zu klein). Screenreader:
"mit Notiz" im Label der Tages-Zelle. **"Tag zurücksetzen"** löscht Werte UND Notizen
und fragt deshalb seitdem immer nach (`renderResetConfirm`, `state.resetConfirm` =
dateKey), auch ohne vorhandene Notizen.

**Haptisches Feedback** (seit 2026-09-27, `haptic()` in `logbuch.js`): kurzes
Vibrieren beim Setzen/Entfernen eines Werts (Buttons, Schieberegler erst beim
Loslassen – nicht bei jedem Schritt, das wären bei 100 Stufen zu viele – und ×) sowie
beim Long-Press-Menü, damit versehentliche Eingaben eher auffallen. Im Menü
abschaltbar ("Beim Eintragen vibrieren", geräte-lokal per `localStorage`
`hapticsDisabled` wie Theme/Streifenmuster), standardmäßig an – abschaltbar, weil
Vibration für manche unangenehm ist (z.B. sensorische Empfindlichkeit). **Nur
Android**: Safari auf iOS bietet Webseiten keine Vibration-API, der Schalter wird dort
gar nicht erst angezeigt (`hapticsSupported`).

**Verwaltungsliste entschlackt** (seit 2026-09-18, `renderManage` in `logbuch.js`):
pro Feld-Zeile steht nur noch der Name plus – falls abweichend – Wiederholung und eigene
Erinnerungszeit (`manageFieldMeta`); Skala/Bereich, Bezeichnungen, Gut/Schlecht-
Richtung und Ziel-Quote werden dort nicht mehr aufgeführt (`formatScale` entfernt,
keine andere Stelle nutzte es). Begründung: der Nutzer befüllt seine Felder täglich
und kennt ihre Bedeutung bereits, eine Zusammenfassung pro Zeile ist redundant –
nur die (unauffällige) eigene Erinnerungszeit ist erwähnenswert genug, um
hervorgehoben zu bleiben (plus ggf. Wiederholung und "in der Auswertung ausgeblendet").
Berechnete Felder zeigen stattdessen ihre Mitglieder ("Ø aus: ..."/"Summe aus: ...") mit
kleinem "Berechnet"-Kennzeichen – die einzige Stelle, an der das sichtbar wird. Seit
2026-09-27 stehen alle Felder in EINER frei sortierbaren Liste, dazwischen Gruppen als
Blöcke (siehe "Gruppen" oben); "+ Neues Feld" (ausgefüllt, primär) und "+ Neue Gruppe"
(umrandet) stehen nebeneinander oben (`.manage-new-row`). "Archivieren" hat eine eigene, dezent
rost-getönte Stil-Klasse (`.manage-btn--warn`, heller als `.manage-btn--danger` bei
"Löschen") statt optisch identisch zu "Bearbeiten" zu sein – reversibel, aber ein
Entfernen aus der Tageseingabe, daher bewusst nicht neutral gestylt.

**Rückmeldung beim Zeitraum-Wechsel** (seit 2026-09-29): Wischen und die ‹ ›-Pfeile laufen
über `shiftPeriod(dir)`; danach gleitet der Inhalt (`.view-body`, bewusst nur der Inhalt,
nicht die fixierten Dialoge) in ~0,2 s aus der Wischrichtung herein (`.view-slide-next`/
`-prev`), bei "Bewegung reduzieren" nur ein kurzes Einblenden. Vorher änderte sich der
Inhalt still – in "Heute" sehen zwei Tage oft fast gleich aus. Dazu steht in "Heute"
"Heute"/"Gestern"/"Morgen" neben dem Datum (`relativeDay`), Screenreader bekommen den neuen
Zeitraum über die Live-Region `#sr-announcer` (`announce()`, liegt außerhalb von `#app` und
übersteht so jedes `render()`), und der Fokus bleibt nach einem Pfeil-Klick auf dem Pfeil.
Verworfen bzw. in den Gestaltungs-Durchgang geschoben: Inhalt folgt beim Wischen dem Finger
(deutlich aufwendiger wegen Abgrenzung zum senkrechten Scrollen und Neuaufbau bei jedem
`render()`).

**Swipe-Schwellenwert für Unterseiten höher als für Tab-Wechsel** (seit 2026-09-19,
`SWIPE_THRESHOLD_SUBPAGE` in `logbuch.js`, 100px statt 50px): ein Wisch nach rechts
verlässt auf einer Unterseite (Verwalten/Über Logbuch) die Seite komplett, während er
bei Heute/Woche/Monat/Jahr nur den Zeitraum wechselt – dort war versehentliches
Auslösen (z.B. beim Scrollen in einer langen Feldliste) spürbar störender als bei den
Tabs, deshalb absichtlich weniger empfindlich statt eines einheitlichen Schwellenwerts.

**Dark Mode** (seit 2026-09-16): folgt standardmäßig `prefers-color-scheme`, im
Burger-Menü überschreibbar (System/Hell/Dunkel als Pill-Toggle, gleiches Muster wie
`f.kind`/`f.mode`/`f.good` im Habit-Formular). Override liegt in `localStorage`
(`themeOverride`, Werte `'light'`/`'dark'`/nicht gesetzt = System) — bewusst NICHT in
`user_settings`, da geräte-lokal statt kontoweit gedacht (anders als die Sprache).
`applyTheme()`/`getThemeOverride()`/`setThemeOverride()` in `logbuch.js`, direkt
nach dem i18n-Block. CSS-seitig: `@media (prefers-color-scheme: dark)` UND
`:root[data-theme="dark"]` setzen dieselben Werte für dieselben Tokens (`--paper`,
`--ink`, `--line`, `--moss`, `--rust`, `--sand`, plus neu `--surface` für Modal-/Menü-
Hintergrund, `--input-bg`, `--shadow`, `--scrim`, `--rust-rgb`/`--moss-rgb` für
`rgba()`-Tönungen, `--on-score` für hellen Text auf Score-Zellen, theme-unabhängig).
Text auf Score-Farben (gewählte Buttons, berechnete Felder in "Heute", Ø-Zellen der
Woche) wählt `textOnScore()` stattdessen je Farbe: reines Weiß oder Schwarz, je nachdem was
mehr Kontrast hat – nur damit erreicht jede Stufe der Skala mind. 4,5:1 (fester heller
Text lag auf den hellen Stufen bei ~3:1).
`scoreColor()` selbst bleibt bewusst unverändert (liefert rohe `rgb()`-Werte,
unabhängig vom Theme). `<meta name="theme-color">` wird per JS synchronisiert
(`syncThemeColorMeta`), da Meta-Tags keine CSS-Variablen lesen können.

**Accessibility** (seit 2026-09-16): Kalenderzellen (Woche/Monat/Jahr) sind per
Tastatur erreichbar (`tabindex="0" role="button"`, Enter/Space über einen
generalisierten `data-action`-Keydown-Dispatch, der einen echten Klick auslöst statt
Aktionen zu duplizieren) und tragen zusätzlich zur Farbe ein Streifenmuster
(`scorePatternStyle()`, diskrete Stufen, gröber in der Jahres-Ansicht) für
Rot-Grün-Farbenblinde. Die Bestätigungs-Modals (Konto löschen, Tutorial überspringen, Tag zurücksetzen)
haben `role="dialog"`/Fokus-Trap/Escape-Schließen/Fokus-Rückgabe (siehe
`focusModalIfOpen()`/`restoreModalFocus()`/`modalTriggerSelector`, gemeinsamer Schließ-Weg `closeModals()`). Meldungen laufen
zentral über `renderNotice()` (Fehler `role="alert"`/assertive, Erfolg
`role="status"`/polite) statt über 6 duplizierte Inline-Fragmente. Das Feld-Umsortieren
hat mit Hoch/Runter-Buttons (`commitHabitOrder()`, gemeinsamer Persistenz-Pfad mit dem
Pointer-Drag) eine Tastatur-Alternative. Beim Ziehen scrollt die Liste am oberen/unteren
Bildschirmrand von selbst weiter (`updateDragAutoScroll`, schneller je näher am Rand), damit
sich ein Feld in einem Zug weit verschieben lässt. Der Zahlenwert-Verlaufsgraph hat eine
`.visually-hidden`-Textzusammenfassung (Anzahl/letzter Wert/Durchschnitt/Spanne/Trend)
statt eines reinen `aria-label`.
**Fokus bleibt nach jeder Aktion erhalten** (seit 2026-09-29, `focusKeyOf`/`restoreFocus` in
`render()`): `render()` ersetzt das ganze `#app` – vorher merkt es sich das fokussierte
Element (id bzw. `data-action` + übrige `data-*`-Merkmale) und fokussiert danach das
entsprechende neue, sofern nichts anderes (Dialog, Unterseiten-Überschrift) den Fokus
bekommen hat. Neue klickbare Elemente brauchen deshalb stabile, eindeutige `data-*`-
Merkmale bzw. eine id. Fehlermeldungen auf Anmelde-/Entsperr-/Reset-Seite mit
`role="alert"`. Burger-Menü: `aria-expanded`, Escape schließt. **Wenig Höhe** (Handy quer,
Zoom; `@media (max-height: 500px)`): Kopf und Tab-Leiste nicht angepinnt
(`stickyHeaderBottom()` liefert dann 0), Dialoge scrollen, wenn sie höher als der
Bildschirm sind.

**Android-Zurück-Taste** (seit 2026-09-18, um Unterseiten erweitert am selben Tag): ohne
eigene Browser-History-Einträge hatte die native/Gesten-Zurück-Taste nichts, wohin sie
zurückgehen könnte, und hat stattdessen sofort die App verlassen — unabhängig davon,
was gerade offen war. `isOverlayOpen()`/`isSubpageView()`/`currentLayerCount()`/
`closeTopLayer()`/`syncLayerHistory()` (direkt nach `modalTriggerSelector` in
`logbuch.js`) schließen stattdessen offene Overlays (Burger-Menü, Feld-Formular,
Konto-/Tutorial-/Feld-Lösch-Bestätigungen) UND Unterseiten (Verwalten/Über Logbuch,
siehe oben) über einen `popstate`-Listener, bevor die App wirklich verlassen wird.
Overlay und Unterseite können gleichzeitig offen sein (z.B. "Neues Feld" innerhalb von
"Verwalten") — `currentLayerCount()` zählt deshalb 0-2 statt nur an/aus, mit je einem
`history.pushState()` pro Ebene, synchron gehalten mit `render()` (auch wenn eine Ebene
ganz normal über die App statt über die Zurück-Taste geschlossen wird, sonst blieben
tote History-Einträge stehen). Bewusst NUR für Overlays/Unterseiten, nicht für
Tab-Wechsel (Heute/Woche/...) — entspricht dem üblichen Verhalten von Android-Apps mit
Tab-Leiste. `state.recoveryKeyToShow` ist bewusst ausgenommen (schon jetzt absichtlich
nur über die Bestätigungs-Checkbox schließbar, auch Escape greift dort nicht — soll die
Zurück-Taste nicht aushebeln).

## Internationalisierung (i18n)

Seit 2026-09-16: Deutsch + Englisch, Deutsch bleibt Standard/Fallback. Zentraler
Mechanismus in `logbuch.js`, direkt nach `esc()`:
- `STRINGS = { de: {...}, en: {...} }` – flache Keys mit Punkt-Namespace
  (`'auth.signupButton'`, `'habitForm.error.nameRequired'`, `'ariaLabel.*'` für
  Aria-Labels, `'error.db.*'` für `translateDbError`), beide Sprachblöcke in
  identischer Key-Reihenfolge zum leichten Diffen. Aktuell 464 Keys je Sprache.
- `t(key, params)` liest aus `STRINGS[currentLocale]`, interpoliert `{platzhalter}`
  aus `params` (dabei automatisch `esc()`'t – Aufrufer müssen nicht selbst escapen),
  fällt bei fehlendem Key auf Deutsch zurück und loggt eine Warnung. Das Template
  selbst bleibt unescaped (darf bewusst gesetztes HTML wie `<strong>` enthalten).
  **Meldungen sind reiner Text** (`state.notice`, `authError`, `unlockError` werden beim
  Anzeigen escaped) – Meldungen mit Parametern deshalb mit `tPlain()` bauen (escaped die
  Parameter nicht), sonst erscheinen sie doppelt escaped ("&amp;").
  Eine Start-Assertion beim Laden vergleicht `Object.keys(STRINGS.de)` gegen
  `.en` und meldet jede Abweichung per `console.error`.
- `currentLocale` (Modul-Variable) wird über `applyLocale(locale)` gesetzt (setzt
  zusätzlich `document.documentElement.lang`) – beim Start per
  `detectInitialLocale()` (Browser-Locale als Platzhalter), dann beim Laden von
  `user_settings.locale` überschrieben, änderbar über die Sprachauswahl im
  Burger-Menü (`saveLocale()`, spiegelt exakt das Muster von
  `saveDefaultReminderMinute()`).
- Datum/Wochentage/Monatsnamen laufen über `Intl.DateTimeFormat`-Helfer
  (`weekdayShort`/`weekdayLong`/`monthName`/`monthShort`/`longDate`/`formatDMY`,
  gecacht in `dtfCache`) statt fester Arrays – passt sich automatisch an
  `currentLocale` an (`de-DE` → `DD.MM.YYYY`, `en-US` → `MM/DD/YYYY`). Die
  Montag-zuerst-Wochentag-**Reihenfolge** (`(d.getDay()+6)%7`) ist davon
  unberührt, reine Formatierung der Labels ändert sich, nicht die Tages-Logik.
- `user_settings.locale` (text, Default `'de'`, Check-Constraint `de`/`en`) hält
  die Sprachpräferenz serverseitig, analog zu `default_reminder_minute`.
- Die Edge Function `send-notifications` hat eine eigene, bewusst simplere
  `PUSH_TEXTS`-Tabelle (nur eine Handvoll Strings × 2 Sprachen, kein Teilen der `t()`-
  Maschinerie über die Browser/Deno-Grenze hinweg) und liest `user_settings.locale`
  pro Nutzer, um Push-Texte in der jeweils richtigen Sprache zu verschicken.
- `habit_definitions.name` (frei vom Nutzer vergebene Feldnamen) ist bewusst
  **nicht** Teil dieses Mechanismus – nur App-Chrome-Texte werden übersetzt, nie
  Nutzerinhalte.

## Erinnerungen (Web Push)

Eine einzige Edge Function `send-notifications` läuft **alle 15 Minuten** (statt
fester Zeitpunkte). Wer gerade was bekommt, entscheidet komplett die SQL-Funktion
`public.get_due_notifications(p_now, p_after, p_limit)` (Migrationen
`20260925150000_*`/`20260925160000_*`) – die Edge Function übersetzt deren Zeilen nur
noch in Nachrichten (`PUSH_TEXTS`) und verschickt sie (parallel, `SEND_CONCURRENCY`).
Alle Zeiten/Daten gelten in der **Ortszeit des jeweiligen Nutzers**
(`user_settings.timezone`):
- **Standard-Erinnerungszeit (`user_settings.default_reminder_minute`, Default 22:00,
  im Menü in 15-Minuten-Schritten änderbar)**: alle aktiven Felder OHNE
  eigene `reminder_minute` – unabhängig von `kind` (Skala oder Zahlenwert) – werden
  gemeinsam geprüft. Fehlt an diesem Tag noch mindestens eines davon, gibt es EINE
  Sammel-Nachricht (nicht eine pro Feld). Zusätzlich zu dieser Zeit: sonntags
  "Wochenübersicht ist da", am Monatsletzten "Monatsübersicht ist da" – beides
  gemeinsam per `user_settings.summary_notifications` abschaltbar (ein Schalter für
  beide, bewusst keine getrennten) und nur, wenn im jeweiligen Zeitraum (Montag bzw.
  Monatserster bis heute) mindestens ein Tag mit nicht-leeren `filled_slugs`
  existiert. Bewusst **keine Mindestquote** (z.B. "≥ 3 Tage"): würde in schwierigen
  Phasen eher Druck machen, passt nicht zum Psyche-Fokus der App. Keine eigene
  Jahresübersicht-Benachrichtigung (in die Jahresansicht schaut man ohnehin laufend,
  nicht nur zum Jahresende).
- **Eigene Zeit je Feld**: jedes Feld kann über `reminder_minute` unabhängig von der
  Standardzeit eine eigene Erinnerungszeit bekommen – z.B. Gewicht typischerweise
  morgens statt zur (abendlichen) Standardzeit. In der App per Checkbox "Eigene
  Erinnerungszeit" im Feld-Formular (`<select>` mit allen 96 15-Minuten-Werten,
  `reminderTimeInputHtml` in `logbuch.js` – bewusst kein natives `<input
  type="time">`, dessen `step`-Attribut viele Browser/Betriebssysteme ignorieren,
  wodurch sich trotzdem jede beliebige Minute auswählen ließe), standardmäßig aus.
- **Eigene Zeit je Gruppe** (seit 2026-09-28, `habit_sections.reminder_minute`, Klartext wie
  bei Feldern, DB-Check auf 15-Minuten-Raster): Felder einer solchen Gruppe fallen aus der
  Sammel-Erinnerung zur Standardzeit heraus und werden stattdessen gemeinsam zur Zeit der
  Gruppe erinnert – **eine Nachricht pro Gruppe** (auch wenn mehrere Gruppen oder die
  Standardzeit auf denselben Slot fallen, bewusst nicht zusammengefasst), nur wenn darin
  ein heute geplantes Feld fehlt. **Vorrang: Feld > Gruppe > Standard** – ein Feld mit
  eigener `reminder_minute` behält diese auch in einer Gruppe mit Zeit (Nutzer-
  Entscheidung, damit einzelne Felder weiter heraushebbar bleiben). Text nennt nur den
  Gruppennamen, nicht die fehlenden Felder ("In „…“ fehlt noch etwas", Name wie bei Feldern
  erst auf dem Gerät eingesetzt, `sectionId` im Payload); Deep-Link zum ersten fehlenden
  Feld (klappt die Gruppe auf). Eingestellt im Gruppen-Formular (Checkbox + Uhrzeit), in der
  Verwaltung an der Gruppen-Kopfzeile angezeigt; im Feld-Formular sagt der Hinweis unter
  "Eigene Erinnerungszeit", dass die Gruppe die Zeit regelt (`habitFormReminderNote`,
  wechselt beim Ändern der Gruppe mit). `get_due_notifications` liefert dafür
  `section_missing` (`[{id, fields}]`), Migration `20260928100000_add_section_reminders`.

**Deep-Links**: jede Benachrichtigung trägt ihr Ziel als URL
(`./logbuch.html?view=today|week|month&date=YYYY-MM-DD`, `deepLink()` in der
Function) – `date` ist der Tag, auf den sie sich bezieht, damit z.B. eine erst
Montagmorgen angetippte Wochenübersicht trotzdem die gemeinte Woche zeigt bzw. eine
nach Mitternacht angetippte Erinnerung den gemeinten Tag. `sw.js` öffnet die App mit
dieser URL oder schickt einer schon offenen App das Ziel per `postMessage`
(`logbuch-navigate`, bewusst kein Neuladen – das würde ggf. erneutes Entsperren des
DEK erzwingen). `parseDeepLink`/`applyDeepLink` in `logbuch.js` setzen daraufhin
Ansicht + Zeitraum (auch schon vor dem Entsperren) und entfernen die Parameter per
`history.replaceState` wieder aus der URL. Erinnerungen an ein bestimmtes Feld tragen zusätzlich
`&field=<Feld-ID>` (bei mehreren das erste): "Heute" scrollt dann zum Feld und hebt es
hervor (`pendingFieldFocus`, eingelöst am Ende von `render()` sobald "Heute" mit geladenen
Feldern angezeigt wird – beim Kaltstart kann davor noch Entsperren/Laden liegen).

Die Sammel-Erinnerung zur Standardzeit ist bewusst generisch ("Noch nicht alle Werte
für heute eingetragen.", keine Feldnamen – sonst bei vielen Feldern schnell eine sehr
lange Nachricht). Eine Erinnerung zu einer eigenen Zeit nennt dagegen das konkrete
Feld (`Erinnerung: <Namen> noch nicht eingetragen.`), da dort meist gezielt ein
einzelnes Feld hervorgehoben werden soll (z.B. Gewicht) – **der Name wird dabei erst auf
dem Gerät eingesetzt**: der Server kennt Feldnamen nicht (sollen verschlüsselt sein),
`get_due_notifications` liefert nur Feld-IDs, `send-notifications` schickt einen
allgemeinen Text ("Ein Feld wartet noch …") plus `fieldIds`, und `sw.js` ersetzt ihn
durch den Namen aus einer lokalen Liste (IndexedDB `logbuch-push`, Store `meta`, Key
`fieldNames`: `{ names: {id: name}, template }`, von der App angelegt). Fehlt die Liste
oder eine ID, bleibt es beim allgemeinen Text. Gruppen-Erinnerungen genauso über
`sectionNames`/`sectionTemplate` im selben Eintrag. Die Function protokolliert in ihrer
Antwort (landet in `net._http_response`, 6 h aufbewahrt) nur Anzahlen je Art der Nachricht
und Fehlerursachen – nie Texte, IDs oder wer etwas bekommen hat.

**Zeitzone pro Nutzer**: `get_due_notifications` rechnet für jeden Nutzer per `p_now
AT TIME ZONE timezone` dessen lokales Datum ("heute") und lokalen Viertelstunden-Slot
aus (auf 15 Minuten **abgerundet**, damit ein um ein paar Minuten verspäteter Cron-Lauf
keine Erinnerung verpasst). Die App gleicht `timezone` still mit der Zeitzone des Geräts
ab (`syncTimezone` in `logbuch.js`, bei jedem Laden der Einstellungen und beim
Zurückkehren in die App per `visibilitychange`; im Menü als Hinweis unter der
Standard-Erinnerungszeit angezeigt). Bewusste Entscheidung für "folgt dem Gerät" statt
manueller Einstellung: die App speichert Einträge unter dem **lokalen Gerätedatum** –
nur wenn die Erinnerung derselben Zeitzone folgt, prüfen beide garantiert denselben
Tag. Grenzen (akzeptiert): umgestellt wird erst, wenn die App am neuen Ort einmal
geöffnet wurde; bei zwei Geräten in verschiedenen Zeitzonen gilt das zuletzt
geöffnete. `pg_cron` läuft nur in UTC – das 15-Minuten-Raster passt trotzdem für alle
realen Zeitzonen, da deren Offsets immer auf Viertelstunden liegen (z.B. Indien +5:30,
Nepal +5:45), inkl. Sommer-/Winterzeit (übernimmt Postgres automatisch).

**Skalierung**: die SQL-Funktion siebt früh auf Nutzer aus, bei denen im aktuellen
Slot überhaupt etwas fällig sein kann, und liefert nur fällige Abos zurück – die Edge
Function lädt also nie mehr alle Nutzer. Abruf seitenweise per **Keyset-Pagination**
(`p.id > p_after`, `PAGE_SIZE` 500), da PostgREST jede Antwort bei `api.max_rows`
(1000) still kappt; Keyset statt Offset, damit eine zwischen zwei Seiten wegfallende
Zeile kein Abo überspringen lässt. `p_now` wird einmal pro Lauf festgelegt (alle Seiten
rechnen mit demselben Zeitpunkt) und macht die Funktion mit beliebigen Zeitpunkten
testbar (`select * from get_due_notifications(timestamptz '...')` per `supabase db
query --linked`). Die Funktion liefert Push-Endpoints aller Nutzer – deshalb nur für
`service_role` ausführbar. Versand parallel mit max. `SEND_CONCURRENCY` (25) Abos
gleichzeitig, je Zustellung höchstens `SEND_TIMEOUT_MS` (10 s) – bei Tausenden gleichzeitig fälligen Nutzern (Ballung am 22-Uhr-Default)
stößt aber eher das Zeit-/CPU-Limit pro Function-Aufruf an (jede Push-Nachricht wird
einzeln verschlüsselt/signiert), nicht die Parallelität. Deshalb misst jede Antwort
`due`/`sent`/`failed`/`duration_ms` (nachlesbar in `net._http_response`); nächster
Schritt bei Bedarf wäre Fan-out (Cron-Lauf verteilt Pakete auf eigene Aufrufe bzw.
`pgmq`-Queue, die Keyset-Seiten passen dafür schon) – fällig, sobald ein 22-Uhr-Lauf
regelmäßig > 30 s braucht oder ~1.000 Push-Abos erreicht sind.

Bekannte Kleinigkeit: in der einen Nacht der Zeitumstellung selbst kann ein einzelnes
15-Minuten-Fenster je nach Richtung doppelt oder gar nicht auftreten (entspricht dem
echten Wanduhr-Verhalten an dem Tag). Für einen kleinen Tracker vernachlässigbar,
nicht extra behandelt.

## Onboarding-Tutorial für neue Accounts

Seit 2026-09-15: neue Accounts starten ohne vorbelegte Felder (siehe Datenmodell) und
werden stattdessen durch ein Tutorial geführt (`renderTutorial` in `logbuch.js`),
gesteuert über `state.userSettings.onboardingCompleted` (aus
`user_settings.onboarding_completed`, Default `false` bei neuen Accounts) – solange
`false`, ersetzt `render()` die normale App durch das Tutorial (Prüfung erst NACH dem
DEK-Unlock, das Tutorial braucht ja schon entschlüsselte Daten). `state.tutorialStep`
(1–`TUTORIAL_STEPS`, also 1–4) lebt nur im Speicher, kein Reload-Resume nötig.

**Leitlinie für alle Texte hier** (Nutzer, 2026-09-29): nie nur sagen, dass etwas so ist,
sondern warum; locker statt förmlich, die App als Freund, der helfen will; persönliche
Ich-Form des Machers, wo es um Vertrauen geht ("Nicht mal ich kann sie lesen"). Ein
Bildschirm = ein Thema. Gemeinsame Bausteine (`tutorialScreen`): Fortschritt als Punkte
ohne Zahlen (`tutorialDots`, aktueller Punkt länger, Screenreader hören "Schritt X von
Y"), Symbol, kurze Überschrift (wird bei jedem Bildschirmwechsel fokussiert,
`lastTutorialScreen`), der eine Kernsatz fett, Begründungen im wiedererkennbaren
"Warum?"-Kasten (`whyBox`), kurze Hinweise in normaler Schriftfarbe (`.onb-hint`, nicht
im blassen Sandton der Formular-Hinweise). Zurück/Überspringen stehen in einer eigenen
Fußleiste mit Trennlinie (`tutorialNav`, Zurück links, Überspringen rechts), damit sie sich
klar vom Inhalt abheben; Aktionen des Inhalts ("Lieber nicht", "Noch ein Feld") bleiben
beim Hauptknopf. Versprechen "ohne Druck" bewusst ohne "vergessen" formuliert (ein
ausgelassener Tag kann auch Absicht sein).

- **Davor** (nur Handy im Browser): Installations-Seite vor dem Anmelden, siehe Stack →
  "Installation vor dem Anmelden". **Danach** (immer): der Ersatzschlüssel, siehe
  Verschlüsselung → Recovery-Key.
- **1 Hallo** (`renderTutorialHello`): was Logbuch ist + drei Versprechen mit Symbol
  (privat · ohne Druck · deins). Platz für einen persönlichen Satz des Nutzers ist
  vorgesehen, aber noch offen (siehe Memory "Später beim Nutzer nachfragen").
- **2 Erinnerungen** (`renderTutorialReminders`): Frage mit Begründung ("nur wenn an
  einem Tag etwas fehlt", plus die abschaltbaren Übersichten – muss mit dem echten
  Verhalten übereinstimmen), Hinweis auf die Erlaubnis-Abfrage, "Ja, erinnere mich"
  (`enable-push`) oder "Lieber nicht". Die Uhrzeit erscheint erst, wenn Push aktiv ist.
  Ohne Push-Unterstützung (iOS im Browser) eine Erklärung statt der Frage.
- **3 Erstes Feld**: Einleitung (`renderTutorialFieldIntro`) mit antippbaren Beispielen
  (`TUTORIAL_EXAMPLES`, `tutorialExampleForm`: öffnet das Formular vorausgefüllt, z.B.
  "Gewicht" als Zahlenwert in kg, "Sport" als Ja/Nein) oder "Eigene Idee" (leeres
  Formular), danach die **echte** `renderHabitForm()` (kein Duplikat; ob das erste Feld
  ein vereinfachtes Formular bekommt, ist eine eigene, noch offene Frage des Nutzers) –
  gesteuert über `state.habitForm`: gesetzt zeigt das Formular, `null` (z.B. nach
  "Abbrechen") die Einleitung. Kein Tab-Leiste/Burger-Menü sichtbar; eine
  `beforeunload`-Warnung verhindert versehentliches Verlassen bei offenem Formular. Nach
  erfolgreichem Anlegen (Insert-Zweig in `handleHabitSave`) Sprung zu 4.
- **4 Geschafft** (`renderTutorialDone`): "Loslegen" (`saveOnboardingCompleted()`) oder
  "Noch ein Feld anlegen" (zurück ins Formular, ohne Einleitung).

Überspringen (Schritte 1–3) fragt zweistufig nach (`.modal-overlay`/`.modal-box`,
gleiches Muster wie `renderDeleteConfirm`) und setzt bei Bestätigung sofort
`onboarding_completed = true` – identisch zu "Loslegen".
`saveOnboardingCompleted()` aktualisiert `state` sofort (App erscheint ohne Wartezeit)
und persistiert danach im Hintergrund.

## Datenschutz & Sicherheit

Seit dem Kurswechsel Richtung breiter Öffentlichkeit (siehe oben) laufend erweitert.
Umgesetzt:
- `send-notifications` ist gegen öffentlichen Aufruf abgesichert (`CRON_SECRET`, siehe
  Secrets unten).
- Selbst-Löschung des Kontos (Recht auf Löschung, Art. 17 DSGVO): Edge Function
  `delete-account` (`supabase/functions/delete-account/index.ts`), aufgerufen über
  "Konto löschen" im Burger-Menü der App (Bestätigung durch Eintippen von "LÖSCHEN").
  Löscht per `auth.admin.deleteUser()` ausschließlich den durchs mitgeschickte
  Access-Token ermittelten Nutzer (nie eine vom Client übergebene ID) — alle anderen
  Tabellen hängen per `on delete cascade` an `auth.users` und werden automatisch mit
  gelöscht.
- **Unbestätigte Konten werden automatisch gelöscht** (seit 2026-09-27): pg_cron-Job
  `daily-cleanup` (täglich 03:17 UTC) ruft `public.delete_stale_unconfirmed_users()` auf –
  löscht Konten ohne E-Mail-Bestätigung und ohne je erfolgte Anmeldung 24h nach der
  letzten Bestätigungsmail (`confirmation_sent_at`, nicht `created_at`, sonst träfe es
  jemanden, der sich gerade eine neue Mail geschickt hat; der Link selbst gilt nur 1h,
  `otp_expiry`). Grund Datensparsamkeit: eine vertippte Adresse gehört oft einer
  fremden Person. Derselbe Job räumt `cron.job_run_details` älter als 14 Tage weg (wächst
  sonst mit jedem 15-Minuten-Lauf unbegrenzt). Migration
  `20260927160000_cleanup_unconfirmed_users`.
- Datenexport (Auskunftsrecht/Datenportabilität, Art. 15/20 DSGVO): "Meine Daten
  exportieren" im Burger-Menü (`handleExportData` in `logbuch.js`) lädt die eigenen
  Rohdaten aus allen vier Tabellen (RLS scoped automatisch auf den eigenen Nutzer) direkt
  im Browser als eine JSON-Datei herunter — kein Server-Roundtrip über eine eigene
  Function nötig. Feedback (siehe unten) ist bewusst **nicht** Teil des Exports
  (Nutzer-Entscheidung 2026-09-25).
- **Feedback an den Betreiber** (seit 2026-09-25, Übergangslösung bis zu einem
  möglichen Community-Bereich): Unterseite "Feedback geben" (Burger-Menü + Links an den
  "ich freue mich über Feedback"-Stellen in "Über Logbuch", `renderFeedback`/
  `handleFeedbackSubmit` in `logbuch.js`) → Edge Function `submit-feedback` →
  `record_feedback()` (SQL) speichert in `public.feedback`, danach Mail an den
  Betreiber über Resend (best effort – schlägt die Mail fehl, bleibt das Feedback
  trotzdem gespeichert). Die Tabellen `feedback`/`feedback_rate_log` sind für Nutzer
  weder les- noch schreibbar (RLS ohne Policies, GRANTs nur an `service_role` –
  bewusste Ausnahme von der sonstigen GRANT-Regel), einziger Weg hinein ist die
  Function. **Limit 5 Nachrichten pro Konto in 24h**, serverseitig und atomar
  (Advisory-Lock pro Nutzer) in `record_feedback()` – ein Client-Limit allein wäre per
  direktem API-Aufruf umgehbar. **"Ohne Absender senden"**: `feedback.user_id` bleibt
  NULL, das Limit läuft dann über das getrennte `feedback_rate_log` (nur Konto +
  Zeitpunkt, kein Inhalt, Einträge nach 24h gelöscht – stündlicher pg_cron-Job
  `feedback-rate-log-cleanup`). Bewusst nicht "anonym" genannt:
  der DB-Owner könnte innerhalb dieser 24h theoretisch über Zeitpunkte zuordnen – der
  App-Text verspricht deshalb nur "ich sehe dann nicht, von wem es kommt". Mit
  Absender: die Konto-E-Mail wird als Reply-To der Mail gesetzt (Antworten geht direkt
  an den Nutzer), der Nutzer sieht im Formular, an welche Adresse. Feedback mit
  Absender wird bei Konto-Löschung per Cascade mitgelöscht, ohne Absender nicht (hängt
  an keinem Konto). Mails sind reiner Text (Nutzereingabe nie als HTML).
- Passwort-Reset-Flow: "Passwort vergessen?" im Anmelden-Formular →
  `supabase.auth.resetPasswordForEmail(email, { redirectTo: <aktuelle App-URL> })`.
  Der Rückkehr-Link löst clientseitig das Event `PASSWORD_RECOVERY` aus
  (`onAuthStateChange`-Listener in `logbuch.js`), das App-Routing zeigt dann
  `renderPasswordRecovery()` (neues Passwort setzen via `auth.updateUser`) statt der
  normalen App, unabhängig vom sonstigen Session-Status. **Wichtig bei einer neuen
  Domain/Hosting-URL**: die jeweilige URL muss unter Supabase Dashboard →
  Authentication → URL Configuration als Redirect-URL erlaubt sein, sonst greift der
  Rückkehr-Link ggf. nicht (das ist reine Dashboard-Konfiguration, nicht Teil dieses
  Repos). Aus demselben Grund bekommt auch `signUp()` explizit `options: {
  emailRedirectTo: <aktuelle App-URL> }` mit — ohne das würde der
  Bestätigungslink in der Registrierungs-Mail auf die in Supabase konfigurierte
  "Site URL" zeigen, die nicht zwingend auf den richtigen Pfad passt (führte zu
  einer 404-Seite beim Bestätigen).

- Signup-Schutz gegen Missbrauch: **kein sichtbares Drittanbieter-Captcha** (bewusste
  Entscheidung, siehe unten), sondern zwei dependency-freie Filter im Signup-Formular
  (`renderAuth` in `logbuch.js`): ein für Menschen unsichtbares Honeypot-Feld
  (`.honeypot-field`, off-screen statt `display:none`, da manche Bots das erkennen)
  und eine Mindest-Ausfüllzeit (`SIGNUP_MIN_FILL_MS`, aktuell 1500ms). Beides wird nur
  clientseitig geprüft und bewusst mit einer generischen Fehlermeldung abgelehnt
  (kein Hinweis, welcher Filter zuschlug). Ergänzt durch die ohnehin verpflichtende
  E-Mail-Bestätigung und Supabase's eingebautes Rate-Limiting pro IP.
  - **Vorgeschichte**: zuerst mit Cloudflare Turnstile umgesetzt (Supabase Attack
    Protection, `verify-captcha` Edge Function). Turnstile lud aber eine
    Drittanbieter-Ressource (`challenges.cloudflare.com`), die von Adblockern/
    Tracking-Schutz (u.a. Operas eingebauter Blocker) häufig blockiert wird —
    strukturelles Problem der ganzen Kategorie (Turnstile/hCaptcha/reCAPTCHA
    gleichermaßen betroffen), nicht Cloudflare-spezifisch. Deaktivieren des
    Adblockers hat es im Test nicht zuverlässig behoben (vermutlich Blockierung auf
    einer anderen Ebene, z.B. Private DNS). Turnstile-Widget, `verify-captcha`
    Function und `TURNSTILE_SECRET_KEY` deshalb wieder vollständig entfernt.
  - Schwächer als ein echtes Captcha gegen gezielte Bot-Angriffe, aber reibungslos für
    echte Nutzer unabhängig von Adblocker/Netzwerk — passender Kompromiss für den
    aktuellen Rahmen (kleiner, wachsender Nutzerkreis, kein Hauptziel für organisierte
    Spam-Angriffe).

Datenschutzerklärung/AGB/Impressum sind bewusst NICHT Teil dieses Repos — das klärt der
Nutzer selbst außerhalb, bevor eine wirklich breite/kommerzielle Nutzung startet.

- **E-Mail-Versand (Registrierung/Passwort-Reset) über Custom SMTP** (seit 2026-09-15):
  Supabase's eingebauter Standard-E-Mail-Versand ist hart auf 2 Mails/Stunde
  limitiert (nur für eigenes Testen gedacht, nicht für echte Nutzer) — blockierte
  bei mehreren Test-Registrierungen kurz hintereinander. Jetzt über
  [Resend](https://resend.com) als Custom SMTP (Supabase Dashboard →
  Authentication → Emails → SMTP Settings), Rate-Limit auf 50/Stunde angehoben
  (Authentication → Rate Limits). Versand-Domain `mail.louis-schmidberger.de`
  (Subdomain der privaten Website-Domain des Nutzers, bei IONOS verwaltet, DNS-
  Records für Resend dort eingetragen) — bewusste Interims-Lösung, unabhängig von
  einer möglichen künftigen eigenen Projekt-Domain (die beiden Themen sind
  entkoppelt: eine spätere Domain bräuchte nur eine neue Resend-Domain-Verifizierung,
  nichts an der App selbst). `RESEND_API_KEY` liegt **ausschließlich** im Supabase-
  Dashboard-Formular, nie im Repo. `supabase/config.toml` dokumentiert die
  SMTP-Konfiguration (ohne den Key selbst, per `env(RESEND_API_KEY)`-Platzhalter).
  **Troubleshooting "Bestätigungsmail kommt nie an"**: als Erstes im Supabase-
  Dashboard → Authentication → Emails → SMTP Settings prüfen, ob "Enable custom
  SMTP" noch aktiv ist — der Schalter kann sich (Ursache unklar, kein Zusammenhang
  mit einzelnen Bounces durch Tippfehler in Empfängeradressen) unabhängig von
  Code-/Repo-Änderungen ausschalten. Ist er aus, läuft der Versand unbemerkt über
  Supabase's eingebauten Mailer zurück (2 Mails/Stunde, siehe oben) statt über
  Resend — genau das war am 2026-09-23 die Ursache, als zwei Test-Registrierungen
  keine Mail bekamen. Erst danach im Resend-Dashboard ("Emails"-Tab) nachsehen,
  ob die konkrete Adresse einen Bounce/Fehler zeigt.

- **Passwort-Policy** (seit 2026-09-18): Mindestlänge auf 10 Zeichen angehoben
  (`auth.minimum_password_length` in `supabase/config.toml`, vorher 6 — bewusst
  ohne Zeichenklassen-Zwang, `password_requirements` bleibt leer/"No required
  characters", da aktuelle Empfehlungen Länge über erzwungene Komplexität stellen).
  Zusätzlich im Dashboard aktiviert (Authentication → Sign In / Providers → Email,
  **nicht** Teil von `config.toml`): "Require current password when updating" —
  passt zur Zero-Access-Architektur, da das Passwort der einzige Schlüssel ist.
  "Leaked password protection" (HaveIBeenPwned-Abgleich) bleibt vorerst
  deaktiviert — nur ab Supabase Pro-Plan verfügbar, aktuell auf Free.

## Secrets

- `VAPID_PUBLIC_KEY` ist im Klartext in `logbuch.js` hinterlegt – das ist beabsichtigt,
  öffentliche Push-Keys sind dafür gedacht.
- `VAPID_PRIVATE_KEY` liegt **ausschließlich** als Supabase Function Secret
  (`supabase secrets set ...`), niemals im Repo. Beim Rotieren: neuen Key generieren,
  Secret updaten, öffentlichen Key in `logbuch.js` UND im Push-Subscribe-Flow der
  Nutzer neu abgleichen (alte Subscriptions werden mit neuem Key ungültig).
- `SUPABASE_ANON_KEY` (publishable) ist ebenfalls unkritisch öffentlich, liegt in
  `logbuch.js` und im Vault (`publishable_key`, für den Cron-Aufruf der Edge Function).
- `RESEND_FEEDBACK_KEY` (Function Secret): eigener Resend-API-Key nur für
  `submit-feedback` (Berechtigung "Sending access"), getrennt vom SMTP-Key, damit er
  sich unabhängig sperren lässt. `FEEDBACK_TO_EMAIL` (Function Secret): Empfänger der
  Feedback-Mails – bewusst nicht im Code, da das Repo öffentlich ist; änderbar per
  `supabase secrets set FEEDBACK_TO_EMAIL=...` ohne Code-Änderung. Niemals im Repo.
- `CRON_SECRET` (Function Secret) + Vault-Secret `cron_secret` (gleicher Wert): schützt
  `send-notifications` davor, von außen aufgerufen zu werden. Der `publishable_key`
  allein reicht der Supabase-Gateway-Prüfung (`verify_jwt`), um die Function
  aufzurufen — er steht aber öffentlich im Frontend, wäre also ohne dieses Secret ein
  Weg für jede*n, die Function beliebig oft zu triggern (sie verarbeitet dabei *immer
  alle* Nutzer). Die Function vergleicht den Header `x-cron-secret` mit `CRON_SECRET`
  und lehnt sonst mit 401 ab; nur der Cron-Job kennt den Wert (liest ihn aus dem Vault,
  siehe "Vault-Secrets" unten). Niemals im Repo, wie die anderen privaten Secrets.
- **Vault-Secrets** (Supabase Vault, nicht Teil der Migrationen – Vault-Einträge sind
  Daten, kein Schema, werden von `supabase db push` also nicht mit angelegt): der
  Cron-Job (siehe unten) liest zur Laufzeit drei Einträge aus `vault.decrypted_secrets`
  – `project_url` (die Projekt-URL), `publishable_key` (identisch mit
  `SUPABASE_ANON_KEY` oben) und `cron_secret` (identisch mit dem Function Secret
  `CRON_SECRET` oben). Bei einem Fresh-Setup einmalig im SQL Editor anzulegen:
  ```sql
  select vault.create_secret('<project-url>', 'project_url');
  select vault.create_secret('<publishable-key>', 'publishable_key');
  select vault.create_secret('<frisch generierter zufälliger Wert>', 'cron_secret');
  ```
  `cron_secret` muss exakt dem Wert entsprechen, der auch als Function Secret
  `CRON_SECRET` gesetzt wird (`supabase secrets set CRON_SECRET=<wert>`).

## Deployment-Schritte (Referenz, siehe auch Anleitung im Chat-Verlauf)

1. `logbuch.html`, `logbuch.js`, `sw.js`, `vendor/`, `fonts/` → GitHub Pages (Root-Verzeichnis).
2. `supabase functions deploy <name>` für `send-notifications`, `delete-account` und
   `submit-feedback` (Code unter `supabase/functions/<name>/index.ts`).
3. Schema-Änderungen laufen seit 2026-09-16 über **Supabase-Migrationen**
   (`supabase/migrations/`) statt manuell per SQL-Editor-Copy-Paste. Lokaler Workflow
   braucht Docker Desktop (startet eine lokale Schatten-Datenbank zum Abgleich):
   Änderung lokal als neue Migrationsdatei anlegen (`supabase migration new <name>`),
   dann `supabase db push` gegen das Live-Projekt. Bei Dashboard-Änderungen am Schema
   (sollte die Ausnahme sein) danach `supabase db pull`, um die Migrationshistorie
   wieder abzugleichen. Vault-Secrets sind davon ausgenommen, siehe oben.
4. `supabase/config.toml` (seit 2026-09-15 im Repo, via `supabase config pull`) spiegelt
   Auth-/API-/DB-Projekteinstellungen (u.a. das Custom-SMTP-Setup, siehe oben) – rein
   dokumentarisch, kein automatisierter `config push` im normalen Ablauf. Bei
   Dashboard-Änderungen an diesen Einstellungen gerne erneut `supabase config pull
   --force` laufen lassen, damit die Datei aktuell bleibt.

## Präferenzen für die Zusammenarbeit

- Code-Qualität geht vor Geschwindigkeit.
- **Mobil zuerst** (Nutzer-Einschätzung 2026-09-28): die Nutzer sind mit großem Abstand auf
  Handy und Tablet (Android/iOS), nennenswerte PC-Nutzung wird nicht erwartet. Bei jeder
  Gestaltungs-/Bedienentscheidung von Mobilgeräten und deren Plattform-Konventionen
  ausgehen; der PC muss funktionieren, gibt aber nicht die Richtung vor. Daraus z.B.:
  Button-Paare überall **Abbrechen links, Aktion rechts** (iOS/Android-Konvention, seit
  2026-09-28 einheitlich – vorher Aktion links), auch in der Code-Reihenfolge (Screenreader
  lesen in DOM-Reihenfolge; nebenbei landet der Anfangsfokus in Dialogen so auf
  "Abbrechen"). Untereinander gestapelte Buttons (Tutorial, Anmelden) bleiben Hauptaktion
  oben.
- Bei Unklarheiten nachfragen statt zu raten.
- UI-Texte seit der i18n-Umstellung (siehe Abschnitt oben) auf Deutsch UND
  Englisch pflegen, neue Strings immer über `STRINGS`/`t()` in beiden Sprachen
  anlegen statt hartkodiert.
- **Stand-Datum in "Über Logbuch" mitziehen** (Nutzer-Wunsch 2026-09-27): der Hinweis
  "Beta – Stand …" oben auf der Seite kommt aus `APP_STATUS_DATE` in `logbuch.js` (kein
  Build-Step, der es automatisch setzen könnte). Bei jeder für Nutzer sichtbaren Änderung
  von mindestens mittlerer Größe im selben Commit auf das aktuelle Datum setzen – nicht erst
  am Session-Ende gesammelt. Reine Interna, Doku oder winzige Textkorrekturen zählen nicht.
- **Datenschutz-Text in "Über Logbuch" aktuell halten** (Nutzer-Wunsch 2026-09-27): der
  Bereich "Deine Daten und deine Privatsphäre" (`renderPrivacySection`,
  `about.privacy.*`) sagt Nutzern konkret, was der Betreiber sehen kann und was nicht.
  Jede Änderung, die daran etwas verschiebt (neue unverschlüsselte Spalte, zusätzliches
  Log, serverseitige Auswertung, neuer Drittanbieter o.ä.), muss diesen Text im selben
  Zug mit anpassen – und bei Reviews gegen den tatsächlichen Stand geprüft werden. Nicht
  hineingehören Selbstverständlichkeiten (z.B. dass der Betreiber Feedback lesen kann –
  das ist der Zweck von Feedback) und Details ohne echte Aussagekraft (z.B. ob/seit wann
  ein Feld archiviert ist – bewusst weggelassen, Nutzer-Entscheidung 2026-09-28).

## Noch nicht gebaut (bekannte TODOs, kein Zeitdruck)

(aktuell leer)
