# Felder, Gruppen und Auswertung

Begriffe: in der App heißt **"Gruppe"** eine einklappbare Überschrift, unter der Felder
stehen – im Code/in der DB **`section`** (`habit_sections`, `state.sections`,
`renderBySection` …). Der Feldtyp **"Berechnet"** heißt intern **`kind='computed'`**
(umbenannt von `kind='group'`, Migration `20260927220000_rename_group_kind_to_computed`,
damit "group" im Code nicht etwas anderes meint als "Gruppe" in der App). Einzige Altlast:
in der verschlüsselten payload heißt die Mitgliederliste `groupMembers` (Klartext-Spalte
`group_members` bei noch unverschlüsselten Zeilen), am Feld-Objekt im Client `members`.

## Feldtypen

- `kind='scale'`: Stufen mit Gut/Schlecht-Bewertung (Normalfall).
- `kind='number'`: freier Messwert, bewusst **ohne** Gut/Schlecht-Bewertung, mit optionaler
  Einheit.
- `kind='computed'` ("Berechnet"): nicht direkt befüllbar, zeigt einen live berechneten Wert
  seiner Mitglieder.
- `kind='text'`: freie Text-Antwort.

Es gibt keinen Bool-Typ – ein Ja/Nein-Feld ist eine `scale` mit 2 Stufen und Bezeichnungen
(`min:1, max:2, labels:['Nein','Ja']`; ältere Felder können `min:0, max:1` haben).

### Scores und Farben

`normalize(habit, value)` bildet den Wert eines `scale`-Felds auf 0 (schlecht) bis 1 (gut)
ab, unabhängig von der Richtung (`good: 'high'` vs. `'low'`). `scoreColor(score)` färbt
rot→grau→grün (rohe `rgb()`-Werte, theme-unabhängig). `number`-Felder laufen nie durch
`normalize`/`scoreColor` – sie bekommen in "Heute" ein Eingabefeld (normale Zeile ohne
eigenen Kasten, ebenso Text-Felder) und in der Auswertung einen Verlaufs-Graphen
(`renderNumberChart`).

### Text-Felder

Für Fragen wie "Wofür bin ich heute dankbar?". Wert = String unter dem Slug, zählt normal
für `filled_slugs`/Erinnerungen (auch eigene Erinnerungszeit), fließt nie in
Scores/Heatmaps ein. In "Heute" ein **immer offenes Textfeld** (`renderTextBox`;
Nutzer-Entscheidung: wer so ein Feld anlegt, will täglich hineinschreiben – anders als
Notizen, die Ausnahme bleiben). Speichert automatisch: jeder Tastendruck aktualisiert sofort
`state.entries` (ohne `render()`), der verschlüsselte Upsert läuft nach 1 s Tipp-Pause
(`updateTextValue`/`TEXT_SAVE_DELAY_MS`), sofort beim Verlassen des Feldes, beim Wechsel in
eine andere App und vor dem Abmelden (`flushAllDaySaves`). Keine Notizen im Zeilen-Menü
(wären doppelt), kein Mitglied berechneter Felder. DB-Constraints
`habit_definitions_kind_check`/`habit_definitions_kind_fields_check`.

**Rückblick** (`renderTextReviews`): in Woche/Monat/Jahr/Gesamt pro Feld eine Liste Datum +
Text (jeder Eintrag öffnet seinen Tag), überall gleich: eingeklappt (`<details>`, Anzahl im
Titel) und neueste zuerst – eine je nach Ansicht umgekehrte Reihenfolge war verwirrend.
Felder ohne Antwort im Zeitraum erscheinen nicht. Erklärt in "Über Logbuch"
(`about.tip.textFields`).

## Darstellung von Skalen (`display_style`)

`buttons` (Standard) zeigt Auswahl-Buttons, `slider` einen Schieberegler
(`renderHabitSlider`). Beim Anlegen gibt es nur eine Stufenzahl (gespeichert als
`min=1`/`max=<Stufenzahl>`), keine freie Von/Bis-Spanne. Der Regler zeigt **nie** eine
Min/Max-Beschriftung; `slider_show_value` steuert nur, ob der gewählte Wert sichtbar ist.

