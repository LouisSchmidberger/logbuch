import { supabase } from './config.js?v=8aaa0e5b67';
import { formatRecoveryKey } from './crypto.js?v=8aaa0e5b67';
import { expandSection, newMultiOptionId, setSectionCollapsed, timeValueOn } from './fields.js?v=8aaa0e5b67';
import { REMINDER_TIME_STEP, addDays, formatKey, isFutureKey, parseDateKey, reminderTimePicked, startOfDay } from './dates.js?v=8aaa0e5b67';
import { clearCurrentDek, closeModals, currentDek, restoreModalFocus, runtime, state } from './state.js?v=8aaa0e5b67';
import { activeHabits, app, closeHabitForm, enterSubpage, isOverlayOpen, leaveFormGuarded, openFormHasChanges, openHabitForm, subpageBack } from './navigation.js?v=8aaa0e5b67';
import { t, tPlain } from './i18n.js?v=8aaa0e5b67';
import { haptic, setDayProgressShown, setHapticsDisabled, setPatternDisabled, setTextSize, setThemeOverride } from './theme.js?v=8aaa0e5b67';
import { AUTH_MIN_PASSWORD_LENGTH } from './format.js?v=8aaa0e5b67';
import { stepInput } from './notices.js?v=8aaa0e5b67';
import { runWeekStartChange, saveLocale, saveSummaryNotifications } from './data.js?v=8aaa0e5b67';
import { confirmSpareKey, handleEmailChangeSubmit, handlePasswordChangeSubmit, handleSpareKeyCheckSubmit, regenerateRecoveryKey } from './keys.js?v=8aaa0e5b67';
import { SLIDER_STEP_CAP, clampHabitFormSteps, convertHabitToCounter, goalSliderText, habitFormStepCount, habitFormStepValue, habitToForm, handleHabitSave, newHabitForm, resizeLabels, scheduleToForm, syncHabitFormFromDom } from './field-form.js?v=8aaa0e5b67';
import { applyStepEditPreset, applyTypeEditPreset, closeStepDialog, commitLayoutOrder, fieldMoveStep, finishStepChangeAction, handleHabitArchive, isTypeChange, runStepChange, startStepChange, startStepChangeUndo, stepEditCap, stepEditCountChanged, stepEditKey, stepEditNothingToDo, stepEditSummary, stepEditTo, typeChangeBlocker, typeChangeTargets, typeEditFinalMap, typeEditKey, typeEditKindChanged, typeEditStepsChanged, typeEditSummary, typeEditTo, usedValueRange } from './type-change.js?v=8aaa0e5b67';
import { closeSectionForm, deleteSection, handleHabitDelete, openSectionForm, readSectionFormFromDom, saveSectionForm } from './section-form.js?v=8aaa0e5b67';
import { closeNoteEditor, flushAllDaySaves, flushDaySave, handleClearValue, handleCounterStep, handleMultiToggle, handleReset, handleSaveNumber, handleSelect, handleSetValue, openNoteEditor, renderUnlessTyping, updateHabitPayload, updateTextValue } from './save.js?v=8aaa0e5b67';
import { disablePush, enablePush, endPushForThisDevice } from './device.js?v=8aaa0e5b67';
import { handleDeleteAccount, handleExportData } from './account.js?v=8aaa0e5b67';
import { isGuided, passwordRuleText, rememberOnbIncludesInstall, resendConfirmEmail, setOnbInProgress, setOnbMode } from './auth-view.js?v=8aaa0e5b67';
import { DAY_MENU_KEY, closeRowMenu, effectivePreviewValue, focusTodayField, habitSliderValueText, openRowMenu, openTimePicker, previewHabitFromForm, refreshHabitFormPreview, setPreviewValue, setTodayIntroPending, sliderColor, timePicker } from './row-view.js?v=8aaa0e5b67';
import { closeWhatsNew, feedbackSenderNote, handleFeedbackSubmit } from './about-view.js?v=8aaa0e5b67';
import { adjustTemplate, createFromTemplate, createStarterPackage, openTemplateFollowUp, packageFormState, readTemplateFromDom, startTemplateConfirm, templateById, undoTemplateMerge } from './templates.js?v=8aaa0e5b67';
import { habitFormReminderNote } from './fields-view.js?v=8aaa0e5b67';
import { TUTORIAL_STEP_DONE, TUTORIAL_STEP_FIELD, TUTORIAL_STEP_HELLO, TUTORIAL_STEP_REMINDERS, saveOnboardingCompleted } from './tutorial.js?v=8aaa0e5b67';
import { announce, focusReopensPicker, focusSettingsTarget, render } from './main-view.js?v=8aaa0e5b67';
import { SWIPEABLE_VIEWS, lastPointerType, shiftPeriod } from './gestures.js?v=8aaa0e5b67';

// Nur beim Wechsel erfüllt/unerfüllt anfassen - sonst läse ein Screenreader (aria-live)
// bei jedem Tastendruck denselben Satz vor.
function syncPasswordCount(id, len) {
  const count = document.getElementById(id);
  const ok = len >= AUTH_MIN_PASSWORD_LENGTH;
  if (count && count.classList.contains('password-count--ok') !== ok) {
    count.textContent = passwordRuleText(len);
    count.classList.toggle('password-count--ok', ok);
  }
}

// Live-Vorschau während des Ziehens am Schieberegler — nur DOM-Update, kein
// Re-Render/Speichern (verhindert Ruckeln/Sprünge im Formular während der Eingabe).
// Gilt genauso für den Regler in der Vorschau des Feld-Formulars (preview-slider).
function sliderHabit(slider) {
  return slider.dataset.action === 'preview-slider'
    ? (state.habitForm ? previewHabitFromForm(state.habitForm) : null)
    : state.habits.find((h) => h.id === slider.dataset.habit);
}
function commitSliderValue(slider) {
  if (slider.dataset.action === 'preview-slider') setPreviewValue(Number(slider.value), '.value-slider');
  else handleSetValue(formatKey(state.currentDate), slider.dataset.habit, Number(slider.value));
}
// Lücke im nativen 'change'-Event: das feuert beim Loslassen nur, wenn sich der Wert
// seit dem Drücken geändert hat. Ein noch leerer Regler steht aber schon mittig -
// zieht man ihn und lässt ihn genau dort wieder los, sah er durch die Live-Vorschau
// oben eingetragen aus (eingefärbt), gespeichert wurde aber nichts, und das × fehlte.
// Deshalb zusätzlich beim Loslassen selbst speichern, sobald während des Ziehens ein
// 'input' kam (data-dirty). Auf document statt app, da die Maus beim Loslassen schon
// außerhalb des Reglers sein kann; setTimeout, damit ein ggf. danach noch feuerndes
// 'change' nicht doppelt rendert - handleSetValue ist ohnehin idempotent, und hat
// 'change' schon neu gerendert, hängt der alte Regler nicht mehr im DOM.
let sliderPointerTarget = null;

// Tastatur am Computer: ← → blättern wie Wischen, Strg/⌘+Enter speichert das offene Formular,
// die Notiz bzw. das Feedback. Bewusst keine Kürzel mit einzelnen Buchstaben: Screenreader-
// Nutzer lösten sie beim Lesen aus Versehen aus (WCAG 2.1.4). Auf document statt #app: nach
// einem Neuzeichnen hat nichts den Fokus, die Tasten kommen dann bei <body> an.
const CTRL_ENTER_ACTIONS = ['note-save', 'habit-save', 'section-form-save', 'feedback-submit'];

