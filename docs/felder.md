# Felder, Gruppen und Auswertung

Begriffe: in der App heißt **"Gruppe"** eine (meist einklappbare) Überschrift, unter der Felder
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

**Neuer Typ oder neue Berechnungsart** → in `SUPPORTED_KINDS`/`SUPPORTED_AGGREGATES`
aufnehmen. Eine App-Version, die ihn nicht kennt (live, während er auf der Beta mit derselben
Datenbank schon angelegt werden kann), lässt solche Felder ganz weg (`isSupportedHabit`,
`state.unsupportedHabits` nur für `filledFieldIds`), statt sie halb kaputt anzuzeigen oder über
ein unpassendes Formular zu überschreiben.

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
(`renderHabitSlider`). Beim Anlegen gibt es eine Stufenzahl (gespeichert als
`min`/`max=min+Stufenzahl-1`), keine freie Von/Bis-Spanne. Der Regler zeigt **nie** eine
Min/Max-Beschriftung; `slider_show_value` steuert nur, ob der gewählte Wert sichtbar ist.

Live-Vorschau (Wert + Farbe) beim Ziehen über einen `input`-Listener ohne Re-Render;
gespeichert erst beim Loslassen über `handleSetValue` (setzt immer – anders als das
Umschalten von `handleSelect` bei Buttons, wo derselbe Wert den Eintrag wieder entfernt;
beim Regler entfernt das ×). Zwei Wege dorthin: `change`, plus ein eigener
`pointerup`-Listener – ein leerer Regler steht schon mittig; zog man ihn und ließ ihn genau
dort los, feuerte kein `change`, er sah eingetragen aus, war aber nicht gespeichert.

**Bezeichnungen (`labels`) sind kein eigener Modus, sondern ein optionaler Text-Overlay über
denselben Stufen** (zwei sich ausschließende Formular-Modi verworfen, weil die DB nie
zwischen ihnen unterschied). **Neue bzw. unbefüllte Skala-Felder starten bei `min=1`**,
Zahlenskalen ohne eigene Bezeichnungen wahlweise bei 0 (Auswahl "Zahlen: 1 bis 5 | 0 bis 4",
Nutzer-Entscheidung 2026-10-11 – Schmerz-/Stressskalen werden üblicherweise 0 bis 10
abgefragt). Ein frei wählbarer Startwert (auch negativ) wurde am 2026-09-18 bewusst
abgeschafft; Felder mit Daten aus der Zeit davor behalten ihren Startwert (eine Übersetzung
auf 1 mit den alten Zahlen als Bezeichnungen wurde verworfen: alle Einträge umzuschreiben
wäre ein Datenrisiko für drei Zeilen Sonderfall, und über 7 Stufen gibt es keine Bezeichnungen).

Formular (`scaleBody` in `renderHabitForm`), in dieser Reihenfolge: Darstellung →
**eine** "Anzahl Stufen"-Eingabe → Checkbox "Eigene Bezeichnungen verwenden" → ohne
Bezeichnungen "Zahlen" (Start 1 oder 0; steht danach, weil Bezeichnungen die Frage
erübrigen), mit Bezeichnungen nur
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

**In "Heute"** rutschen die Buttons in eine eigene Zeile unter den Namen, sobald Name (mind.
40 %) und Buttons nicht nebeneinander passen, und brechen dort bei Bedarf weiter um
(`.habit-row--buttons`, reines CSS über `flex-wrap`); die Vorschau im Formular genauso.
Verworfen: seitlich wischbar (sah niemand – bei langen Bezeichnungen waren Stufen einfach
weg, Nutzer-Entscheidung 2026-10-14).

### Bearbeiten mit vorhandenen Daten (`f.locked`)

Im Formular selbst ist die Stufenzahl fest; sie ändert nur "Stufen ändern" (unten). Ein
bestehendes `min` ungleich 1 (alte Felder mit Basis 0) bleibt auch dabei unangetastet; "immer
Basis 1" gilt nur für neue Felder. Darstellung, Bezeichnungen-Checkbox und Bezeichnungs-Text
bleiben änderbar (ändern nur die Beschriftung, nie Zahl/Position). Ausnahme:
`lockedChoiceBlocked` (siehe oben). Was rückwirkend umdeutet, sagt ein Hinweis: neue
Bezeichnungen (`habitForm.labelsLockedWarn`) und eine geänderte Bewertung
(`habitForm.goodChangedWarn`, färbt alle alten Einträge um).

