# Verschlüsselung (Zero-Access-Architektur)

`habit_entries.data` (die eigentlichen Werte) und die Feld-Definitionen sind clientseitig
verschlüsselt. Der Betreiber (auch über Supabase-Dashboard/CLI) kann weder die Werte noch
sehen, WORÜBER jemand Buch führt. RLS schützt nur Nutzer voreinander, das hier zusätzlich
vor dem DB-Owner. Alles nativ mit der Web Crypto API, keine Library.

Bewusst unverschlüsselt bleibt nur, was der Server für die Erinnerungen braucht bzw. reine
Anordnung ist: `habit_definitions.kind`/`reminder_minute`/`schedule`/`archived_at`/
`sort_order`/`section_id`, `habit_sections.reminder_minute`/`sort_order` und
`habit_entries.filled_slugs` (nur Feld-IDs, keine Werte/Namen). Erinnerungen nennen
Feldnamen trotzdem – der Name wird erst auf dem Gerät eingesetzt, siehe
[erinnerungen.md](erinnerungen.md). Erklärt für Nutzer in "Über Logbuch" → "Deine Daten und
deine Privatsphäre" (muss mit der Technik übereinstimmen).

**Padding**: alle verschlüsselten Daten werden vor dem Verschlüsseln auf ein Vielfaches von
256 Byte aufgefüllt (`encryptData`, Leerzeichen am JSON-Ende), damit die Länge nicht
verrät, wie viel jemand eingetragen hat. Ältere Einträge verschlüsselt die App beim Öffnen
einmalig neu (`repadOldEntries`): nur Tage ≥ 2 Tage zurück (ein gleichzeitiges normales
Speichern desselben Tages könnte sonst überschrieben werden), übersprungen wird jeder seit
dem Laden geänderte Tag, Upsert nur mit `data`.

## Feld-Definitionen

`habit_definitions.enc` = `{iv, ciphertext}` mit demselben DEK (Inhalt siehe
`habitFromParts`, das daraus das Feld-Objekt baut). Die DB-Schutzregel
`habit_definitions_enc_no_plaintext_check` lehnt eine verschlüsselte Zeile mit
Klartext-Resten ab (`DEF_PLAINTEXT_CLEARED` = die geleerten Spalten). Bestehende Zeilen
stellt die App beim Laden im Hintergrund um (`migrateHabitDefinitions`: verschlüsseln,
lokal kontroll-entschlüsseln und vergleichen, erst dann in einem Schritt speichern +
Klartext leeren; nur ohne vorhandenes `enc`). Konten, die die App nicht mehr öffnen,
behalten ihren Klartext, bis sie es tun (akzeptiert). Nicht zuordenbare/nicht
entschlüsselbare Zeilen werden nicht angezeigt (`notice.habitsUndecryptable`). Gruppen
(`habit_sections.enc`) analog mit `{name}`.

## Zweistufiger Schlüssel

- **DEK** (Data Encryption Key): pro Nutzer ein zufälliger AES-256-GCM-Schlüssel
  (`generateDek`), ver-/entschlüsselt die Daten (`encryptData`/`decryptData`). Ändert sich
  nie mehr, nachdem er erzeugt wurde – auch nicht bei einem Passwort-Reset.
- **KEK** (Key Encryption Key): aus dem Passwort abgeleitet (`deriveKek`, PBKDF2-SHA256,
  `PBKDF2_ITERATIONS` = 600.000 nach OWASP – ältere Konten mit 250.000 stuft
  `upgradePasswordWrap` beim nächsten Entsperren per Passwort still hoch; individueller
  Salt), verpackt den DEK (`wrapDek`/`unwrapDek`). Nur das verpackte Ergebnis
  (`wrapped_dek`) liegt serverseitig – nutzlos ohne Passwort.
- **Ersatzschlüssel** (in der App "Ersatzschlüssel", englisch "spare key", im Code
  `recoveryKey`): zweiter zufälliger 256-Bit-Schlüssel, der den DEK ein zweites Mal
  verpackt (`wrapped_dek_recovery`). Löst den Zielkonflikt "Passwortverlust soll nicht
  Datenverlust bedeuten, aber der Server darf nie Zugriff haben". Verliert jemand Passwort
  UND Ersatzschlüssel, sind die Daten unwiederbringlich weg – unumgehbar, jeder dann noch
  funktionierende Mechanismus wäre ein serverseitiger Zugriffsweg.
  - Wird **einmalig** angezeigt (`renderRecoveryKeyDisplay`) und nirgends serverseitig im
    Klartext gespeichert. Gestaltung siehe [onboarding.md](onboarding.md) → Ersatzschlüssel.
  - **Wann**: nicht gleich bei der Einrichtung (erster Eindruck wäre eine
    Sicherheitswarnung), sondern als eigener Schritt nach dem Tutorial – auch wenn es
    übersprungen wurde. `user_encryption.recovery_key_confirmed` merkt sich, ob der aktuelle
    Schlüssel bestätigt ist: `setupEncryption` und `regenerateRecoveryKey` setzen `false`
    (`spareKeyPending`), `maybeShowSpareKey` erzeugt nach dem Laden bzw. dem Tutorial einen
    frischen und zeigt ihn, `confirmSpareKey` setzt `true`. Wer vorher schließt, bekommt
    beim nächsten Öffnen einen neuen (der ungesehene ist damit ungültig).
  - In den Einstellungen jederzeit neu erzeugbar (`regenerateRecoveryKey`, macht den alten
    ungültig, braucht kein Passwort, da der DEK im Speicher liegt). Fragt vorher nach
    (`renderRegenKeyConfirm`) – der alte ist sofort ungültig, auch der aufgeschriebene.

