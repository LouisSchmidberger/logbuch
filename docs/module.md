# Module (Aufbau des Frontend-Codes)

Die App-Logik liegt in ES-Modulen unter `js/`, eins je Bereich; `logbuch.js` ist nur der
Einstieg. Kein Build-Schritt: der Browser lädt die Module selbst (`<script type="module">`),
die CSP (`script-src 'self'`) erlaubt das ohne Ausnahme. Gestaltung in `logbuch.css`.

Entstanden 2026-11-10 durch Aufteilen der früheren Einzeldatei (15.000 Zeilen) an ihren
Abschnitts-Überschriften, mit unverändertem Verhalten (alle Rundgang-Bilder vorher/nachher gleich).

## Bereiche

| Modul | Inhalt |
|---|---|
| `config` | Supabase-Client, Schlüssel, Werte aus der Start-URL |
| `crypto` | Verschlüsselung, Schlüssel-Cache (IndexedDB) |
| `fields` | Feld-Definitionen, Gruppen-Anordnung, berechnete Felder, Ziele |
| `dates` | Zeitpläne, Datum-Helfer, Wochenbeginn, Erinnerungszeiten |
| `state` | `state`, `runtime`, aktueller Schlüssel (`currentDek`) |
| `navigation` | Android-Zurück, Ebenen, Rückfrage beim Verlassen, `app` (das `#app`-Element) |
| `strings` / `i18n` | Texte de/en / `t()`, Sprache |
| `theme`, `format`, `notices` | Dark Mode und Textgröße; Formatierung, Fehlertexte; Meldungen |
| `data`, `keys`, `session` | Laden aus Supabase und Schalter; Schlüssel-Ablauf; Anmeldung |
| `field-form`, `type-change`, `section-form` | Feld-Formular; Stufen/Typ ändern; Gruppen-Formular |
| `save`, `device`, `account` | Notizen und Speichern; Installation und Push; Export, Löschen |
| `*-view`, `templates`, `tutorial` | Rendering der Bildschirme, Vorlagen, Tutorial |
| `events`, `gestures`, `deeplinks` | Event-Delegation; Wischen, Long-Press, Ziehen; Deep-Links |

## Regeln

- **Beim Laden eines Moduls läuft nichts außer Deklarationen.** Event-Listener und anderer
  Start-Code stehen in `init<Modul>()` am Modulende; `logbuch.js` ruft alle in fester
  Reihenfolge auf. Grund: die Reihenfolge, in der der Browser Module auswertet, folgt dem
  Import-Netz, nicht der Dateiliste - Code beim Laden griffe sonst auf Konstanten anderer
  Module zu, die noch nicht ausgewertet sind ("Cannot access … before initialization").
  Dasselbe gilt für Startwerte von Konstanten: aus einem anderen Modul nur Funktionen
  aufrufen, keine Konstanten lesen (Beispiel `timePickerMax` in `row-view`).
- **Variablen, die mehrere Module setzen, stehen in `runtime`** (`state.js`). ES-Module
  können eine importierte Variable nicht neu zuweisen, eine Eigenschaft eines geteilten
  Objekts schon. `state` bleibt für das, was gerendert wird; `runtime` sind Merker für Abläufe.
  Eine Variable, die nur ihr eigenes Modul setzt, bleibt dort als `let`.
- **Imports mit `?v=0` schreiben** (`import { x } from './y.js?v=0';`), der pre-commit-Hook
  setzt die Kennung (Cache-Busting, docs/freigabe.md). Alle Imports eines Moduls müssen
  dieselbe Adresse nutzen, sonst lädt der Browser es doppelt (zwei getrennte Zustände).
- **Was `dev/tests.mjs` prüft, muss exportiert sein**; die Vorschau reicht alle Exporte durch.
- Der Linter (`npm run lint`) meldet nicht importierte Namen - nach dem Verschieben von Code
  zwischen Modulen zuerst laufen lassen.
