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

- **Frontend**: `logbuch.html` – eine einzelne Datei, Vanilla JS (kein Framework, kein
  Build-Step), `supabase-js` per ESM-CDN-Import. Rendering per Template-Strings +
  Event-Delegation auf `#app` (kein virtuelles DOM, bewusst einfach gehalten).
- **Service Worker**: `sw.js` – nur für Web-Push-Empfang/-Klick, sonst nichts (kein Offline-
  Caching gebaut).
- **Backend**: Supabase (Projekt-Ref `qdadoqcnqmrauhshvcts`, Region Europe) – Postgres-Tabellen,
  Auth (E-Mail/Passwort), Edge Function für Push-Versand.
- **Hosting**: GitHub Pages, statisch. `logbuch.html` und `sw.js` müssen im selben
  Wurzelverzeichnis des gehosteten Pfads liegen.
- **PWA-Installationshinweis** (`renderInstallHint` in `logbuch.html`): erscheint direkt
  im App-Bereich (nicht auf den Auth-Screens), solange die Seite nicht als PWA läuft
  (`display-mode: standalone` bzw. `navigator.standalone`) und nicht per
  `localStorage`-Flag dauerhaft weggeklickt wurde. Auf iOS ist "zum Home-Bildschirm
  hinzufügen" keine reine Komfortsache, sondern **Voraussetzung** dafür, dass
  Web-Push überhaupt funktioniert (Safari liefert Push sonst gar nicht aus, seit
  iOS 16.4) — Hinweistext ist deshalb iOS-spezifisch dringlicher formuliert.

## Datenmodell

Tabelle `habit_definitions`: eine Zeile pro Nutzer und Feld – **ersetzt die frühere feste
`HABITS`-Konstante**. Jeder Nutzer verwaltet seine Felder selbst über "Felder verwalten"
im Burger-Menü der App (anlegen, umbenennen, archivieren, reaktivieren; siehe
`renderManage` in `logbuch.html` – kein eigener Tab mehr, siehe Abschnitt "Design").
- `slug` (text, Key in `habit_entries.data`), `name`, `kind` (`'scale'`, `'number'` oder
  `'group'`, siehe Skalen-/Farblogik unten), `min`/`max` (int, nur bei `kind='scale'`;
  bei `display_style='slider'` fix `0`/`<Stufenzahl>`), `labels` (jsonb, nur bei
  `kind='scale'`; `null` = nummerierte Stufen, sonst Array von Strings der Länge
  `max-min+1`), `good` (`'high'`/`'low'`, nur bei `kind='scale'`), `unit` (text, nur bei
  `kind='number'`, z.B. `'kg'`), `display_style` (`'buttons'`/`'slider'`, nur bei
  `kind='scale'` mit `labels=null` relevant), `slider_show_value` (bool, nur bei
  `display_style='slider'` relevant – steuert nur die Sichtbarkeit des aktuellen Werts
  während der Eingabe, der Regler zeigt **nie** eine Min/Max-Beschriftung),
  `group_members` (jsonb, nur bei `kind='group'`: Array von Slugs anderer
  `kind='scale'`-Felder dieses Nutzers), `reminder_minute` (Minuten seit Mitternacht,
  0–1439, 15-Minuten-Raster, oder `null` = Standardzeit, siehe Erinnerungen – bei
  `kind='group'` immer `null`, eine Gruppe kann nie "fehlen"), `sort_order`,
  `archived_at` (Soft-Delete – archivierte Felder
  verschwinden aus der Tageseingabe, bleiben aber in Wochen-/Monatsansicht sichtbar,
  solange sie dort Daten haben, und lassen sich reaktivieren). Ein archiviertes Feld
  **endgültig löschen** (`habit-delete`) geht auch mit vorhandenen historischen
  Einträgen – dann aber erst nach explizitem zweiten Bestätigungsklick in der App
  (`state.habitDeleteConfirm`), da die Rohwerte danach nicht mehr auswertbar sind.
  Löscht zuerst die `habit_definitions`-Zeile, räumt danach zusätzlich per
  `purgeHabitFromEntries` (in `logbuch.html`) best effort den zugehörigen Schlüssel
  aus jedem betroffenen Tages-Eintrag (`habit_entries.data`) weg, statt ihn als
  verwaisten Key im verschlüsselten JSON liegen zu lassen (passend zur Zero-Access-/
  Löschrecht-Ausrichtung der App – "Löschen" soll möglichst wenig übrig lassen).
  Läuft im Hintergrund über die bereits im Speicher gehaltenen, entschlüsselten
  `state.entries` – kein zusätzlicher Fetch nötig.
