# Datenmodell

Alle Tabellen mit Nutzerdaten haben RLS (jede Zeile nur für den eigenen `user_id` sicht-/
änderbar – schützt Nutzer voreinander, nicht vor dem DB-Owner; dafür ist die
Verschlüsselung da, siehe [verschluesselung.md](verschluesselung.md)). Rechte sind genau auf
SELECT/INSERT/UPDATE/DELETE für `authenticated` zurückgeschnitten (Supabases
Default-Privilegien vergeben auch `anon`/TRUNCATE). Neue Tabellen brauchen explizite GRANTs
in ihrer Migration. Feldtypen, Gruppen und Auswertung: siehe [felder.md](felder.md).

## `habit_definitions` – eine Zeile pro Nutzer und Feld

Jeder Nutzer verwaltet seine Felder selbst über "Felder verwalten" im Menü (`renderManage`):
anlegen, umbenennen, archivieren, reaktivieren.

**Größtenteils verschlüsselt**: die Eigenschaften stehen nicht in Klartext-Spalten, sondern
verschlüsselt in `enc` (Details siehe [verschluesselung.md](verschluesselung.md) →
Feld-Definitionen). Im Klartext bleiben nur `kind`, `reminder_minute`, `schedule`,
`archived_at`, `sort_order`, `section_id`. Im Client heißen die Eigenschaften wie unten.

- `slug` (Key in `habit_entries.data`; verschlüsselt als `key`, bei neuen Feldern ein
  zufälliger Schlüssel aus `newHabitKey` statt aus dem Namen abgeleitet), `name`, `kind`
  (`'scale'`, `'number'`, `'computed'` ("Berechnet") oder `'text'`), `min`/`max` (nur
  `scale`; neue Felder immer `min=1`, `max=<Stufenzahl>`; ältere können eine andere Basis
  haben), `labels` (nur `scale`; `null` = nummerierte Stufen, sonst Array der Länge
  `max-min+1`), `good` (`'high'`/`'low'`/`null` = keine Wertung, nur `scale`), `unit` (nur
  `number`, z.B. `'kg'`), `display_style` (`'buttons'`/`'slider'`, nur `scale`), `slider_show_value`
  (nur bei `slider` relevant – steuert nur die Sichtbarkeit des aktuellen Werts während der
  Eingabe; der Regler zeigt **nie** eine Min/Max-Beschriftung), `group_members` (nur
  `computed`: Schlüssel anderer `scale`- bzw. `number`-Felder dieses Nutzers),
  `reminder_minute` (Minuten seit Mitternacht, 0–1439, 15-Minuten-Raster, `null` =
  Standardzeit; bei `computed` immer `null`, ein berechnetes Feld kann nie "fehlen"),
  `schedule` (Wiederholung, `null` = täglich, bei `computed` immer `null`, siehe unten),
  `sort_order`, `archived_at`.
- **Archivieren** (`archived_at`, Soft-Delete): archivierte Felder verschwinden aus der
  Tageseingabe und sind in der Auswertung standardmäßig ausgeblendet (pro Feld wieder
  einblendbar, siehe [felder.md](felder.md) → "In der Auswertung anzeigen"); reaktivierbar.
- **Endgültig löschen** (`habit-delete`) geht auch mit historischen Einträgen, dann aber
  erst nach zweitem Bestätigungsklick (`state.habitDeleteConfirm`), da die Rohwerte danach
  nicht mehr auswertbar sind. Löscht zuerst die Definition, räumt danach per
  `purgeKeyFromEntries` best effort den Schlüssel (und die Notizen dazu) aus jedem
  betroffenen Tages-Eintrag weg (über die entschlüsselten `state.entries`, gespeichert je
  Tag über `saveDay`), statt ihn verwaist im verschlüsselten JSON liegen zu lassen – passend
  zur Zero-Access-/Löschrecht-Ausrichtung: "Löschen" soll möglichst wenig übrig lassen.
- **Feld-Typ und Stufenzahl sind nur änderbar, solange das Feld noch keine Daten hat**
  (`habitHasData`/`f.locked`) – sonst würden alte Werte plötzlich etwas anderes bedeuten.
  Für eine neue Skala: archivieren, neu anlegen. Alles andere (Name, Einheit,
  Bezeichnungen, Darstellung, Bewertung, Wiederholung, Erinnerungszeit) bleibt änderbar
  (Details [felder.md](felder.md) → "Bearbeiten mit vorhandenen Daten"). Gilt nicht für
  `computed`: hält nie einen eigenen Eintrag, ist nie "locked"; eine geänderte
  Mitgliederliste wirkt rückwirkend auf die ganze Auswertung (Durchschnitt wird bei jedem
  Rendern live berechnet, nie gespeichert) – beabsichtigt.
- **Kein automatisches Seeding** (bewusst): neue Nutzer starten leer und werden durch das
  Onboarding-Tutorial zu eigenen, selbst gewählten Feldern geführt.

