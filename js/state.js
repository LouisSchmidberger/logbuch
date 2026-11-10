import { startOfDay, startOfWeek } from './dates.js?v=8aaa0e5b67';
import { clearFeatureAccess } from './data.js?v=8aaa0e5b67';
import { isStandaloneDisplay } from './device.js?v=8aaa0e5b67';
import { signedInHereBefore } from './auth-view.js?v=8aaa0e5b67';
import { closeWhatsNew } from './about-view.js?v=8aaa0e5b67';

// --- App-State ---------------------------------------------------------
// Laufzeitwerte, die mehrere Module setzen (ES-Module können importierte Variablen nicht neu
// zuweisen, Eigenschaften eines geteilten Objekts schon). Nicht Teil von state: nichts davon wird
// gerendert oder gespeichert, es sind Merker für Abläufe.
export const runtime = {
  weekStartIso: 1,
  // Ersatzschlüssel (Recovery-Key) noch unbestätigt (user_encryption.recovery_key_confirmed
  // = false): neues Konto, Reset ohne Ersatzschlüssel, oder im Menü neu erzeugt und vor dem
  // Bestätigen geschlossen. maybeShowSpareKey zeigt dann einen frisch erzeugten an.
  spareKeyPending: false,
  // Merkt sich einen CSS-Selektor für das Element, das ein Modal (Konto löschen/
  // Tutorial überspringen) geöffnet hat, damit der Fokus beim Schließen
  // (Abbrechen/Escape) dorthin zurückspringt. Bewusst ein Selektor statt einer
  // direkten Element-Referenz: render() ersetzt bei jedem Aufruf das komplette
  // innerHTML, jede zuvor gemerkte Node wäre beim Schließen längst verwaist —
  // der Selektor wird erst beim tatsächlichen Zurückspringen neu aufgelöst.
  modalTriggerSelector: null,
  // Scroll-Position vor dem Feld-Formular und ihre Einlösung am Ende von render()
  // (openHabitForm/closeHabitForm).
  habitFormReturnScrollY: null,
  pendingScrollRestore: null,
  // Was nach "Verwerfen" in der Rückfrage läuft (leaveFormGuarded).
  pendingFormLeave: null,
  // verhindert, dass mehrere gleichzeitig fehlschlagende Requests forceLogoutAccountGone
  // mehrfach anstoßen.
  accountGoneHandled: false,
  stepperHoldSwallowClick: false,
  // Tage, deren Eintrag sich nicht entschlüsseln ließ (z.B. beschädigt oder mit einem
  // anderen Schlüssel geschrieben). Sie erscheinen leer, dürfen aber nie überschrieben
  // werden - sonst wäre der Inhalt endgültig weg, auch falls er sich später doch noch
  // lesen ließe. saveDay verweigert deshalb das Speichern dort.
  undecryptableEntryDates: new Set(),
  // Alle aufklappbaren Abschnitte in "Über Logbuch" (hervorgehobene Bereiche und
  // Tipp-Gruppen) sind bei JEDEM Öffnen der Seite zugeklappt (Nutzer-Wunsch 2026-09-27) -
  // kein dauerhaftes Merken mehr. Was man während eines Besuchs aufklappt, bleibt nur so
  // lange offen, wie man auf der Seite ist (übersteht einen Re-Render), enterSubpage
  // setzt es beim nächsten Öffnen zurück.
  openAboutSections: new Set(),
  signupFormShownAt: null,
  onbModeThisVisit: null,
  onbInProgressThisVisit: false,
  // falls localStorage nicht geht (privater Modus)
  installGateSkippedThisVisit: false,
  // Android/Chrome bietet einen echten Installations-Dialog an - dann ein Knopf statt nur
  // einer Anleitung. iOS kennt das nicht, dort bleibt es bei der Anleitung.
  deferredInstallPrompt: null,
  appJustInstalled: false,
  // Spam-Frage nach der Bestätigungsmail beantwortet (spamFeedbackHtml).
  spamFeedbackAnswered: false,
  // zuletzt im Tutorial angelegtes Feld (Zurück von "Geschafft")
  tutorialLastFieldDefId: null,
  // Schlüssel wird beim Öffnen mit gespeicherter Anmeldung gerade geladen (isOpeningAccount).
  sessionRestoreInFlight: false,
  // Richtung der Rutsch-Animation nach shiftPeriod (renderApp).
  pendingPeriodSlide: 0,
  // authFlowInFlight: von den Login/Signup-Submit-Handlern VOR dem signUp/
  // signInWithPassword-Aufruf gesetzt (nicht erst danach — onAuthStateChange kann schon
  // in der Lücke dazwischen feuern) und erst nach completeAuthFlow() wieder gelöscht.
  // Solange gesetzt, überlässt onAuthStateChange dem Submit-Handler komplett das
  // Entsperren + Laden (dort ist das Passwort im Klartext verfügbar) — sonst würde
  // onAuthStateChange parallel einen zweiten, redundanten Cache-Entsperr-Versuch
  // starten und dabei ggf. kurz den Passwort-Abfrage-Screen aufblitzen lassen, obwohl
  // das Passwort gerade eben schon eingegeben wurde.
  authFlowInFlight: false,
};

