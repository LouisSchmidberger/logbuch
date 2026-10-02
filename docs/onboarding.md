# Onboarding

Der Weg vom ersten Öffnen bis zur eingerichteten App, für neue Konten.

## Entscheidungen (vom Nutzer bestätigt)

- **Faustregel**: klarer formulieren gilt für alle, mehr erklären nur bei "Schritt für
  Schritt". EIN Ablauf, keine zwei getrennten Onboardings: Erklärungen sind aufklappbar
  (`whyBox` bzw. `.why-details`, "Warum?"-Kästen) und bei Schritt für Schritt von Anfang an
  offen (`isGuided`).
- **Einstiegsfrage nach dem Wunsch, nicht nach dem Können**: "Wie möchtest du starten?" →
  Schritt für Schritt (mit genauen Erklärungen und Bildern) / Kurz und knapp. Grund: "kennst
  du dich aus?" schätzen viele falsch ein und kann herablassend wirken.
- **Reihenfolge**: Startseite → "Ich bin neu hier" → Einstiegsfrage → (Schritt für Schritt:
  "So läuft's ab") → Installations-Seite (nur Handy im Browser) → Registrieren → "Schau in
  dein Postfach" → Tutorial → Ersatzschlüssel. Die Installations-Seite kommt vor dem
  Registrieren, damit man sich gleich in der installierten App registriert – kam der Hinweis
  erst nach dem Anmelden, war ein zweites Anmelden in der App nötig und er wurde oft
  weggeklickt. Wer schon ein Konto hat, bekommt sie auf einem neuen Handy trotzdem (vor dem
  Anmelden).
- **Installation mit gezeichneten Skizzen statt Screenshots**: vereinfachte Handy-Ansicht,
  der richtige Knopf grün eingekreist, Beschriftung aus der App, passt sich Hell/Dunkel an –
  Screenshots veralten je Sprache/Theme/OS-Version. Auch ungefähre Skizzen helfen mehr als
  gar keine (Nutzer). Gilt genauso für alle anderen Anleitungen zu fremden Oberflächen
  (Mitteilungen erlauben, Bildschirmfoto, Downloads).
- **"Browser verlassen/Symbol finden"** ist laut Nutzer-Erfahrung kein Problem (Browser
  schließt sich, Symbol ist sichtbar) → nur ein Satz Vorwarnung, kein eigener Schritt.
- **Erstes Feld = das echte Feld-Formular, Stück für Stück aufgedeckt**: das Tutorial soll
  auf die echte Oberfläche vorbereiten, nicht nur ein Feld erzeugen – ein eigener
  Frage-Antwort-Assistent wurde deshalb verworfen. "Berechnet" ist im Tutorial immer
  ausgeblendet, auch bei "Noch ein Feld anlegen" mit genug passenden Feldern (Grund nicht
  dokumentiert). Davon getrennt gilt überall: der Typ erscheint erst ab zwei passenden
  Feldern, beim allerersten Feld führte er sonst ins Leere (siehe [felder.md](felder.md)).
  **Keine Vorlagen/Beispiele zum Antippen** – Vorlagen sind erst sinnvoll, wenn man das
  Formular einmal selbst durchgegangen ist; nur Ideen als Text unter dem Namen.
- **"Mehr Einstellungen"** auch im echten Formular (siehe [felder.md](felder.md)), weil das
  Formular für Neulinge zu lang war und das Tutorial dasselbe Formular nutzt.
- **Erinnerungen**: bei Schritt für Schritt vorher eine Skizze des Erlaubnis-Dialogs (wie bei
  der Installation: auch ungefähre Skizzen helfen mehr als gar keine); bei Blockieren ein
  freundlicher Ausweg statt Sackgasse (siehe [erinnerungen.md](erinnerungen.md) →
  Blockierte Mitteilungen).
- **Ersatzschlüssel** als eigener Schritt am Ende statt bei der Einrichtung (erster Eindruck
  wäre sonst eine Sicherheitswarnung). Vier gleich große Wege zum Aufbewahren: Kopieren und
  Datei allein reichen nicht – die Zwischenablage kennen viele nicht, eine Datei ist auf dem
  Handy oft nicht wiederzufinden –, deshalb auch Aufschreiben und Abfotografieren; gleich
  groß, weil kleine Pillen-Knöpfe zu unscheinbar waren. Abschluss-Knopf immer aktiv mit Rückfrage statt
  Häkchen + ausgegrautem "Fertig": ein deaktivierter Knopf ohne erkennbaren Grund war ein
  Stolperstein.