- **Feld-Typ (`kind`) und Skala (`min`/`max`/`labels`) sind nur änderbar, solange das
  Feld noch keine Daten hat** (App-seitig gesperrt, siehe `habitHasData`/`f.locked`) –
  sonst würden alte Werte plötzlich etwas anderes bedeuten. Für eine neue Skala: altes
  Feld archivieren, neues anlegen. `name`, `unit` und `reminder_minute` bleiben davon
  unberührt, da sie keine historischen Werte umdeuten. Gilt **nicht** für `kind='group'`:
  eine Gruppe hält nie einen eigenen Eintrag in `habit_entries.data` (ihr Slug taucht
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
- `filled_slugs` (jsonb, Array von Strings) – bewusst **unverschlüsselt**, nur die
  Namen der an dem Tag befüllten Felder, keine Werte. Wird ausschließlich von
  `send-notifications` für die Vollständigkeits-Prüfung gebraucht, da die Function
  `data` nicht entschlüsseln kann.
- RLS aktiv: jede Zeile nur für den eigenen `user_id` sicht-/änderbar (schützt Nutzer
  voreinander, nicht vor dem DB-Owner — dafür ist ja gerade die Verschlüsselung da).

Tabelle `push_subscriptions`: eine Zeile pro Browser/Gerät mit aktivierten Erinnerungen
(Web-Push-Endpoint + Schlüssel). RLS wie oben.

Tabelle `user_settings`: eine Zeile pro Nutzer. `default_reminder_minute` (Minuten
seit Mitternacht, 0–1439, 15-Minuten-Raster, Default 1320 = 22:00) ist die
Standard-Erinnerungszeit für alle Felder ohne eigene `reminder_minute` (siehe
Erinnerungen), im Burger-Menü der App änderbar. `onboarding_completed` (bool, Default
`false`) steuert, ob der Account noch das Onboarding-Tutorial sieht (siehe Abschnitt
unten) – wird bei Registrierung automatisch angelegt (Trigger
`on_auth_user_created_seed_settings`). RLS wie oben.

Tabelle `user_encryption`: eine Zeile pro Nutzer, hält den zweifach "verpackten"
Data Encryption Key (DEK) — nie den Schlüssel selbst im Klartext. Details siehe
Abschnitt "Verschlüsselung". **Kein** automatischer Seed-Trigger bei Registrierung
(anders als `habit_definitions`/`user_settings`) — die Einrichtung passiert bewusst
erst beim ersten echten Login, da sie das Passwort im Klartext braucht. RLS wie oben.

**Der Reminder-Check** in der Edge Function fragt dafür live die aktiven (nicht
archivierten) `habit_definitions` je Nutzer ab – keine hartkodierte Liste mehr, kein
manuelles Synchronhalten nötig. `kind='group'`-Felder werden dabei ausgeschlossen
(Gruppen sind nie direkt befüllbar, tauchen nie in `filled_slugs` auf – ohne den
Ausschluss würden sie die Sammel-Erinnerung dauerhaft fälschlich als "fehlend" auslösen).
Erinnert wird, sobald mindestens ein zur jeweiligen Zeit fälliges aktives Feld an dem
Tag noch fehlt, nicht erst wenn alles leer ist (Details siehe Abschnitt "Erinnerungen").

## Skalen-/Farblogik

Drei Feld-Typen: `kind='scale'` (Stufen mit Gut/Schlecht-Bewertung – der Normalfall),
`kind='number'` (freier Zahlenwert wie Gewicht, bewusst **ohne** Gut/Schlecht-Bewertung,
dafür mit optionaler Einheit) und `kind='group'` (nicht direkt befüllbar, zeigt den live
berechneten Durchschnitt seiner Mitglieder-Felder – siehe `habitScore` unten).

`normalize(habit, value)` bildet den Wert eines `scale`-Felds auf 0 (schlecht) bis 1 (gut)
ab, unabhängig von der Richtung (`good: 'high'` vs. `good: 'low'`, z.B. bei
"Gekifft"/"Gevaped"). `scoreColor(score)` färbt danach rot→grau→grün. `number`-Felder
laufen nie durch `normalize`/`scoreColor` (kein "gut/schlecht" bei einem Zahlenwert wie
Gewicht) – sie bekommen stattdessen in "Heute" eine eigene Eingabebox und in den
Auswertungs-Tabs einen Verlaufs-Graphen (`renderNumberChart`), statt in die Score-/
Heatmap-Logik einzufließen. Es gibt keinen separaten Bool-Typ mehr – ein Ja/Nein-Feld ist
einfach eine `scale` mit `min:0, max:1, labels:['Nein','Ja']`.

**Darstellung von `scale`-Feldern mit nummerierten Stufen (`labels=null`)**:
`display_style='buttons'` (Standard) zeigt Auswahl-Buttons wie bisher, gedeckelt auf 12
Stufen (mehr wäre unbedienbar). `display_style='slider'` zeigt stattdessen einen
Schieberegler (`renderHabitSlider`) – dafür wird beim Anlegen keine freie Von/Bis-Spanne
eingegeben, sondern nur eine Stufenzahl (Standard 100, wirkt wie Prozent; Ganzzahl,
2–1000), intern als `min=0`/`max=<Stufenzahl>` gespeichert. Der Regler zeigt **nie** eine
Min/Max-Beschriftung im Eingabe-UI (nur in der Verwaltungs-Zusammenfassung,
`formatScale`) – `slider_show_value` steuert nur, ob der aktuell gewählte Wert während
der Eingabe sichtbar ist. Live-Vorschau (Wert + Farbe) läuft beim Ziehen rein über einen
`input`-Listener ohne Re-Render; gespeichert wird erst bei `change` (Loslassen), über
denselben `handleSelect`-Pfad wie bei den Buttons.

**Gruppierte Felder (`kind='group'`)**: fassen mehrere `kind='scale'`-Felder (`slugs` in
`group_members`) zu einem Durchschnittswert zusammen (z.B. "Sport gemacht" = Ø aus
"Ausdauersport" + "Kraftsport"). Nie selbst direkt befüllbar – kein Eintrag in
`habit_entries.data`, kein eigener `good`, keine Erinnerungszeit. Der zentrale Helfer
`habitScore(h, dateKey)` liefert für `kind='group'` den Durchschnitt aus
`normalize(member, ...)` über alle Mitglieder mit Wert an dem Tag (null, wenn keins
befüllt ist) und ersetzt damit an allen relevanten Stellen (`dayOverallScore`,
`renderWeek`, `computeHabitStats` → Monat/Jahr/Gesamt) die direkten `normalize`-Aufrufe;
für normale `scale`-Felder ist er ein reiner Durchreicher zu `normalize`. In "Heute"
erscheint eine Gruppe als nicht-editierbare Info-Zeile (`renderGroupInfo`) mit dem
Tages-Mittelwert. `habitVisibleInRange(h, dateKeys)` ersetzt entsprechend die
Sichtbarkeits-Prüfung archivierter Felder in den Auswertungs-Ansichten, da eine Gruppe
nie einen eigenen Entry-Key hat.

**Ziel-Quote (`goal_threshold`, `kind='scale'`/`kind='group'`)**: bei manchen Feldern ist
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
nur Nutzer voreinander, das hier zusätzlich vor dem DB-Owner selbst. Bewusst **nicht**
verschlüsselt: `habit_definitions` (Feld-Namen/Labels bleiben lesbar, dadurch bleiben
personalisierte Push-Erinnerungen möglich) und `habit_entries.filled_slugs` (nur
Feldnamen ohne Werte, für die Vollständigkeits-Prüfung der Reminder-Function).

**Zweistufiger Schlüssel** (Crypto-Helfer + Lebenszyklus-Funktionen in `logbuch.html`,
alles native Web Crypto API, keine Library):
- **DEK** (Data Encryption Key): pro Nutzer ein zufälliger AES-256-GCM-Schlüssel
  (`generateDek`), verschlüsselt/entschlüsselt `habit_entries.data`
  (`encryptData`/`decryptData`). Ändert sich nie mehr, nachdem er einmal erzeugt
  wurde — auch nicht bei einem Passwort-Reset.
- **KEK** (Key Encryption Key): aus dem Passwort abgeleitet (`deriveKek`, PBKDF2-
  SHA256, 250.000 Iterationen, individueller Salt), "verpackt" (wrapped) den DEK
  (`wrapDek`/`unwrapDek`). Nur das verpackte Ergebnis (`wrapped_dek` in
  `user_encryption`) liegt serverseitig — nutzlos ohne Passwort.
- **Recovery-Key**: ein zweiter, zufälliger 256-Bit-Schlüssel, der den DEK ein
  zweites Mal verpackt (`wrapped_dek_recovery`). Wird dem Nutzer **einmalig**
  angezeigt (`renderRecoveryKeyDisplay`, Kopieren-/Download-Button, muss per
  Checkbox bestätigt werden) und nirgends serverseitig im Klartext gespeichert. Löst
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
  verloren" nur mit expliziter zweiter Bestätigung, danach sind alte Einträge weg.
- Logout: `currentDek = null` (der IndexedDB-Cache bleibt für den nächsten Login auf
  demselben Gerät). Konto-Löschung räumt den Cache zusätzlich explizit auf.

**Was das für Änderungen an anderer Stelle bedeutet**: `state.entries` hält nach dem
Laden (`loadEntries`) immer schon entschlüsselte Klartext-Objekte — die gesamte
übrige App (Scores, Graphen, Statistiken, `saveDay`, Export) arbeitet unverändert
damit. Nur `loadEntries`/`saveDay`/`handleExportData` fassen `currentDek` direkt an.

## Design

Ledger/Logbuch-Ästhetik: Parchment-Hintergrund (`--paper`), warmes Schwarz (`--ink`),
Fraunces (Serif, kursiv für Überschriften) + IBM Plex Sans. Farb-Tokens als CSS-Variablen
im `<style>`-Block von `logbuch.html`. Bei Erweiterungen an diesem Stil festhalten,
nicht auf generische Tailwind-/Card-Optik wechseln.

Tab-Leiste zeigt nur noch die Auswertungs-Ansichten (Heute/Woche/Monat/Jahr/Gesamt).
Alles Konfigurative sitzt im **Burger-Menü** (☰-Button oben rechts, `renderMenu` in
`logbuch.html`): Push aktiv/inaktiv, Standard-Erinnerungszeit, "Felder verwalten"
(öffnet `renderManage`, kein eigener Tab mehr) und Abmelden.

## Erinnerungen (Web Push)

Eine einzige Edge Function `send-notifications` läuft **alle 15 Minuten** (statt
fester Zeitpunkte) und prüft pro Nutzer, ob gerade dessen Standard-Erinnerungszeit ist
bzw. pro Feld, ob dessen eigene Zeit erreicht ist:
- **Standard-Erinnerungszeit (`user_settings.default_reminder_minute`, Default 22:00
  Berliner Zeit, im Menü in 15-Minuten-Schritten änderbar)**: alle aktiven Felder OHNE
  eigene `reminder_minute` – unabhängig von `kind` (Skala oder Zahlenwert) – werden
  gemeinsam geprüft. Fehlt an diesem Tag noch mindestens eines davon, gibt es EINE
  Sammel-Nachricht (nicht eine pro Feld). Zusätzlich zu dieser Zeit: sonntags
  "Wochenübersicht ist da", am Monatsletzten "Monatsübersicht ist da".
- **Eigene Zeit je Feld**: jedes Feld kann über `reminder_minute` unabhängig von der
  Standardzeit eine eigene Erinnerungszeit bekommen – z.B. Gewicht typischerweise
  morgens statt zur (abendlichen) Standardzeit. In der App per Checkbox "Eigene
  Erinnerungszeit" im Feld-Formular (`<select>` mit allen 96 15-Minuten-Werten,
  `reminderTimeInputHtml` in `logbuch.html` – bewusst kein natives `<input
  type="time">`, dessen `step`-Attribut viele Browser/Betriebssysteme ignorieren,
  wodurch sich trotzdem jede beliebige Minute auswählen ließe), standardmäßig aus.

