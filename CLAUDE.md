# Logbuch – Projektkontext

Persönlicher Habit-/Gewichts-Tracker, standalone gebaut (bewusst unabhängig von Claude.ai,
läuft komplett eigenständig). Herkunft: in einem Claude.ai-Chat konzipiert und gebaut,
wird ab jetzt hier in Claude Code weitergeführt.

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

Tabelle `habit_entries`: eine Zeile pro Nutzer und Kalendertag.
- `entry_date` (date), `data` (jsonb) – alle Werte des Tages in einem Objekt.
- Keys in `data` entsprechen den `id`s aus der `HABITS`-Konstante in `logbuch.html`
  (`morgenroutine`, `zaehne`, `ernaehrung`, `getrunken`, `kraftsport`, `ausdauersport`,
  `gelernt`, `gekifft`, `gevaped`, `sex`, `gefuehlslage`, `guterTag`, `bettzeit`)
  plus optional `weight` (number, kg – **kein** Habit, eigene Behandlung, siehe unten).
- RLS aktiv: jede Zeile nur für den eigenen `user_id` sicht-/änderbar.

Tabelle `push_subscriptions`: eine Zeile pro Browser/Gerät mit aktivierten Erinnerungen
(Web-Push-Endpoint + Schlüssel). RLS wie oben.

**Wichtig bei neuen Habits**: Ein neuer Eintrag im `HABITS`-Array in `logbuch.html` reicht
für Heute/Woche/Monat – die Ansichten sind datengetrieben. Wird ein Habit fürs Reminder-
Logic relevant (22-Uhr-Check "wurde heute was eingetragen?"), muss die ID zusätzlich in
`HABIT_IDS` in der Edge Function (`supabase/functions/send-notifications/index.ts`)
nachgetragen werden – die beiden Listen sind bewusst nicht geteilt (kein Build-Step,
kein gemeinsames Modul), also manuell synchron halten.

## Skalen-/Farblogik

`normalize(habit, value)` bildet jeden Wert auf 0 (schlecht) bis 1 (gut) ab, unabhängig
von der Richtung (`good: 'high'` vs. `good: 'low'`, z.B. bei "Gekifft"/"Gevaped").
`scoreColor(score)` färbt danach rot→grau→grün. Gewicht ist bewusst **ausgenommen** von
dieser Logik (kein "gut/schlecht" bei einem Gewichtswert) – hat eigenes Eingabefeld, keine
Farbe, kein Eintrag in `HABITS`.

## Design

Ledger/Logbuch-Ästhetik: Parchment-Hintergrund (`--paper`), warmes Schwarz (`--ink`),
Fraunces (Serif, kursiv für Überschriften) + IBM Plex Sans. Farb-Tokens als CSS-Variablen
im `<style>`-Block von `logbuch.html`. Bei Erweiterungen an diesem Stil festhalten,
nicht auf generische Tailwind-/Card-Optik wechseln.

## Erinnerungen (Web Push)

Eine einzige Edge Function `send-notifications` deckt beide Zeitpunkte ab:
- **8 Uhr Berliner Zeit**: Gewicht heute noch nicht eingetragen? → Erinnerung.
- **22 Uhr Berliner Zeit**: Kein Habit heute eingetragen? → Erinnerung. Zusätzlich
  sonntags "Wochenübersicht ist da", am Monatsletzten "Monatsübersicht ist da".

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