- **Nach dem Onboarding**: Erklärungen dorthin, wo man sie braucht (Karten in "Heute"), statt
  nur in "Über Logbuch". Dauerhaft für alle: "Eintrag entfernt [Rückgängig]", Hinweis bei
  leerer Auswertung, "Was bedeuten Farben und Zahlen?" (siehe
  [design-bedienung.md](design-bedienung.md) und [felder.md](felder.md)).

**Leitlinie für alle Texte hier** (Nutzer): nie nur sagen, dass etwas so ist, sondern warum;
locker statt förmlich, die App als Freund, der helfen will; persönliche Ich-Form des Machers,
wo es um Vertrauen geht ("Nicht mal ich kann sie lesen"). Ein Bildschirm = ein Thema.
Versprechen "ohne Druck" bewusst ohne "vergessen" formuliert (ein ausgelassener Tag kann
auch Absicht sein).

## Gerätespeicher

Alles nur auf dem Gerät (`localStorage`), nie im Konto:
- `onboardingMode` (`'guided'`/`'short'`, `getOnbMode`/`setOnbMode`)
- `onboardingInProgress` (Einrichten läuft, `isOnbInProgress`): gesetzt bei der
  Einstiegsfrage, beendet mit dem bestätigten Ersatzschlüssel (`confirmSpareKey`) bzw. bei
  "Ich habe schon ein Konto".
- `onboardingWithInstall`: ob die Etappe "Aufs Handy holen" mitzählt, festgelegt bei der
  Einstiegsfrage (`rememberOnbIncludesInstall`/`onbIncludesInstall`).
- `installGateSkipped` ("Ich bleib erst mal im Browser"), `installHintDismissed`
- `signedInHere` (auf dem Gerät schon angemeldet → Start direkt beim Anmelden)
- `todayIntroPending` (Erklär-Karten in "Heute" stehen aus)

Konto-Löschung räumt sie weg (`clearDeviceAccountTraces`). iPhone: Safari und die
installierte App teilen keinen Speicher.

## Startseite und Einstiegsfrage

**Startseite** (`renderAuthWelcome`, `authMode: 'welcome'`): zwei Knöpfe "Ich bin neu hier" /
"Ich habe schon ein Konto" statt direkt "Anmelden" – das klang für Neulinge nach "ich bin neu,
also melde ich mich an", und Registrieren war nur ein kleiner Link. Die Formulare haben ein ←
zurück dorthin. Wer sich auf dem Gerät schon angemeldet hat, startet direkt beim Anmelden.

**Einstiegsfrage** (`renderOnbMode`). Bei Schritt für Schritt folgt **"So läuft's ab"**
(`renderOnbOverview`: Etappen, Dauer etwa 5 bis 10 Minuten, Hinweis "hol dir gern jemanden
dazu" als Angebot), bei Kurz und knapp direkt das Registrieren (bzw. davor die
Installations-Seite).

**Fortschrittsleiste** (`onbProgress(stage)`): Etappen install / account / setup / key,
"Schritt X von N: …". Die Etappe install zählt nur auf dem Handy und nur, wenn die App schon
installiert ist oder die Installations-Seite hier nicht früher weggeklickt wurde. Die Zählung
wird bei der Einstiegsfrage festgelegt und bleibt, auch wenn man die Seite mitten im
Einrichten überspringt – sonst spränge "Schritt 2 von 4" auf "Schritt 1 von 3". Ein
Unterschritt (Tutorial) steht als kleine Punkte-Zeile darunter, nicht in derselben
Überschrift.

## Installations-Seite (nur Handy im Browser)

`renderInstallGate`, "Erst mal ein Zuhause für Logbuch": Begründung im "Warum?"-Kasten
(iOS: sonst keine Erinnerungen), Anleitung je Browser (`installBrowser`: Safari iOS, andere
iOS-Browser, Chrome, Samsung Internet, Firefox, Opera, sonst allgemein; `installSteps`) mit
SVG-Skizzen (`sketchHtml`). Opera, Edge, Vivaldi u.a. tragen "Chrome" in der Kennung, haben
aber andere Menüs – sie bekommen lieber die allgemeine Anleitung als eine falsche genaue
(allgemeine Skizzen: Menü "oben rechts oder unten rechts", gestrichelt; Liste mit Eintrag zum
Startbildschirm). Opera hat eine eigene (Menü ⋮ → „Hinzufügen zu …“ → Startbildschirm, nach
einem Nutzer-Screenshot). Bei Schritt für Schritt stehen die Skizzen im Ablauf, sonst kurze
Text-Schritte mit "Mit Bildern zeigen" zum Aufklappen; danach ein Satz Vorwarnung "Browser
schließt sich oft von selbst …". Auf Android/Chrome zusätzlich ein echter
Installieren-Knopf (`beforeinstallprompt`). "Ich bleib erst mal im Browser" merkt sich das
Gerät (`installGateSkipped`).

