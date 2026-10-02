# Design und Bedienung

## Ästhetik und Tokens

Ledger/Logbuch-Ästhetik: Parchment-Hintergrund (`--paper`), warmes Schwarz (`--ink`),
Fraunces (Serif, kursiv für Überschriften) + IBM Plex Sans. Farb-Tokens als CSS-Variablen im
`<style>`-Block von `logbuch.html`. Bei Erweiterungen an diesem Stil festhalten, nicht auf
generische Tailwind-/Card-Optik wechseln.

**Symbole**: Menüpunkte, Seitenköpfe der Unterseiten, "+ Neues Feld"/"Neue Gruppe",
Abschnitte in Einstellungen und "Über Logbuch" tragen ein Symbol – alle zentral in `ICONS` +
`icon(name)` (dekorativ, `aria-hidden`). Vorerst Emojis; Nutzer tendiert zu eigenen,
gezeichneten Symbolen (Gestaltungs-Durchgang) – dann nur `ICONS` austauschen. Bewusst ohne
Symbol: Tabs, einzelne Felder, Wert-Knöpfe (wirkte überladen).

**Dark Mode**: folgt standardmäßig `prefers-color-scheme`, in den Einstellungen
überschreibbar (System/Hell/Dunkel als Pill-Toggle). Override in `localStorage`
(`themeOverride`: `'light'`/`'dark'`/nicht gesetzt) – bewusst NICHT in `user_settings`, da
geräte-lokal statt kontoweit gedacht (anders als die Sprache). `applyTheme()`/
`getThemeOverride()`/`setThemeOverride()`. CSS: `@media (prefers-color-scheme: dark)` UND
`:root[data-theme="dark"]` setzen dieselben Werte für dieselben Tokens (`--paper`, `--ink`,
`--line`, `--moss`, `--rust`, `--sand`, `--surface`, `--input-bg`, `--shadow`, `--scrim`,
`--rust-rgb`/`--moss-rgb` für `rgba()`-Tönungen, `--on-score`). `<meta
name="theme-color">` wird per JS synchronisiert (`syncThemeColorMeta`), da Meta-Tags keine
CSS-Variablen lesen können.

**Kontrast, Projektwerte**: `--sand` (Nebentext) ist im hellen Modus `#6b6354` (~4,8:1 auf
`--paper`), im dunklen ~6,5:1. Knopf-Rahmen in `--sand`, nicht `--line` (zu blass). Text auf
Score-Farben (gewählte Buttons, berechnete Felder in "Heute", Ø-Zellen) wählt
`textOnScore()` je Farbe: reines Weiß oder Schwarz, je nachdem was mehr Kontrast hat – nur
so erreicht jede Stufe der Skala 4,5:1 (fester heller Text lag auf hellen Stufen bei ~3:1).
`scoreColor()` selbst bleibt theme-unabhängig.

**Textgröße** (`getTextSize`/`setTextSize`/`applyTextSize`): alle Schriftgrößen im CSS in
`rem` (Fließtext 15–16px, kaum etwas unter 13px, nur in den engen Kalender-Rastern 12px),
ebenso Maße von Bedienelementen mit Text (Wert-Buttons, runde Knöpfe, Raster-Spalten,
`#app`-Breite 30rem). In den Einstellungen "Textgröße" Klein/Normal/Groß/Sehr groß setzt
`data-text-size` auf `<html>` (87,5/100/112,5/125 %; "Klein" für alle, die lieber mehr auf
einmal sehen), pro Gerät per `localStorage` `textSize`. Grund: Zwei-Finger-Zoom vergrößert
wie eine Lupe (seitlich schieben), und in der installierten App fehlt die Browser-Leiste mit
ihrer Schriftgrößen-Einstellung.

**Knöpfe, Projektwerte**: Hauptaktion ausgefüllt, Nebenaktionen umrandet (`.auth-toggle`,
`.onb-nav-btn`, `.today-jump`, `.push-toggle`, `.tip-link`); unterstrichen (`.link-btn`) nur
mitten im Fließtext. Anlass war ein Onboarding-Test mit einer wenig handy-erfahrenen Person,
die unterstrichenen Text nicht als antippbar erkannte. Kleine Symbol-Knöpfe (‹ ›, ☰, ←, ⋮,
+/−, ↑↓, ×, kleine Knöpfe der Verwaltung) bleiben optisch kompakt, ein unsichtbares
`::after` vergrößert die Fläche auf mind. 2.75rem. Wert-Buttons sichtbar 2rem mit 0.5rem
Abstand, Tippfläche bis in die halbe Lücke (~40px, ohne Überlappung).

