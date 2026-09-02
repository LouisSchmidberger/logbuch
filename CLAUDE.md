# Logbuch – Projektkontext

Habit-/Gewichts-Tracker, standalone gebaut (bewusst unabhängig von Claude.ai, läuft
komplett eigenständig). Ursprünglich als reiner Einzelnutzer-Tracker in einem
Claude.ai-Chat konzipiert, seitdem in Claude Code weitergeführt; seit der
`habit_definitions`-Umstellung (siehe Datenmodell) mehrnutzerfähig – jeder Nutzer
verwaltet seine eigenen Felder. Registrierung ist bewusst offen (kein Invite-System) –
akzeptierter Trade-off für einen kleinen, informell geteilten Kreis (Freunde/Familie),
kein Wachstum auf breite Öffentlichkeit vorgesehen.

## Stack

- **Frontend**: `logbuch.html` – eine einzelne Datei, Vanilla JS (kein Framework, kein
  Build-Step), `supabase-js` per ESM-CDN-Import. Rendering per Template-Strings +
  Event-Delegation auf `#app` (kein virtuelles DOM, bewusst einfach gehalten).
- **Service Worker**: `sw.js` – nur für Web-Push-Empfang/-Klick, sonst nichts (kein Offline-
  Caching gebaut).
- **Backend**: Supabase (Projekt-Ref `qdadoqcnqmrauhshvcts`, Region Europe) – Postgres-Tabellen,
  Auth (E-Mail/Passwort), Edge Function für Push-Versand.
- **Hosting**: GitHub Pages, statisch. `logbuch.html` und `sw.js` müssen im selben
  Wurzelverzeichnis des gehosteten Pfads liegen.

## Datenmodell

Tabelle `habit_definitions`: eine Zeile pro Nutzer und Feld – **ersetzt die frühere feste
`HABITS`-Konstante**. Jeder Nutzer verwaltet seine Felder selbst über den Tab "Felder" in
der App (anlegen, umbenennen, archivieren, reaktivieren; siehe `renderManage` in
`logbuch.html`).
- `slug` (text, Key in `habit_entries.data`), `name`, `min`/`max` (int), `labels` (jsonb,
  `null` = Zahlenwerte, sonst Array von Strings der Länge `max-min+1`), `good`
  (`'high'`/`'low'`), `sort_order`, `archived_at` (Soft-Delete – archivierte Felder
  verschwinden aus der Tageseingabe, bleiben aber in Wochen-/Monatsansicht sichtbar,
  solange sie dort Daten haben, und lassen sich reaktivieren).
- **Skala (`min`/`max`/`labels`) ist nur änderbar, solange das Feld noch keine Daten hat**
  (App-seitig gesperrt, siehe `habitHasData`/`f.locked`) – sonst würden alte Werte
  plötzlich etwas anderes bedeuten. Für eine neue Skala: altes Feld archivieren, neues
  anlegen.
- Neue Nutzer bekommen die bisherigen 13 Standardfelder automatisch vorbelegt (Trigger
  `on_auth_user_created_seed_habits` in `supabase-setup.sql`) – ab da aber genauso frei
  verwaltbar wie jedes selbst angelegte Feld.
- RLS aktiv: jede Zeile nur für den eigenen `user_id` sicht-/änderbar – Felder eines
  Nutzers beeinflussen keinen anderen.

Tabelle `habit_entries`: eine Zeile pro Nutzer und Kalendertag.
- `entry_date` (date), `data` (jsonb) – alle Werte des Tages in einem Objekt.
- Keys in `data` entsprechen den `slug`s aus `habit_definitions` des jeweiligen Nutzers,
  plus optional `weight` (number, kg – **kein** Habit, eigene Behandlung, siehe unten).
- RLS aktiv: jede Zeile nur für den eigenen `user_id` sicht-/änderbar.

Tabelle `push_subscriptions`: eine Zeile pro Browser/Gerät mit aktivierten Erinnerungen
(Web-Push-Endpoint + Schlüssel). RLS wie oben.

**Der 22-Uhr-Reminder-Check** ("sind noch nicht alle Felder ausgefüllt?") in der Edge
Function fragt dafür live die aktiven (nicht archivierten) `habit_definitions` je Nutzer
ab – keine hartkodierte Liste mehr, kein manuelles Synchronhalten nötig. Erinnert wird,
sobald mindestens ein aktives Feld an dem Tag noch fehlt, nicht erst wenn der ganze Tag
leer ist.

## Skalen-/Farblogik

