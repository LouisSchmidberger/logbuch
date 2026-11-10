import { isTextKind } from './fields.js?v=90bbeaa075';
import { entryKeyFor, formatKey } from './dates.js?v=90bbeaa075';
import { closeModals, restoreModalFocus, runtime, state } from './state.js?v=90bbeaa075';
import { defaultHabitForm, syncHabitFormFromDom } from './field-form.js?v=90bbeaa075';
import { closeStepDialog, stepDialogOpen, stepEditKey, typeEditKey } from './type-change.js?v=90bbeaa075';
import { closeSectionForm, readSectionFormFromDom } from './section-form.js?v=90bbeaa075';
import { DAY_NOTE_KEY, SECTION_NOTE_PREFIX, commitPendingNoteDraft, sectionShownToday } from './save.js?v=90bbeaa075';
import { closeRowMenu, closeTimePicker, timePicker } from './row-view.js?v=90bbeaa075';
import { closeWhatsNew } from './about-view.js?v=90bbeaa075';
import { render } from './main-view.js?v=90bbeaa075';

// --- Android-Zurück-Taste schließt offene Overlays/Unterseiten statt die App zu
// verlassen -------------------------------------------------------------------
// Ohne eigene History-Einträge hat die native/Gesten-Zurück-Taste nichts, wohin sie
// "zurückgehen" könnte, und beendet stattdessen sofort die App (bzw. den Tab) -
// unabhängig davon, was gerade offen ist. Bewusst nur für Overlays (Menü,
// Feld-Formular, Lösch-Bestätigungen) und Unterseiten (Verwalten/Über Logbuch), NICHT
// für reine Tab-Wechsel (Heute/Woche/...) - das entspricht dem üblichen Verhalten von
// Android-Apps mit Tab-Leiste. state.recoveryKeyToShow bleibt bewusst ausgenommen: das
// ist schon jetzt absichtlich nur über die Bestätigungs-Checkbox schließbar (auch
// Escape greift dort nicht), das soll die Zurück-Taste nicht aushebeln.
//
// Overlay und Unterseite können gleichzeitig offen sein (z.B. "Neues Feld" innerhalb
// von "Verwalten") - deshalb ein Layer-Zähler statt einer reinen Boolean-Prüfung, mit
// je einem History-Eintrag pro Layer, damit zwei Zurück-Drücke auch zwei Ebenen
// nacheinander schließen.
export function isSubpageView(view) { return ['manage', 'about', 'feedback', 'settings', 'install'].includes(view); }
// Merkt sich den Tab, von dem aus eine Unterseite betreten wurde (nicht überschreiben,
// wenn man z.B. innerhalb von "Verwalten" übers Menü direkt zu "Über Logbuch"
// wechselt - sonst würde "Zurück" dann fälschlich zu "Verwalten" statt zum
// ursprünglichen Tab führen).
export function enterSubpage(view) {
  if (!isSubpageView(state.view)) state.previousTabView = state.view;
  if (view === 'about' || view === 'settings') runtime.openAboutSections = new Set(); // bei jedem Öffnen alles zugeklappt
  if (view !== 'manage') closeManageOverlays();
  state.view = view;
  state.menuOpen = false;
}
// Feld-Formular und Feld-Lösch-Bestätigung gehören zur Verwaltungsseite - wer sie
// verlässt (←-Button, Wischen, Menü-Wechsel zu einer anderen Unterseite), schließt
// sie mit. Sonst blieben sie unsichtbar im State offen und zählten weiter als
// History-Ebene (ein wirkungsloser Android-Zurück-Druck auf der nächsten Seite).
function closeManageOverlays() {
  state.habitForm = null;
  runtime.habitFormReturnScrollY = null;
  state.habitDeleteConfirm = null;
  state.sectionForm = null;
  state.sectionDeleteConfirm = null;
}
function leaveSubpage() {
  closeManageOverlays();
  state.view = state.previousTabView || 'today';
}
export function isOverlayOpen() {
  return state.menuOpen || !!state.rowMenu || isNoteEditorOpen() || !!state.sectionForm || !!state.resetConfirm || !!state.regenKeyConfirm || !!state.logoutConfirm || state.leaveFormConfirm || !!state.deleteConfirm || !!state.passwordChange || !!state.spareKeyCheck || !!state.emailChange || state.tutorialSkipConfirm || !!state.habitForm || !!state.habitDeleteConfirm || !!state.whatsNew;
}
// Der Notiz-Editor gehört zu einem bestimmten Tag in "Heute" und ist nur offen, solange
// er dort auch sichtbar ist - wechselt man Tag/Tab, speichert render() den Entwurf und
// schließt ihn (siehe commitPendingNoteDraft).
// Zusätzlich muss das Feld selbst noch in "Heute" stehen - wird es z.B. über das
// Zeilen-Menü archiviert, während seine Notiz offen ist, wäre der Editor sonst
// unsichtbar, zählte aber weiter als offene Ebene.
export function isNoteEditorOpen() {
  const ed = state.noteEditor;
  if (!ed || state.view !== 'today' || ed.dateKey !== entryKeyFor(ed.key, formatKey(state.currentDate))) return false;
  if (ed.key === DAY_NOTE_KEY) return true;
  if (ed.key.startsWith(SECTION_NOTE_PREFIX)) return sectionShownToday(ed.key.slice(SECTION_NOTE_PREFIX.length));
  return activeHabits().some((h) => h.id === ed.key && !isTextKind(h));
}
function currentLayerCount() {
  return (isSubpageView(state.view) ? 1 : 0) + (isOverlayOpen() ? 1 : 0) + (timePicker ? 1 : 0);
}
// Das Feld-Formular ist eine eigene Ebene innerhalb der Verwaltung: solange es offen
// ist, zeigt die Verwaltung NUR das Formular (kein Weiterscrollen zu den anderen
// Feldern, Titel im Seitenkopf, siehe renderManage/renderApp). Geöffnet wird es immer
// über openHabitForm, das sich die Scroll-Position merkt - closeHabitForm (einziger
// Schließ-Weg: Speichern, Abbrechen, ←-Button, Wischen, Android-Zurück) bringt einen
// genau dorthin zurück (per runtime.pendingScrollRestore, eingelöst am Ende von render()).
// Wurde es über einen Shortcut aus "Heute" geöffnet (returnToTab, lebt bewusst im
// Formular-Zustand und verschwindet so automatisch mit ihm), geht es danach direkt
// zurück zum Tab statt in der Verwaltung zu bleiben - die Absicht war dort "jetzt
// tracken", nicht "verwalten".
export function openHabitForm(form) {
  runtime.habitFormReturnScrollY = window.scrollY;
  state.habitForm = form;
  render();
  markFormBaseline();
  window.scrollTo(0, 0);
  // Nur beim Neuanlegen direkt den Namen fokussieren (öffnet auf dem Handy gleich die
  // Tastatur, funktioniert nur zuverlässig synchron aus einem Klick-Handler) - ohne
  // Namen geht es dort nicht weiter. Beim Bearbeiten will man meist etwas anderes
  // ändern; dort bleibt der Fokus auf der Seitenüberschrift (siehe renderApp).
  if (!form.defId) requestAnimationFrame(() => document.getElementById('habit-form-name')?.focus());
}
export function closeHabitForm() {
  const returnToTab = state.habitForm?.returnToTab;
  state.habitForm = null;
  if (returnToTab && state.view === 'manage') state.view = state.previousTabView || 'today';
  runtime.pendingScrollRestore = runtime.habitFormReturnScrollY;
  runtime.habitFormReturnScrollY = null;
}
// ←-Button und Wischen auf einer Unterseite: bei offenem Feld-Formular zurück zur
// Liste (bzw. zum Tab, siehe returnToTab), sonst die Unterseite verlassen.
export function subpageBack() {
  if (state.view === 'manage' && state.habitForm) leaveFormGuarded(closeHabitForm);
  else if (state.view === 'manage' && state.sectionForm) leaveFormGuarded(closeSectionForm);
  else leaveSubpage();
}