export const state = {
  onbDisplayOpen: false, // Einführung: Auswahl "Aa Anzeige" aufgeklappt (addOnbDisplayBar)
  session: null,
  entries: {},       // { 'YYYY-MM-DD': { habitId: value, ... } }
  loading: true,
  notice: null,       // { type: 'error'|'ok', text }
  view: 'today',
  previousTabView: 'today', // Tab, zu dem "Verwalten"/"Über Logbuch" zurückspringen (siehe enterSubpage/closeTopLayer)
  currentDate: startOfDay(new Date()),
  weekAnchor: startOfWeek(new Date()),
  monthAnchor: (() => { const d = startOfDay(new Date()); d.setDate(1); return d; })(),
  yearAnchor: new Date().getFullYear(),
  // 'welcome' | 'mode' (Einstiegsfrage) | 'overview' ("So läuft's ab") | 'installed' (frisch
  // installierte App) | 'signup' | 'checkMail' | 'signin' | 'forgot'
  authMode: signedInHereBefore() ? 'signin' : isStandaloneDisplay() ? 'installed' : 'welcome',
  authError: null,
  authEmail: '', // bleibt über einen Re-Render (z.B. nach Fehler) hinweg erhalten,
  authPassword: '', // damit ein Tippfehler nicht das ganze Formular leert (siehe input-Listener).
  authPasswordVisible: false,
  // Adresse, an die gerade eine Bestätigungsmail ging (nach der Registrierung bzw. beim
  // Anmelden mit noch unbestätigter Adresse) - blendet die Hilfe "Keine Mail da?" ein.
  confirmEmailFor: null,
  confirmResend: null, // null | 'sending' | 'sent' | { error: text }
  passwordRecovery: false, // true zwischen Klick auf den Passwort-Reset-Link und neuem Passwort
  todayIntroStep: 0, // aktuelle Karte der einmaligen Erklärung in "Heute" (renderTodayIntro)
  pushStatus: 'unknown', // 'unsupported' | 'unknown' | 'off' | 'on' | 'busy' | 'blocked' (Mitteilungen im Browser/Handy verboten)
  habits: [],         // alle Felder des Nutzers (aktiv + archiviert), sort_order-sortiert
  unsupportedHabits: [], // Felder eines Typs, den diese Version nicht kennt (siehe isSupportedHabit)
  sections: [],       // Gruppen (intern "sections"): { id, name, sortOrder } (siehe layoutBlocks)
  sectionForm: null,  // { id: null (neu) | Gruppen-ID, name, members: [defId] } - offenes Gruppen-Formular
  sectionDeleteConfirm: null, // Gruppen-ID, deren Löschen gerade bestätigt wird
  habitForm: null,    // { defId, locked, name, mode: 'numeric'|'labels', min, max, steps, labels, good }
  habitFormSaving: false, // true während handleHabitSave() läuft, verhindert Doppel-Submits
  menuOpen: false,
  rowMenu: null,      // offenes Zeilen-Menü in "Heute": Feld-id, 'section:<id>' oder DAY_MENU_KEY
  noteEditor: null,   // { dateKey, key, draft } - offener Notiz-Editor (key = slug oder DAY_NOTE_KEY)
  resetConfirm: null, // dateKey, während die Rückfrage "Tag zurücksetzen?" offen ist
  unplannedOpenFor: null, // dateKey, an dem "Heute nicht geplant" aufgeklappt wurde
  // Standard-Erinnerungszeit (Minuten seit Mitternacht) für Felder ohne eigene reminder_minute.
  // onboardingCompleted default true, bis loadUserSettings() den echten Wert lädt – verhindert,
  // dass das Tutorial kurz aufblitzt, bevor die tatsächlichen Einstellungen geladen sind.
  userSettings: { defaultReminderMinute: 1320, onboardingCompleted: true, locale: 'de', summaryNotifications: true, timezone: 'Europe/Berlin' },
  deleteConfirm: null, // { busy: boolean } während der Konto-Löschen-Bestätigung offen ist
  passwordChange: null, // { current, next, visible, busy, error } während "Passwort ändern" offen ist
  spareKeyCheck: null, // { value, busy, result: 'ok'|'wrong'|'error'|null, errorText } während "Ersatzschlüssel prüfen" offen ist
  emailChange: null, // { value, password, busy, error, sentTo } während "E-Mail-Adresse ändern" offen ist
  regenKeyConfirm: false, // Rückfrage vor "Ersatzschlüssel neu erzeugen" offen
  logoutConfirm: false,   // Rückfrage vor "Abmelden" (aus dem Menü) offen
  leaveFormConfirm: false, // Rückfrage "Änderungen verwerfen?" beim Verlassen eines geänderten Formulars (siehe leaveFormGuarded)
  habitDeleteConfirm: null, // defId eines archivierten Feldes mit Daten, dessen Löschen gerade bestätigt wird
  tutorialStep: null, // TUTORIAL_STEP_* während Tutorial bzw. Erinnerungs-Schritt für neue Accounts laufen, sonst null
  tutorialSkipConfirm: false, // Bestätigungsdialog "Tutorial überspringen?" offen
  confirmLanding: false, // "E-Mail bestätigt - zurück zur App" statt Anmelden im Browser (renderConfirmLanding)
  encryptionSetupInProgress: false, // true während setupEncryption()/Migration läuft
  recoveryKeyToShow: null, // { hex } - einmalige Anzeige des Ersatzschlüssels nach Erzeugung
  unlockError: null, // Fehlertext im renderUnlockPrompt-Screen
  unlockBusy: false,
  recoveryFallbackConfirm: false, // "Recovery-Key auch verloren?" im Passwort-Reset aufgeklappt
  recoveryBusy: false,
  feedback: { message: '', anonymous: false, busy: false }, // Unterseite "Feedback geben"
};