## `habit_entries` – eine Zeile pro Nutzer und Kalendertag

- `entry_date`, `data` – **clientseitig verschlüsselt** (`{iv, ciphertext}`). Entschlüsselt
  enthält das Objekt die Werte des Tages, Keys = `slug`s des Nutzers.
- **Notizen** liegen im selben Objekt unter dem einzigen reservierten Schlüssel `_notes`:
  `{ mood: 3, _notes: { mood: "…", _day: "…" } }` – je Feld-Slug eine Notiz, `_day` für den
  ganzen Tag, `section:<id>` für Gruppen (`NOTES_KEY`/`DAY_NOTE_KEY`/`SECTION_NOTE_PREFIX`,
  `getNote`/`withNote`). Kollidiert nie mit einem Feld, da Feld-Schlüssel nur aus `a-z0-9`
  bestehen. **Konvention: Schlüssel mit `_` am Anfang sind nie Feldwerte.** Ohne
  verbleibende Notiz verschwindet `_notes` wieder.
- `filled_slugs` – bewusst **unverschlüsselt**, nur die **IDs** (`habit_definitions.id`) der
  an dem Tag befüllten Felder, keine Werte/Namen (Spaltenname historisch). Nur für
  `get_due_notifications` (Server kann `data` nicht lesen). Notizen zählen nicht – eine
  Notiz allein gilt für Erinnerungen nicht als eingetragen. Bewusst keine Speicher-Uhrzeit
  (verriete, wann jemand typischerweise einträgt). Trigger
  `habit_entries_normalize_filled_slugs` übersetzt noch auftauchende slugs (alte
  App-Version) in Feld-IDs, solange die Definition unverschlüsselt ist; nicht Zuordenbares
  fällt weg.
- **Speichern eines Tages** (`saveDay`): ein Tag ist ein einziges verschlüsseltes Objekt –
  ein zweites Gerät mit veraltetem Stand würde sonst anderswo eingetragene Werte
  überschreiben. Deshalb holt jede Speicherung zuerst die aktuelle Zeile; hat sie sich seit
  dem zuletzt bekannten Stand geändert (`syncedEntries`, erkannt am IV), führt `mergeDay`
  beide Schlüssel für Schlüssel zusammen (eigene Änderungen gewinnen, sonst Server-Stand,
  Notizen einzeln). Speicherungen eines Tages laufen nacheinander (`daySaveChains`) und
  schreiben immer den dann aktuellen `state.entries`-Stand – **Aufrufer ändern
  `state.entries` vorher und rufen nur `saveDay(dateKey)`**. Nicht entschlüsselbare Tage
  werden nie überschrieben (`undecryptableEntryDates`, Meldung statt Speichern).
- Einträge laden seitenweise (`fetchAllRows`, PostgREST kappt bei 1000 Zeilen).
- **Rückkehr in die App** (`visibilitychange`): Schlüssel-Prüfung (`checkDekStillCurrent`),
  Tageswechsel (`rollOverToNewDay`: wer auf dem damaligen "heute" bzw. laufenden Zeitraum
  stand, landet auf dem neuen – sonst trüge man nach einer Nacht im Hintergrund in den
  Vortag ein) und nach ≥ 5 Min. Abwesenheit Neuladen von Einträgen, Feldern und Gruppen
  (`refreshAfterReturn`, nicht bei offenem Formular/Editor; verwirft das Ergebnis, falls
  währenddessen schon etwas geändert wurde).

## `habit_sections` – Gruppen

`id`, `user_id`, `enc` (verschlüsselter `{name}`), `sort_order`, `reminder_minute` (eigene
Erinnerungszeit oder `null`). Zuordnung über die Klartext-Spalte
`habit_definitions.section_id` → FK `ON DELETE SET NULL`; Trigger
`habit_definitions_check_section_owner` erzwingt eine Gruppe desselben Nutzers. Bedeutung
und Bedienung siehe [felder.md](felder.md) → Gruppen.

## `push_subscriptions`

Eine Zeile pro Browser/Gerät mit aktivierten Erinnerungen (Endpoint + Schlüssel). Endpoint
nur `https://`, begrenzte Längen, höchstens 10 Abos pro Konto (Trigger
`push_subscriptions_limit`) – `send-notifications` schickt an jeden Endpoint eine Anfrage,
ohne Grenze könnte ein Konto den Versand für alle ausbremsen. Abmelden beendet die
Erinnerungen des Geräts (siehe [erinnerungen.md](erinnerungen.md)).

## `user_settings` – eine Zeile pro Nutzer

`default_reminder_minute` (0–1439, 15-Min.-Raster, Default 1320 = 22:00),
`onboarding_completed` (Default `false`, steuert das Tutorial), `summary_notifications`
(Default `true`, Wochen-/Monatsübersicht), `timezone` (IANA, Default `'Europe/Berlin'`,
per Trigger gegen `pg_timezone_names` validiert, folgt still dem Gerät), `locale`
(`de`/`en`, Default `de`). Die Zeile wird bei Registrierung automatisch angelegt (Trigger
`on_auth_user_created_seed_settings`).