Live-Vorschau (Wert + Farbe) beim Ziehen über einen `input`-Listener ohne Re-Render;
gespeichert erst beim Loslassen über `handleSetValue` (setzt immer – anders als das
Umschalten von `handleSelect` bei Buttons, wo derselbe Wert den Eintrag wieder entfernt;
beim Regler entfernt das ×). Zwei Wege dorthin: `change`, plus ein eigener
`pointerup`-Listener – ein leerer Regler steht schon mittig; zog man ihn und ließ ihn genau
dort los, feuerte kein `change`, er sah eingetragen aus, war aber nicht gespeichert.

**Bezeichnungen (`labels`) sind kein eigener Modus, sondern ein optionaler Text-Overlay über
denselben Stufen** (zwei sich ausschließende Formular-Modi verworfen, weil die DB nie
zwischen ihnen unterschied). **Neue bzw. unbefüllte Skala-Felder starten immer bei
`min=1`** – wer andere Bezeichnungen will, nutzt eigene Bezeichnungen statt eines
verschobenen Zahlenbereichs.

Formular (`scaleBody` in `renderHabitForm`), in dieser Reihenfolge: Darstellung →
**eine** "Anzahl Stufen"-Eingabe → Checkbox "Eigene Bezeichnungen verwenden", darunter nur
dann eine Zeile pro Stufe (Textfeld, die Zahl als Startwert; ohne Bezeichnungen keine
ausgegrauten Zahlen-Felder – sie wirkten wie kaputte Eingabefelder) → Live-Vorschau →
Bewertung/Ziel-Quote. Die Vorschau rendert `renderHabitOptions`/`renderHabitSlider` mit
einem synthetischen Habit-Objekt (`previewHabitFromForm`) und ist bedienbar wie in "Heute";
der Wert lebt nur in `f.previewValue` (Aktionen `preview-select`/`preview-slider`/
`preview-clear`, `setPreviewValue`), nie echte Daten, Hinweis "wird nicht gespeichert".
`habitFormStepCount(f)`/`habitFormStepValue(f, i)` gelten für beide Darstellungen;
`resizeLabels(labels, newLength, defaultForIndex)` hält die Bezeichnungs-Liste bei jeder
Änderung der Stufenzahl auf Länge (auch bei ausgeschalteter Checkbox) und befüllt neue/leere
Positionen mit der Zahl als Text. Auch der Schieberegler zeigt Bezeichnungen
(`habitSliderValueText`).

### Stufenzahl-Grenzen

Eine Regel: jede Stufe mit eigener Bedeutung muss man sehen und gezielt treffen können.
Buttons (mit oder ohne Bezeichnungen) und Schieberegler mit Bezeichnungen: 2 bis
`CHOICE_STEP_CAP` (7) – mehr Abstufungen machen Antworten eher beliebiger als genauer.
Schieberegler ohne Bezeichnungen ("ungefähr wie viel"): 2 bis `SLIDER_STEP_CAP` (100) – mehr
lässt sich auf dem Handy nicht einzeln treffen. `habitFormStepCap(f)` liefert die gültige
Grenze. Begründung für Nutzer im ⓘ an "Anzahl Stufen" (`habitForm.stepsExplain`: in
Fragebögen haben sich 5–7 Stufen bewährt – bewusst vorsichtig formuliert, die Studienlage
ist nicht eindeutiger). Am Deckel von 7 zeigt das Formular einen Hinweis mit Umschalt-Knopf
("Zum Schieberegler wechseln" bzw. "Eigene Bezeichnungen abschalten",
`habit-steps-to-slider`), statt das Hochzählen stumm enden zu lassen. Bestehende Felder mit
mehr Stufen bleiben nutzbar; ist so ein Feld gesperrt, sind nur Buttons/Bezeichnungen
gesperrt, die es vorher noch nicht hatte (`lockedChoiceBlocked`, mit Erklärung).

Die +/−-Knöpfe (`stepperInput`) zählen beim Gedrückthalten immer schneller weiter
(`stepperHold`); gespeichert/neu gerendert wird erst beim Loslassen, der Klick danach wird
verschluckt.

