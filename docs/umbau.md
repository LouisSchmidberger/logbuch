# Umbau: Build, TypeScript, Struktur

Plan für den schrittweisen Umbau über mehrere Sessions: Build-Schritt (Vite), TypeScript,
klare Schichten, Supabase hinter einem Modul, am Ende optional React. Grundlage war ein Review
von außen (2026-11-10); dieser Stand ist an das Repo angepasst. Wo die Datei dem Repo
widerspricht, gilt das Repo: Abweichung melden, nicht raten.

**Grundsatz: Der Umbau ändert kein Verhalten.** Nach jeder Phase läuft die App wie vorher und
darf dort stehen bleiben. Kein "alles oder nichts".

## Ausgangslage

Schon erledigt: Code in 31 ES-Module unter `js/` aufgeteilt (docs/module.md, mit `runtime` und
`init…()`), CSS in `logbuch.css`, ESLint, CI (Linter, `dev/tests.mjs`, Rundgänge, Abgleich
JS ↔ SQL mit `dev/sync-tests.mjs`, `deno check` der Functions), feste Paketversionen in den
Edge Functions. Die Module importieren sich gegenseitig im Kreis; das läuft nur, weil beim
Laden nichts außer Deklarationen passiert.

Warum ein Build-Schritt nötig ist: TypeScript kann Imports mit `?v=…` nicht auflösen (TS2307,
gemessen). Typprüfung ohne Build ginge nur mit Umwegen; mit Vite übernehmen Hash-Dateinamen das
Cache-Busting und `?v=` fällt weg.

## Grundregeln (jede Phase)

1. **Nie auf `main` arbeiten.** Pro Phase ein Branch `umbau/phase-<n>-<thema>`, pro Schritt ein
   Commit. Neue Funktionen auf eigenen Branches, nie vermischt mit Umbau-Commits.
2. **Verschieben ist nicht Verbessern.** In einem Verschiebe-Commit keine Fehlerkorrektur,
   Umbenennung oder Umformatierung. Ein gefundener Fehler wird gemeldet und getrennt behoben.
3. **Kleine Schritte**, nach jedem Commit alles grün (Fertig-Kriterium).
4. **Der Nutzer entscheidet vor dem Start der Phase**: Deploy-Pipeline und Pages-Einstellungen,
   jede neue Laufzeit-Abhängigkeit (Paket, das im Bundle landet), eine State-Bibliothek, ob
   Phase 5 (React) kommt.
5. Umbau-Schritte gehören nicht ins `CHANGELOG`.
6. **Doku im selben Commit**: Stack und Konventionen in `CLAUDE.md`, `docs/module.md`,
   `dev/README.md`, `docs/freigabe.md` werden mit jeder Phase falsch, wenn sie nicht mitgehen.

### Unantastbar (nur auf ausdrückliche Anweisung)

- **Datenformat und Kryptografie**: Algorithmen, Auffüllung (`ENCRYPT_PAD_BLOCK`), IV,
  Schlüsselableitung, Aufbau von `habit_entries.data`, Byte für Byte. Live und Beta teilen
  **eine Datenbank**; die alte Live-Version muss lesen können, was die neue schreibt.
- Schutz in `loadEntries`/`saveDay`: Verwerfen bei gewechseltem `currentDek`,
  `keepLocalChanges`, nicht entschlüsselbare Tage nie überschreiben.
- `currentDek` nur über `setCurrentDek`/`clearCurrentDek`.
- `fetchWithJwtFutureRetry` (PGRST303); `authFlowInFlight` **vor** dem Auth-Aufruf;
  `fetchAllRows` (PostgREST kappt bei 1000 Zeilen).
- Zeitplan-Regeln in JS und SQL synchron (`dev/sync-tests.mjs`).
- CSP (`script-src 'self'`, `connect-src` nur eigenes Supabase), keine Drittanbieter zur
  Laufzeit (kein CDN, keine Google Fonts).
- `STRINGS`: `de` und `en` mit gleichen Keys in gleicher Reihenfolge.
- Vertrag App ↔ Service Worker: IndexedDB `logbuch-push`, Store `meta`
  (`saveFieldNamesForPush` ↔ `sw.js`).

### Fertig-Kriterium je Schritt

- `npm run lint`, `node dev/tests.mjs`, `node dev/rundgang.mjs alle` ohne Fehler; später
  zusätzlich `npm run typecheck` und `npm run build`.