Auf iOS ist die Installation **Voraussetzung** für Web-Push (Safari liefert sonst keinen
Push aus, seit iOS 16.4) – die Texte sind dort deshalb dringlicher formuliert.

**Hinweis in der App** (`renderInstallHint`): erscheint im App-Bereich (nicht auf den
Auth-Screens), solange die Seite auf dem Handy nicht als PWA läuft (`display-mode:
standalone` bzw. `navigator.standalone`) und nicht weggeklickt wurde
(`installHintDismissed`). Auf dem Desktop gar nicht: Push funktioniert dort im normalen Tab
genauso zuverlässig, "installieren" brächte nur Kosmetik.

**Frisch installierte App** (`authMode: 'installed'`, standalone ohne frühere Anmeldung,
`renderOnbInstalled`): "Geschafft! Logbuch ist jetzt auf deinem Handy. Weiter geht's mit
deinem Konto." Ist die Einstiegsfrage auf diesem Speicher schon beantwortet (Android teilt
ihn mit dem Browser), geht es mit "Konto erstellen" weiter; sonst (iPhone) kommt die
Einstiegsfrage hier noch einmal und führt direkt zu "Konto erstellen" – "So läuft's ab"
entfällt dort.

## Registrieren und Bestätigen

Registrieren/Anmelden sperren und beschriften den Knopf sofort ("Konto wird erstellt …",
`authSubmitBusy`) – sonst tippten viele während der Wartezeit nochmal und bekamen einen
Fehler, obwohl es geklappt hatte. Passwort-Hinweis: "Merk es dir gut oder schreib es auf",
die Verschlüsselung als Grund im "Warum?".

**"Schau in dein Postfach"** (`renderCheckMail`, `authMode: 'checkMail'`): eigene Seite nach
dem Registrieren, damit Meldung, Hilfe und Formular nicht untereinander stehen und alle drei
etwas wollen. Drei nummerierte Schritte (E-Mail-App öffnen, Mail von Logbuch öffnen – sonst
im Spam schauen, Knopf zum Bestätigen tippen) im aufklappbaren Kasten "So geht's", offen nur
bei Schritt für Schritt; darunter der Hinweis zum Anmelden (hier über "Weiter zum Anmelden"
oder auf der Seite nach dem Bestätigen, mit installierter App am besten dort), der Knopf
"Weiter zum Anmelden" und die Hilfe zur Bestätigungsmail (`renderConfirmEmailHelp`, siehe
[datenschutz-sicherheit.md](datenschutz-sicherheit.md) → E-Mail-Versand).

**"Adresse bestätigt"** (`renderConfirmLanding`): der Bestätigungslink geht im Browser auf,
nicht in der App. Kommt man darüber an (`#…type=signup`, vor dem Start von supabase-js
gemerkt, `ARRIVED_VIA_SIGNUP_CONFIRM`), zeigt die Seite "Adresse bestätigt! Diese Seite
brauchst du nicht mehr. Öffne Logbuch jetzt wieder über das Symbol …" statt der Anmeldung –
nur auf dem Handy im Browser und nur, wenn die Installations-Seite nicht übersprungen wurde.
Weitermachen im Browser bleibt möglich.

**"Passwort eingeben"** (`renderUnlockPrompt`, früher "Entsperren"): einfacher Satz +
"Warum?" (neues Gerät, gelöschte Browserdaten oder Ankunft über den Mail-Link).

## Tutorial

`renderTutorial`, gesteuert über `user_settings.onboarding_completed` (Default `false`, im
Client `state.userSettings.onboardingCompleted`):
solange `false`, ersetzt `render()` die App durch das Tutorial – geprüft erst nach dem
DEK-Unlock (das Tutorial braucht entschlüsselte Daten). `state.tutorialStep` (1–
`TUTORIAL_STEPS` = 4) lebt nur im Speicher, kein Reload-Resume nötig.

Gemeinsame Bausteine (`tutorialScreen`): Fortschritt (`tutorialProgress` →
`onbProgress('setup', [Teil, 4])`), Symbol, kurze Überschrift (bei jedem Bildschirmwechsel
fokussiert, `lastTutorialScreen`), der eine Kernsatz fett, Begründungen im "Warum?"-Kasten
(`whyBox`), kurze Hinweise in normaler Schriftfarbe (`.onb-hint`, nicht im blassen Sandton
der Formular-Hinweise). Zurück/Überspringen in einer eigenen Fußleiste mit Trennlinie
(`tutorialNav`, Zurück links, Überspringen rechts), damit sie sich vom Inhalt abheben;
Aktionen des Inhalts ("Lieber nicht", "Noch ein Feld") bleiben beim Hauptknopf. Keine
Tab-Leiste/kein Menü; eine `beforeunload`-Warnung verhindert versehentliches Verlassen.

