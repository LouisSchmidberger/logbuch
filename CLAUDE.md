# Logbuch – Projektkontext

Habit-Tracker mit frei anlegbaren Feldern (Skala, Zahl, Text, berechnete Werte), standalone
(unabhängig von Claude.ai). Mehrere Nutzer, jeder verwaltet seine eigenen Felder;
Registrierung offen (kein Invite-System). Zero-Access-Verschlüsselung: der Betreiber kann
weder Werte noch Feldnamen lesen.

**Zielbild**: langfristig breite Öffentlichkeit + eingeschränkt kommerzielle Nutzung.
Rechtlicher/geschäftlicher Rahmen (Impressum, Datenschutzerklärung, AGB, Gewerbe) klärt der
Nutzer außerhalb dieses Repos – hier nur die technischen Vorbereitungen (Sicherheit/
Datenschutz zuerst). Bis die Rechtstexte stehen, nur informelles Testen mit bekannten
Personen.

## Pflichtlektüre vor Änderungen

Bevor du an einem dieser Bereiche etwas änderst, lies die zugehörige Datei:

| Bereich | Datei |
|---|---|
| Tabellen, Spalten, RLS, Speichern eines Tages, Notiz-Format, Wiederholung | [docs/datenmodell.md](docs/datenmodell.md) |
| Feldtypen, Skalen/Farben/Scores, berechnete Felder, Gruppen, Feld-Formular, Auswertung | [docs/felder.md](docs/felder.md) |
| Alles mit DEK/Passwort/Ersatzschlüssel, Entsperren, Login/Logout-Ablauf | [docs/verschluesselung.md](docs/verschluesselung.md) |
| Push, `send-notifications`, `get_due_notifications`, Erinnerungszeiten, Deep-Links, Zeitzone | [docs/erinnerungen.md](docs/erinnerungen.md) |
| UI, Navigation, Menü/Einstellungen, "Heute", Notizen, Meldungen, Fokus, Theme, Textgröße | [docs/design-bedienung.md](docs/design-bedienung.md) |
| Startseite, Installation, Registrieren, Tutorial, Ersatzschlüssel-Seite, Erklär-Karten | [docs/onboarding.md](docs/onboarding.md) |
| Texte/`STRINGS`/`t()`, Sprache, Datumsformate | [docs/i18n.md](docs/i18n.md) |
| Konto löschen, Export, Feedback, Auth/Passwort, E-Mail-Versand, Secrets | [docs/datenschutz-sicherheit.md](docs/datenschutz-sicherheit.md) |

## Stack und Hosting

- **Frontend**: `logbuch.html` (Markup + CSS) und `logbuch.js` (die ganze App-Logik, als
  ES-Modul), Vanilla JS, kein Framework, kein Build-Step. Getrennt statt einer Datei, damit
  die Content-Security-Policy (`<meta>` in `logbuch.html`) Inline-Skripte komplett verbieten
  kann (`script-src 'self'`): eingeschleuster Code liefe nicht, und `connect-src` lässt
  Daten nur zum eigenen Supabase-Projekt. **Neue externe Quellen müssen in die CSP.**
- **Keine Drittanbieter zur Laufzeit**: `supabase-js` liegt in fester Version unter
  `vendor/` (Neu-Bauen siehe Dateikopf; nicht vom CDN – wer das CDN kontrolliert, könnte
  Passwort und Schlüssel mitlesen), die Schriften (Fraunces, IBM Plex Sans, SIL OFL) unter
  `fonts/` (nicht Google Fonts – übermittelte bei jedem Öffnen die IP an Google).
- **Service Worker** `sw.js`: nur Web-Push-Empfang/-Klick, kein Offline-Caching.
- **Backend**: Supabase (Projekt-Ref `qdadoqcnqmrauhshvcts`, Region Europe) – Postgres,
  Auth (E-Mail/Passwort), Edge Functions `send-notifications`, `delete-account`,
  `submit-feedback`; pg_cron für Erinnerungen und Aufräum-Jobs. Resend als SMTP und für
  Feedback-Mails.