- Rundgang-Bilder gegen die Baseline aus Phase 0: in den Phasen 1–4 **kein Pixel** anders
  (außer Datum und zufälligem Ersatzschlüssel).
- Neue Tabelle/Spalte/Supabase-Aufruf → `dev/mock-supabase.js` nachziehen.

## Git und Beta

- Vor Phase 1: `git tag vor-umbau` auf `main`.
- Ein Merge pro Phase; `main` bleibt immer deploybar, kein Force-Push auf `main`.
- Beta-Test eines Umbau-Branches nur nach Rücksprache (Beta = Alltagskonto des Nutzers,
  Datenbank mit Live geteilt): `git push beta umbau/phase-…:main`, zurück mit
  `git push --force-with-lease beta main:main`.
- Live wie in `CLAUDE.md` "Deployment": gesammelt, auf Okay des Nutzers.

## Phasen

### Phase 0: Absicherung (kein App-Code)

1. Baseline-Bilder: `node dev/rundgang.mjs alle` für `handy`, `schmal`, `pc`, dazu
   `--theme=dark` und `--size=xlarge`; nach `dev/screenshots/baseline/` (nicht ins Git).
2. **Krypto-Fixtures**: mit dem heutigen Code (`encryptData` über die Vorschau) Chiffretexte mit
   festem Test-Schlüssel und erfundenem Klartext erzeugen, als Testdaten ablegen und in
   `dev/tests.mjs` prüfen, dass sie entschlüsselt werden. Das sichert jede spätere Phase ab.

### Phase 1: Build mit Vite und Typprüfung

- Vite und `tsconfig.json` (`allowJs`, `checkJs`, `noEmit`) im Projektstamm.
  `supabase/functions/*` (Deno) gehören **nicht** in diese `tsconfig`.
- Quellcode nach `src/` (heute `js/` und `logbuch.js`), statische Dateien (`sw.js`,
  `manifest.json`, Icons, `fonts/`) nach `public/`, unverändert und ohne Hash.
- `supabase-js` aus npm in **exakt** `2.117.2`; danach `vendor/` entfernen,
  `vendor/LICENSES.txt` weiter mitliefern.
- Einstieg bleibt **`logbuch.html`** (`manifest.json`, `sw.js`, Push-Links und installierte
  Apps zeigen darauf), `index.html` bleibt die Weiterleitung. `base: './'`, damit derselbe
  Build unter `/logbuch/` und `/logbuch-beta/` läuft.
- **CSP** unverändert; im Build keine Inline-Skripte. Braucht `vite dev` eine lockere CSP, nur
  dort, nie im Produktions-Build.
- **Cache-Busting**: Hash-Dateinamen statt `?v=`; Hook `.githooks/pre-commit` auf den Linter
  zurückbauen, `docs/freigabe.md` anpassen. Falle: eine noch zwischengespeicherte alte HTML
  verweist auf gelöschte Dateien; die Dateien des vorigen Builds eine Runde behalten.
- **Deployment** wird ein Build-Schritt (GitHub Actions in `logbuch` und `logbuch-beta`). Wie
  genau, entscheidet der Nutzer vor dem Start.
- **Vorschau**: `mock-supabase.js` per Vite-Alias, `preview-hook.js` nur im Vorschau-Modus.
  Nach `npm run build` darf `__logbuchPreview` nicht im Ergebnis stehen; `dev/` wird nicht mehr
  mitveröffentlicht (heute liegt es öffentlich auf Pages).
- Typfehler aus `checkJs` zuerst nur sichtbar machen (CI meldet, sperrt nicht), dann abbauen.

### Phase 2: Struktur

- **Schichten ohne Kreis-Imports**: `lib` → `crypto`/`domain` → `data` → `features` → `ui` →
  `app`; untere importieren nie von oberen. `render()` über ein kleines Modul mit
  `requestRender()`, das der Start mit der echten `render` verdrahtet. ESLint
  `import/no-cycle` als Fehler, sobald die Kreise abgebaut sind.
- **Ordner pro Bereich**: aus den flachen Modulen werden `src/<schicht>/…` bzw.
  `src/features/<name>/`. Wo Logik und Rendering gemischt sind, zuerst gemeinsam verschieben.