## Navigation

**Tab-Leiste** zeigt nur die Auswertungs-Ansichten (Heute/Woche/Monat/Jahr/Gesamt; `.tabs`
horizontal scrollbar für künftige Views).

**Menü** (Knopf "☰ Menü" oben rechts – mit Wort, nicht jede Person erkennt die drei
Striche; `renderMenu`) enthält nur Ziele: "Felder verwalten", "Einstellungen", "Über
Logbuch", "Feedback geben". `.menu-panel` hebt sich über einen kräftigen Rand (`var(--ink)`)
und `--popover-bg` ab (`--surface` ist im Hellmodus identisch mit `--paper`, reicht für ein
freischwebendes Popover nicht). Scrollen neben dem offenen Menü schließt es
(`scroll`-Listener am `window`, direkt nach `syncLayerHistory()`).

**Einstellungen** (`renderSettings`) in drei einklappbaren Abschnitten (bei jedem Öffnen
zugeklappt, `settingsSectionStart`; mit Symbol): Erinnerungen (an/aus,
Standard-Erinnerungszeit, Wochen-/Monatsübersicht), Anzeige (Textgröße, Hell/Dunkel,
Sprache, Streifenmuster, Vibration), Konto (Export, Ersatzschlüssel, Abmelden, Konto
löschen). Erklärungen stehen direkt unter der Einstellung statt hinter einem "?". Grund für
die eigene Seite: im schmalen Menü-Popover musste alles in sich scrollen (klappte nicht
zuverlässig) und es gab keinen Platz für Erklärungen.

**Unterseiten statt Tab-Swap**: "Felder verwalten", "Über Logbuch", "Feedback geben" und
"Einstellungen" sind `state.view`-Werte, aber keine Tabs. Betreten über `enterSubpage(view)`
(merkt sich in `state.previousTabView`, von welchem Tab man kam, außer beim direkten Wechsel
zwischen zwei Unterseiten übers Menü); sie ersetzen Header **und** Tab-Leiste durch
`renderSubpageHeader()` (← Zurück + Titel + ☰). `isSubpageView(view)` steuert die
Verzweigung in `renderApp()`. ← und Android-/Browser-Zurück führen zu `previousTabView`,
nie hart zu "Heute". Beim Betreten bzw. Wechsel der Ebene (Liste ↔ Feld-Formular) wird das
`<h1>` fokussiert (`tabindex="-1"`) – bewusst nur dann (`lastFocusedSubpageLevel`), nicht
bei jedem `render()`, sonst warf jede Umschaltung im Formular den Fokus nach oben. Header
(+ Tab-Leiste) sind über `.sticky-top` angepinnt (außer bei wenig Höhe, siehe unten).

**"Über Logbuch"**: alle aufklappbaren Abschnitte sind bei **jedem** Öffnen zugeklappt
(Nutzer-Wunsch, `openAboutSections`, von `enterSubpage` zurückgesetzt) – kein dauerhaftes
Merken. Tipps, die auf eine Stelle in der App verweisen, haben darunter einen Link dorthin
(`renderTip` mit drittem Element `{ menu: '<ziel>' }` bzw. `{ manage: true }`): "In den
Einstellungen zeigen" öffnet die Einstellungen, scrollt zur Einstellung
(`data-menu-target`), hebt sie hervor und fokussiert sie (`focusSettingsTarget`). Bewusst
nur diese Richtung – keine Sprünge zwischen Tipps, keine Links von der App in die
Erklärungen (Nutzer-Entscheidung). Oben steht "Beta – Stand …" aus `APP_STATUS_DATE`.

