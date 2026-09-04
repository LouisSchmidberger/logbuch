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
- `slug` (text, Key in `habit_entries.data`), `name`, `kind` (`'scale'` oder `'number'`,
  siehe Skalen-/Farblogik unten), `min`/`max` (int, nur bei `kind='scale'`), `labels`
  (jsonb, nur bei `kind='scale'`; `null` = Zahlenwerte, sonst Array von Strings der Länge
  `max-min+1`), `good` (`'high'`/`'low'`, nur bei `kind='scale'`), `unit` (text, nur bei
  `kind='number'`, z.B. `'kg'`), `reminder_hour` (0–23 oder `null` = Standardzeit, siehe
  Erinnerungen), `sort_order`, `archived_at` (Soft-Delete – archivierte Felder
  verschwinden aus der Tageseingabe, bleiben aber in Wochen-/Monatsansicht sichtbar,
  solange sie dort Daten haben, und lassen sich reaktivieren).
- **Feld-Typ (`kind`) und Skala (`min`/`max`/`labels`) sind nur änderbar, solange das
  Feld noch keine Daten hat** (App-seitig gesperrt, siehe `habitHasData`/`f.locked`) –
  sonst würden alte Werte plötzlich etwas anderes bedeuten. Für eine neue Skala: altes
  Feld archivieren, neues anlegen. `name`, `unit` und `reminder_hour` bleiben davon
  unberührt, da sie keine historischen Werte umdeuten.
- Neue Nutzer bekommen die bisherigen 13 Standardfelder plus "Gewicht" (`kind='number'`,
  `unit='kg'`) automatisch vorbelegt (Trigger `on_auth_user_created_seed_habits` in
  `supabase-setup.sql`) – ab da aber genauso frei verwaltbar/löschbar wie jedes selbst
  angelegte Feld.
- RLS aktiv: jede Zeile nur für den eigenen `user_id` sicht-/änderbar – Felder eines
  Nutzers beeinflussen keinen anderen.

Tabelle `habit_entries`: eine Zeile pro Nutzer und Kalendertag.
- `entry_date` (date), `data` (jsonb) – alle Werte des Tages in einem Objekt.
- Keys in `data` entsprechen den `slug`s aus `habit_definitions` des jeweiligen Nutzers
  (Gewicht ist heute ein ganz normaler `slug='weight'`-Eintrag darin, kein Sonderfall
  mehr).
- RLS aktiv: jede Zeile nur für den eigenen `user_id` sicht-/änderbar.

Tabelle `push_subscriptions`: eine Zeile pro Browser/Gerät mit aktivierten Erinnerungen
(Web-Push-Endpoint + Schlüssel). RLS wie oben.

**Der Reminder-Check** in der Edge Function fragt dafür live die aktiven (nicht
archivierten) `habit_definitions` je Nutzer ab – keine hartkodierte Liste mehr, kein
manuelles Synchronhalten nötig. Erinnert wird, sobald mindestens ein zur jeweiligen
Stunde fälliges aktives Feld an dem Tag noch fehlt, nicht erst wenn alles leer ist
(Details siehe Abschnitt "Erinnerungen").

## Skalen-/Farblogik

Zwei Feld-Typen: `kind='scale'` (Stufen mit Gut/Schlecht-Bewertung – der Normalfall) und
`kind='number'` (freier Zahlenwert wie Gewicht, bewusst **ohne** Gut/Schlecht-Bewertung,
dafür mit optionaler Einheit).

`normalize(habit, value)` bildet den Wert eines `scale`-Felds auf 0 (schlecht) bis 1 (gut)
ab, unabhängig von der Richtung (`good: 'high'` vs. `good: 'low'`, z.B. bei
"Gekifft"/"Gevaped"). `scoreColor(score)` färbt danach rot→grau→grün. `number`-Felder
laufen nie durch `normalize`/`scoreColor` (kein "gut/schlecht" bei einem Zahlenwert wie
Gewicht) – sie bekommen stattdessen in "Heute" eine eigene Eingabebox und in den
Auswertungs-Tabs einen Verlaufs-Graphen (`renderNumberChart`), statt in die Score-/
Heatmap-Logik einzufließen. Es gibt keinen separaten Bool-Typ mehr – ein Ja/Nein-Feld ist
einfach eine `scale` mit `min:0, max:1, labels:['Nein','Ja']`.