- **Event-Registry**: die Event-Delegation in `events.js` (über 1.400 Zeilen) wird eine Tabelle
  `{ [action]: handler }`, je Bereich eine Datei. Vorher prüfen, ob Reihenfolge oder frühe
  `return`s zwischen Zweigen zählen; die gemeinsame Vorarbeit (`state.notice = null` u. ä.)
  bleibt im Verteiler.
- **Tests mit Vitest**: jeder Fall aus `dev/tests.mjs` 1:1 als `src/**/*.test.ts`, danach
  `internals` aus `dev/server.mjs` streichen. Rundgänge bleiben Puppeteer.
- `STRINGS` in `de.ts`/`en.ts`, `CHANGELOG` in eine eigene Datei.
- ESLint `max-lines` 500 als Warnung (ohne Texte und `CHANGELOG`).

### Phase 3: TypeScript

1. Von den Blättern her nach `.ts` umbenennen (`lib` → `crypto` → `domain` → `data` →
   `features` → `ui`), Umbenennen und Typisieren in getrennten Commits.
2. Strenge stufenweise: `noImplicitAny`, `strictNullChecks`, dann `strict`. Kein `any` ohne
   Begründung, kein `@ts-ignore`, höchstens `@ts-expect-error` mit Grund.
3. Gemeinsame Typen in `src/types/`; Datenbanktypen aus dem Schema erzeugen
   (`supabase gen types`), nicht abschreiben.
4. **Krypto**: Base64-String, `ArrayBuffer`, `Uint8Array` und Schlüssel als getrennte Typen
   (Brand-Typen), damit sie nicht vertauscht werden können.
5. **i18n**: `type StringKey = keyof typeof de`, `en` mit `satisfies Record<StringKey, string>`,
   dynamische Keys über Template-Literal-Typen. Die Reihenfolge-Regel bleibt ein Test.

### Phase 4: Supabase hinter einem Modul

Die Supabase-Aufrufe (rund 75) sind über viele Bereiche verteilt; das ist die eigentliche
Kopplung an den Anbieter.

- **Nur `src/data/supabaseClient.ts` importiert `@supabase/supabase-js`** (ESLint
  `no-restricted-imports`); Vorschau und Tests tauschen genau dieses Modul.
- Darum Funktionen nach Fachlichkeit (`fetchEntries()`, `saveDayRow(…)`), nicht nach der
  Supabase-API. Zuerst nur die Abfrage herausziehen und `{ data, error }` wie bisher
  zurückgeben; Entschlüsseln, `state` und Meldungen bleiben, wo sie sind.
- Neue Funktionen nutzen nur Postgres und Auth; kein Storage, kein Realtime, keine neue Edge
  Function ohne Absprache, keine Logik in SQL/RLS, die im Client oder einer Function geht.

### Phase 5: React (nur nach ausdrücklichem Okay)

Ein Neubau der Oberfläche, kein Verschieben: rund 90 `render…`-Funktionen, die ganze
Event-Delegation und viel von Hand gebaute Fokus-, Scroll- und History-Logik. Deshalb eine
Ansicht nach der anderen, jede für sich auslieferbar. Vor dem Start schriftlich festlegen:

- **Brücke**: React-Wurzel in einem eigenen Container, den `render()` nicht überschreibt.
- **Zustand**: ohne neue Abhängigkeit (`useSyncExternalStore` über `state`); eine Bibliothek
  nur auf Anweisung.
- **Reihenfolge** einfach → schwierig: Anmelden → Über Logbuch → Auswertung → Felder verwalten
  → Vorlagen → "Heute" zuletzt (Long-Press, Wischen, Ziehen).

Regeln: eine Komponente pro Datei; Logik als reine Funktionen getrennt (mit Tests), keine
Supabase- oder Krypto-Aufrufe in Komponenten; ein Hook pro Datei; kein
`dangerouslySetInnerHTML` (die Texte mit `<strong>` u. ä. über eine kleine Komponente, die nur
die vorkommenden Tags übersetzt); Gestaltung bleibt (Ledger-Optik, `rem`, kein Tailwind, kein
UI-Kit). Erhalten bleiben muss, was React nicht von selbst liefert (vor jeder Ansicht
docs/design-bedienung.md lesen): Fokus nach Aktionen, Scroll-Wiederherstellung,
Android-Zurück und `history.go()`-Falle, `<select>`-Fokus, iOS-Zoom, Button-Reihenfolge im DOM,
Eingaben über Neuzeichnen hinweg, stabile Knopftexte (die Rundgänge tippen auf Texte).