**History-Ebenen** (`isOverlayOpen()`/`isSubpageView()`/`currentLayerCount()`/
`closeTopLayer()`/`syncLayerHistory()`): ohne eigene History-Einträge verließ die
Android-Zurück-Taste sofort die App. Overlay (Menü, Formular, Bestätigungen) und Unterseite
können gleichzeitig offen sein, deshalb zählt `currentLayerCount()` 0–2, mit je einem
`history.pushState()` pro Ebene, synchron gehalten mit `render()` (auch wenn eine Ebene über
die App geschlossen wird, sonst blieben tote Einträge). `syncLayerHistory()` gleicht um die
volle Differenz ab: öffnen sich zwei Ebenen auf einmal ("+ Neues Feld" in "Heute"), entsteht
ein `pushState` pro Ebene; schließen sich mehrere, geht es per `history.go(-Differenz)`
zurück (mit nur einem Schritt blieb ein toter Eintrag stehen bzw. ging das Schließen einen
Schritt zu weit). **Falle**: ein selbst ausgelöstes `history.go()` feuert asynchron ein
`popstate`, das sonst als echter Zurück-Druck eine weitere Ebene schließen würde –
`closingLayerViaPopstate` wird davor gesetzt, und der Listener konsumiert dieses Event ohne
Aktion. Schließt ein echter Zurück-Druck mehr als eine Ebene, räumt das folgende `render()`
den übrigen Eintrag weg. Bewusst nur für Overlays/Unterseiten, nicht für Tab-Wechsel
(übliches Verhalten von Android-Apps mit Tab-Leiste). `state.recoveryKeyToShow` ist
ausgenommen (absichtlich nur über die Bestätigung schließbar, auch Escape greift nicht).
**Verlassen der Verwaltung schließt deren Overlays** (`leaveSubpage`/
`closeManageOverlays`) – sonst bliebe ein Feld-Formular unsichtbar im State und zählte
weiter als Ebene.

**Wischen**: `SWIPE_THRESHOLD_SUBPAGE` (100px) ist höher als der Schwellenwert für
Tab-Ansichten (50px) – ein Wisch nach rechts verlässt eine Unterseite komplett, versehentlich
ausgelöst (z.B. beim Scrollen einer langen Feldliste) stört das spürbar mehr als ein
Zeitraum-Wechsel.

**Zeitraum-Wechsel** (Wischen und ‹ › über `shiftPeriod(dir)`): der Inhalt (`.view-body`,
bewusst nicht die fixierten Dialoge) gleitet in ~0,2 s aus der Wischrichtung herein
(`.view-slide-next`/`-prev`), bei "Bewegung reduzieren" nur Einblenden – in "Heute" sehen
zwei Tage oft fast gleich aus. In "Heute" steht "Heute"/"Gestern"/"Morgen" neben dem Datum
(`relativeDay`), Screenreader bekommen den neuen Zeitraum über `#sr-announcer`
(`announce()`, liegt außerhalb von `#app` und übersteht jedes `render()`), der Fokus bleibt
nach einem Pfeil-Klick auf dem Pfeil. In den Gestaltungs-Durchgang geschoben: Inhalt folgt
beim Wischen dem Finger (aufwendig wegen Abgrenzung zum senkrechten Scrollen und Neuaufbau
bei jedem `render()`).

## Verwaltung und Feld-Formular

**Feld-Formular als eigene Ebene der Verwaltung**: solange `state.habitForm` offen ist,
zeigt `renderManage` NUR das Formular; der Titel (`habitFormTitleKey`) steht im Seitenkopf
(im Tutorial als `<h2>` im Formular, `renderHabitForm({ titleInHeader })`). ← und Wischen
führen zur Liste (`subpageBack`) bzw. zum Tab bei `returnToTab`. Geöffnet immer über
`openHabitForm` (merkt sich die Scroll-Position; fokussiert nur beim Neuanlegen das
Namensfeld – beim Bearbeiten will man meist etwas anderes ändern), `closeHabitForm` stellt
sie wieder her (`pendingScrollRestore`, am Ende von `render()` eingelöst).

**"+ Neues Feld" in "Heute"**: umrandeter Button in der Fußleiste (bewusst nicht ausgefüllt
– "Heute" ist die Eintrags-Ansicht, nicht die Verwaltung). Öffnet die Verwaltung mit offenem
"Neues Feld"-Formular; `returnToTab: true` lässt `closeHabitForm()` (Speichern, Abbrechen,
Zurück) direkt zum Tab zurückspringen – die Absicht ist "jetzt tracken", nicht "verwalten".