// currentDek (Modul-Variable statt state): der lebende Entschlüsselungs-Schlüssel darf
// nie über render()/innerHTML laufen und soll auch nicht versehentlich durch
// generische State-Handhabung angefasst werden. currentDekId ist seine Kennung
// (user_encryption.dek_id), gegen die checkDekStillCurrent prüft.
export let currentDek = null;
export let currentDekId = null;
// Konto, dem der geladene Schlüssel gehört - damit sich erkennen lässt, wenn die Session
// plötzlich einem anderen Konto gehört (z.B. in einem anderen Tab umgemeldet).
export let currentDekUserId = null;
export function setCurrentDek(dek, dekId, userId) {
  currentDek = dek;
  currentDekId = dekId;
  currentDekUserId = userId;
}
export function clearCurrentDek() {
  clearFeatureAccess(); // gehört zum angemeldeten Konto wie der Schlüssel
  currentDek = null;
  currentDekId = null;
  currentDekUserId = null;
}

export function restoreModalFocus() {
  if (!runtime.modalTriggerSelector) return;
  document.querySelector(runtime.modalTriggerSelector)?.focus();
  runtime.modalTriggerSelector = null;
}
// Gemeinsamer Schließ-Weg aller Bestätigungs-Modals (Abbrechen-Button, Escape,
// Android-Zurück) - rendert NICHT selbst, der Aufrufer muss danach render() und
// restoreModalFocus() aufrufen (closeTopLayer läuft z.B. vor einem eigenen render()).
export function closeModals() {
  if (state.whatsNew) closeWhatsNew(); // Schließen = gesehen (speichert)
  state.deleteConfirm = null;
  if (!state.passwordChange?.busy) state.passwordChange = null;
  state.spareKeyCheck = null;
  if (!state.emailChange?.busy) state.emailChange = null;
  state.tutorialSkipConfirm = false;
  state.resetConfirm = null;
  state.regenKeyConfirm = false;
  state.logoutConfirm = false;
  state.leaveFormConfirm = false;
  runtime.pendingFormLeave = null;
}