**Vorschau** zeigt Buttons wie in "Heute" in einer Zeile und blendet einen Hinweis ein, wenn
sie auf dem Gerät nicht hineinpassen (`syncPreviewFitHint`, gemessen nach jedem
Rendern/Drehen/Laden der Schrift). **In "Heute"** rutschen die Buttons in eine eigene Zeile
unter den Namen, sobald Name (mind. 40 %) und Buttons nicht nebeneinander passen
(`.habit-row--buttons`, reines CSS über `flex-wrap`); seitlich gescrollt wird nur, was
selbst in voller Breite nicht passt.

### Bearbeiten mit vorhandenen Daten (`f.locked`)

Nur die Stufenzahl (bzw. das historische `min`/`max`) bleibt gesperrt. Ein bestehendes `min`
ungleich 1 (alte Felder mit Basis 0) bleibt unangetastet; "immer Basis 1" gilt nur für neue
Felder. Darstellung, Bezeichnungen-Checkbox und Bezeichnungs-Text bleiben änderbar (ändern
nur die Beschriftung, nie Zahl/Position). Ausnahme: `lockedChoiceBlocked` (siehe oben).

**Bewusst nicht umgesetzt**: rückwirkende Umrechnung bei einer echten Anzahl-Änderung (z.B.
3 → 5 Stufen) mit vorhandenen Daten – bei nummerierten Stufen mathematisch unproblematisch,
bei Bezeichnungen aber riskant (ein altes "Ja" bekäme nachträglich eine Intensität, die nie
gemeint war). Weg für eine andere Skala: archivieren und neu anlegen.

### Skalen ohne Wertung (`good = null`)

Dritter Zustand "Keine Wertung" (Pill neben Hoch/Niedrig, `habit-good` mit `data-good=""`)
für reines Tracken ohne Urteil; `isNeutralScale(h)`. **Keine Färbung nach Wert**
(Nutzer-Entscheidung): `habitColor(habit, score)` ist die zentrale Weiche und liefert nur
"eingetragen" (`NEUTRAL_FILL` = `--sand`) bzw. `transparent`; gewählte Buttons und der
Regler in "Heute" nutzen die übliche Auswahl-Farbe (`NEUTRAL_SELECTED` = `--ink`, Text
`--paper`, wie `.pill-toggle--active`). Wochen-Grid ohne Streifenmuster, leere Ø-Zelle; in
Monat/Jahr/Gesamt nur die Anzahl ("12×").
Verworfen: eine Graustufen-Skala hell→dunkel nach Position – setzt eine Reihenfolge voraus,
die es oft nicht gibt ("sonnig/bewölkt/Regen"), und wirkte trotzdem wie eine Wertung; die
Ausprägung soll stattdessen die Überarbeitung der Auswertung zeigen (z.B. Verteilung pro
Stufe).
Unbewertete Felder fließen **nicht** in `dayOverallScore` ein und sind kein Mitglied
berechneter Felder (im Formular ausgeschlossen, in `habitScore` defensiv gefiltert) – beides
baut auf einem Gut/Schlecht-Urteil auf. `goal_threshold` ist dann immer `null` (DB-Check
`habit_definitions_kind_fields_check`, Formular blendet es aus).

## Berechnete Felder (`kind='computed'`)

Normale Felder (in Gruppen einsortierbar, in der Auswertung ausblendbar), die man nur nicht
selbst ausfüllen kann. Im Formular der vierte Typ, nur angeboten, wenn es mindestens zwei
passende Felder gibt (beim ersten Feld im Tutorial führte er sonst ins Leere). Kein Eintrag
in `habit_entries.data`, kein eigener `good`, keine Erinnerungszeit, keine Wiederholung
(dran, sobald ein Mitglied dran ist). Notizen gehen (liegen ohnehin unter `_notes`).

**Aus Skalen**: Durchschnitt mehrerer `scale`-Felder. `habitScore(h, dateKey)` liefert den
Durchschnitt aus `normalize(member, …)` über alle Mitglieder mit Wert (null, wenn keins
befüllt ist) und ist für normale `scale`-Felder ein Durchreicher – deshalb nutzen
`renderWeek`/`computeHabitStats` überall `habitScore`. In "Heute" eine nicht-editierbare
Info-Zeile (`renderComputedInfo`). `habitVisibleInRange(h, dateKeys)` prüft die
Sichtbarkeit archivierter Felder (berechnete haben nie einen Entry-Key). In der Tagesfarbe
(`dayOverallScore`) zählen sie nicht – ihre Mitglieder sind schon drin.