// Was beim Start einmal laufen muss (Event-Listener u.ä.). Nicht beim Laden des Moduls, sondern
// vom Einstieg (logbuch.js) aufgerufen, in fester Reihenfolge, wenn alle Module geladen sind.
export function initEvents() {
  // --- Event-Delegation ----------------------------------------------------
  app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    // Jede neue Aktion räumt eine noch angezeigte Meldung von einer früheren Aktion weg
    // (z.B. einen Validierungsfehler, der sonst nach erfolgreicher Korrektur einfach
    // stehen bliebe, bis man aktiv neu lädt) – die aktuelle Aktion setzt bei Bedarf
    // gleich danach ihre eigene, aktuelle Meldung.
    state.notice = null;
    // Jede andere Aktion (Wert wählen, Tag/Tab wechseln, ...) schließt ein offenes
    // Zeilen-Menü mit - die Menüpunkte selbst lesen ihr Ziel aus el.dataset, nicht aus
    // state.rowMenu.
    if (action !== 'row-menu') state.rowMenu = null;

    if (action === 'pick-date') {
      // Finger: das Gerät öffnet seinen Kalender selbst. Maus: Chrome/Edge täten es nur über
      // das kleine Kalender-Symbol, das hier unsichtbar ist.
      if (lastPointerType === 'mouse') { try { el.showPicker(); } catch { /* ältere Browser: Tastatur-Eingabe */ } }
      return;
    }
    if (action === 'onb-mode') {
      setOnbMode(el.dataset.mode);
      setOnbInProgress(true);
      rememberOnbIncludesInstall();
      // Von der Einstiegsfrage aus erst die persönliche Nachricht; in der frisch installierten
      // App (iPhone) kam sie schon im Browser, dort direkt weiter.
      state.authMode = state.authMode === 'mode' ? 'intro' : 'signup';
      render();
      document.querySelector('.auth-box h1, .auth-box .sub')?.focus({ preventScroll: true });
    } else if (action === 'avg-info') {
      state.notice = { type: 'ok', text: el.dataset.text };
      render();
    } else if (action === 'group-tip-hide') {
      try { localStorage.setItem('groupTipDismissed', 'true'); } catch { /* dann eben nur bis zum Neuladen */ }
      render();
      document.querySelector('[data-action="group-new"]')?.focus({ preventScroll: true });
    } else if (action === 'today-intro-next') {
      // Ohne data-Merkmal für "letzte Karte", damit der Fokus beim Weiterblättern auf dem
      // Knopf bleibt (restoreFocus findet ihn über data-action).
      const lastStep = (isGuided() ? 3 : 1) - 1;
      if ((state.todayIntroStep || 0) >= lastStep) { setTodayIntroPending(false); state.todayIntroStep = 0; }
      else state.todayIntroStep = (state.todayIntroStep || 0) + 1;
      render();
    } else if (action === 'check-mail-done') {
      // Die Hilfe beim Anmelden erscheint wieder, falls die Adresse doch noch nicht bestätigt ist.
      state.confirmEmailFor = null;
      state.confirmResend = null;
      state.authMode = 'signin';
      render();
      document.querySelector('.auth-box .sub')?.focus({ preventScroll: true });
    } else if (action === 'auth-choose') {
      // Wer "Ich habe schon ein Konto" wählt, richtet kein neues Konto ein.
      if (el.dataset.mode === 'signin' && ['welcome', 'installed'].includes(state.authMode)) setOnbInProgress(false);
      state.authMode = el.dataset.mode;
      state.authError = null;
      state.notice = null;
      render();
      // Neue Seite: Fokus auf ihren Titel (nicht ins E-Mail-Feld - das öffnete auf dem Handy
      // sofort die Tastatur).
      document.querySelector(['welcome', 'mode', 'intro', 'overview', 'installed'].includes(state.authMode) ? '.auth-box h1' : '.auth-box .sub')?.focus({ preventScroll: true });
    } else if (action === 'resend-confirm') {
      if (state.confirmEmailFor && state.confirmResend !== 'sending') resendConfirmEmail();
    } else if (action === 'start-forgot') {
      state.authMode = 'forgot';
      state.authError = null;
      render();
    } else if (action === 'cancel-forgot') {
      state.authMode = 'signin';
      state.authError = null;
      render();
    } else if (action === 'toggle-recovery-fallback') {
      state.recoveryFallbackConfirm = !state.recoveryFallbackConfirm;
      state.authError = null;
      render();
    } else if (action === 'spare-key-method') {
      const shown = state.recoveryKeyToShow;
      if (!shown) return;
      shown.method = el.dataset.method;
      shown.used = true;
      shown.ask = false;
      if (shown.method === 'copy') {
        try {
          await navigator.clipboard.writeText(formatRecoveryKey(shown.hex));
        } catch {
          state.notice = { type: 'error', text: t('recoveryDisplay.copyFailed') };
        }
      } else if (shown.method === 'file') {
        const blob = new Blob(
          [`${t('recoveryDisplay.fileTitle')}\n${formatRecoveryKey(shown.hex)}\n\n${t('recoveryDisplay.fileBody')}\n`],
          { type: 'text/plain' }
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = t('recoveryDisplay.fileName');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60_000); // siehe handleExportData
      }
      render();
    } else if (action === 'spare-key-done') {
      const shown = state.recoveryKeyToShow;
      if (!shown) return;
      // Ohne benutzten Weg - oder nach "Aufschreiben", wo die App nicht sehen kann, ob es
      // passiert ist - einmal freundlich nachfragen.
      if (!shown.used || shown.method === 'write') {
        shown.ask = true;
        render();
        document.querySelector('.spare-key-ask .auth-submit')?.focus();
        return;
      }
      await confirmSpareKey();
    } else if (action === 'spare-key-ask-back') {
      if (state.recoveryKeyToShow) state.recoveryKeyToShow.ask = false;
      render();
    } else if (action === 'spare-key-finish') {
      await confirmSpareKey();
    } else if (action === 'regenerate-recovery-key') {
      runtime.modalTriggerSelector = '[data-action="regenerate-recovery-key"]';
      state.regenKeyConfirm = true;
      state.menuOpen = false;
      render();
    } else if (action === 'regen-key-cancel') {
      state.regenKeyConfirm = false;
      render();
      restoreModalFocus();
    } else if (action === 'regen-key-confirm') {
      state.regenKeyConfirm = false;
      runtime.modalTriggerSelector = null; // danach kommt die Anzeige des neuen Schlüssels
      await regenerateRecoveryKey();
    } else if (action === 'logout-arm') {
      runtime.modalTriggerSelector = '[data-action="logout-arm"]';
      state.logoutConfirm = true;
      state.menuOpen = false;
      render();
    } else if (action === 'logout-cancel') {
      state.logoutConfirm = false;
      render();
      restoreModalFocus();
    } else if (action === 'logout') {
      state.logoutConfirm = false;
      runtime.modalTriggerSelector = null;
      flushAllDaySaves(); // ausstehende Text-Feld-Speicherungen noch mit dem Schlüssel verschicken
      await endPushForThisDevice();
      clearCurrentDek();
      state.authEmail = '';
      state.authPassword = '';
      state.authPasswordVisible = false;
      await supabase.auth.signOut();
    } else if (action === 'dismiss-install-hint') {
      try { localStorage.setItem('installHintDismissed', 'true'); } catch { /* egal, blendet dann halt nicht dauerhaft aus */ }
      render();
    } else if (action === 'toggle-menu') {
      state.menuOpen = !state.menuOpen;
      render();
    } else if (action === 'onb-display-toggle') {
      state.onbDisplayOpen = !state.onbDisplayOpen;
      render();
    } else if (action === 'text-size-set') {
      setTextSize(el.dataset.size);
      render();
    } else if (action === 'theme-set') {
      setThemeOverride(el.dataset.theme || null);
      render();
    } else if (action === 'open-manage') {
      enterSubpage('manage');
      render();
    } else if (action === 'leave-form-stay') {
      closeModals();
      render();
      restoreModalFocus();
    } else if (action === 'leave-form-discard') {
      const proceed = runtime.pendingFormLeave;
      closeModals();
      runtime.modalTriggerSelector = null; // die Ebene darunter ist gleich weg, render() fokussiert neu
      proceed?.();
      render();
    } else if (action === 'open-settings' || action === 'open-about' || action === 'open-feedback' || action === 'open-install') {
      // Aus einem geänderten Feld-/Gruppen-Formular heraus erst nachfragen (enterSubpage schließt es).
      const view = action.slice('open-'.length);
      leaveFormGuarded(() => enterSubpage(view));
      render();
    } else if (action === 'open-settings-at') {
      enterSubpage('settings');
      render();
      focusSettingsTarget(el.dataset.target);
    } else if (action === 'whats-new-close') {
      closeWhatsNew();
      render();
    } else if (action === 'whats-new-all') {
      closeWhatsNew();
      enterSubpage('about');
      runtime.openAboutSections.add('aboutNewsCollapsed');
      render();
      requestAnimationFrame(() => document.getElementById('about-news')?.scrollIntoView({ block: 'start' }));
    } else if (action === 'feedback-submit') {
      await handleFeedbackSubmit();
    } else if (action === 'subpage-back') {
      subpageBack();
      render();
    } else if (action === 'export-data') {
      await handleExportData();
    } else if (action === 'open-password-change') {
      runtime.modalTriggerSelector = '[data-action="open-password-change"]';
      state.passwordChange = { current: '', next: '', visible: false, busy: false, error: null };
      state.menuOpen = false;
      render();
    } else if (action === 'password-change-cancel') {
      state.passwordChange = null;
      render();
      restoreModalFocus();
    } else if (action === 'password-change-visibility') {
      state.passwordChange.visible = !state.passwordChange.visible;
      render();
      document.querySelector('[data-action="password-change-visibility"]')?.focus();
    } else if (action === 'open-email-change') {
      runtime.modalTriggerSelector = '[data-action="open-email-change"]';
      state.emailChange = { value: '', password: '', busy: false, error: null, sentTo: null };
      state.menuOpen = false;
      render();
    } else if (action === 'email-change-close') {
      state.emailChange = null;
      render();
      restoreModalFocus();
    } else if (action === 'open-spare-key-check') {
      runtime.modalTriggerSelector = '[data-action="open-spare-key-check"]';
      state.spareKeyCheck = { value: '', busy: false, result: null, errorText: '' };
      state.menuOpen = false;
      render();
    } else if (action === 'spare-key-check-close') {
      state.spareKeyCheck = null;
      render();
      restoreModalFocus();
    } else if (action === 'open-delete-confirm') {
      runtime.modalTriggerSelector = '[data-action="open-delete-confirm"]';
      state.deleteConfirm = { busy: false };
      state.menuOpen = false;
      render();
    } else if (action === 'delete-confirm-cancel') {
      state.deleteConfirm = null;
      render();
      restoreModalFocus();
    } else if (action === 'delete-confirm-submit') {
      await handleDeleteAccount();
    } else if (action === 'set-view') {
      state.view = el.dataset.view;
      render();
    } else if (action === 'nav-day' || action === 'nav-week' || action === 'nav-month' || action === 'nav-year') {
      shiftPeriod(Number(el.dataset.dir));
      render();
      // render() ersetzt den Pfeil - Fokus zurück, damit man per Tastatur weiterblättern kann.
      document.querySelector(`[data-action="${action}"][data-dir="${el.dataset.dir}"]`)?.focus({ preventScroll: true });
    } else if (action === 'jump-today') {
      const today = startOfDay(new Date());
      runtime.pendingPeriodSlide = today > state.currentDate ? 1 : -1;
      state.currentDate = today;
      render();
    } else if (action === 'open-day') {
      if (isFutureKey(el.dataset.date)) return;
      state.currentDate = parseDateKey(el.dataset.date);
      state.view = 'today';
      render();
      if (el.dataset.focusHabit) focusTodayField(el.dataset.focusHabit);
    } else if (action === 'select') {
      const dateKey = formatKey(state.currentDate);
      const value = JSON.parse(el.dataset.value);
      handleSelect(dateKey, el.dataset.habit, value);
    } else if (action === 'multi-toggle' || action === 'multi-none') {
      handleMultiToggle(formatKey(state.currentDate), el.dataset.habit, action === 'multi-none' ? null : el.dataset.option);
    } else if (action === 'reset-day-arm') {
      // Das Menü ist nach dem Dialog zu - der Fokus kehrt deshalb auf dessen ⋮ zurück.
      runtime.modalTriggerSelector = `.row-menu-trigger[data-menu="${DAY_MENU_KEY}"]`;
      state.resetConfirm = formatKey(state.currentDate);
      render();
    } else if (action === 'reset-day-cancel') {
      state.resetConfirm = null;
      render();
      restoreModalFocus();
    } else if (action === 'reset-day-confirm') {
      const dateKey = state.resetConfirm;
      state.resetConfirm = null;
      handleReset(dateKey);
      restoreModalFocus();
    } else if (action === 'note-edit') {
      openNoteEditor(el.dataset.note);
    } else if (action === 'note-save') {
      closeNoteEditor(true);
    } else if (action === 'note-cancel') {
      closeNoteEditor(false);
    } else if (action === 'counter-step') {
      handleCounterStep(formatKey(state.currentDate), el.dataset.habit, Number(el.dataset.dir));
    } else if (action === 'time-pick') {
      // Leer startet die Auswahl bei "jetzt" - heute und gestern (nach Mitternacht am Vortag =
      // heute Nacht); an älteren Tagen ergäbe "jetzt" keinen Sinn, dort nur die Uhrzeit.
      const dateKey = formatKey(state.currentDate);
      const h = state.habits.find((x) => x.id === el.dataset.habit);
      if (!h) return;
      const now = new Date();
      const yesterday = dateKey === formatKey(addDays(startOfDay(now), -1));
      const nowAllowed = yesterday || dateKey === formatKey(now);
      const old = state.entries[dateKey]?.[h.id];
      const has = typeof old === 'number';
      openTimePicker({
        title: h.name, dateKey, step: 1, nowAllowed, triggerId: el.id,
        value: has ? old : nowAllowed ? timeValueOn(dateKey, now) : now.getHours() * 60 + now.getMinutes(),
        onPick: (v) => handleSetValue(dateKey, h.id, v),
        onClear: has ? () => { handleClearValue(dateKey, h.id); flushDaySave(dateKey); } : null,
      });
    } else if (action === 'reminder-time-pick') {
      const labelId = (el.getAttribute('aria-labelledby') || '').split(' ')[0];
      openTimePicker({
        title: (labelId && document.getElementById(labelId)?.textContent.trim()) || t('time.label'),
        step: REMINDER_TIME_STEP, value: Number(el.dataset.value), triggerId: el.id,
        onPick: (v) => reminderTimePicked(el.id, v),
      });
    } else if (action === 'clear-value') {
      handleClearValue(formatKey(state.currentDate), el.dataset.habit);
    } else if (action === 'preview-select') {
      // Wie in "Heute": derselbe Wert nochmal entfernt ihn wieder.
      const v = JSON.parse(el.dataset.value);
      setPreviewValue(state.habitForm && effectivePreviewValue(state.habitForm) === v ? null : v, `[data-value='${JSON.stringify(v)}']`);
    } else if (action === 'preview-clear') {
      setPreviewValue(null, '.value-slider');
    } else if (action === 'enable-push') {
      enablePush();
    } else if (action === 'disable-push') {
      disablePush();
    } else if (action === 'today-new-field') {
      enterSubpage('manage');
      openHabitForm({ ...newHabitForm(), returnToTab: true });
    } else if (action === 'today-starter-package') {
      enterSubpage('manage');
      openHabitForm({ ...newHabitForm(), ...packageFormState(), returnToTab: true });
    } else if (action === 'row-menu') {
      if (state.rowMenu === el.dataset.menu) closeRowMenu();
      else openRowMenu(el.dataset.menu);
    } else if (action === 'section-menu-edit') {
      enterSubpage('manage');
      openSectionForm(el.dataset.id, { returnToTab: true });
    } else if (action === 'row-menu-edit') {
      // Gleiches Muster wie der "+ Neues Feld"-Shortcut: returnToTab führt nach
      // Speichern/Abbrechen zurück nach "Heute" statt in der Verwaltung zu bleiben.
      const h = state.habits.find((x) => x.defId === el.dataset.id);
      if (h) {
        enterSubpage('manage');
        openHabitForm({ ...habitToForm(h), returnToTab: true });
      }
    } else if (action === 'row-menu-archive') {
      // Anders als in der Verwaltung verschwindet das Feld hier einfach aus der Liste -
      // die Meldung sagt, wo es wieder zu finden ist.
      if (await handleHabitArchive(el.dataset.id, true)) {
        state.notice = { type: 'ok', text: t('notice.fieldArchived') };
        render();
      }
    } else if (action === 'habit-new') {
      openHabitForm(newHabitForm());
    } else if (action === 'group-new') {
      openSectionForm(null);
    } else if (action === 'section-edit') {
      openSectionForm(el.dataset.id);
    } else if (action === 'section-form-save') {
      await saveSectionForm();
    } else if (action === 'section-form-cancel') {
      closeSectionForm();
      render();
    } else if (action === 'habit-edit') {
      const h = state.habits.find((x) => x.defId === el.dataset.id);
      if (h) openHabitForm(habitToForm(h));
    } else if (action === 'habit-reveal-next') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      if (f.revealStage === 1 && !f.name.trim()) {
        state.notice = { type: 'error', text: t('habitForm.error.nameRequired') };
        render();
        document.getElementById('habit-form-name')?.focus();
        return;
      }
      f.revealStage = Math.min(3, f.revealStage + 1);
      render();
      // Zum neu aufgedeckten Teil scrollen und dort den Fokus setzen.
      const target = document.getElementById(f.revealStage === 2 ? 'habit-form-kind-field' : 'habit-form-details');
      target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      (f.revealStage === 2 ? target?.querySelector('[aria-pressed="true"]') : document.querySelector('#habit-form .form-part[aria-labelledby="habit-form-part-entry"] :is(button, input)'))?.focus({ preventScroll: true });
    } else if (action === 'habit-convert-counter') {
      syncHabitFormFromDom();
      state.habitForm.convertConfirm = true;
      render();
      document.querySelector('[data-action="habit-convert-cancel"]')?.focus();
    } else if (action === 'habit-convert-cancel') {
      state.habitForm.convertConfirm = false;
      render();
      document.querySelector('[data-action="habit-convert-counter"]')?.focus();
    } else if (action === 'habit-convert-confirm') {
      await convertHabitToCounter(state.habitForm.defId);
    } else if (action === 'step-edit-open') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h) return;
      f.stepEdit = { steps: h.max - h.min + 1, labels: h.labels ? [...h.labels] : null, preset: 'spread', map: {}, confirm: false };
      applyStepEditPreset(h, f.stepEdit);
      f.stepEdit.initial = stepEditKey(f.stepEdit);
      render();
      // Auf die Überschrift, nicht ins Zahlenfeld - dort ginge auf dem Handy sofort die Tastatur auf.
      document.getElementById('step-dialog-title')?.focus();
    } else if (action === 'type-edit-open') {
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h || !typeChangeTargets(h).length || typeChangeBlocker(h)) return;
      // Nach der Umwandlung wird das Formular neu aus dem Feld aufgebaut - andere Eingaben gingen verloren.
      if (openFormHasChanges()) {
        state.notice = { type: 'error', text: t('typeEdit.error.dirty') };
        render();
        return;
      }
      f.typeEdit = { kind: null, steps: 5, preset: 'round', unit: '', map: {}, confirm: false };
      typeEditKindChanged(h, f.typeEdit, typeChangeTargets(h)[0]);
      f.typeEdit.initial = typeEditKey(f.typeEdit);
      render();
      document.getElementById('step-dialog-title')?.focus();
    } else if (action === 'type-edit-kind' || action === 'type-edit-preset') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h || !f.typeEdit) return;
      if (action === 'type-edit-kind') typeEditKindChanged(h, f.typeEdit, el.dataset.kind);
      else {
        f.typeEdit.preset = el.dataset.preset;
        applyTypeEditPreset(h, f.typeEdit);
      }
      render();
      const attr = action === 'type-edit-kind' ? `data-kind="${el.dataset.kind}"` : `data-preset="${el.dataset.preset}"`;
      document.querySelector(`[data-action="${action}"][${attr}]`)?.focus();
    } else if (action === 'type-edit-apply') {
      syncHabitFormFromDom();
      const te = state.habitForm.typeEdit;
      if (!te) return;
      const { error } = typeEditFinalMap(te);
      if (error) state.notice = { type: 'error', text: t(error) };
      else te.confirm = true;
      render();
      document.querySelector(te.confirm ? '[data-action="type-edit-confirm-cancel"]' : '[data-action="type-edit-apply"]')?.focus();
    } else if (action === 'type-edit-confirm-cancel') {
      state.habitForm.typeEdit.confirm = false;
      render();
      document.querySelector('[data-action="type-edit-apply"]')?.focus();
    } else if (action === 'type-edit-confirm') {
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h || !f.typeEdit?.confirm) return; // zweiter Tipp
      const te = f.typeEdit;
      const { map } = typeEditFinalMap(te);
      const to = typeEditTo(h, te);
      const extra = te.kind === 'scale' ? { preset: te.preset === 'custom' ? 'round' : te.preset, range: usedValueRange(h) } : {};
      f.typeEdit = null;
      f.typeRunning = true;
      finishStepChangeAction(f, await startStepChange(h.defId, to, map, extra), 'typeEdit.done', true);
    } else if (action === 'step-edit-cancel') {
      syncHabitFormFromDom();
      const wasType = !!state.habitForm.typeEdit;
      state.habitForm.stepEdit = null;
      state.habitForm.typeEdit = null;
      render();
      document.querySelector(wasType ? '[data-action="type-edit-open"]' : '[data-action="step-edit-open"]')?.focus();
    } else if (action === 'step-edit-preset') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h || !f.stepEdit) return;
      f.stepEdit.preset = el.dataset.preset;
      applyStepEditPreset(h, f.stepEdit);
      render();
      document.querySelector(`[data-action="step-edit-preset"][data-preset="${el.dataset.preset}"]`)?.focus();
    } else if (action === 'step-edit-apply') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h || !f.stepEdit) return;
      const se = f.stepEdit;
      if (se.labels && se.labels.some((l) => !l.trim())) {
        state.notice = { type: 'error', text: t('habitForm.error.fillAllLabels') };
      } else if (stepEditNothingToDo(h, se)) {
        state.notice = { type: 'error', text: t('stepEdit.error.nothing') };
      } else {
        se.confirm = true;
      }
      render();
      document.querySelector(se.confirm ? '[data-action="step-edit-confirm-cancel"]' : '[data-action="step-edit-apply"]')?.focus();
    } else if (action === 'step-edit-confirm-cancel') {
      state.habitForm.stepEdit.confirm = false;
      render();
      document.querySelector('[data-action="step-edit-apply"]')?.focus();
    } else if (action === 'step-edit-confirm') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h || !f.stepEdit) return;
      const to = stepEditTo(h, f.stepEdit);
      const map = { ...f.stepEdit.map };
      f.stepEdit = null;
      finishStepChangeAction(f, await startStepChange(h.defId, to, map), 'stepEdit.done');
    } else if (action === 'step-edit-resume') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const sc = state.habits.find((x) => x.defId === f.defId)?.stepChange;
      const type = !!sc && isTypeChange(sc);
      if (type) f.typeRunning = true;
      const doneKey = sc?.state === 'undo' ? (type ? 'typeEdit.undoDone' : 'stepEdit.undoDone') : (type ? 'typeEdit.done' : 'stepEdit.done');
      finishStepChangeAction(f, await runStepChange(f.defId), doneKey, type);
    } else if (action === 'step-undo') {
      syncHabitFormFromDom();
      state.habitForm.stepUndoConfirm = true;
      render();
      document.querySelector('[data-action="step-undo-cancel"]')?.focus();
    } else if (action === 'step-undo-cancel') {
      state.habitForm.stepUndoConfirm = false;
      render();
      document.querySelector('[data-action="step-undo"]')?.focus();
    } else if (action === 'step-undo-confirm') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      if (!f.stepUndoConfirm) return; // zweiter Tipp
      f.stepUndoConfirm = false;
      const sc = state.habits.find((x) => x.defId === f.defId)?.stepChange;
      const type = !!sc && isTypeChange(sc);
      if (type) f.typeRunning = true;
      finishStepChangeAction(f, await startStepChangeUndo(f.defId), type ? 'typeEdit.undoDone' : 'stepEdit.undoDone', type);
    } else if (action === 'habit-cancel') {
      closeHabitForm();
      render();
    } else if (action === 'habit-kind') {
      syncHabitFormFromDom();
      state.habitForm.kind = el.dataset.kind;
      render();
    } else if (action === 'section-toggle') {
      const { section, scope } = el.dataset;
      if (el.getAttribute('aria-expanded') === 'false') expandSection(scope, section);
      else setSectionCollapsed(scope, section, true);
      render();
      document.querySelector(`[data-action="section-toggle"][data-section="${section}"][data-scope="${scope}"]`)?.focus();
    } else if (action === 'section-delete-arm') {
      state.sectionDeleteConfirm = el.dataset.id;
      render();
    } else if (action === 'section-delete-cancel') {
      state.sectionDeleteConfirm = null;
      render();
    } else if (action === 'section-delete') {
      await deleteSection(el.dataset.id);
    } else if (action === 'computed-type') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      if (f.computedType !== el.dataset.type) {
        f.computedType = el.dataset.type;
        // Mitglieder der anderen Art passen nicht mehr - raus damit.
        f.members = f.members.filter((key) => {
          const h = state.habits.find((x) => x.id === key);
          // "Dauer" wählt seine zwei Felder über eigene Auswahllisten (durationFrom/To).
          return h && f.computedType !== 'duration' && f.computedType !== 'since' && (f.computedType === 'number' ? h.kind === 'number' : h.kind === 'scale');
        });
      }
      render();
      document.querySelector(`[data-action="computed-type"][data-type="${el.dataset.type}"]`)?.focus();
    } else if (action === 'multi-option-add') {
      syncHabitFormFromDom();
      const option = { id: newMultiOptionId(), label: '' };
      state.habitForm.multiOptions.push(option);
      render();
      document.getElementById(`habit-form-multi-option-${option.id}`)?.focus();
    } else if (action === 'multi-option-remove') {
      syncHabitFormFromDom();
      state.habitForm.multiOptions = state.habitForm.multiOptions.filter((o) => o.id !== el.dataset.option);
      render();
      app.querySelector('[data-action="multi-option-add"]')?.focus();
    } else if (action === 'multi-option-hide') {
      syncHabitFormFromDom();
      const option = state.habitForm.multiOptions.find((o) => o.id === el.dataset.option);
      if (option) option.hidden = !option.hidden;
      render();
    } else if (action === 'tpl-pick') {
      startTemplateConfirm(state.habitForm, el.dataset.template);
      if (templateById(el.dataset.template).direct) {
        adjustTemplate(state.habitForm);
        render();
        window.scrollTo(0, 0);
        document.getElementById('habit-form-name')?.focus();
        return;
      }
      render();
      window.scrollTo(0, 0);
      document.getElementById(`tpl-name-${templateById(el.dataset.template).slots[0].slot}`)?.focus({ preventScroll: true });
    } else if (action === 'tpl-good') {
      readTemplateFromDom(state.habitForm);
      state.habitForm.template.answers.good = el.dataset.good || null;
      render();
    } else if (action === 'pkg-single') {
      state.habitForm.template = { stage: 'pick' };
      render();
      window.scrollTo(0, 0);
    } else if (action === 'tpl-package') {
      if (state.habitForm.packageChosen) state.habitForm.template = { stage: 'package' };
      else Object.assign(state.habitForm, packageFormState());
      render();
      window.scrollTo(0, 0);
    } else if (action === 'pkg-create') {
      if (state.habitFormSaving) return;
      state.habitFormSaving = true;
      render();
      let result;
      try { result = await createStarterPackage(state.habitForm.packageChosen); } finally { state.habitFormSaving = false; }
      if (result.notice) state.notice = result.notice;
      else {
        closeHabitForm();
        if (state.tutorialStep === TUTORIAL_STEP_FIELD) {
          runtime.tutorialLastFieldDefId = result.habits[0]?.defId ?? null;
          state.tutorialStep = TUTORIAL_STEP_DONE;
        } else {
          state.notice = { type: 'ok', text: tPlain(result.habits.length === 1 ? 'pkg.createdOne' : 'pkg.created', { count: result.habits.length }) };
        }
      }
      render();
    } else if (action === 'tpl-custom') {
      delete state.habitForm.template;
      render();
      window.scrollTo(0, 0);
      document.getElementById('habit-form-name')?.focus();
    } else if (action === 'tpl-back') {
      state.habitForm.template = { stage: 'pick' };
      render();
      window.scrollTo(0, 0);
    } else if (action === 'tpl-adjust') {
      adjustTemplate(state.habitForm);
      render();
      window.scrollTo(0, 0);
    } else if (action === 'tpl-create') {
      if (state.habitFormSaving) return;
      readTemplateFromDom(state.habitForm);
      state.habitFormSaving = true;
      render();
      let result;
      try { result = await createFromTemplate(state.habitForm); } finally { state.habitFormSaving = false; }
      if (result.notice) state.notice = result.notice;
      else if (result.followUp) {
        closeHabitForm();
        openTemplateFollowUp(result.followUp);
      } else if (result.merged) {
        closeHabitForm();
        const m = result.merged;
        state.notice = {
          type: m.notArchived ? 'error' : 'ok',
          text: m.notArchived
            ? tPlain('tpl.error.mergeArchive', { fields: m.notArchived.join(', ') })
            : tPlain('tpl.merged', { names: result.habits.map((h) => h.name).join(', '), fields: m.names.join(', ') }),
          action: {
            label: t('notice.undo'),
            run: async () => {
              await undoTemplateMerge(m);
              state.notice = { type: 'ok', text: tPlain('tpl.mergeUndone') };
              render();
            },
          },
        };
      } else {
        closeHabitForm();
        state.notice = { type: 'ok', text: tPlain('tpl.created', { names: result.habits.map((h) => h.name).join(', ') }) };
        if (state.tutorialStep === TUTORIAL_STEP_FIELD) {
          // "Zurück" von "Geschafft" öffnet das erste angelegte Feld, nicht ein berechnetes am Ende.
          runtime.tutorialLastFieldDefId = result.habits[0].defId;
          state.tutorialStep = TUTORIAL_STEP_DONE;
        }
      }
      render();
    } else if (action === 'since-value') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const v = Number(el.dataset.value);
      f.sinceValues = f.sinceValues.includes(v) ? f.sinceValues.filter((x) => x !== v) : [...f.sinceValues, v].sort((a, b) => a - b);
      render();
      document.querySelector(`[data-action="since-value"][data-value="${v}"]`)?.focus();
    } else if (action === 'since-mode') {
      syncHabitFormFromDom();
      state.habitForm.sinceMode = el.dataset.mode === 'start' ? 'start' : 'last';
      render();
      document.querySelector(`[data-action="since-mode"][data-mode="${el.dataset.mode}"]`)?.focus();
    } else if (action === 'habit-reminder-add') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      // Neue Zeit: eine Stunde nach der letzten; geht das nicht (spät abends), die erste volle
      // Stunde, die noch frei ist - nie eine schon vorhandene Zeit.
      const last = f.reminderTimes[f.reminderTimes.length - 1];
      const next = last + 60 <= 1425 && !f.reminderTimes.includes(last + 60) ? last + 60
        : Array.from({ length: 24 }, (_, h) => h * 60).find((m) => !f.reminderTimes.includes(m));
      f.reminderTimes = [...f.reminderTimes, next];
      // Bedingung der neuen Zeit: wie die letzte (alle oder keine brauchen eine Zahl).
      f.reminderBelow = [...f.reminderBelow, f.reminderBelow[f.reminderBelow.length - 1] ?? ''];
      render();
      const i = f.reminderTimes.length - 1;
      document.getElementById(`habit-form-reminder-time-${i}`)?.focus();
    } else if (action === 'habit-reminder-remove') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const i = Number(el.dataset.index);
      f.reminderTimes = f.reminderTimes.filter((_, j) => j !== i);
      f.reminderBelow = f.reminderBelow.filter((_, j) => j !== i);
      render();
      // Fokus nicht ins Leere: auf die Zeile, die jetzt an dieser Stelle steht (sonst die letzte).
      // Ohne Zeiten mehr: auf "+ Weitere Zeit".
      const rest = document.getElementById(`habit-form-reminder-time-${Math.min(i, f.reminderTimes.length - 1)}`);
      (rest || document.querySelector('[data-action="habit-reminder-add"]'))?.focus();
    } else if (action === 'habit-schedule-mode') {
      syncHabitFormFromDom();
      state.habitForm.schedule.mode = el.dataset.mode;
      render();
      document.querySelector(`[data-action="habit-schedule-mode"][data-mode="${el.dataset.mode}"]`)?.focus();
    } else if (action === 'habit-schedule-day') {
      syncHabitFormFromDom();
      const sch = state.habitForm.schedule;
      const day = Number(el.dataset.day);
      sch.days = sch.days.includes(day) ? sch.days.filter((d) => d !== day) : [...sch.days, day];
      render();
      // render() baut das Formular neu auf - Fokus zurück auf denselben Button, sonst
      // landet man per Tastatur nach jedem Umschalten wieder am Seitenanfang.
      document.querySelector(`[data-action="habit-schedule-day"][data-day="${el.dataset.day}"]`)?.focus();
    } else if (action === 'habit-good') {
      syncHabitFormFromDom();
      state.habitForm.good = el.dataset.good || null;
      render();
    } else if (action === 'habit-entry-mode') {
      syncHabitFormFromDom();
      state.habitForm.kind = el.dataset.kind;
      render();
    } else if (action === 'habit-summary') {
      syncHabitFormFromDom();
      state.habitForm.summary = el.dataset.summary === 'sum' ? 'sum' : 'avg';
      render();
      document.querySelector(`[data-action="habit-summary"][data-summary="${state.habitForm.summary}"]`)?.focus();
    } else if (action === 'habit-numgoal') {
      syncHabitFormFromDom();
      state.habitForm.numberGoalDir = el.dataset.dir || null;
      render();
      if (state.habitForm.numberGoalDir) document.getElementById('habit-form-numgoal-value')?.focus();
    } else if (action === 'habit-numgoal-scope') {
      syncHabitFormFromDom();
      state.habitForm.numberGoalScope = el.dataset.scope === 'week' ? 'week' : 'day';
      render();
      document.querySelector(`[data-action="habit-numgoal-scope"][data-scope="${state.habitForm.numberGoalScope}"]`)?.focus();
    } else if (action === 'habit-period') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      f.period = el.dataset.period;
      f.periodReminderDay = null; // Standardtag des neuen Zeitraums
      if (f.period !== 'day') { f.sectionId = null; f.schedule = scheduleToForm(null); }
      render();
    } else if (action === 'habit-start') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const steps = habitFormStepCount(f);
      f.min = Number(el.dataset.start) === 0 ? 0 : 1;
      f.max = f.min + steps - 1;
      render();
    } else if (action === 'habit-display-style') {
      syncHabitFormFromDom();
      const f = state.habitForm;
      f.displayStyle = el.dataset.style;
      clampHabitFormSteps(f);
      f.labels = resizeLabels(f.labels, habitFormStepCount(f), f.labelsEnabled ? (i) => String(habitFormStepValue(f, i)) : undefined);
      render();
    } else if (action === 'habit-steps-to-slider') {
      // Am Deckel für gezielt wählbare Stufen (siehe atChoiceCap in renderHabitForm):
      // Schieberegler ohne Bezeichnungen, danach direkt weiter hochzählen können. Die
      // Bezeichnungs-Texte bleiben im Formular-Zustand erhalten (resizeLabels), falls man
      // zurückwechselt.
      syncHabitFormFromDom();
      const f = state.habitForm;
      f.displayStyle = 'slider';
      f.labelsEnabled = false;
      render();
      document.getElementById('habit-form-steps')?.focus();
    } else if (action === 'stepper-inc' || action === 'stepper-dec') {
      // Nach Gedrückthalten hat stepperHold schon gezählt und gespeichert - der Klick beim
      // Loslassen darf nicht noch einen Schritt draufsetzen.
      if (runtime.stepperHoldSwallowClick) { runtime.stepperHoldSwallowClick = false; return; }
      const target = document.getElementById(el.dataset.target);
      if (!target) return;
      stepInput(target, action === 'stepper-inc' ? 1 : -1);
      target.dispatchEvent(new Event('change', { bubbles: true }));
      // Der change-Handler rendert neu und ersetzt dabei den Knopf - Fokus zurück, damit man
      // per Tastatur weiterzählen kann.
      document.querySelector(`[data-action="${action}"][data-target="${el.dataset.target}"]`)?.focus({ preventScroll: true });
    } else if (action === 'habit-save') {
      await handleHabitSave();
    } else if (action === 'habit-archive') {
      await handleHabitArchive(el.dataset.id, true);
    } else if (action === 'habit-reactivate') {
      await handleHabitArchive(el.dataset.id, false);
    } else if (action === 'habit-delete-arm') {
      state.habitDeleteConfirm = el.dataset.id;
      render();
    } else if (action === 'habit-delete-cancel') {
      state.habitDeleteConfirm = null;
      render();
    } else if (action === 'habit-delete') {
      state.habitDeleteConfirm = null;
      await handleHabitDelete(el.dataset.id);
    } else if (action === 'habit-move' && el.closest('.manage-item')?.dataset.orderType === 'habit') {
      // Tastatur-/Klick-Alternative zum Ziehen für ein Feld, auch in/aus Gruppen
      // (fieldMoveStep); speichert über denselben Pfad wie das Ziehen (commitLayoutOrder).
      const defId = el.closest('.manage-item').dataset.orderId;
      const before = state.habits.find((h) => h.defId === defId)?.sectionId ?? null;
      const step = fieldMoveStep(defId, el.dataset.dir);
      if (!step) return;
      await commitLayoutOrder(step.items);
      // Fokus auf denselben Button am neuen Platz (render() hat das DOM ersetzt); ist er dort
      // gesperrt (ganz oben/unten), auf den anderen.
      const btn = (dir) => document.querySelector(`.manage-item[data-order-id="${defId}"] [data-action="habit-move"][data-dir="${dir}"]`);
      const target = btn(el.dataset.dir);
      (target && !target.disabled ? target : btn(el.dataset.dir === 'up' ? 'down' : 'up'))?.focus();
      // Wechsel des Behälters ansagen - sonst merkt man ohne Blick nicht, dass das Feld jetzt
      // in einer Gruppe steht bzw. sie verlassen hat.
      if (step.sectionId !== before) {
        const sec = state.sections.find((x) => x.id === step.sectionId);
        announce(sec ? tPlain('manage.movedIntoGroup', { name: sec.name }) : tPlain('manage.movedOutOfGroup'));
      }
    } else if (action === 'habit-move') {
      // Gruppen-Block: nur auf der obersten Ebene. Liest wie der Drag-Handler die aktuellen
      // Geschwister direkt aus dem DOM, damit beide Wege exakt dieselbe Reihenfolge berechnen
      // und über commitLayoutOrder() denselben Persistenz-Pfad nutzen.
      const rowEl = el.closest('.manage-item');
      const rows = [...rowEl.parentElement.children].filter((r) => r.classList.contains('manage-item'));
      const fromIndex = rows.indexOf(rowEl);
      const toIndex = el.dataset.dir === 'up' ? fromIndex - 1 : fromIndex + 1;
      if (toIndex < 0 || toIndex >= rows.length) return;
      const reordered = [...rows];
      const [movedEl] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, movedEl);
      await commitLayoutOrder(reordered.map((r) => ({ type: r.dataset.orderType, id: r.dataset.orderId })));
      // Fokus auf denselben Button am neuen Platz (render() hat das DOM ersetzt).
      document.querySelector(`.manage-item[data-order-id="${rowEl.dataset.orderId}"] [data-action="habit-move"][data-dir="${el.dataset.dir}"]`)?.focus();
    } else if (action === 'install-prompt') {
      // Android/Chrome: echter Installations-Dialog statt Anleitung (beforeinstallprompt).
      if (!runtime.deferredInstallPrompt) return;
      runtime.deferredInstallPrompt.prompt();
      const { outcome } = await runtime.deferredInstallPrompt.userChoice;
      runtime.deferredInstallPrompt = null;
      if (outcome === 'accepted') runtime.appJustInstalled = true;
      render();
    } else if (action === 'install-gate-skip') {
      try { localStorage.setItem('installGateSkipped', 'true'); } catch { /* dann eben nur für diesen Besuch */ }
      runtime.installGateSkippedThisVisit = true;
      render();
    } else if (action === 'spam-feedback') {
      // Ohne render(): auf der Passwort-Seite ginge sonst ein schon getipptes Passwort verloren.
      runtime.spamFeedbackAnswered = true;
      const box = el.closest('.spam-feedback');
      box.innerHTML = `<p class="spam-feedback-q" role="status" tabindex="-1">${t('spamFeedback.thanks')}</p>`;
      box.querySelector('[role="status"]').focus();
      supabase.rpc('record_signup_mail_feedback', { p_in_spam: el.dataset.inSpam === 'true' })
        .then(() => {}, () => {}); // best effort - eine fehlende Rückmeldung ist kein Problem für den Nutzer
    } else if (action === 'confirm-landing-continue') {
      state.confirmLanding = false;
      render();
    } else if (action === 'tutorial-next') {
      state.tutorialStep = Math.min(TUTORIAL_STEP_REMINDERS, state.tutorialStep + 1);
      render();
    } else if (action === 'tutorial-back') {
      // Gibt neuen Nutzern Vertrauen ("kann ich aus Versehen zu weit geklickt haben?"),
      // obwohl technisch nichts verloren geht — jede Einstellung lässt sich später über
      // Menü/Formular erneut ändern. state.habitForm wird mit geleert, damit beim Zurück
      // von "Geschafft" ein frisches Formular statt des schon gespeicherten erscheint.
      // Schritt 1 hat keinen Zurück-Knopf (davor liegt nichts mehr).
      // Nach "Tutorial überspringen" gibt es noch kein Feld - dann zurück zum Feld-Schritt
      // statt zu "Dein erstes Feld steht". Umgekehrt beim zweiten Feld ("Noch ein Feld
      // anlegen"): zurück zu "Geschafft", wo man herkam, nicht zum Anfang.
      // Von "Geschafft" aus öffnet Zurück das eben angelegte Feld zum Bearbeiten - ein leeres
      // Formular verleitete dazu, das Feld zum "Korrigieren" ein zweites Mal anzulegen.
      const hasField = activeHabits().length > 0;
      const justCreated = state.tutorialStep === TUTORIAL_STEP_DONE
        ? activeHabits().find((h) => h.defId === runtime.tutorialLastFieldDefId) : null;
      state.tutorialStep = state.tutorialStep === TUTORIAL_STEP_REMINDERS && !hasField ? TUTORIAL_STEP_FIELD
        : state.tutorialStep === TUTORIAL_STEP_FIELD && hasField ? TUTORIAL_STEP_DONE
        : Math.max(TUTORIAL_STEP_HELLO, state.tutorialStep - 1);
      state.habitForm = justCreated ? { ...habitToForm(justCreated), revealStage: 3 } : null;
      render();
    } else if (action === 'tutorial-add-more') {
      state.tutorialStep = TUTORIAL_STEP_FIELD;
      state.habitForm = { ...newHabitForm(), revealStage: 1 };
      render();
      document.getElementById('habit-form-name')?.focus();
    } else if (action === 'tutorial-finish') {
      await saveOnboardingCompleted();
    } else if (action === 'tutorial-skip-arm') {
      runtime.modalTriggerSelector = '[data-action="tutorial-skip-arm"]';
      state.tutorialSkipConfirm = true;
      render();
    } else if (action === 'tutorial-skip-cancel') {
      state.tutorialSkipConfirm = false;
      render();
      restoreModalFocus();
    } else if (action === 'tutorial-skip-confirm') {
      // Überspringt nur das Tutorial - die Erinnerungen sind ein eigener Schritt und kommen trotzdem.
      state.tutorialSkipConfirm = false;
      state.habitForm = null; // sonst bliebe das Feld-Formular unsichtbar weiter offen
      state.tutorialStep = TUTORIAL_STEP_REMINDERS;
      render();
    } else if (action === 'clear-input') {
      const id = el.dataset.target;
      if (id === 'email') state.authEmail = '';
      if (id === 'password') state.authPassword = '';
      render();
      document.getElementById(id)?.focus();
    } else if (action === 'toggle-password-visibility') {
      state.authPasswordVisible = !state.authPasswordVisible;
      render();
      const input = document.getElementById('password');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  });
  // Ziel-Regler im Feld-Formular: Text beim Ziehen mitführen, ohne render() (Fokus bleibt).
  app.addEventListener('input', (e) => {
    const goalSliderEl = e.target.closest?.('[data-action="goal-slider"]');
    if (!goalSliderEl || !state.habitForm) return;
    const { text, span } = goalSliderText(state.habitForm, Number(goalSliderEl.value));
    document.getElementById('habit-form-goal-text').textContent = text;
    const spanEl = document.getElementById('habit-form-goal-span');
    spanEl.textContent = span;
    spanEl.hidden = !span;
    goalSliderEl.setAttribute('aria-valuetext', text + (span ? ' · ' + span : ''));
    const lo = Number(goalSliderEl.min), hi = Number(goalSliderEl.max);
    goalSliderEl.style.setProperty('--slider-pct', ((Number(goalSliderEl.value) - lo) / (hi - lo)) * 100 + '%');
  });
  app.addEventListener('change', async (e) => {
    state.notice = null; // siehe Kommentar beim 'click'-Listener oben
    if (e.target.id === 'day-date-input') {
      if (!e.target.value) return; // "Löschen" in der Datumsauswahl: Tag bleibt
      // max= hält nicht jeder Browser ein: ein Tag in der Zukunft wird zu heute.
      const picked = isFutureKey(e.target.value) ? startOfDay(new Date()) : parseDateKey(e.target.value);
      if (formatKey(picked) === formatKey(state.currentDate)) return;
      runtime.pendingPeriodSlide = picked > state.currentDate ? 1 : -1;
      state.currentDate = picked;
      render();
      const input = document.getElementById('day-date-input');
      if (input && !focusReopensPicker(input)) input.focus({ preventScroll: true });
      return;
    }
    // Berechnetes Feld aus Zahlen: nach jeder Mitglieder-Änderung neu rendern, damit Felder mit anderer
    // Einheit gesperrt bzw. wieder freigegeben werden (siehe computedBody).
    // "Tage seit": anderes Quellfeld -> andere Stufen zur Auswahl.
    if (e.target.id?.startsWith('pkg-item-') && state.habitForm?.packageChosen) {
      const id = e.target.id;
      state.habitForm.packageChosen[id.slice('pkg-item-'.length)] = e.target.checked;
      render();
      document.getElementById(id)?.focus();
      return;
    }
    if ((e.target.id === 'tpl-group' || e.target.id?.startsWith('tpl-source-') || e.target.id?.startsWith('tpl-merge-') || e.target.id?.startsWith('tpl-extra-')) && state.habitForm?.template) {
      const id = e.target.id;
      readTemplateFromDom(state.habitForm);
      render();
      if (id.startsWith('tpl-merge-') || id.startsWith('tpl-extra-')) document.getElementById(id)?.focus();
      return;
    }
    if (e.target.id === 'habit-form-since-source' && state.habitForm) {
      syncHabitFormFromDom();
      state.habitForm.sinceValues = [];
      render();
      const select = document.getElementById('habit-form-since-source');
      if (select && !focusReopensPicker(select)) select.focus();
      return;
    }
    const memberBox = e.target.closest?.('[data-member-key]');
    if (memberBox && state.habitForm?.computedType === 'number') {
      syncHabitFormFromDom();
      render();
      document.querySelector(`[data-member-key="${CSS.escape(memberBox.dataset.memberKey)}"]`)?.focus();
      return;
    }
    const archivedStatsToggle = e.target.closest?.('[data-action="archived-stats-toggle"]');
    if (archivedStatsToggle) {
      const habit = state.habits.find((h) => h.defId === archivedStatsToggle.dataset.id);
      if (habit) {
        const id = habit.defId;
        await updateHabitPayload(habit, { archivedInStats: archivedStatsToggle.checked });
        document.querySelector(`[data-action="archived-stats-toggle"][data-id="${id}"]`)?.focus(); // render() hat das DOM ersetzt
      }
      return;
    }
    if (e.target.classList?.contains('text-field-input')) {
      flushDaySave(formatKey(state.currentDate)); // Feld verlassen: nicht erst auf den Timer warten
      return;
    }
    const numberInput = e.target.closest('[data-action="number-input"]');
    if (numberInput) {
      // Speichert beim Verlassen des Feldes (Blur/Tab-Wechsel) statt über einen
      // separaten Button — zuverlässiger als Debounce-nach-Tippen (kein Timer, der bei
      // abruptem Verlassen noch nicht abgelaufen sein könnte).
      handleSaveNumber(formatKey(state.currentDate), numberInput.dataset.habit, numberInput.value);
      return;
    }
    // Von/Bis (Buttons) oder Anzahl Stufen (Schieberegler) geändert - Bezeichnungs-Liste
    // (auch wenn aktuell ausgeblendet, siehe resizeLabels) muss auf die neue Stufenzahl
    // gebracht werden, sonst zeigt die Live-Vorschau/das nächste Aktivieren der
    // Bezeichnungen eine falsche Anzahl Zeilen.
    const rangeEl = e.target.closest('[data-action="habit-range-change"]');
    if (rangeEl && state.habitForm) {
      syncHabitFormFromDom();
      const f = state.habitForm;
      // Deckel greift auch, wenn direkt in die Stufenzahl getippt wird (das max-Attribut
      // des Inputs verhindert das allein nicht zuverlässig, siehe clampHabitFormSteps).
      clampHabitFormSteps(f);
      f.labels = resizeLabels(f.labels, habitFormStepCount(f), f.labelsEnabled ? (i) => String(habitFormStepValue(f, i)) : undefined);
      render();
      return;
    }
    // Stufen ändern: neue Anzahl.
    const stepEditCountEl = e.target.closest('[data-action="step-edit-count"]');
    if (stepEditCountEl && state.habitForm?.stepEdit) {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h) return;
      const steps = Math.round(Number(stepEditCountEl.value));
      stepEditCountChanged(h, f.stepEdit, Number.isFinite(steps) ? Math.min(stepEditCap(h), Math.max(2, steps)) : f.stepEdit.steps);
      render();
      return;
    }
    // Typ ändern: Anzahl Stufen der neuen Skala.
    const typeEditCountEl = e.target.closest('[data-action="type-edit-count"]');
    if (typeEditCountEl && state.habitForm?.typeEdit) {
      syncHabitFormFromDom();
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h) return;
      const steps = Math.round(Number(typeEditCountEl.value));
      typeEditStepsChanged(h, f.typeEdit, Number.isFinite(steps) ? Math.min(SLIDER_STEP_CAP, Math.max(2, steps)) : f.typeEdit.steps);
      render();
      return;
    }
    // Typ ändern: Zuordnung eines alten Werts - wie bei Stufen ändern ohne render().
    const typeMapEl = e.target.closest('[data-type-map]');
    if (typeMapEl && state.habitForm?.typeEdit) {
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h) return;
      if (typeMapEl.tagName === 'SELECT') {
        f.typeEdit.map[typeMapEl.dataset.typeMap] = typeMapEl.value === '' ? null : Number(typeMapEl.value);
        f.typeEdit.preset = 'custom';
        document.querySelectorAll('[data-action="type-edit-preset"]').forEach((b) => {
          b.classList.remove('pill-toggle--active');
          b.setAttribute('aria-pressed', 'false');
        });
      } else {
        f.typeEdit.map[typeMapEl.dataset.typeMap] = typeMapEl.value;
      }
      const summary = document.getElementById('type-edit-summary');
      if (summary) summary.innerHTML = typeEditSummary(h, f.typeEdit);
      return;
    }
    // Stufen ändern: eine alte Stufe zugeordnet - ohne render() (iOS öffnet die Auswahl sonst
    // wieder, siehe focusReopensPicker), nur Zusammenfassung und Vorschlag-Knöpfe nachziehen.
    const stepMapEl = e.target.closest('[data-step-map]');
    if (stepMapEl && state.habitForm?.stepEdit) {
      const f = state.habitForm;
      const h = state.habits.find((x) => x.defId === f.defId);
      if (!h) return;
      f.stepEdit.map[stepMapEl.dataset.stepMap] = stepMapEl.value === '' ? null : Number(stepMapEl.value);
      f.stepEdit.preset = 'custom';
      document.querySelectorAll('[data-action="step-edit-preset"]').forEach((b) => {
        b.classList.remove('pill-toggle--active');
        b.setAttribute('aria-pressed', 'false');
      });
      const summary = document.getElementById('step-edit-summary');
      if (summary) summary.innerHTML = stepEditSummary(h, f.stepEdit);
      return;
    }
    // Nur die Vorschau austauschen statt render() - hält den Fokus auf der Checkbox.
    const showValueEl = e.target.closest('[data-action="habit-slider-show-value"]');
    if (showValueEl && state.habitForm) {
      state.habitForm.sliderShowValue = showValueEl.checked;
      refreshHabitFormPreview();
      return;
    }
    const labelsToggleEl = e.target.closest('[data-action="habit-labels-toggle"]');
    if (labelsToggleEl && state.habitForm) {
      syncHabitFormFromDom();
      const f = state.habitForm;
      f.labelsEnabled = labelsToggleEl.checked;
      clampHabitFormSteps(f);
      // Beim Aktivieren bleiben die Zahlen als Startwert stehen (siehe resizeLabels) -
      // macht sichtbar, dass es weiterhin dieselbe Skala ist, bis man sie überschreibt.
      f.labels = resizeLabels(f.labels, habitFormStepCount(f), f.labelsEnabled ? (i) => String(habitFormStepValue(f, i)) : undefined);
      // Mit eigenen Bezeichnungen sind die Zahlen unsichtbar - intern wieder ab 1 (beim
      // Speichern ohnehin, siehe habitFormDefinition); die vorbelegten Texte behalten "0 …".
      if (f.labelsEnabled && !f.locked && f.min !== 1) { f.max = f.max - f.min + 1; f.min = 1; }
      render();
      return;
    }
    const sectionReminderToggle = e.target.closest('[data-action="section-reminder-toggle"]');
    if (sectionReminderToggle && state.sectionForm) {
      readSectionFormFromDom();
      render();
      document.getElementById('section-form-reminder-enabled')?.focus();
      return;
    }
    // Gruppe im Feld-Formular gewechselt: nur den Erinnerungs-Hinweis austauschen (kein
    // render(), der Fokus bleibt auf der Auswahl).
    if (e.target.id === 'habit-form-section' && state.habitForm) {
      state.habitForm.sectionId = e.target.value || null;
      const note = document.getElementById('habit-form-reminder-note');
      if (note) note.innerHTML = habitFormReminderNote(state.habitForm);
      return;
    }
    const reminderToggle = e.target.closest('[data-action="habit-reminder-toggle"]');
    if (reminderToggle && state.habitForm) {
      syncHabitFormFromDom();
      state.habitForm.reminderEnabled = reminderToggle.checked;
      render();
      return;
    }
    const dayProgressToggle = e.target.closest('[data-action="day-progress-toggle"]');
    if (dayProgressToggle) {
      setDayProgressShown(dayProgressToggle.checked);
      render();
      return;
    }
    const patternToggle = e.target.closest('[data-action="pattern-toggle"]');
    if (patternToggle) {
      setPatternDisabled(!patternToggle.checked);
      render();
      return;
    }
    // Kein render() nötig (nichts Sichtbares ändert sich) - so bleibt auch der Fokus auf
    // der Checkbox. Beim Einschalten einmal vibrieren, als direkte Rückmeldung.
    const hapticsToggle = e.target.closest('[data-action="haptics-toggle"]');
    if (hapticsToggle) {
      setHapticsDisabled(!hapticsToggle.checked);
      haptic();
      return;
    }
    const feedbackAnonymous = e.target.closest('[data-action="feedback-anonymous"]');
    if (feedbackAnonymous) {
      state.feedback.anonymous = feedbackAnonymous.checked;
      const note = document.getElementById('feedback-sender-note');
      if (note) note.innerHTML = feedbackSenderNote(feedbackAnonymous.checked);
      return;
    }
    const summaryToggle = e.target.closest('[data-action="summary-notifications-toggle"]');
    if (summaryToggle) {
      saveSummaryNotifications(summaryToggle.checked);
      return;
    }
    const localeEl = e.target.closest('[data-action="menu-locale"]');
    if (localeEl) {
      saveLocale(localeEl.value);
      return;
    }
    const weekStartEl = e.target.closest('[data-action="menu-week-start"]');
    if (weekStartEl) {
      await runWeekStartChange(Number(weekStartEl.value));
      document.getElementById('menu-week-start')?.focus({ preventScroll: true });
      return;
    }
    const slider = e.target.closest('[data-action="value-slider"], [data-action="preview-slider"]');
    if (slider) {
      // Loslassen/Commit — erst hier wird tatsächlich gespeichert, nicht bei jedem
      // Zwischenwert während des Ziehens.
      commitSliderValue(slider);
    }
  });
  app.addEventListener('submit', (e) => {
    if (e.target.id === 'password-change-form') { e.preventDefault(); handlePasswordChangeSubmit(); }
    if (e.target.id === 'spare-key-check-form') { e.preventDefault(); handleSpareKeyCheckSubmit(); }
    if (e.target.id === 'email-change-form') { e.preventDefault(); handleEmailChangeSubmit(); }
  });
  // Hält E-Mail/Passwort im Anmelde-Formular auch über einen Re-Render (z.B. nach
  // einem Fehler) hinweg – sonst wäre bei jedem Fehlversuch das ganze Formular leer.
  app.addEventListener('input', (e) => {
    if (e.target.id === 'email' && !state.session) { state.authEmail = e.target.value; return; }
    if (e.target.id === 'password' && !state.session) {
      state.authPassword = e.target.value;
      syncPasswordCount('password-count', e.target.value.length);
      return;
    }
    if (e.target.id === 'email-change-input' && state.emailChange) { state.emailChange.value = e.target.value; return; }
    if (e.target.id === 'email-change-password' && state.emailChange) { state.emailChange.password = e.target.value; return; }
    if (e.target.id === 'spare-key-check-input' && state.spareKeyCheck) { state.spareKeyCheck.value = e.target.value; return; }
    if (e.target.id === 'password-change-current' && state.passwordChange) { state.passwordChange.current = e.target.value; return; }
    if (e.target.id === 'password-change-new' && state.passwordChange) {
      state.passwordChange.next = e.target.value;
      syncPasswordCount('password-change-count', e.target.value.length);
      return;
    }
    // Kein render() beim Tippen (würde Fokus/Cursor zurücksetzen) - nur merken, damit
    // der Text einen späteren Re-Render (z.B. Meldung beim Absenden) übersteht.
    if (e.target.id === 'feedback-message') { state.feedback.message = e.target.value; return; }
    if (e.target.id === 'note-input' && state.noteEditor) { state.noteEditor.draft = e.target.value; return; }
    if (e.target.id === 'section-form-name' && state.sectionForm) { state.sectionForm.name = e.target.value; return; }
    if (e.target.classList.contains('text-field-input')) { updateTextValue(formatKey(state.currentDate), e.target.dataset.habit, e.target.value); return; }
    // Bezeichnungen im Feld-Formular: Live-Vorschau mitziehen, ohne das ganze Formular
    // neu zu rendern (würde Fokus/Cursor im gerade bearbeiteten Feld zurücksetzen) - nur
    // die Vorschau selbst wird ausgetauscht (der Fokus liegt dabei ja im Bezeichnungs-Feld).
    const labelInput = e.target.closest('[data-label-index]');
    if (labelInput && state.habitForm?.labelsEnabled) {
      state.habitForm.labels[Number(labelInput.dataset.labelIndex)] = labelInput.value;
      refreshHabitFormPreview();
    }
  });
  app.addEventListener('input', (e) => {
    const slider = e.target.closest('[data-action="value-slider"], [data-action="preview-slider"]');
    if (!slider) return;
    const habit = sliderHabit(slider);
    if (!habit) return;
    const v = Number(slider.value);
    const pct = ((v - habit.min) / (habit.max - habit.min)) * 100;
    slider.classList.remove('value-slider--unset');
    slider.dataset.dirty = '1'; // siehe pointerup-Listener unten
    slider.style.setProperty('--slider-color', sliderColor(habit, v));
    slider.style.setProperty('--slider-pct', pct + '%');
    slider.setAttribute('aria-valuetext', habitSliderValueText(habit, v));
    const valueEl = document.getElementById('slider-value-' + habit.id);
    if (valueEl) valueEl.textContent = habitSliderValueText(habit, v);
  });
  app.addEventListener('pointerdown', (e) => {
    sliderPointerTarget = e.target.closest('[data-action="value-slider"], [data-action="preview-slider"]');
  });
  document.addEventListener('pointerup', () => {
    const slider = sliderPointerTarget;
    sliderPointerTarget = null;
    if (!slider?.dataset.dirty) return;
    setTimeout(() => {
      if (slider.isConnected) commitSliderValue(slider);
    });
  });
  // Wird aus dem Anfassen ein Scrollen (touch-action: pan-y, siehe CSS), bricht der Browser
  // die Geste ab - einen dabei schon vorläufig angezeigten Wert verwerfen statt speichern.
  document.addEventListener('pointercancel', () => {
    const slider = sliderPointerTarget;
    sliderPointerTarget = null;
    if (!slider?.dataset.dirty || !slider.isConnected) return;
    delete slider.dataset.dirty;
    renderUnlessTyping();
  });
  document.addEventListener('pointercancel', () => { sliderPointerTarget = null; });
  // Merkt sich, wenn einer der "Über Logbuch"-Abschnitte zu-/aufgeklappt wird (siehe
  // isAboutSectionCollapsed, nur für die Dauer des Besuchs) - reines DOM-natives
  // <details>-Verhalten, kein eigener Klick-Handler/Re-Render nötig.
  // capture:true, da der native 'toggle'-Event bei <details> in vielen Browsern noch
  // nicht bubbled (erst seit jüngeren Chrome/Firefox-Versionen standardisiert) - eine
  // normale (bubble-basierte) Delegation auf app hätte hier nie gefeuert. Die
  // Capture-Phase läuft dagegen unabhängig vom bubbles-Flag immer von oben nach unten
  // durch den ganzen Baum, deshalb funktioniert die Delegation so zuverlässig überall.
  app.addEventListener('toggle', (e) => {
    // "Heute nicht geplant": offen/zu übersteht so einen Re-Render (z.B. nach dem
    // Eintragen eines Werts), gilt aber nur für den jeweiligen Tag.
    if (e.target.matches?.('details.unplanned')) {
      state.unplannedOpenFor = e.target.open ? formatKey(state.currentDate) : null;
      return;
    }
    if (e.target.matches?.('details.habit-form-more') && state.habitForm) {
      state.habitForm.moreOpen = e.target.open;
      return;
    }
    if (e.target.matches?.('details.part-more') && state.habitForm) {
      state.habitForm.partMore = { ...state.habitForm.partMore, [e.target.dataset.more]: e.target.open };
      return;
    }
    const details = e.target.closest('details[data-collapse-key]');
    if (!details) return;
    if (details.open) runtime.openAboutSections.add(details.dataset.collapseKey);
    else runtime.openAboutSections.delete(details.dataset.collapseKey);
  }, true);
  // Menü schließen, wenn außerhalb davon geklickt wird.
  document.addEventListener('click', (e) => {
    if (!state.menuOpen) return;
    if (e.target.closest('.menu-panel, .menu-btn')) return;
    state.menuOpen = false;
    render();
  });
  // Dasselbe für das Zeilen-Menü in "Heute" bei Klicks außerhalb von #app (innerhalb
  // greift schon der Light-Dismiss-Capture-Listener, siehe "Zeilen-Menü per Long-Press").
  document.addEventListener('click', (e) => {
    if (!state.rowMenu) return;
    if (e.target.closest('.row-menu, [data-menu]')) return;
    state.rowMenu = null;
    render();
  });
  app.addEventListener('keydown', (e) => {
    if (e.target?.dataset?.action === 'number-input' && e.key === 'Enter') {
      e.preventDefault();
      handleSaveNumber(formatKey(state.currentDate), e.target.dataset.habit, e.target.value);
      return;
    }
    if (e.key === 'Escape' && state.rowMenu) {
      closeRowMenu();
      return;
    }
    if (e.key === 'Escape' && state.menuOpen) {
      state.menuOpen = false;
      render();
      document.querySelector('.menu-btn')?.focus();
      return;
    }
    const modalBox = document.querySelector('.modal-box');
    if (modalBox) {
      if (e.key === 'Escape' && modalBox.classList.contains('step-dialog')) {
        closeStepDialog();
        render();
        if (state.leaveFormConfirm) return; // focusModalIfOpen hat den Fokus schon in der Rückfrage
        (document.getElementById('step-dialog-title') || document.querySelector('[data-action="step-edit-open"]'))?.focus();
        return;
      }
      if (e.key === 'Escape') {
        closeModals();
        render();
        restoreModalFocus();
        return;
      }
      // Fokus-Trap: Tab/Shift+Tab bleibt innerhalb des offenen Modals, statt in die
      // dahinterliegende (verdeckte, aber technisch noch im DOM befindliche) Seite
      // weiterzuwandern.
      if (e.key === 'Tab') {
        const focusable = [...modalBox.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
          .filter((el) => !el.disabled && el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    // Generalisierte Tastatur-Aktivierung für per data-action klickbare, aber nicht
    // nativ fokussierbare Elemente (v.a. die Kalenderzellen, die tabindex="0" bekommen
    // haben) — löst denselben echten Klick aus, den die Maus auch auslösen würde, statt
    // die ~60 bestehenden Klick-Aktionen für Tastatur-Nutzung zu duplizieren. Auf
    // tabindex="0" beschränkt, damit z.B. Enter in einem normalen Input (das zufällig in
    // einem [data-action]-Vorfahren sitzt) nicht versehentlich mit-ausgelöst wird.
    if (e.key === 'Enter' || e.key === ' ') {
      const el = e.target.closest('[data-action][tabindex="0"]');
      if (el) {
        e.preventDefault();
        el.click();
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (timePicker || e.defaultPrevented || !state.session || !currentDek) return;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (!SWIPEABLE_VIEWS.includes(state.view) || state.loading || isOverlayOpen() || document.querySelector('.modal-box')
        || !app.querySelector('.view-body') || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      shiftPeriod(e.key === 'ArrowRight' ? 1 : -1);
      render();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !document.querySelector('.modal-box')) {
      const btn = CTRL_ENTER_ACTIONS.map((a) => app.querySelector(`[data-action="${a}"]`)).find((b) => b && !b.disabled && b.getClientRects().length);
      if (!btn) return;
      e.preventDefault();
      btn.click();
    }
  });
}