`normalize(habit, value)` bildet jeden Wert auf 0 (schlecht) bis 1 (gut) ab, unabhängig
von der Richtung (`good: 'high'` vs. `good: 'low'`, z.B. bei "Gekifft"/"Gevaped").
`scoreColor(score)` färbt danach rot→grau→grün. Gewicht ist bewusst **ausgenommen** von
dieser Logik (kein "gut/schlecht" bei einem Gewichtswert) – hat eigenes Eingabefeld, keine
Farbe, kein Eintrag in `habit_definitions`. Es gibt keinen separaten Bool-Typ mehr – ein
Ja/Nein-Feld ist einfach eine Skala mit `min:0, max:1, labels:['Nein','Ja']`.

## Design

Ledger/Logbuch-Ästhetik: Parchment-Hintergrund (`--paper`), warmes Schwarz (`--ink`),
Fraunces (Serif, kursiv für Überschriften) + IBM Plex Sans. Farb-Tokens als CSS-Variablen
im `<style>`-Block von `logbuch.html`. Bei Erweiterungen an diesem Stil festhalten,
nicht auf generische Tailwind-/Card-Optik wechseln.

## Erinnerungen (Web Push)

Eine einzige Edge Function `send-notifications` deckt beide Zeitpunkte ab:
- **8 Uhr Berliner Zeit**: Gewicht heute noch nicht eingetragen? → Erinnerung.
- **22 Uhr Berliner Zeit**: Mindestens ein aktives Feld heute noch nicht eingetragen?
  → Erinnerung (nicht erst wenn der ganze Tag leer ist). Zusätzlich sonntags
  "Wochenübersicht ist da", am Monatsletzten "Monatsübersicht ist da".

**DST-sicher ohne manuelles Nachjustieren**: `pg_cron` kennt keine Zeitzonen mit
Sommerzeit-Umstellung, läuft nur in UTC. Statt die Cron-Zeit zweimal im Jahr von Hand zu
verschieben, läuft die Function **viermal täglich** (6, 7, 20, 21 Uhr UTC – siehe
`supabase-setup.sql`) und prüft selbst per `Intl.DateTimeFormat` mit `timeZone:
'Europe/Berlin'`, ob gerade wirklich 8 oder 22 Uhr Berliner Zeit ist. Nur der jeweils
passende Durchlauf sendet, die anderen drei brechen sofort ab (kein Zusatzaufwand,
Intl-API übernimmt die Sommer-/Winterzeit-Umrechnung automatisch).

Bekannte Kleinigkeit: in der einen Nacht der Zeitumstellung selbst kann es im Extremfall
zu einem doppelten oder ausbleibenden Trigger kommen. Für einen Einzelnutzer-Tracker
vernachlässigbar, nicht extra behandelt.

## Secrets

- `VAPID_PUBLIC_KEY` ist im Klartext in `logbuch.html` hinterlegt – das ist beabsichtigt,
  öffentliche Push-Keys sind dafür gedacht.
- `VAPID_PRIVATE_KEY` liegt **ausschließlich** als Supabase Function Secret
  (`supabase secrets set ...`), niemals im Repo. Beim Rotieren: neuen Key generieren,
  Secret updaten, öffentlichen Key in `logbuch.html` UND im Push-Subscribe-Flow der
  Nutzer neu abgleichen (alte Subscriptions werden mit neuem Key ungültig).
- `SUPABASE_ANON_KEY` (publishable) ist ebenfalls unkritisch öffentlich, liegt in
  `logbuch.html` und im Vault (`publishable_key`, für den Cron-Aufruf der Edge Function).

## Deployment-Schritte (Referenz, siehe auch Anleitung im Chat-Verlauf)

1. `logbuch.html` + `sw.js` → GitHub Pages (Root-Verzeichnis).
2. `supabase functions deploy send-notifications` (Code liegt/soll liegen unter
   `supabase/functions/send-notifications/index.ts`).
3. `supabase-setup.sql` im Supabase SQL Editor ausführen (Tabellen, RLS, Vault-Secrets,
   vier Cron-Jobs). **Nicht automatisiert über Migrationen** – bislang manuell im
   Dashboard ausgeführt. Wäre ein sinnvoller nächster Schritt, das in
   `supabase/migrations/` zu überführen, falls das Projekt wächst.

## Präferenzen für die Zusammenarbeit

- Code-Qualität geht vor Geschwindigkeit.
- Bei Unklarheiten nachfragen statt zu raten.
- UI-Texte durchgängig auf Deutsch.

## Noch nicht gebaut (bekannte TODOs, kein Zeitdruck)

- Jahres- und "seit Beginn der Aufzeichnung"-Übersicht (Datenmodell trägt das bereits,
  reine Auswertungsfrage).
- Irgendeine visuelle Aufbereitung des Gewichtsverlaufs (aktuell nur letzter Wert als
  Text sichtbar, kein Chart).
- SQL-Setup in Supabase-Migrationen überführen statt manuell im Dashboard auszuführen.