1. **Hallo** (`renderTutorialHello`): was Logbuch ist + drei Versprechen mit Symbol (privat ·
   ohne Druck · deins). Platz für einen persönlichen Satz des Nutzers ist vorgesehen, Inhalt
   noch offen.
2. **Erinnerungen** (`renderTutorialReminders`): Frage mit Begründung ("nur wenn an einem Tag
   etwas fehlt", plus die abschaltbaren Übersichten – muss mit dem echten Verhalten
   übereinstimmen), Hinweis auf die Erlaubnis-Abfrage, "Ja, erinnere mich" (`enable-push`)
   oder "Lieber nicht". Die Uhrzeit erscheint erst, wenn Push aktiv ist. Bei Schritt für
   Schritt eine Skizze der Erlaubnis-Frage mit hervorgehobenem "Erlauben"
   (`sketchHtml('permIos'|'permAndroid')`); blockiert → Anleitung; iPhone im Browser →
   aufklappbarer Kasten mit der Installations-Anleitung (`installManualHtml`, dieselbe wie
   auf der Installations-Seite). Ohne Push-Unterstützung eine Erklärung statt der Frage.
3. **Erstes Feld** (`renderTutorialFieldForm`): Satz, was ein Feld ist, aufklappbarer Kasten
   "Warum erst mal nur eins?" (wenige Felder sind schnell eingetragen und halten länger durch
   als ein langer Fragebogen), dann das echte Feld-Formular, Stück für Stück aufgedeckt
   (`f.revealStage`: 1 Name mit Ideen als Text darunter → 2 + Feld-Typ → 3 + Einstellungen
   zum Typ, Vorschau, "Mehr Einstellungen" (zu), "Feld anlegen"; Aktion
   `habit-reveal-next`). Ausgefülltes bleibt stehen. Je neu aufgedecktem Teil ein Tipp-Kasten
   (`.form-tip`, "Genauer erklärt" bei Schritt für Schritt offen). Kein "Abbrechen"
   (Zurück/Überspringen in der Fußleiste). Nach erfolgreichem Anlegen (Insert-Zweig in
   `handleHabitSave`) Sprung zu 4.
4. **Geschafft** (`renderTutorialDone`): "Loslegen" (`saveOnboardingCompleted()`) oder "Noch
   ein Feld anlegen" (wieder das aufgedeckte Formular ab dem Namen).

Überspringen (Schritte 1–3) fragt zweistufig nach (`.modal-overlay`/`.modal-box`, wie
`renderDeleteConfirm`) und setzt bei Bestätigung sofort `onboarding_completed = true` –
identisch zu "Loslegen". `saveOnboardingCompleted()` aktualisiert `state` sofort (App ohne
Wartezeit) und speichert im Hintergrund.

## Ersatzschlüssel

Technik siehe [verschluesselung.md](verschluesselung.md). Seite `renderRecoveryKeyDisplay`:
Satz oben ("Falls du dein Passwort einmal vergisst, kommst du nur mit diesem Schlüssel wieder
an deine Einträge"), Technik im "Warum?", der Schlüssel groß in Fünfergruppen
(`formatRecoveryKey`), "Wie möchtest du ihn aufbewahren?" mit vier gleich großen Wegen:
Aufschreiben, Foto vom Bildschirm (mit Tastenkombi fürs Gerät), Als Datei speichern (danach:
wo sie meist liegt), Kopieren (bei Schritt für Schritt mit Erklärung zum Einfügen).
Abschluss-Knopf "Ich habe ihn aufbewahrt" immer aktiv; ohne benutzten Weg fragt er einmal
nach ("Hast du ihn sicher aufbewahrt?"), nach "Aufschreiben" mit "Hast du ihn
aufgeschrieben?".

## Erklär-Karten in "Heute"

`renderTodayIntro`: einmalig nach dem Einrichten eines neuen Kontos, nicht für
Bestandsnutzer. `confirmSpareKey` setzt `todayIntroPending` nur, wenn auf diesem Gerät gerade
das Einrichten lief; die Karten erscheinen nur bei mindestens einem aktiven Feld. Kurz und
knapp: eine Karte (eintragen, nochmal tippen entfernt, Punkt = offen); Schritt für Schritt:
genau drei nacheinander (eintragen; andere Tage per Wischen/Pfeilen; ⋮ und Menü), jeweils
mit [Weiter] bzw. [Verstanden].