### Stufen ändern (`renderStepDialog`, `startStepChange`)

Eigener Dialog über dem Formular (Nutzer-Entscheidung 2026-10-29: ein eigener Mechanismus,
der sich vom übrigen Formular abheben soll; ein Kasten im Formular ging darin unter), in
drei Stufen: Einstellen → "Wirklich umstellen?" als eigener Bildschirm → Fortschritt, danach
zu. Rückgängig ebenfalls als Dialog. Im Formular selbst (`stepEditHtml`) nur Stufenzahl und
die Knöpfe. Escape/Android-Zurück = Abbrechen bzw. "Zurück"; mit Eingaben im Dialog erst
"Änderungen verwerfen?" (`closeStepDialog`), während des Umstellens wirkungslos.

Nutzer-Entscheidung 2026-10-29: die Verantwortung liegt beim Nutzer – er legt je alte Stufe
fest, auf welche neue sie wandert oder ob ihre Einträge entfernt werden, mit klarer
Zusammenfassung (geändert / entfernt / zusammengelegt) und Rückfrage. Zwei Vorschläge:
"Gleichmäßig verteilen" (Enden bleiben Enden, dazwischen anteilig gerundet) und "Zahlen
beibehalten" (über der neuen Spanne auf die höchste). Bezeichnungen wandern mit derselben
Rechnung mit, neue Stufen bleiben leer und müssen beschriftet werden. Die Zuordnung zeigt nur
Stufen mit Einträgen. Grenzen wie beim Anlegen (`stepEditCap`).

- **Sicherung im Tages-Eintrag** (`_prev`, siehe [datenmodell.md](datenmodell.md)), nicht als
  archiviertes Zweitfeld: archivierte Felder rechnen in die Tagesfarbe mit
  (`dayOverallScore`), alte Tage zählten doppelt.
- **Ablauf** über `stepChange` in der verschlüsselten Definition: `state: 'apply'` setzen →
  Tage umschreiben (Wert + Sicherung in einem `saveDay`, bis zu 6 parallel, Fortschritt
  `#step-change-progress`) → Definition auf die neue Spanne, `state: 'done'`. Welche Tage fertig
  sind, steht in den Tagen selbst (`_prev.c`); ein Abbruch läuft beim nächsten Laden weiter
  (`resumeStepChanges`) oder per "Weiter umstellen". Ein nicht gespeicherter Tag bekommt
  lokal seinen alten Stand zurück, sonst hielte der nächste Lauf ihn für fertig.
- **Rückgängig** (`stepChangeUndoable`) nur, solange jeder Tag noch genau den umgerechneten
  Wert trägt und kein Tag ohne Sicherung einen Wert hat – sonst holte die Sicherung einen
  alten Wert über einen neuen zurück. Läuft als `state: 'undo'` genauso fortsetzbar.
- Weiter nur über archivieren und neu anlegen: "Wie oft" (Tageswerte lassen sich nicht
  sinnvoll zu Wochenwerten zusammenlegen und umgekehrt) und Text in einen anderen Typ (aus
  freiem Text lässt sich kein Wert ableiten).

### Typ ändern (`typeEditHtml`, `renderTypeDialog`)

Nutzer-Entscheidung 2026-10-29: Skala → Zahl, Zahl/Zähler → Skala, Skala/Zahl/Zähler → Text,
mit demselben Ablauf, Dialog, Sicherung, Fortsetzen und Rückgängig wie "Stufen ändern"
(`stepChange` mit `kind` in `from`/`to`; `isTypeChange` unterscheidet). `to` enthält alle
typabhängigen Eigenschaften (`TYPE_CHANGE_KEYS`), `from` dieselben von vorher – Rückgängig
stellt so auch Bezeichnungen, Bewertung, Ziel, Einheit, Schritt und `counterSince` wieder
her. `updateHabitPayload` schreibt die Klartext-Spalte `kind` mit, wenn sie wechselt.