## Design

Ledger/Logbuch-Ästhetik: Parchment-Hintergrund (`--paper`), warmes Schwarz (`--ink`),
Fraunces (Serif, kursiv für Überschriften) + IBM Plex Sans. Farb-Tokens als CSS-Variablen
im `<style>`-Block von `logbuch.html`. Bei Erweiterungen an diesem Stil festhalten,
nicht auf generische Tailwind-/Card-Optik wechseln.

## Erinnerungen (Web Push)

Eine einzige Edge Function `send-notifications` läuft **stündlich** (statt fester
Zeitpunkte) und prüft pro Nutzer und Feld, ob gerade dessen Erinnerungsstunde ist:
- **8 Uhr Berliner Zeit (Standard)**: alle aktiven `kind='number'`-Felder ohne eigene
  `reminder_hour` (z.B. Gewicht), die heute noch nicht eingetragen sind.
- **22 Uhr Berliner Zeit (Standard)**: alle aktiven `kind='scale'`-Felder ohne eigene
  `reminder_hour`, die heute noch nicht eingetragen sind (nicht erst wenn der ganze Tag
  leer ist). Zusätzlich sonntags "Wochenübersicht ist da", am Monatsletzten
  "Monatsübersicht ist da".
- **Eigene Stunde je Feld**: jedes Feld kann über `reminder_hour` (0–23) eine eigene
  Erinnerungszeit bekommen, unabhängig von `kind` und den beiden Standardzeiten – z.B.
  ein Zahlenwert-Feld, das mittags statt morgens erinnert werden soll. In der App per
  Checkbox "Eigene Erinnerungszeit" im Feld-Formular, standardmäßig aus.

Die Nachricht nennt die konkret fehlenden Feldnamen (`Erinnerung: <Namen> noch nicht
eingetragen.`), gruppiert nach Standard-8-Uhr/Standard-22-Uhr/eigener Stunde.

**DST-sicher ohne manuelles Nachjustieren**: `pg_cron` kennt keine Zeitzonen mit
Sommerzeit-Umstellung, läuft nur in UTC. Die Function läuft deshalb **jede volle
UTC-Stunde** (`0 * * * *`, siehe `supabase-setup.sql`) und bestimmt sich selbst per
`Intl.DateTimeFormat` mit `timeZone: 'Europe/Berlin'`, welche Berliner Stunde gerade ist
– das deckt beliebige `reminder_hour`-Werte automatisch ab, ganz ohne feste
UTC-Zeitpunkte-Liste (Intl-API übernimmt die Sommer-/Winterzeit-Umrechnung automatisch).

Bekannte Kleinigkeit: in der einen Nacht der Zeitumstellung selbst kann eine einzelne
Berliner Stunde je nach Richtung doppelt oder gar nicht auftreten (entspricht dem echten
Wanduhr-Verhalten an dem Tag). Für einen kleinen Tracker vernachlässigbar, nicht extra
behandelt.

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
   ein stündlicher Cron-Job). **Nicht automatisiert über Migrationen** – bislang manuell
   im Dashboard ausgeführt. Wäre ein sinnvoller nächster Schritt, das in
   `supabase/migrations/` zu überführen, falls das Projekt wächst.

## Präferenzen für die Zusammenarbeit

- Code-Qualität geht vor Geschwindigkeit.
- Bei Unklarheiten nachfragen statt zu raten.
- UI-Texte durchgängig auf Deutsch.

## Noch nicht gebaut (bekannte TODOs, kein Zeitdruck)

- SQL-Setup in Supabase-Migrationen überführen statt manuell im Dashboard auszuführen.