Die Sammel-Erinnerung zur Standardzeit ist bewusst generisch ("Noch nicht alle Werte
für heute eingetragen.", keine Feldnamen – sonst bei vielen Feldern schnell eine sehr
lange Nachricht). Eine Erinnerung zu einer eigenen Zeit nennt dagegen das konkrete
Feld (`Erinnerung: <Namen> noch nicht eingetragen.`), da dort meist gezielt ein
einzelnes Feld hervorgehoben werden soll (z.B. Gewicht).

**15-Minuten-Raster, DST-sicher ohne manuelles Nachjustieren**: `pg_cron` kennt keine
Zeitzonen mit Sommerzeit-Umstellung, läuft nur in UTC. Die Function läuft deshalb
**alle 15 Minuten** (`*/15 * * * *`, siehe `supabase/migrations/`) und bestimmt sich
selbst per `Intl.DateTimeFormat` mit `timeZone: 'Europe/Berlin'`, welche Berliner
Minute seit Mitternacht gerade ist – das deckt beliebige `reminder_minute`-Werte
automatisch ab, ganz ohne feste UTC-Zeitpunkte-Liste. Der Berlin-UTC-Offset ist immer
eine volle Stunde, daher bleibt das 15-Minuten-Raster unabhängig von Sommer-/
Winterzeit exakt ausgerichtet (Intl-API übernimmt die Umrechnung automatisch).