// --- Rückfrage beim Verlassen eines geänderten Formulars ----------------------
// Feld- und Gruppen-Formular: wer sie mit Änderungen anders als über "Abbrechen" verlässt
// (←, Wischen, Android-Zurück, Menü), wird gefragt, statt still alles zu verlieren.
// "Abbrechen" verwirft bewusst ohne Rückfrage. Verglichen wird mit dem Stand direkt nach
// dem Öffnen (form.baseline, gesetzt von markFormBaseline) - nur die gespeicherten
// Werte, keine reinen Anzeige-Zustände (Fehler, aufgeklappte Teile). Formulare ohne
// baseline (Tutorial) fragen nie: dort gibt es eigene Wege (Überspringen-Rückfrage).
function habitFormSnapshot(f) {
  const snap = {};
  for (const k of Object.keys(defaultHabitForm())) snap[k] = f[k];
  snap.labels = f.labelsEnabled ? f.labels.slice(0, f.max - f.min + 1) : null;
  snap.members = [...f.members].sort();
  snap.schedule = f.schedule.mode === 'interval'
    ? { every: f.schedule.every, start: f.schedule.start }
    : [...f.schedule.days].sort();
  if (!f.reminderEnabled) { snap.reminderTimes = null; snap.reminderBelow = null; }
  // "Stufen ändern" offen und schon etwas eingestellt (nur Öffnen zählt nicht).
  snap.stepEdit = f.stepEdit && stepEditKey(f.stepEdit) !== f.stepEdit.initial ? 'changed' : null;
  snap.typeEdit = f.typeEdit && typeEditKey(f.typeEdit) !== f.typeEdit.initial ? 'changed' : null;
  return JSON.stringify(snap);
}
function sectionFormSnapshot(sf) {
  return JSON.stringify({
    name: sf.name, collapse: sf.collapse, members: [...sf.members].sort(),
    reminderMinute: sf.reminderEnabled ? sf.reminderMinute : null,
  });
}
// Nach dem ersten render() des Formulars aufrufen: liest es einmal aus dem DOM zurück,
// damit Normalisierungen beim Einlesen (Uhrzeit, Bezeichnungen) nicht als Änderung zählen.
export function markFormBaseline() {
  if (state.habitForm) { syncHabitFormFromDom(); state.habitForm.baseline = habitFormSnapshot(state.habitForm); }
  else if (state.sectionForm) { readSectionFormFromDom(); state.sectionForm.baseline = sectionFormSnapshot(state.sectionForm); }
}
export function openFormHasChanges() {
  const f = state.habitForm;
  if (f?.baseline) { syncHabitFormFromDom(); return habitFormSnapshot(f) !== f.baseline; }
  const sf = state.sectionForm;
  if (sf?.baseline) { readSectionFormFromDom(); return sectionFormSnapshot(sf) !== sf.baseline; }
  return false;
}
// Führt proceed (rendert NICHT selbst, wie closeHabitForm) sofort aus - oder öffnet bei
// Änderungen die Rückfrage und führt es erst bei "Verwerfen" aus. Der Aufrufer rendert
// in beiden Fällen wie gewohnt danach.
export function leaveFormGuarded(proceed) {
  if (state.leaveFormConfirm) return; // Rückfrage schon offen (z.B. zweiter Wisch)
  if (!openFormHasChanges()) { proceed(); return; }
  runtime.pendingFormLeave = proceed;
  state.leaveFormConfirm = true;
  state.menuOpen = false;
  runtime.modalTriggerSelector = '.subpage-header .back-btn';
}
// Schließt jeweils nur die "oberste" Ebene (analog zur bestehenden Escape-Logik) -
// Overlays vor der Unterseite, da sie darüber liegen. In der Praxis nie mehrere
// Overlays gleichzeitig offen, da z.B. die Menü-Aktionen state.menuOpen beim Öffnen
// eines anderen Overlays bereits selbst auf false setzen.
function closeTopLayer() {
  if (state.whatsNew) {
    closeWhatsNew();
  } else if (state.deleteConfirm || state.passwordChange || state.spareKeyCheck || state.emailChange || state.tutorialSkipConfirm || state.resetConfirm || state.regenKeyConfirm || state.logoutConfirm || state.leaveFormConfirm) {
    closeModals(); // bei "Änderungen verwerfen?" = Weiter bearbeiten
    restoreModalFocus();
  } else if (stepDialogOpen()) {
    closeStepDialog();
  } else if (state.menuOpen) {
    state.menuOpen = false;
  } else if (state.rowMenu) {
    state.rowMenu = null;
  } else if (isNoteEditorOpen()) {
    commitPendingNoteDraft(); // wie Tag-/Tab-Wechsel: Zurück speichert, nur "Abbrechen" verwirft
  } else if (state.sectionForm || state.habitForm) {
    // Bleibt das Formular wegen der Rückfrage offen, legt das folgende render() den eben
    // verbrauchten History-Eintrag wieder an (syncLayerHistory).
    leaveFormGuarded(state.sectionForm ? closeSectionForm : closeHabitForm);
  } else if (state.habitDeleteConfirm) {
    state.habitDeleteConfirm = null;
  } else if (isSubpageView(state.view)) {
    leaveSubpage();
  }
}
let openLayerCount = 0;
// true zwischen einem SELBST ausgelösten history.go() (siehe syncLayerHistory) und
// dem dadurch erst asynchron ausgelösten popstate - unterscheidet "wir korrigieren nur
// die History-Position, der State stimmt schon" von einem echten Zurück-Druck. Ohne das
// hätte z.B. ein direkter Wechsel zwischen zwei Unterseiten übers Menü (schließt dabei
// nebenbei das Menü-Overlay, die Layer-Zahl sinkt also auch ohne echten Zurück-Druck)
// fälschlich die Unterseite selbst mit geschlossen, weil das eigene Korrektur-go()
// ebenfalls ein popstate auslöst.
let closingLayerViaPopstate = false;
// Von render() aufgerufen: hält die History mit der Layer-Anzahl synchron, damit pro
// geöffneter Ebene genau ein Zurück-Druck sie wieder schließt - auch wenn sie
// stattdessen ganz normal über die App (Abbrechen-Button, ←-Button o.ä.) geschlossen
// wird (sonst blieben "tote" History-Einträge stehen, die zusätzliche, wirkungslose
// Zurück-Drücke vor dem eigentlichen Verlassen der App erfordert hätten).
export function syncLayerHistory() {
  if (closingLayerViaPopstate) return;
  const n = currentLayerCount();
  if (n > openLayerCount) {
    // Ein Eintrag PRO neuer Ebene - öffnen sich zwei auf einmal (z.B. "+ Neues Feld" in
    // "Heute": Verwaltung + Formular), muss es auch zwei geben, sonst ginge das
    // go(-2) beim gemeinsamen Schließen unten einen Schritt zu weit (App verlassen).
    for (let i = openLayerCount; i < n; i++) history.pushState({ logbuchLayer: true }, '');
    openLayerCount = n;
  } else if (n < openLayerCount) {
    // go(-Differenz) statt back(): schließt eine Aktion zwei Ebenen auf einmal (z.B.
    // Deep-Link aus einer Benachrichtigung, oder Speichern im "Heute"-Shortcut-
    // Formular), bliebe mit back() ein toter Eintrag stehen, der einen wirkungslosen
    // Zurück-Druck kosten würde. Eine Traversierung = genau ein popstate, egal wie weit.
    const steps = openLayerCount - n;
    openLayerCount = n;
    closingLayerViaPopstate = true; // siehe Kommentar an der Deklaration oben
    history.go(-steps);
  }
}