- **Hosting**: GitHub Pages, statisch. `logbuch.html`, `logbuch.js`, `sw.js`, `vendor/`,
  `fonts/` müssen im selben Wurzelverzeichnis des gehosteten Pfads liegen.

## Konventionen

- Rendering per Template-Strings + Event-Delegation auf `#app` (`data-action`), kein
  virtuelles DOM (bewusst einfach). `render()` ersetzt das ganze `#app` und stellt den Fokus
  wieder her – **neue klickbare Elemente brauchen stabile, eindeutige `data-*`-Merkmale bzw.
  eine id**.
- Begriffe: "Gruppe" in der App = `section` im Code/in der DB; Feldtyp "Berechnet" =
  `kind='computed'`; "Ersatzschlüssel" = `recoveryKey`.
- `state.entries` enthält immer entschlüsselte Objekte. Zum Speichern `state.entries`
  ändern und dann nur `saveDay(dateKey)` aufrufen. `currentDek` nur über
  `setCurrentDek`/`clearCurrentDek` setzen/leeren, nie in `state`.
- Schlüssel in einem Tages-Eintrag, die mit `_` beginnen, sind nie Feldwerte (`_notes`).
- Alle UI-Texte über `STRINGS`/`t()`; Meldungen sind reiner Text (mit Parametern
  `tPlain()`); Fehler immer über `errorNotice(key, rawMessage)`, nie roher Fehler im Satz.
- CSS-Größen immer in `rem`, nie in px (Textgröße-Einstellung skaliert über `<html>`).
- Gerätespezifische Einstellungen (Theme, Textgröße, Streifenmuster, Vibration,
  Onboarding-Zustand) in `localStorage`, kontoweite (Sprache, Erinnerungszeiten) in
  `user_settings`.
- Button-Paare: **Abbrechen links, Aktion rechts**, auch in der Code-Reihenfolge
  (Screenreader lesen in DOM-Reihenfolge; Anfangsfokus in Dialogen landet so auf
  "Abbrechen"). Untereinander gestapelte Buttons (Tutorial, Anmelden): Hauptaktion oben.
- Optik: Ledger-Ästhetik beibehalten (siehe docs/design-bedienung.md), keine generische
  Tailwind-/Card-Optik.

## Bekannte Fallstricke

- **Cache-Busting**: GitHub Pages lässt Browser Dateien 10 Min. zwischenspeichern – neue
  `logbuch.html` könnte auf alte `logbuch.js` treffen. Die HTML lädt deshalb
  `logbuch.js?v=<Kennung>`; die Kennung setzt der Hook `.githooks/pre-commit` bei jedem
  Commit. **Pro Klon einmal nötig: `git config core.hooksPath .githooks`** (sonst bleibt die
  Kennung stehen). Alte HTML + neue JS ist nur teilweise abgedeckt (vollständig nur mit
  Build-Schritt).
- **"JWT issued at future" (PGRST303)**: PostgREST lehnt ein frisch ausgestelltes Token
  gelegentlich ab (Uhren-Abweichung Auth↔PostgREST, behoben erst in PostgREST 14.18/16.3;
  Version prüfbar per `npx supabase services`). Abgefangen in `fetchWithJwtFutureRetry`:
  bis zu zwei Wiederholungen nach 1 s/2 s, sicher auch für Schreibzugriffe (PostgREST weist
  sie vor der Ausführung ab).
- **iOS-Zoom**: Safari zoomt bei Eingabefeldern < 16px heran und nie wieder heraus – dort
  bekommen alle Felder 16px (`@supports (-webkit-touch-callout: none)`). Bewusst nicht per
  `maximum-scale=1` (sperrt auf Android das Zwei-Finger-Zoomen).
- **Zeitplan-Regeln doppelt**: `isScheduledOn`/`isPlannedOn` (JS) und
  `public.habit_scheduled_on` (SQL) müssen synchron bleiben.
- **`get_due_notifications` läuft über alle Nutzer in einem Rutsch**: neue vom Nutzer
  schreibbare Spalten, die sie liest, brauchen eine DB-Prüfung (CHECK/Trigger), sonst kann
  ein einzelner Wert den ganzen Lauf abbrechen.