Bekannte Kleinigkeit: in der einen Nacht der Zeitumstellung selbst kann ein einzelnes
15-Minuten-Fenster je nach Richtung doppelt oder gar nicht auftreten (entspricht dem
echten Wanduhr-Verhalten an dem Tag). Für einen kleinen Tracker vernachlässigbar,
nicht extra behandelt.

## Onboarding-Tutorial für neue Accounts

Seit 2026-09-15: neue Accounts starten ohne vorbelegte Felder (siehe Datenmodell) und
werden stattdessen durch ein 3-Schritte-Tutorial geführt (`renderTutorial` in
`logbuch.html`), gesteuert über `state.userSettings.onboardingCompleted` (aus
`user_settings.onboarding_completed`, Default `false` bei neuen Accounts) – solange
`false`, ersetzt `render()` die normale App durch das Tutorial (Prüfung erst NACH dem
DEK-Unlock, das Tutorial braucht ja schon entschlüsselte Daten). `state.tutorialStep`
(1/2/3) lebt nur im Speicher, kein Reload-Resume nötig.

- **Schritt 1**: Vollbild-Screen (gleiches Muster wie `renderAuth`, ersetzt `#app`
  komplett) mit Erklärung zu täglichem Ausfüllen + Push-Wert, eingebetteter
  Push-Aktivierung (`renderPushRow`) und der Standard-Erinnerungszeit-Auswahl.