**Aus Zahlen**: fasst `number`-Felder per Summe, Durchschnitt, Minimum oder Maximum zusammen
(`aggregate` in der payload: gesetzt = aus Zahlen, `null` = aus Skalen). Helfer
`isNumberComputed`, `isScoredKind`, `hasNumericSeries`, `numberComputedDay`/
`habitNumericValue`. Mitglieder nur mit **derselben Einheit** (Formular sperrt andere,
sobald eins gewählt ist, mit Hinweis; beim Speichern nochmal geprüft); das Feld übernimmt
diese Einheit (`computedUnit`). Gerechnet wird mit den an dem Tag eingetragenen Mitgliedern
(bei der Summe zählt ein fehlendes als 0); ist keins eingetragen, gibt es keinen Wert statt
0. Keine Bewertung (kein Score, keine Farbe, keine Ziel-Quote); in "Heute" eine neutrale
Info-Zeile mit Wert + Einheit, in der Auswertung ein Verlaufsgraph. Werte auf 2
Nachkommastellen gerundet (gegen Gleitkomma-Reste).

## Gruppen (`sections`)

Tabelle siehe [datenmodell.md](datenmodell.md). Einklappbare Abschnitte zum Anordnen von
Feldern (auch berechneten) – reine Anordnung, bewusst **keine eigene Berechnung** (wer einen
Wert will, kombiniert Gruppe + berechnetes Feld). Die Zuordnung ist absichtlich
unverschlüsselt (nur zwei zufällige IDs): die DB löst sie beim Löschen selbst, Umhängen
braucht kein Neu-Verschlüsseln – steht so auch im Datenschutz-Text ("welches Feld in welcher
Gruppe steht").

- **Anlegen/Bearbeiten** über ein eigenes Formular (eigene Ebene der Verwaltung,
  `openSectionForm`/`renderSectionForm`/`saveSectionForm`): Name + Liste aller aktiven
  Felder zum Ankreuzen; **jedes Feld in höchstens einer Gruppe** – Felder einer anderen
  Gruppe erscheinen ausgegraut mit deren Namen. Neu angekreuzte landen am Ende der Gruppe,
  abgewählte am Ende der obersten Ebene. Zusätzlich im Feld-Formular über die Auswahl
  "Gruppe" (nur wenn es Gruppen gibt). Eigene Erinnerungszeit siehe
  [erinnerungen.md](erinnerungen.md).
- **Anordnung** (`layoutBlocks`): auf oberster Ebene Felder ohne Gruppe und Gruppen
  gemeinsam nach `sort_order`; Felder einer Gruppe darin nach ihrem eigenen `sort_order`
  (gilt nur innerhalb ihres Behälters).
- **Verwaltung**: eine Gruppe ist ein Block (Kopfzeile mit Bearbeiten/Löschen + eingerückte
  Felder), der sich wie ein Feld verschieben lässt; Ziehen/↑↓ jeweils innerhalb des
  Behälters (`commitLayoutOrder`). Die Zieh-Rechnung tauscht, sobald die in Zugrichtung
  vordere Kante (nach unten die Unterkante, nach oben die Oberkante) die Mitte eines
  Geschwisters überquert – mit der Mitte des gezogenen Elements blieb ein großer Block einen
  Platz vor dem Ende hängen. Eine gezogene Gruppe wird auf ihre Kopfzeile zusammengeklappt
  (`.manage-section--drag-collapsed`). Umhängen zwischen Gruppen bewusst nur über die
  Formulare (einfach und für Tastatur/Screenreader gleich gut; Ziehen zwischen Gruppen wäre
  ein möglicher späterer Zusatz).
- **Löschen** (zweistufig) löscht keine Felder: sie rücken an die Stelle der Gruppe;
  Notizen zur Gruppe werden mitgelöscht (Hinweis in der Bestätigung, falls es welche gibt).
- Ein **reaktiviertes Feld** kommt ans Ende seines Bereichs (`handleHabitArchive`) – sonst
  landete ein Feld aus einer inzwischen gelöschten Gruppe mit seiner alten Position
  irgendwo auf der obersten Ebene.
- **Anzeige überall** (Nutzer-Entscheidung): "Heute" und alle Auswertungs-Ansichten ordnen
  nach Gruppen (`renderBySection`, leere Gruppen ausgelassen), mit einklappbarer
  Überschrift (`section-toggle`, `aria-expanded`) und eingerücktem Inhalt
  (`.section-content`, bewusst ohne senkrechte Linie – wirkte überladen; im Wochen-Raster
  nur der Feldname eingerückt, sonst stünden die Kästchen nicht unter den Wochentagen).
  Eingeklappt-Zustand pro Gerät, getrennt für "Heute" und Auswertung (`localStorage`
  `sectionCollapsed:<today|stats>:<id>`). "Heute nicht geplant" bleibt ungegliedert. Ein
  Sprung zu einem Feld in einer eingeklappten Gruppe klappt sie auf.

## Feld-Formular: "Mehr Einstellungen" und Sichtbarkeit

**"Mehr Einstellungen"** (`<details class="habit-form-more">`): Ziel-Quote, Wiederholung,
eigene Erinnerungszeit, Gruppe und "In der Auswertung anzeigen" stehen eingeklappt unter
"Mehr Einstellungen – kannst du auch später ändern" (Formular war für Neulinge zu lang; das
Tutorial nutzt dasselbe Formular). Aufgeklappt, sobald dort etwas vom Standard abweicht;
offen/zu übersteht Re-Renders über `f.moreOpen`.

**"In der Auswertung anzeigen"** (`hideInStats` in der payload, standardmäßig an):
ausgeblendete Felder erscheinen nur in "Heute" (`inStats`). **Archivierte Felder** sind in
der Auswertung standardmäßig ausgeblendet (Nutzer-Entscheidung, Übersicht aufgeräumt),
lassen sich einzeln wieder einblenden (`archivedInStats`, Checkbox "In der Auswertung
anzeigen" an der archivierten Zeile, gespeichert über `updateHabitPayload`) und sind dann
sichtbar, solange sie im Zeitraum Daten haben – damit die Vorgeschichte eines abgelösten
Felds (Skala ändern = archivieren + neu anlegen) nicht verloren ist. Verworfen: archivierte
Felder ausnahmslos ausblenden. Wirkt nur auf die Anzeige – Tagesfarbe und berechnete
Felder rechnen unverändert mit (Nutzer-Entscheidung).

**Ziel-Quote** (`goal_threshold`, `scale` und `computed` aus Skalen): bei manchen Feldern
ist eine 100%-Quote unrealistisch (z.B. Kraftsport jeden Tag). Formular "Ab wann als voll
erreicht gilt (%)", Standard 100 = `null`. `applyGoal(habit, score)` staucht den Score auf
`min(1, score/threshold)` (bei Standard exakter Durchreicher). Nur für die Farbgebung
(`dayOverallScore`, Wochen-Grid inkl. Ø, `renderStatsRows`) – nie auf angezeigte
Prozentzahlen und bewusst **nicht** in `renderHabitOptions`/`renderHabitSlider` (in "Heute"
zählt der rohe Wert des Tages).

## Auswertung: Erklärungen

Ohne jeden Eintrag zeigen Woche/Monat/Jahr/Gesamt statt leerer Kästchen einen Satz, was hier
bald zu sehen ist (`renderStatsEmpty`); darunter dauerhaft, zugeklappt "Was bedeuten Farben
und Zahlen?" (`renderStatsLegend`: Farbleiste aus `scoreColor`, Ø/%, (N×), Tagesfarbe,
Schraffur, Streifenmuster). Bewusst klein – die Überarbeitung der Auswertung ist eigenes
Thema.

Sprünge aus der Auswertung zu einem Feld (Rückblick-Eintrag, Punkt im Zahlen-Graphen,
Feld-Zelle in der Woche; `data-focus-habit` an `open-day`) scrollen in "Heute" zum Feld,
heben es kurz hervor (`.field-highlight`, bei `prefers-reduced-motion` ohne Animation) und
fokussieren dessen ⋮-Button (`focusTodayField`).