## Schlüssel-Lebenszyklus

`currentDek` ist eine Modul-Variable, nie Teil von `state`/`render()`; gesetzt/geleert
ausschließlich über `setCurrentDek`/`clearCurrentDek`. Nur die Lade-/Speicher-/
Export-Funktionen fassen ihn an; `state.entries` hält nach `loadEntries` immer
entschlüsselte Objekte, die übrige App arbeitet nur damit.

- `unlockEncryption(userId, password, { verifyPassword })`, aufgerufen aus
  `completeAuthFlow` direkt nach `signIn`/`signUp` bzw. aus der Entsperr-Maske ("Passwort
  eingeben", `renderUnlockPrompt`): prüft zuerst den IndexedDB-Cache (`usableCachedDek`,
  ohne PBKDF2); sonst wird `user_encryption` geladen und entpackt (falsch →
  `WRONG_PASSWORD`, Meldung über `unlockErrorText`, Netzwerkfehler getrennt). Gibt es keine
  Zeile, richtet `setupEncryption` alles ein (DEK, beide Wrappings,
  `migrateExistingEntries`). Dabei **nur einfügen, nie überschreiben**: legt ein zweites
  Gerät fast gleichzeitig an, gewinnt das erste (`KEY_EXISTS` → mit dem Passwort
  entsperren) – sonst wäre, was das erste verschlüsselt hat, unlesbar. Aus der
  Entsperr-Maske (`verifyPassword`, z.B. nach dem Bestätigungslink im Browser) wird das
  Passwort vor dem Einrichten per `signInWithPassword` geprüft – sonst würde ein Tippfehler
  zum Schlüssel-Passwort.
- Bestehende Session ohne frisches Passwort (Reload): erst der Cache, sonst
  `renderUnlockPrompt()` (falsches Passwort erkennt man daran, dass `unwrapDek`
  fehlschlägt).
- `authFlowInFlight` verhindert, dass `onAuthStateChange` (feuert bei jedem
  `signIn`/`signUp`/`updateUser`) parallel einen zweiten Entsperr-Versuch startet – **muss
  VOR dem jeweiligen Supabase-Auth-Aufruf gesetzt werden**, sonst Race Condition.
- **Passwort-Reset** über den Mail-Link (`renderPasswordRecovery`) verlangt zusätzlich den
  Ersatzschlüssel, um den DEK zu erben und mit dem neuen Passwort neu zu verpacken – ohne
  Bestandsdaten neu zu verschlüsseln. Fallback "Ersatzschlüssel auch verloren" nur mit
  zweiter Bestätigung: neuer DEK (`setupEncryption` mit `replace: true` – die einzige
  Stelle, die einen bestehenden Schlüssel ersetzt), danach löscht
  `deleteUndecryptableData` alles mit dem alten DEK Verschlüsselte (Einträge,
  Feld-Definitionen mit `enc`, Gruppen) – best effort, das neue Passwort ist dann schon
  gesetzt; bei Fehler `recovery.cleanupFailed`. Bewusst erst nach `setupEncryption`:
  scheitert die, bleibt der alte Stand samt Recovery-Wrapping erhalten.
- **Logout**: `clearLoadedAccountState` verwirft Schlüssel, Daten und alles Kontobezogene
  im State (offene Formulare, Entwürfe, Dialoge, Unterseite); der IndexedDB-Cache bleibt
  für den nächsten Login auf dem Gerät, die Erinnerungen des Geräts enden
  (`endPushForThisDevice`). Konto-Löschung räumt den Cache zusätzlich auf.
  `currentDekUserId` merkt sich, zu welchem Konto der Schlüssel gehört – meldet
  `onAuthStateChange` ein anderes Konto (z.B. anderer Tab), wird alles verworfen; bei
  gleichem Konto (Token-Erneuerung) bewusst kein `render()`, das verwürfe Getipptes.
- **Kennung des DEK** (`user_encryption.dek_id`): zufällige UUID, nicht geheim, neu nur
  wenn ein neuer DEK entsteht. Der Cache speichert sie neben dem DEK (`{key, dekId}`), vor
  jeder Nutzung wird verglichen (`usableCachedDek`) – sonst würde ein anderes Gerät nach
  einem Reset mit dem alten DEK weiter speichern (für alle übrigen unlesbar). Passt sie
  nicht: Cache löschen, Passwort abfragen (`unlock.keyChanged`). Ohne Verbindung beim Start
  wird ebenfalls das Passwort abgefragt statt dem Cache ungeprüft zu vertrauen.
  `checkDekStillCurrent` prüft zusätzlich beim Zurückkehren (`visibilitychange`), da ein
  entsperrtes Gerät nach dem Reset bis zum Ablauf seines Tokens (bis 1 h) angemeldet bleibt;
  ausstehende Speicherungen werden dabei ungesendet verworfen. Caches ohne Kennung (reiner
  base64-String) werden einmalig übernommen und bekommen sie nachgetragen
  (Nutzer-Entscheidung: kein erneutes Passwort für alle nach dem Update).
