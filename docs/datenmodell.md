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
Feld-Definitionen). Im Klartext bleiben nur `kind`, `reminder_minute`, `reminder_minutes`, `schedule`, `period`,
`period_reminder_day`, `archived_at`, `sort_order`, `section_id`. Im Client heißen die Eigenschaften wie unten.

- `slug` (Key in `habit_entries.data`; verschlüsselt als `key`, bei neuen Feldern ein
  zufälliger Schlüssel aus `newHabitKey` statt aus dem Namen abgeleitet), `name`, `kind`
  (`'scale'`, `'number'`, `'counter'` ("Zähler"), `'computed'` ("Berechnet") oder `'text'`), `min`/`max` (nur
  `scale`; neue Felder immer `min=1`, `max=<Stufenzahl>`; ältere können eine andere Basis
  haben), `labels` (nur `scale`; `null` = nummerierte Stufen, sonst Array der Länge
  `max-min+1`), `good` (`'high'`/`'low'`/`null` = keine Wertung, nur `scale`), `unit` (nur
  `number`, z.B. `'kg'`), `display_style` (`'buttons'`/`'slider'`, nur `scale`), `slider_show_value`
  (nur bei `slider` relevant – steuert nur die Sichtbarkeit des aktuellen Werts während der
  Eingabe; der Regler zeigt **nie** eine Min/Max-Beschriftung), `group_members` (nur
  `computed`: Schlüssel anderer `scale`- bzw. `number`-Felder dieses Nutzers),
  `reminder_minute` (Minuten seit Mitternacht, 0–1439, 15-Minuten-Raster, `null` =
  Standardzeit; bei `computed` immer `null`, ein berechnetes Feld kann nie "fehlen"),
  `reminder_minutes` (bis zu 4 Zeiten aufsteigend, nur Tagesfelder, `null` bei keiner oder einer
  Zeit; CHECK `habit_reminder_minutes_valid`; Trigger `habit_definitions_sync_reminder_minutes`
  hält `reminder_minute` auf der ersten Zeit und verwirft die Liste, wenn eine ältere
  App-Version nur `reminder_minute` ändert),
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
- **Feld-Typ und "Wie oft" sind nur änderbar, solange das Feld noch keine Daten hat**
  (`habitHasData`/`f.locked`) – sonst würden alte Werte plötzlich etwas anderes bedeuten.
  Die Stufenzahl einer Skala ändert "Stufen ändern", den Typ (außer aus Text) "Typ ändern",
  beide samt Umrechnung der Einträge (Sicherung `_prev`, siehe unten). Alles andere
  (Name, Einheit, Bezeichnungen, Darstellung, Bewertung, Wiederholung, Erinnerungszeit)
  bleibt änderbar (Details [felder.md](felder.md) → "Bearbeiten mit vorhandenen Daten"). Gilt nicht für
  `computed`: hält nie einen eigenen Eintrag, ist nie "locked"; eine geänderte
  Mitgliederliste wirkt rückwirkend auf die ganze Auswertung (Durchschnitt wird bei jedem
  Rendern live berechnet, nie gespeichert) – beabsichtigt.
- **Kein automatisches Seeding** (bewusst): neue Nutzer starten leer und werden durch das
  Onboarding-Tutorial zu eigenen, selbst gewählten Feldern geführt.

## `habit_entries` – eine Zeile pro Nutzer und Kalendertag

- `entry_date`, `data` – **clientseitig verschlüsselt** (`{iv, ciphertext}`). Entschlüsselt
  enthält das Objekt die Werte des Tages, Keys = `slug`s des Nutzers.
- **Notizen** liegen im selben Objekt unter dem reservierten Schlüssel `_notes`:
  `{ mood: 3, _notes: { mood: "…", _day: "…" } }` – je Feld-Slug eine Notiz, `_day` für den
  ganzen Tag, `section:<id>` für Gruppen (`NOTES_KEY`/`DAY_NOTE_KEY`/`SECTION_NOTE_PREFIX`,
  `getNote`/`withNote`). Kollidiert nie mit einem Feld, da Feld-Schlüssel nur aus `a-z0-9`
  bestehen. **Konvention: Schlüssel mit `_` am Anfang sind nie Feldwerte.** Ohne
  verbleibende Notiz verschwindet `_notes` wieder.
- **Sicherung von "Stufen ändern"/"Typ ändern"** unter `_prev`: `{ <Feld>: { c: <Umstellungs-Id>, v: <alter
  Wert> } }` (`PREV_KEY`/`withPrev`), je Feld nur die letzte Umstellung; endgültiges Löschen
  des Felds räumt sie mit weg (`purgeKeyFromEntries`). Ablauf siehe [felder.md](felder.md).
- `filled_slugs` – bewusst **unverschlüsselt**, nur die **IDs** (`habit_definitions.id`) der
  an dem Tag befüllten Felder, keine Werte/Namen (Spaltenname historisch). Nur für
  `get_due_notifications` (Server kann `data` nicht lesen). Notizen zählen nicht – eine
  Notiz allein gilt für Erinnerungen nicht als eingetragen. Bewusst keine Speicher-Uhrzeit
  (verriete, wann jemand typischerweise einträgt). Trigger
  `habit_entries_normalize_filled_slugs` übersetzt noch auftauchende slugs (alte
  App-Version) in Feld-IDs, solange die Definition unverschlüsselt ist; nicht Zuordenbares
  fällt weg.