- **Schritt 2**: erst ein Zwischenschritt ("Überleg dir einen Wert") mit Beispielen,
  danach die **echte** `renderHabitForm()` (kein Duplikat) – gesteuert rein über
  `state.habitForm`: gesetzt (per `defaultHabitForm()`) zeigt das Formular, `null`
  (z.B. nach "Abbrechen") fällt zurück auf den Zwischenschritt. Kein Tab-Leiste/
  Burger-Menü sichtbar (Tutorial-Screens ersetzen `#app` komplett statt in `renderApp`
  eingebettet zu sein), eine `beforeunload`-Warnung verhindert versehentliches
  Verlassen, solange `state.tutorialStep === 2`. Nach erfolgreichem Anlegen des ersten
  Feldes (Insert-Zweig in `handleHabitSave`) automatischer Sprung zu Schritt 3.
- **Schritt 3**: Vollbild-Screen mit Empfehlung, optional 2–4 weitere Felder
  anzulegen ("Weiteres Feld anlegen" springt zurück in den Schritt-2-Formular-Zustand,
  diesmal ohne den Zwischenschritt) oder "Fertig" (`saveOnboardingCompleted()`).

Überspringen (Schritt 1/2) fragt zweistufig nach (`.modal-overlay`/`.modal-box`,
gleiches Muster wie `renderDeleteConfirm`) und setzt bei Bestätigung sofort
`onboarding_completed = true` – identisch zu "Fertig" in Schritt 3.
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
- Datenexport (Auskunftsrecht/Datenportabilität, Art. 15/20 DSGVO): "Meine Daten
  exportieren" im Burger-Menü (`handleExportData` in `logbuch.html`) lädt die eigenen
  Rohdaten aus allen vier Tabellen (RLS scoped automatisch auf den eigenen Nutzer) direkt
  im Browser als eine JSON-Datei herunter — kein Server-Roundtrip über eine eigene
  Function nötig.