- **Zuordnung je alter Wert** (bis `TYPE_MAP_ROWS_MAX` = 20 verschiedene; darüber nur die
  Regel): zu Zahl ein Eingabefeld (Vorschlag: bisherige Zahl), zu Text ein Eingabefeld
  (Vorschlag: so wie bisher angezeigt, `valueAsText`), zu Skala eine Auswahl mit den
  Vorschlägen "Runden" (gerundet, in die Spanne geholt; Werte unter 1 → Skala ab 0) und
  "Gleichmäßig verteilen" (kleinster bis größter eingetragener Wert, `range` im `stepChange`).
  Leer bzw. "Entfernen" = Einträge entfernen. Werte ohne Zeile (auch inzwischen anderswo
  eingetragene) laufen über `stepChangeConvert`.
- **Was wegfällt**, nennt die Zusammenfassung: Bezeichnungen/Bewertung (→ Zahl), Einheit/Ziel
  (→ Skala; die Bewertung übernimmt die Richtung des alten Ziels), Tagesfarbe/Durchschnitte
  (→ Text), "leer = 0" und "falls weniger als" (aus Zähler), Notizen werden bei Text nicht
  angezeigt (bleiben gespeichert). Zähler als Ziel gibt es hier nicht – dafür bleibt "In
  Zähler umwandeln" (`convertHabitToCounter`, ohne Rückgängig).
- **Gesperrt**, solange das Feld in einem berechneten Feld steckt (`typeChangeBlocker`, auch
  archivierte): das berechnete Feld verlangt Skalen bzw. Zahlen. Öffnen nur ohne andere
  ungespeicherte Änderungen im Formular, weil es danach aus dem Feld neu aufgebaut wird
  (`finishStepChangeAction` mit `typeChange`).

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
  In "Heute" zusätzlich als leicht getönter Block (2026-10-10, aus Vergleichsbildern
  gewählt; verworfen: Doppellinie am Gruppenende, Tönung nur des Inhalts).
  Eingeklappt-Zustand pro Gerät, getrennt für "Heute" und Auswertung (`localStorage`
  `sectionCollapsed:<today|stats>:<id>`). "Heute nicht geplant" bleibt ungegliedert. Ein
  Sprung zu einem Feld in einer eingeklappten Gruppe klappt sie auf.
- **Einklappen in "Heute"** pro Gruppe (Nutzer-Entscheidung 2026-10-10, eine Auswahl statt
  mehrerer Schalter; `collapse` verschlüsselt mit dem Namen in `habit_sections.enc`, ohne
  Wert = `'done'`): `'done'` (Standard) Zuklappen, wenn alles eingetragen ist; `'manual'` nur von Hand; `'start'` startet eingeklappt;
  `'never'` reine Überschrift ohne Knopf (auch in der Auswertung). Automatisch zugeklappt
  wird **nur beim Betreten des Tages** (`todayAutoCollapse`, neu bestimmt bei Tag- oder
  Ansichtswechsel, Neuladen und nach `refreshAfterReturn`), nie während man einträgt – sonst
  verschwände eine Gruppe, wenn man den letzten Wert kurz danach nochmal ändert (dasselbe
  Problem wie beim verworfenen Einklappen eingetragener Felder, siehe
  docs/design-bedienung.md). Von Hand Aufklappen hebt das automatische Zuklappen für diesen
  Besuch auf (`expandSection`).
- **"✓ erledigt"** steht in "Heute" in jeder Gruppen-Überschrift, sobald alle Felder der
  Gruppe eingetragen sind – auch aufgeklappt und unabhängig von der Einklapp-Einstellung
  (umgeschaltet auch ohne Neuzeichnen in `syncTodayOpenMarkers`).
- **Tipp zum Gruppieren**: einmalig in "Felder verwalten" ab 6 aktiven Feldern ohne Gruppe
  (`GROUP_TIP_MIN_FIELDS`, ausblendbar, `localStorage` `groupTipDismissed`), dazu
  `about.tip.sections`.