- `reminder_progress` – unverschlüsselt, `{ <Feld-ID>: 0–4 }`: je Zähler mit eigenen Zeiten
  und Bedingungen ("falls weniger als"), wie viele davon an dem Tag erfüllt sind
  (`reminderProgress`, in `saveDay` mitgeschrieben). Nur die Stufe, nie Zählerstand oder Zahlen
  (Nutzer-Entscheidung 2026-10-28, siehe [erinnerungen.md](erinnerungen.md) → Zähler). CHECK `habit_reminder_progress_valid`.
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

## Zeitraum-Felder (`habit_definitions.period`)

`period` = `'day'` (Standard, alle bisherigen Felder) | `'week'` | `'month'` | `'year'`. Ein
Zeitraum-Feld hat **einen Wert pro Zeitraum**, an jedem Tag darin setzbar, gespeichert im
Eintrag des **ersten Tags des Zeitraums** (Montag, Monatserster, 1.1.) unter dem
Feldschlüssel – bewusst keine eigene Tabelle: Verschlüsselung, `saveDay`/`mergeDay`, Export
und Löschen funktionieren so unverändert. Erster Tag: `periodStart` (JS) und
`public.habit_period_start` (SQL) – **synchron halten**. Zeitraum-Felder haben keine
Wiederholung, sind nie "Berechnet" und in keiner Gruppe (DB-Check
`habit_definitions_period_combination_check`). `period_reminder_day`: Tag der Erinnerung im
Zeitraum, `null` = Standard (Woche: ISO-Wochentag 1–7, Std. 7 = Sonntag; Monat: 1–31 oder
-1 = letzter, Std. letzter; Jahr: MMTT, Std. 1231; ein Tag, den es im Monat nicht gibt, gilt
als Monatsletzter), DB-Check `habit_definitions_period_check`. Beides Klartext, weil
`get_due_notifications` es braucht (Entscheidung 2026-10-11, wie `schedule`). Erinnerung
siehe [erinnerungen.md](erinnerungen.md).

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
Trigger, Erinnerungsminuten per Bereich, `reminder_minutes` und `reminder_progress` per
CHECK-Funktion. **Neue solche Spalten brauchen dieselbe Prüfung.**

Die Funktion fragt live die aktiven `habit_definitions` je Nutzer ab (keine hartkodierte
Liste). `kind='computed'` ist ausgeschlossen (nie direkt befüllbar, sonst dauerhaft
"fehlend"). Erinnert wird, sobald mindestens ein zur jeweiligen Zeit fälliges aktives Feld
an dem Tag noch fehlt. Felder, die an dem (lokalen) Tag laut Wiederholung nicht dran sind,
zählen weder als fehlend noch lösen sie ihre eigene Zeit aus (`habit_scheduled_on`).
Details [erinnerungen.md](erinnerungen.md).

## Wiederholung (`habit_definitions.schedule`)

Pro Feld einstellbar, an welchen Tagen es "dran" ist (Formular "An welchen Tagen?": Umschalter
"Wochentage" mit 7 runden Wochentags-Knöpfen, alle vorbelegt, oder "Alle paar Tage" mit
Abstand und erstem Tag; nicht für berechnete Felder – die sind dran, sobald eines ihrer
aktiven Mitglieder dran ist). Monatlich/jährlich decken Zeitraum-Felder ab.

"Alle N Tage" (Nutzer-Entscheidung 2026-10-28) ist für Dinge mit festem Abstand, der nicht zur
Woche passt (alle 3 Tage Pflanzen gießen, alle 14 Tage eine Spritze). Bewusst ohne
Warnhinweis zur Zuverlässigkeit der Erinnerungen in "Über Logbuch" (Nutzer-Entscheidung
2026-10-28).

Gedacht nur für Dinge an festen Tagen (montags wiegen). Was man mal macht und mal nicht
(Sport), bleibt täglich – "Nein" ist dann ein Eintrag, das Ziel regelt die Ziel-Quote; "einmal
pro Woche, egal an welchem Tag" ist ein Zeitraum-Feld (siehe oben), keine Wiederholung. Die
Texte im Formular und in "Über Logbuch" sagen das so (Nutzer-Entscheidungen 2026-10-10/11).

Format: `null` = täglich, `{type:'weekly', days:[0..6]}` (0 = Montag) oder
`{type:'interval', every:2..365, unit:'day', start:'YYYY-MM-DD'}` (dran am Starttag und dann
alle `every` Tage, davor nicht); die DB lässt per CHECK (`habit_schedule_valid`) nichts
anderes zu, ungültige Pläne gelten als dran. Alle 7 Wochentage werden als `null` gespeichert (eine einzige Darstellung
von täglich).

**Zwei Implementierungen derselben Regel, die synchron bleiben müssen**:
`isScheduledOn`/`isPlannedOn` in `logbuch.js` und `public.habit_scheduled_on(schedule,
date)` (plpgsql, aktuelle Fassung in Migration `20261028160925_schedule_interval`). Der Tagesabstand in JS
rechnet über lokale Mitternacht mit `Math.round(…/86400000)`, damit Sommer-/Winterzeit
(23/25-Stunden-Tage) nicht um einen Tag verschiebt.

Bewusst **nicht** unterstützt: Kalender-Regeln wie "jeder erste Montag im Monat" (Nutzer:
unübersichtlich und eher irrelevant). Häufigkeiten ohne feste Tage ("3x pro Woche") regelt
die Ziel-Quote eines täglichen Felds, "1x pro Woche" ein Wochenfeld.

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