**Verwaltungsliste** (`renderManage`): pro Feld nur der Name plus – falls abweichend –
Wiederholung, eigene Erinnerungszeit und "in der Auswertung ausgeblendet"
(`manageFieldMeta`); Skala, Bezeichnungen, Richtung und Ziel-Quote bewusst nicht (der Nutzer
kennt die Bedeutung seiner Felder, eine Zusammenfassung ist redundant). Berechnete Felder
zeigen ihre Mitglieder ("Ø aus: …"/"Summe aus: …") mit "Berechnet"-Kennzeichen – die einzige
Stelle, an der das sichtbar wird. Alle Felder in EINER frei sortierbaren Liste, dazwischen
Gruppen als Blöcke ([felder.md](felder.md) → Gruppen); "+ Neues Feld" (ausgefüllt) und "+
Neue Gruppe" (umrandet) nebeneinander oben (`.manage-new-row`). "Archivieren" hat eine
dezent rost-getönte Klasse (`.manage-btn--warn`, heller als `.manage-btn--danger` bei
"Löschen") – reversibel, aber ein Entfernen aus der Tageseingabe, daher nicht neutral.
Umsortieren per Hoch/Runter-Buttons als Tastatur-Alternative (`commitLayoutOrder()`,
gemeinsamer Pfad mit dem Pointer-Drag). Beim Ziehen scrollt die Liste am Bildschirmrand von
selbst (`updateDragAutoScroll`, schneller je näher am Rand).

## "Heute"

**Einmalige Erklär-Karte(n)**: siehe [onboarding.md](onboarding.md).

**"Noch offen"** (`isOpenToday`/`openMarkerHtml`/`todayAllDone`): ein kleiner Punkt
(`.open-dot`, Moos, Form statt Farbe) hinter dem Namen jedes heute geplanten, direkt
ausfüllbaren Felds ohne Wert – dieselbe Logik wie die Erinnerungen, Notizen zählen nicht; im
Bereich "Heute nicht geplant" keiner. Bei eingeklappten Gruppen trägt die Überschrift den
Punkt. Screenreader: "(noch offen)" als versteckter Text. Ist alles eingetragen, steht still
"Alles eingetragen für heute/diesen Tag" (`.today-complete`). Text-Felder speichern ohne
`render()`, deshalb zieht `syncTodayOpenMarkers` Punkt und Hinweis dort nach.
Nutzer-Entscheidung: markiert wird nur das Offene; **bewusst kein Zähler** ("5 von 8" würde
eher Druck machen, wie die verworfene Mindestquote bei den Übersichten). Verworfen:
eingetragene Felder nach unten schieben/einklappen (Zeilen sprängen beim Antippen weg);
eingetragene Namen blasser (zu wenig Kontrast für kleinen Text). Erklärt in "Über Logbuch"
(`about.tip.openDot`).

**Zeilen-Menü** (`renderRowMenuButton`/`renderRowHead`/`renderRowMenuPanel`/
`renderSectionMenuPanel`/`openRowMenu`/`closeRowMenu`, `state.rowMenu` bzw. `data-menu` =
Feld-id oder `section:<id>`): kleines Popover. Felder: "Bearbeiten" (Feld-Formular mit
`returnToTab: true`), "Archivieren" (danach Meldung, wo man reaktiviert) und – außer bei
Text-Feldern – "Notiz". Gruppen: "Notiz" und "Bearbeiten" (Löschen bewusst nicht aus
"Heute"). **Auslöser ist ein senkrechtes ⋮ links vor jedem Feld und jeder
Gruppen-Überschrift** (Nutzer-Entscheidung: einheitlich für Felder und Gruppen – bei Gruppen
ist ein Tipp auf die Überschrift schon Auf-/Zuklappen; links, damit die ⋮ eine ruhige Spalte
bilden). Verworfen: der Feldname als einziger Auslöser (man sieht ihm nicht an, dass er
antippbar ist, und es passte nicht für Gruppen); ein waagerechtes ⋯ hinter jedem Namen
(überladen). Der ⋮ ist das einzige Bedienelement für Tastatur/Screenreader
(Disclosure-Muster, `aria-expanded`, "Optionen für …", Escape schließt und gibt den Fokus
zurück). Abkürzungen für Zeige-Geräte: Tipp auf den Feldnamen (`row-menu-name`, kein
Button), Long-Press (eigener 500-ms-Timer, da iOS kein `contextmenu` feuert) bzw.
Rechtsklick. Zahlen-/Text-Felder: der Name ist kein `<label>` (Antippen würde sonst das
Eingabefeld fokussieren), das Eingabefeld trägt seinen Namen per `aria-label`. Vom
Long-Press ausgenommen: Eingabefelder, Schieberegler, das Menü selbst – nicht der Name
(Android macht aus langem Drücken keinen Klick). Der Klick nach einem Long-Press wird
verschluckt (`suppressNextClick`), sonst setzte er einen Wert bzw. klappte die Gruppe.
**Light-Dismiss**: bei offenem Menü schließt ein Tipp außerhalb nur das Menü (kein Umspringen
zu einem anderen Menü, kein versehentlich gesetzter Wert) – nur für Zeige-Geräte
(`e.detail > 0`), Tastatur-Klicks laufen normal durch. Scrollen, Wischen und Deep-Links
schließen es ebenfalls. Zählt als Overlay für die Zurück-Logik.