export function activeHabits() {
  return state.habits.filter((h) => !h.archivedAt);
}

export function habitHasData(habitId) {
  return Object.values(state.entries).some((day) => day[habitId] !== undefined);
}

export const app = document.getElementById('app');

export function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Was beim Start einmal laufen muss (Event-Listener u.ä.). Nicht beim Laden des Moduls, sondern
// vom Einstieg (logbuch.js) aufgerufen, in fester Reihenfolge, wenn alle Module geladen sind.
export function initNavigation() {
  window.addEventListener('popstate', () => {
    if (closingLayerViaPopstate) { closingLayerViaPopstate = false; return; }
    if (currentLayerCount() === 0) return; // nichts (mehr) zu schließen - Browser navigiert normal weiter
    openLayerCount = Math.max(0, openLayerCount - 1); // History-Position ist durch den Pop bereits korrekt
    // Die Uhrzeit-Auswahl liegt über allem und außerhalb von #app: ohne render() schließen.
    if (timePicker) { closeTimePicker({ viaPopstate: true }); return; }
    closeTopLayer();
    // Schließt closeTopLayer dabei mehr als eine Ebene (z.B. Feld-Formular aus dem
    // "Heute"-Shortcut: Formular UND Verwaltung), räumt syncLayerHistory in render() den
    // übrigen History-Eintrag selbst weg.
    render();
  });
  // Scrollen NEBEN dem Menü (Hintergrund/Fenster) soll das Menü schließen, Scrollen AUF
  // dem Menü selbst (falls dessen Inhalt bei Zoom o.ä. nicht mehr auf den Bildschirm
  // passt) dagegen nicht - und darf dabei auch nicht den Hintergrund mitscrollen. Löst
  // sich rein über 'scroll' am WINDOW statt einer Body-Scroll-Sperre: 'scroll'-Events
  // bubbeln nicht, ein Scroll innerhalb von .menu-panel (eigenes overflow-y: auto, siehe
  // CSS) feuert nur dort, nie am window - dieser Listener sieht deshalb nur echte
  // Hintergrund-Scrolls. .menu-panel hat zusätzlich overscroll-behavior: contain, damit
  // ein Scroll, der dort an sein Ende kommt (z.B. durchgescrollt bis ganz unten), nicht
  // ins darunterliegende Fenster "durchreicht" und dort doch noch scrollt.
  // Das Zeilen-Menü in "Heute" schließt beim Scrollen ebenso - es hängt zwar an seiner
  // Zeile (scrollt mit), bleibt aber sonst beim Weiterscrollen unbemerkt offen und würde
  // den nächsten Tipp als Light-Dismiss verschlucken.
  window.addEventListener('scroll', () => {
    if (state.menuOpen) { state.menuOpen = false; render(); }
    if (state.rowMenu) closeRowMenu();
  }, { passive: true });
}