- **Neue Tabellen** brauchen explizite GRANTs in ihrer Migration (`authenticated` +
  `service_role`, kein `anon`).
- **PostgREST kappt bei 1000 Zeilen** – Listen seitenweise laden (`fetchAllRows`, Keyset).
- **`history.go()` feuert ein eigenes `popstate`** – vor jedem selbst ausgelösten
  `history.go()` `closingLayerViaPopstate` setzen (siehe docs/design-bedienung.md).
- **`<select>` nach Finger-Bedienung nie per Skript fokussieren** – iOS öffnet sonst sofort
  wieder das Auswahl-Menü (`focusReopensPicker`).
- **Schraffierte Zellen**: Farbe als `background-color`, nicht `background:` (setzt die
  Schraffur zurück).
- **`authFlowInFlight`** muss VOR dem Supabase-Auth-Aufruf gesetzt werden (Race mit
  `onAuthStateChange`).
- **Bestätigungsmail kommt nicht an**: zuerst prüfen, ob "Enable custom SMTP" im Dashboard
  noch an ist (schaltet sich gelegentlich von selbst aus).
- **Neue Domain/Hosting-URL**: als Redirect-URL in Supabase → Authentication → URL
  Configuration erlauben, sonst greifen Bestätigungs-/Reset-Links nicht.

## Pflichten bei Änderungen

- **Mobil zuerst**: die Nutzer sind mit großem Abstand auf Handy und Tablet (Android/iOS).
  Jede Gestaltungs-/Bedienentscheidung geht von Mobilgeräten und deren Konventionen aus; der
  PC muss funktionieren, gibt aber nicht die Richtung vor.
- **Texte in beiden Sprachen**: neue Strings immer über `STRINGS`/`t()` in `de` UND `en`,
  in identischer Key-Reihenfolge.
- **`APP_STATUS_DATE`** in `logbuch.js` ("Beta – Stand …" in "Über Logbuch"): bei jeder für
  Nutzer sichtbaren Änderung mindestens mittlerer Größe im selben Commit auf das aktuelle
  Datum setzen. Reine Interna, Doku oder winzige Textkorrekturen zählen nicht.
- **Datenschutz-Text in "Über Logbuch"** (`renderPrivacySection`, `about.privacy.*`) sagt
  konkret, was der Betreiber sehen kann und was nicht. Jede Änderung, die daran etwas
  verschiebt (neue unverschlüsselte Spalte, zusätzliches Log, serverseitige Auswertung,
  neuer Drittanbieter o.ä.), passt ihn im selben Zug an; bei Reviews gegen den Stand prüfen.
  Nicht hinein: Selbstverständlichkeiten (dass der Betreiber Feedback lesen kann) und
  Details ohne Aussagekraft (ob/seit wann ein Feld archiviert ist).
- **Tipps in "Über Logbuch"** mit Ortsangabe bekommen einen Link dorthin (`renderTip`).
- **Bestätigungsmail-Vorlage**: `supabase/templates/confirmation.html` und das Template im
  Dashboard gleich halten.

## Deployment

1. `logbuch.html`, `logbuch.js`, `sw.js`, `vendor/`, `fonts/` → GitHub Pages (Root).
2. `supabase functions deploy <name>` für `send-notifications`, `delete-account`,
   `submit-feedback` (Code unter `supabase/functions/<name>/index.ts`).
3. Schema-Änderungen nur über Migrationen (`supabase/migrations/`):
   `supabase migration new <name>`, dann `supabase db push` gegen das Live-Projekt
   (lokal braucht das Docker Desktop für die Schatten-Datenbank). Nach Dashboard-Änderungen am Schema (Ausnahme) `supabase db pull`.
   Vault-Secrets sind nicht Teil der Migrationen (siehe docs/datenschutz-sicherheit.md).
4. `supabase/config.toml` spiegelt Auth-/API-/DB-Einstellungen rein dokumentarisch (kein
   `config push`); nach Dashboard-Änderungen `supabase config pull --force`.
