import { supabase } from './config.js?v=90bbeaa075';
import { saveFieldNamesForPush } from './fields.js?v=90bbeaa075';
import { clearCurrentDek, currentDek, currentDekUserId, runtime, setCurrentDek, state } from './state.js?v=90bbeaa075';
import { t } from './i18n.js?v=90bbeaa075';
import { loadEntries, loadFeatureAccess, loadHabits, loadSections, loadUserSettings, presetWeekStartForNewAccount, repadOldEntries, resumeWeekStartChange } from './data.js?v=90bbeaa075';
import { fetchEncryptionRow, maybeShowSpareKey, unlockEncryption, usableCachedDek } from './keys.js?v=90bbeaa075';
import { resumeStepChanges } from './type-change.js?v=90bbeaa075';
import { syncedEntries } from './save.js?v=90bbeaa075';
import { checkPushStatus } from './device.js?v=90bbeaa075';
import { rememberSignedInHere } from './auth-view.js?v=90bbeaa075';
import { render } from './main-view.js?v=90bbeaa075';

// --- Auth-Status & Start ---------------------------------------------------
export async function completeAuthFlow(userId, password, { verifyPassword = false } = {}) {
  runtime.accountGoneHandled = false;
  await unlockEncryption(userId, password, { verifyPassword });
  state.loading = true;
  render();
  await Promise.all([loadEntries(), loadHabits(), loadUserSettings(), loadSections(), loadFeatureAccess()]);
  state.loading = false;
  saveFieldNamesForPush(); // erst nach loadUserSettings - die Textvorlage hängt an der Sprache
  repadOldEntries();
  resumeStepChanges();
  resumeWeekStartChange();
  presetWeekStartForNewAccount();
  checkPushStatus().then(render);
  render();
  maybeShowSpareKey();
}

// Verwirft alles aus dem Konto Geladene samt Schlüssel - beim Abmelden und bei einem
// veralteten Schlüssel (checkDekStillCurrent). Auch offene Formulare, Entwürfe, Dialoge
// und die zuletzt offene Unterseite gehören zum Konto - sonst sähe sie, wer sich danach
// auf demselben Gerät anmeldet (z.B. einen Feldnamen im offenen Feld-Formular).
export function clearLoadedAccountState() {
  state.entries = {};
  state.habits = [];
  state.unsupportedHabits = [];
  state.noteEditor = null;
  state.rowMenu = null;
  state.resetConfirm = null;
  state.sections = [];
  state.sectionForm = null;
  state.sectionDeleteConfirm = null;
  state.habitForm = null;
  state.habitFormSaving = false;
  state.habitDeleteConfirm = null;
  state.deleteConfirm = null;
  state.passwordChange = null;
  state.spareKeyCheck = null;
  state.emailChange = null;
  state.regenKeyConfirm = false;
  state.logoutConfirm = false;
  state.menuOpen = false;
  state.recoveryKeyToShow = null;
  state.unplannedOpenFor = null;
  state.feedback = { message: '', anonymous: false, busy: false };
  state.view = 'today';
  state.previousTabView = 'today';
  runtime.undecryptableEntryDates = new Set();
  syncedEntries.clear();
  clearCurrentDek();
  runtime.spareKeyPending = false;
  state.unlockError = null;
  state.tutorialStep = null;
  state.tutorialSkipConfirm = false;
}

// Was beim Start einmal laufen muss (Event-Listener u.ä.). Nicht beim Laden des Moduls, sondern
// vom Einstieg (logbuch.js) aufgerufen, in fester Reihenfolge, wenn alle Module geladen sind.
export function initSession() {
  supabase.auth.onAuthStateChange(async (event, session) => {
    state.session = session;
    if (session) rememberSignedInHere();
    state.authError = null;
    if (event === 'PASSWORD_RECOVERY') {
      state.passwordRecovery = true;
      render();
      return;
    }
    if (runtime.authFlowInFlight) { render(); return; }
    if (session) {
      // Schon entsperrt und dasselbe Konto: z.B. die stündliche Token-Erneuerung oder die
      // Rückkehr in die App - sichtbar ändert sich nichts. Bewusst KEIN render(): der würde
      // die ganze Ansicht neu aufbauen und dabei Getipptes, aber noch nicht Gespeichertes
      // (z.B. den Namen im Feld-Formular) verwerfen.
      if (currentDek && currentDekUserId === session.user.id) return;
      // Schlüssel eines ANDEREN Kontos geladen (z.B. in einem anderen Tab umgemeldet):
      // alles davon verwerfen, sonst würde mit fremdem Schlüssel unter diesem Konto
      // gespeichert.
      if (currentDek) clearLoadedAccountState();
      // Kein Passwort verfügbar (Session-Wiederherstellung, z.B. Browser-Reload) - nur
      // der lokale Cache kann hier helfen, sonst muss renderUnlockPrompt() greifen.
      state.loading = true;
      runtime.sessionRestoreInFlight = true;
      render();
      // Ohne Verbindung lässt sich der Cache nicht gegen die aktuelle Kennung prüfen -
      // dann lieber das Passwort abfragen als womöglich mit einem veralteten Schlüssel
      // zu speichern (laden ließe sich ohne Verbindung ohnehin nichts).
      let cached = null;
      let row = null;
      try {
        try {
          row = await fetchEncryptionRow(session.user.id);
          const result = await usableCachedDek(session.user.id, row);
          cached = result.dek;
          if (result.stale) state.unlockError = t('unlock.keyChanged');
        } catch { /* -> renderUnlockPrompt */ }
        if (cached) {
          setCurrentDek(cached, row.dek_id, session.user.id);
          runtime.spareKeyPending = !row.recovery_key_confirmed;
          await Promise.all([loadEntries(), loadHabits(), loadUserSettings(), loadSections(), loadFeatureAccess()]);
          saveFieldNamesForPush(); // siehe completeAuthFlow
          repadOldEntries();
          resumeStepChanges();
          resumeWeekStartChange();
          presetWeekStartForNewAccount();
          checkPushStatus().then(render);
        }
      } finally {
        // Auch bei einem unerwarteten Fehler, sonst bliebe der Startbildschirm für immer stehen.
        state.loading = false;
        runtime.sessionRestoreInFlight = false;
      }
      maybeShowSpareKey();
    } else {
      clearLoadedAccountState();
    }
    render();
  });
}