**Notizen** (Format siehe [datenmodell.md](datenmodell.md)): pro Feld (auch berechnete,
nicht Text-Felder), pro Gruppe und für den ganzen Tag, bewusst **kein Teil der Auswertung**.
Gedacht als Ausnahme ("heute wegen Erkältung kein Sport") – deshalb nur über das
Zeilen-Menü statt eines eigenen Symbols pro Zeile. Vorhandene Notiz als kleiner kursiver
Text unter Feld bzw. Gruppen-Überschrift (`renderNote`, antippbar → Editor; bei Gruppen auch
eingeklappt sichtbar, aber nur an Tagen, an denen die Gruppe in "Heute" steht,
`sectionShownToday`), Tagesnotiz unter der Liste (`renderDayNote`, ohne Notiz ein
gestrichelter Platzhalter-Button). Editor mit Speichern/Abbrechen, leer speichern = löschen,
max. `NOTE_MAX_LENGTH` (2000). `state.noteEditor` (`{dateKey, key, draft, original}`) zählt
nur an seinem Tag als Overlay (`isNoteEditorOpen`, prüft auch, ob das Feld noch in "Heute"
steht). **Getipptes geht nie still verloren**: wird der Editor unsichtbar (Tag-/Tab-Wechsel,
anderer Editor), speichert und schließt ihn `render()` zentral (`commitPendingNoteDraft`);
beim Wechsel in eine andere App sichert `persistNoteDraft` den Entwurf (Editor bleibt
offen). Nur "Abbrechen" und Zurück verwerfen bewusst (`discardNoteDraft`, stellt `original`
wieder her). Beim Abmelden wird ein offener Editor verworfen (sonst sähe ihn das nächste
Konto). Ein Re-Render beim Tippen behält Fokus/Cursor. `ensureNoteEditorVisible` hält den
Editor über der Bildschirmtastatur: Android verkleinert dank
`interactive-widget=resizes-content` (Meta-Viewport) den Layout-Viewport; zusätzlich wird
gegen `window.visualViewport` (iOS ignoriert das Attribut) und den angepinnten Header
gerechnet – sofort und nach Ende der Tastatur-Animation. Wählt man die Notiz eines Feldes,
deren Editor schon offen ist, springt der Fokus zurück ins Textfeld.
**Übersicht**: Woche – Punkt in der Feld-Zelle und am Wochentag (irgendeine Notiz an dem
Tag); Zahlen-Felder – Ring um den Datenpunkt im Verlaufsgraphen (als HTML über dem SVG, da
das SVG nur waagerecht gestreckt wird und ein Kreis darin zur Ellipse würde), plus "davon X
mit Notiz" in der Screenreader-Zusammenfassung; in Woche/Monat sind Datenpunkte antippbar
(senkrechte Spalte → dieser Tag in "Heute", `interactive` in `renderNumberCharts`; nur
Zeige-Geräte, per Tastatur über Wochentage/Monatszellen erreichbar; in Jahr/Gesamt bewusst
nicht, dort läge ~1px pro Tag); Monat – Punkt in der Tageszelle; Jahr – keiner (Zellen zu
klein). Screenreader: "mit Notiz" im Label der Tages-Zelle.

**"Tag zurücksetzen"** löscht Werte UND Notizen und fragt deshalb immer nach
(`renderResetConfirm`, `state.resetConfirm` = dateKey). Erreichbar über ein ⋮ vor dem
Wochentag oben (`renderDayMenuPanel`, `DAY_MENU_KEY` im Zeilen-Menü-Mechanismus).

**Ende von "Heute"**: drei erkennbare Teile – "Alles eingetragen" als Abschluss der Liste,
darunter der Tag ("Heute nicht geplant", Tagesnotiz), zuletzt eine Fußleiste mit Trennlinie
für "+ Neues Feld" (`.today-footer`, gehört nicht zum Tag). Alles linksbündig. Verworfen:
"+ Neues Feld" dort als reiner Text-Link (wirkte allein unter der Linie verloren).