## Feld-Formular: Aufbau und Sichtbarkeit

**Abschnitte nach Thema** (`part()` in `renderHabitForm`, Nutzer-Entscheidung 2026-10-12):
**Was?** (Name, Feld-Typ) · **Wie trägst du ein?** (je Typ, mit Vorschau; Bewertung gehört
hierher, weil sie auch die Farben in "Heute" bestimmt) · **Wann?** (Einmal pro Tag/Woche/
Monat/Jahr, Wochentage, Erinnerungszeit) · **Auswertung** (Ziel, Durchschnitt/Summe, "In der
Auswertung anzeigen") · **Gruppe**. Leere Abschnitte entfallen. Vorher standen rund 15
Einstellungen gleichförmig untereinander, getrennt nur in wichtig / "Mehr Einstellungen" –
unübersichtlich. Im Tutorial liegen Wann/Auswertung/Gruppe weiter zugeklappt unter "Mehr
Einstellungen" (`habit-form-more`, offen, sobald dort etwas vom Standard abweicht, `f.moreOpen`).

**Auswahlformen**: genau eine von 2–4 Optionen = Segment-Schalter (`.pill-group.seg`, bei
langen Texten untereinander `.seg--stack`, auch in den Einstellungen); Mehrfachauswahl
(Wochentage) bleibt runde Pillen – die Form zeigt so "eins" gegenüber "mehrere". Feld-Typ als
Karten mit einem Satz Erklärung (`kind-cards`). Lange Listen (Gruppe) als Auswahlliste. Reiter
(Tabs) verworfen: bedeuten auf dem Handy "andere Ansicht", nicht "Einstellung wählen".
Eintippen/Hochzählen zeigt eine Vorschau der Zeile in "Heute" (nur Bild).

**"In der Auswertung anzeigen"** (`hideInStats` in der payload, standardmäßig an):
ausgeblendete Felder erscheinen nur in "Heute" (`inStats`). **Archivierte Felder** sind in
der Auswertung standardmäßig ausgeblendet (Nutzer-Entscheidung, Übersicht aufgeräumt),
lassen sich einzeln wieder einblenden (`archivedInStats`, Checkbox "In der Auswertung
anzeigen" an der archivierten Zeile, gespeichert über `updateHabitPayload`) und sind dann
sichtbar, solange sie im Zeitraum Daten haben – damit die Vorgeschichte eines abgelösten
Felds (z. B. nach archivieren + neu anlegen) nicht verloren ist. Verworfen: archivierte
Felder ausnahmslos ausblenden. Wirkt nur auf die Anzeige – Tagesfarbe und berechnete
Felder rechnen unverändert mit (Nutzer-Entscheidung).

**Ziel-Quote** (`goal_threshold`, `scale` und `computed` aus Skalen): `applyGoal(habit, score)`
staucht den Score auf `min(1, score/threshold)` (ohne Ziel = `null` = exakter Durchreicher).
Nur für die Farbgebung (`dayOverallScore`, Wochen-Grid inkl. Ø, `renderStatsRows`) und bewusst
**nicht** in "Heute" (dort zählt der rohe Wert des Tages). Eingabe je Feldart in natürlichen
Begriffen (`goalControlHtml`, Nutzer-Entscheidung 2026-10-10): zwei Stufen "an [n] von 7
Tagen", mehrstufige Skala **stufenlos** per Regler in Zehnteln "ab Ø 4,3" / "bis Ø 1,6", bei
eigenen Bezeichnungen darunter "zwischen „gut“ (4) und „sehr gut“ (5)" (2026-10-11 – das Ziel
wirkt vor allem auf Durchschnitte, die zwischen den Stufen liegen; verworfen: nur ganze, dann
halbe Stufen), berechnete Felder weiter in %. Gespeichert als
**genauer Bruch** (n/7), nicht als ganze Prozentzahl – 2/7 als 29 % hätte genau 2 von 7 Tagen
knapp verfehlt. Keine Option heißt "Standard" (könnte Druck machen).

**Ø in der Auswertung** je Feldart statt Prozent für alle (`habitAvgShort`/`habitAvgLong`):
zwei Stufen "an 2 von 5 Tagen „Ja“" bzw. "2/5", mehrstufige Skala Mini-Skala + "Ø 3,4 von 5"
(ältere Felder mit anderem Startwert, vor 2026-09-18 angelegt: "Ø 4,2 (0 bis 10)"), mit eigenen Bezeichnungen Mini-Skala +
"Ø 1,4 · keine (1) – leicht (2)" (Zahlen wie im Formular vor den Bezeichnungen, damit die
Zahl zuzuordnen ist); berechnete Felder in %. Gezählt
werden für alle Felder gleich nur die eingetragenen Tage (verworfen: "leer = Nein" nur für
zwei Stufen – gleich aussehende Felder hätten unsichtbar verschieden gerechnet). "Zwei
Stufen" ist eine Skala mit genau zwei Werten und Bewertung, unabhängig von den Bezeichnungen.
In der schmalen Ø-Spalte der Woche zeigen alle Skalen ab drei Stufen nur die Mini-Skala
(`avgMiniScale`, Punkt in Feldrichtung: links der erste Wert wie die Knöpfe in "Heute", gut/
schlecht zeigt die Farbe); die Ø-Zelle ist ein Knopf, Antippen zeigt den Wert ausgeschrieben
als Meldung. Verworfen: Zahl allein (verrät nicht, wie viele Stufen), gerundete Bezeichnung
(lange passen nicht), zweizeilig (Schrift unter 13 px), "rechts = besser" (bei "Niedrige Werte
erstrebenswert" verwirrend).

## Zähler (`kind = 'counter'`) und Ziel für Zahlen

Eine Zahl, die man im Lauf des Tages (bzw. Zeitraums) per "+" hochzählt (Zigaretten, Gläser
Wasser); jeder neue Tag/Zeitraum beginnt bei 0 (Nutzer-Entscheidung 2026-10-11). **Für
Nutzer kein eigener Typ**: im Formular "Zahl" mit "Wie trägst du ein? Eintippen / Hochzählen
(+)"; **intern eigener `kind`**, weil `get_due_notifications` nur den Klartext-Typ sieht und
Zähler nie als "fehlend" erinnern darf (verworfen: Zähler als eigener Typ in der Auswahl –
der Nutzer fand die Trennung Zahl/Zähler nicht gelungen).

**Ziel für Zahlen und Zähler** (optional, Abschnitt Auswertung): keins / mindestens X /
höchstens X (`good` 'high'/'low' + `target` in `enc`). Mit Ziel gelten sie als bewertet
(`hasNumberGoal` in `isScoredKind`): Tagesscore `numberGoalScore` (mindestens: Wert/Ziel;
höchstens: bis zum Ziel 1, darüber linear bis 0 beim Doppelten), damit eigene Zeile im
Wochenraster, Ø-Spalte = **Durchschnitt** ("6,2", gefärbt nach Zielnähe; verworfen: "4/7" –
sah wie ein Wert aus), Langform "Ø 6,2 · Ziel an 4 von 7 Tagen erreicht", Tagesfarbe,
gestrichelte Ziellinie im Verlauf. In "Heute" steht das Ziel als "/ 8" hinter dem Wert, der Wert gefärbt nach
Zielnähe (`goalValueStyle`, auch schon bei 0; ohne "max"/Haken – Nutzer-Entscheidung 2026-10-14). Ohne Ziel neutraler Verlauf wie
bisher – nicht jede Zahl braucht eins. **Ohne Antippen = 0** – in "Heute" sichtbar
als 0, nie "offen", zählt nicht für "alles eingetragen"; in der Auswertung zählt ein leerer
Tag ab dem Anlegen (`created_at`) bis **gestern** als 0 – der laufende Tag erst, wenn getippt
wurde (sonst wäre "mindestens 8" morgens rot) (`habitNumericValue`/`counterZeroApplies`),
Verläufe lückenlos über alle Tage (`counterDayKeys` – Jahr/Gesamt übergeben sonst nur Tage mit
Eintrag). "−" daneben zum Korrigieren statt Rückgängig-Meldung; Schritt pro Tippen einstellbar
(`step` in `enc`, Standard 1); Erinnerungen nur als Tagesfeld (siehe
[erinnerungen.md](erinnerungen.md) → Zähler); nicht im Tutorial. Auf 0
heruntergezählt wird der Schlüssel entfernt (gilt ohnehin als 0).

**Umwandeln in einen Zähler** (nur auf Wunsch, mit Rückfrage, in "Feld bearbeiten" unter dem
gesperrten Typ): Zahlenfelder und Skalen, die bei 0 beginnen (frühere "Anzahl"-Skalen).
Einträge bleiben unverändert (schon Zahlen), nur die Definition wird ein Zähler; "leer = 0"
gilt erst ab dem Tag der Umwandlung (`counterSince` in `enc`) – frühere leere Tage waren evtl.
vergessen, nicht 0. Skalen verlieren die Bezeichnungen; ihre Bewertung wird zum Ziel (hohe
Werte gut + Ziel-Quote → "mindestens" der Wert, ab dem sie voll erreicht war). Kein
Zurückwandeln.

**Durchschnitt oder Summe** (`summary` in `enc`, `'avg'` Standard, Zahlen, Zähler und
berechnete Felder aus Zahlen; Abschnitt Auswertung, bewusst nicht versteckt): die Verlaufszeile
in Woche/Monat/Jahr/Gesamt zeigt "1 h zuletzt · Ø 2,3 h" bzw. "Summe 16 h · Ø 2,3 h pro Tag"
(Summe immer mit Schnitt – "beides" ohne dritte Option; Nutzer-Entscheidung 2026-10-12).
Standard überall Durchschnitt, auch beim Hochzählen. Die Ø-Spalte im Wochenraster (Felder mit
Ziel) bleibt immer der Durchschnitt – das Ziel gilt pro Tag, sonst passten Zahl und Farbe
nicht zusammen.

## Zeitraum-Felder (Woche/Monat/Jahr)

Datenmodell und Erinnerung: [datenmodell.md](datenmodell.md) → Zeitraum-Felder. Im Formular
"Wie oft trägst du das ein?" (Täglich/Wöchentlich/Monatlich/Jährlich) nach dem Feld-Typ –
nicht im Tutorial, nicht bei "Berechnet", mit Daten gesperrt; bei Zeitraum-Feldern steht
"Erinnerung am" (`periodReminderControl`) statt der Wochentage, und es gibt keine Gruppe. Ziel bei zwei Stufen "in [n] von 4 Wochen / 12 Monaten / 5 Jahren". Alle Speicher-
und Notiz-Wege laufen über `entryKeyFor` (erster Tag des Zeitraums). In "Heute" unten je
Zeitraum ein Bereich (`renderPeriodBlock`, Optik wie eine Gruppe, von Hand einklappbar,
`sectionCollapsed:today:period-<p>`), nur wenn es solche Felder gibt; zählt nicht für "alles
eingetragen" und nicht in der Tagesfarbe; berechnete Felder nehmen nur Tagesfelder auf.

Auswertung (`renderPeriodStats`): aus den Tagesfeld-Listen heraus (`inStats`), stattdessen je
Zeitraum ein Block "Wöchentliche/Monatliche/Jährliche Felder" **ganz unten** (dazwischen
zerrissen sie die Tagesfeld-Ansicht). Woche zeigt Wochenfelder, Monat zusätzlich
Monatsfelder, Jahr/Gesamt alle. Gerechnet mit denselben Bausteinen wie Tagesfelder, nur über
die ersten Tage der Zeiträume, die in der Ansicht beginnen (`periodAnchors`): zwei Stufen
"in 3 von 4 Wochen „Ja“", Skala Mini-Skala + Ø, Zahlen als Verlauf (ein Punkt je Zeitraum),
Text als Rückblick mit Zeitraum statt Datum. Umfasst die Ansicht genau einen Zeitraum, steht
nur dessen Wert da. "Tage mit Eintrag" in Gesamt zählt nur Tage mit Tagesfeld-Werten
(`dayHasDayValues`).

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