## `user_encryption` – eine Zeile pro Nutzer

Hält den zweifach verpackten DEK, nie den Schlüssel selbst. **Kein** Seed-Trigger – die
Einrichtung passiert erst beim ersten echten Login, da sie das Passwort im Klartext braucht.
Details [verschluesselung.md](verschluesselung.md).

## Weitere Tabellen

`feedback`, `feedback_rate_log`, `protected_accounts` – siehe
[datenschutz-sicherheit.md](datenschutz-sicherheit.md).

## Robustheit von `get_due_notifications`

Die Abfrage läuft über alle Nutzer in einem Rutsch – ein einziger Wert, an dem sie
scheitert, ließe den ganzen Lauf abbrechen. Deshalb prüft die DB die Form aller dort
gelesenen, vom Nutzer schreibbaren Spalten selbst: `schedule` über `habit_schedule_valid`
(CHECK, spiegelt `formToSchedule`), `filled_slugs` muss ein Array sein, `timezone` per
Trigger, Erinnerungsminuten per Bereich. **Neue solche Spalten brauchen dieselbe Prüfung.**

Die Funktion fragt live die aktiven `habit_definitions` je Nutzer ab (keine hartkodierte
Liste). `kind='computed'` ist ausgeschlossen (nie direkt befüllbar, sonst dauerhaft
"fehlend"). Erinnert wird, sobald mindestens ein zur jeweiligen Zeit fälliges aktives Feld
an dem Tag noch fehlt. Felder, die an dem (lokalen) Tag laut Wiederholung nicht dran sind,
zählen weder als fehlend noch lösen sie ihre eigene Zeit aus (`habit_scheduled_on`).
Details [erinnerungen.md](erinnerungen.md).

## Wiederholung (`habit_definitions.schedule`)

Pro Feld einstellbar, an welchen Tagen es "dran" ist (Formular "Wiederholung": Typ als
Auswahlliste, Wochentage als 7 runde Buttons; nicht für berechnete Felder – die sind dran,
sobald eines ihrer aktiven Mitglieder dran ist).

Format: `null` = täglich, sonst `{type:'weekly', days:[0..6]}` (0 = Montag),
`{type:'monthly', day:1..31 | -1}` (-1 = letzter Tag), `{type:'yearly', month, day}` oder
`{type:'interval', every: 1..365, unit:'day'|'week', start:'YYYY-MM-DD'}` (davor nie dran).
Einen Tag, den es im Monat nicht gibt (31.4., 29.2. außerhalb von Schaltjahren), behandeln
beide Seiten als Monatsletzten statt ihn ausfallen zu lassen; ungültige Pläne gelten als
dran (die DB lässt sie per CHECK gar nicht erst zu). Alle 7 Wochentage bzw. "alle 1 Tage"
werden als `null` gespeichert (eine einzige Darstellung von täglich).

**Zwei Implementierungen derselben Regeln, die synchron bleiben müssen**:
`isScheduledOn`/`isPlannedOn` in `logbuch.js` und `public.habit_scheduled_on(schedule,
date)` (plpgsql, aktuelle Fassung in Migration `20260929120000_harden_reminder_inputs`).

Bewusst **nicht** unterstützt: Kalender-Regeln wie "jeder erste Montag im Monat" (Nutzer:
unübersichtlich und eher irrelevant) und Häufigkeits-Ziele ohne feste Tage ("3x pro Woche"
– anderes Konzept, eher Richtung Ziel-Quote).

- **"Heute"**: nicht geplante Felder stehen eingeklappt unter "Heute nicht geplant (N)"
  (`<details class="unplanned">`) – ausnahmsweise eintragen geht dort trotzdem. Die
  Einteilung richtet sich nur nach dem Plan, nicht nach vorhandenen Werten (sonst spränge
  ein Feld beim ersten Antippen heraus); dafür ist der Bereich automatisch offen, sobald
  dort an dem Tag ein Wert oder eine Notiz steht. Offen/zu übersteht einen Re-Render über
  `state.unplannedOpenFor` (dateKey). Ein Sprung aus der Auswertung zu einem Feld darin
  klappt ihn auf (`focusTodayField`).
- **Woche**: Zellen an nicht geplanten Tagen ohne Wert sind gestrichelt schraffiert
  (`.grid-cell--unplanned`), damit "nicht dran" nicht wie "vergessen" aussieht. Die
  Zellfarbe steht deshalb inline als `background-color`, **nicht** als Kurzschreibweise
  `background:` – die setzte die Schraffur (`background-image`) zurück.
  Durchschnitte/Quoten sind unberührt (rechnen nur mit eingetragenen Werten).
- **Verwaltungsliste**: Kurzform des Plans neben einer ggf. eigenen Erinnerungszeit
  (`manageFieldMeta`/`scheduleSummary`, z.B. "Mo, Mi, Fr · Erinnerung 08:00").