**Haptik** (`haptic()`): kurzes Vibrieren beim Setzen/Entfernen eines Werts (Schieberegler
erst beim Loslassen – bei 100 Stufen wären es sonst zu viele) und beim Long-Press-Menü, damit
versehentliche Eingaben auffallen. Abschaltbar ("Beim Eintragen vibrieren", `localStorage`
`hapticsDisabled`), standardmäßig an – abschaltbar, weil Vibration für manche unangenehm ist
(z.B. sensorische Empfindlichkeit). Nur Android: Safari auf iOS bietet keine Vibration-API,
der Schalter erscheint dort nicht (`hapticsSupported`).

## Meldungen, Fokus, Barrierefreiheit

**Meldungen** (`state.notice`) erscheinen als schwebender Kasten unten (`syncToast`, eigenes
`#toast-root` außerhalb von `#app`) – oben unter dem Kopf sah man Fehler z.B. beim Speichern
im langen Feld-Formular nicht. Erfolg verschwindet nach 4–12 s je nach Länge
(Antippen/Fokus hält ihn), Fehler bleiben bis × oder zur nächsten Aktion; Screenreader über
`#sr-announcer` (polite) bzw. `#sr-alert` (assertive). Nur die Anmelde-Seiten zeigen
Meldungen im Text (`renderNotice()`, dort sind es Anleitungen). Fehler immer über
`errorNotice(key, rawMessage)`: ganzer Satz + übersetzter bekannter Fehler
(`translateDbError`) bzw. "Bitte versuch es nochmal" mit aufklappbaren technischen Details –
nie der rohe Fehler im Satz. Meldungen können einen Knopf tragen (`notice.action = { label,
run }`): wird ein Wert entfernt, erscheint "<Feld>: Eintrag entfernt [Rückgängig]"
(`offerUndoRemoval`, für alle, dauerhaft – sonst ginge ein "zur Sicherheit nochmal
angetippter" Wert still verloren).

**Fokus bleibt nach jeder Aktion** (`focusKeyOf`/`restoreFocus` in `render()`): `render()`
ersetzt das ganze `#app` – vorher merkt es sich das fokussierte Element (id bzw.
`data-action` + übrige `data-*`) und fokussiert danach das entsprechende neue, sofern nichts
anderes (Dialog, Unterseiten-Überschrift) den Fokus bekommen hat. **Neue klickbare Elemente
brauchen stabile, eindeutige `data-*`-Merkmale bzw. eine id.** Ausnahme: `<select>` wird
nach Bedienung per Finger nie per Skript fokussiert (`focusReopensPicker`) – auf iOS öffnet
das sofort wieder das Auswahl-Menü.

**Weitere Umsetzung**: Kalenderzellen (Woche/Monat/Jahr) per Tastatur erreichbar
(`tabindex="0" role="button"`, Enter/Space über einen generalisierten
`data-action`-Keydown-Dispatch, der einen echten Klick auslöst) und zusätzlich zur Farbe mit
Streifenmuster (`scorePatternStyle()`, diskrete Stufen, gröber in der Jahres-Ansicht) für
Rot-Grün-Farbenblinde. Bestätigungs-Modals (Konto löschen, Tutorial überspringen, Tag
zurücksetzen, Ersatzschlüssel neu erzeugen, Abmelden aus dem Menü – beendet die Erinnerungen
des Geräts und verlangt danach das Passwort) haben `role="dialog"`/Fokus-Trap/Escape/
Fokus-Rückgabe (`focusModalIfOpen()`/`restoreModalFocus()`/`modalTriggerSelector`,
gemeinsamer Schließ-Weg `closeModals()`). Der Zahlenwert-Verlaufsgraph hat eine
`.visually-hidden`-Zusammenfassung (Anzahl/letzter Wert/Durchschnitt/Spanne/Trend) statt
eines reinen `aria-label`. Fehlermeldungen auf Anmelde-/Entsperr-/Reset-Seite mit
`role="alert"`. Menü: `aria-expanded`, Escape schließt. **Wenig Höhe** (Handy quer, Zoom;
`@media (max-height: 500px)`): Kopf und Tab-Leiste nicht angepinnt (`stickyHeaderBottom()`
liefert 0), Dialoge scrollen, wenn sie höher als der Bildschirm sind.
