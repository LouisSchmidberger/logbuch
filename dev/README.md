# Lokale Vorschau

Logbuch lokal ansehen und per Skript fotografieren, ohne Konto, ohne Netz und ohne live zu
gehen: auch eingeloggte Seiten und das Onboarding. Das echte Gerät bleibt die letzte Instanz.

## Wie es funktioniert

`server.mjs` liefert die echten App-Dateien aus, tauscht aber zwei Dinge, **nur beim
Ausliefern** (die Dateien im Repo bleiben unverändert):

- `vendor/supabase-js-*.js` → `mock-supabase.js`: nachgebautes Supabase (Anmeldung,
  Tabellen mit Standardwerten/Schlüsseln/"nur eigene Zeilen", die zwei Edge Functions),
  gespeichert in localStorage von `localhost`. Mails landen im Vorschau-Postfach
  (`/dev/postfach.html`).
- `logbuch.js` bekommt eine Zeile angehängt, die `preview-hook.js` mit einigen inneren
  Funktionen der App lädt (`window.__logbuchPreview`). Darüber legen die Beispieldaten
  denselben Weg zurück wie echte Eingaben, mit gleicher Verschlüsselung und gleichem Format.

Diese Trennung ist eine bewusste Entscheidung: Die Vorschau lässt sich auf der Live-URL nicht
einschalten, weil es dort diesen Server nicht gibt. Der Ordner `dev/` wird zwar mit
veröffentlicht, bewirkt ohne den Server aber nichts. Ein Vorschau-Schalter in der App selbst
wurde verworfen, weil damit Testcode in der Live-App läge.

**Wenn logbuch.js eine neue Tabelle, Spalte mit Standardwert, einen neuen Abfrage-Baustein
oder einen neuen Auth-Aufruf bekommt:** in `mock-supabase.js` nachziehen. Sonst weicht die
Vorschau still ab oder bricht mit "nicht nachgebaut" ab.

## Benutzen

Einmalig: `cd dev && npm install` (nur `puppeteer-core`, nutzt das installierte Edge/Chrome).

```
node dev/server.mjs                 # Vorschau auf http://localhost:5180/ (läuft weiter)
node dev/rundgang.mjs onboarding    # bzw. onboarding-kurz, app, alle
node dev/rundgang.mjs app --device=schmal --theme=dark --size=xlarge
```

Die Bilder landen in `dev/screenshots/<rundgang>-<gerät>[-dark][-<größe>]/` (nicht im Git).
Geräte: `handy` (390 px), `schmal` (360 px), `iphone`, `pc`. Größen wie die Einstellung
Textgröße: `small`, `large`, `xlarge`.

Eigene Abläufe ohne neues Skript: `node dev/shoot.mjs <Schritte>`, zum Beispiel
`seeded "tap:Menü" "tap:Einstellungen" shot:einstellungen` (alle Schritte im Dateikopf).
`buttons` listet, was gerade antippbar ist.

Von Hand im Browser: Server starten, `http://localhost:5180/` öffnen. In der Konsole
`await __logbuchPreview.resetAll()` (alles frisch) oder nach dem Anmelden
`await __logbuchPreview.seedDemo()` (Beispieldaten), danach neu laden.
Langsames Netz nachstellen: `localStorage.setItem('logbuchPreviewDelayMs', '2000')`
(Verzögerung pro Supabase-Aufruf, Standard 30 ms).

## Grenzen

Push, echter Mailversand und die Serverlogik der Erinnerungen fehlen. Die Installation als App
lässt sich headless nicht auslösen, deshalb gehen die Rundgänge über "Ich bleib erst mal im
Browser". Die Rundgänge tippen über sichtbare Knopftexte. Ändert sich ein Text, bricht der
Rundgang mit einer Liste dessen ab, was sichtbar war, und legt ein `FEHLER`-Bild ab.