- Passwort-Reset-Flow: "Passwort vergessen?" im Anmelden-Formular →
  `supabase.auth.resetPasswordForEmail(email, { redirectTo: <aktuelle App-URL> })`.
  Der Rückkehr-Link löst clientseitig das Event `PASSWORD_RECOVERY` aus
  (`onAuthStateChange`-Listener in `logbuch.html`), das App-Routing zeigt dann
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
  (`renderAuth` in `logbuch.html`): ein für Menschen unsichtbares Honeypot-Feld
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

## Secrets

- `VAPID_PUBLIC_KEY` ist im Klartext in `logbuch.html` hinterlegt – das ist beabsichtigt,
  öffentliche Push-Keys sind dafür gedacht.
- `VAPID_PRIVATE_KEY` liegt **ausschließlich** als Supabase Function Secret
  (`supabase secrets set ...`), niemals im Repo. Beim Rotieren: neuen Key generieren,
  Secret updaten, öffentlichen Key in `logbuch.html` UND im Push-Subscribe-Flow der
  Nutzer neu abgleichen (alte Subscriptions werden mit neuem Key ungültig).
- `SUPABASE_ANON_KEY` (publishable) ist ebenfalls unkritisch öffentlich, liegt in
  `logbuch.html` und im Vault (`publishable_key`, für den Cron-Aufruf der Edge Function).
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

1. `logbuch.html` + `sw.js` → GitHub Pages (Root-Verzeichnis).
2. `supabase functions deploy send-notifications` und `supabase functions deploy
   delete-account` (Code liegt/soll liegen unter `supabase/functions/<name>/index.ts`).
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
- Bei Unklarheiten nachfragen statt zu raten.
- UI-Texte durchgängig auf Deutsch.

## Noch nicht gebaut (bekannte TODOs, kein Zeitdruck)

(aktuell leer)
