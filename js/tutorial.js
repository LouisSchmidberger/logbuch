import { supabase } from './config.js?v=90bbeaa075';
import { reminderTimeInputHtml } from './dates.js?v=90bbeaa075';
import { state } from './state.js?v=90bbeaa075';
import { activeHabits, app, esc } from './navigation.js?v=90bbeaa075';
import { t } from './i18n.js?v=90bbeaa075';
import { errorNotice } from './format.js?v=90bbeaa075';
import { maybeShowSpareKey } from './keys.js?v=90bbeaa075';
import { defaultHabitForm, newHabitForm } from './field-form.js?v=90bbeaa075';
import { isIOSDevice, isStandaloneDisplay, pushBlockedHelp } from './device.js?v=90bbeaa075';
import { installManualHtml, isGuided, onbProgress, sketchHtml } from './auth-view.js?v=90bbeaa075';
import { CHANGELOG } from './about-view.js?v=90bbeaa075';
import { packageDefaultChoice } from './templates.js?v=90bbeaa075';
import { renderHabitForm } from './fields-view.js?v=90bbeaa075';
import { iconSvg, render } from './main-view.js?v=90bbeaa075';

// --- Onboarding-Tutorial für neue Accounts ----------------------------------
// state.userSettings.onboardingCompleted kommt aus der DB (Default false bei neuen
// Accounts, siehe supabase/migrations/) und steuert in render(), ob statt der normalen
// App dieses Tutorial gezeigt wird - und danach der eigenständige Erinnerungs-Schritt
// (gehört nicht zum Tutorial, kommt aber auch nach "Tutorial überspringen"; erst er setzt
// onboardingCompleted). state.tutorialStep (TUTORIAL_STEP_*) lebt nur im Speicher,
// kein Reload-Resume nötig — dafür verhindert die beforeunload-Warnung im offenen
// Formular (Feld-Schritt) ein versehentliches Verlassen mitten im Feld-Anlegen.
//
export async function saveOnboardingCompleted() {
  state.userSettings = { ...state.userSettings, onboardingCompleted: true, lastSeenChangelog: CHANGELOG[0].id };
  state.tutorialStep = null;
  state.tutorialSkipConfirm = false;
  state.habitForm = null;
  render();
  maybeShowSpareKey(); // direkt nach den Erinnerungen, auch wenn das Tutorial übersprungen wurde
  const { error } = await supabase.from('user_settings')
    .upsert({ user_id: state.session.user.id, onboarding_completed: true, last_seen_changelog: CHANGELOG[0].id }, { onConflict: 'user_id' });
  if (error) {
    state.notice = errorNotice('notice.saveFailed', error.message);
    render();
  }
}

function renderTutorialSkipConfirm() {
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="tutorial-skip-confirm-title">
        <h2 id="tutorial-skip-confirm-title">${t('tutorial.skipConfirm.title')}</h2>
        <p>${t('tutorial.skipConfirm.body')}</p>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="tutorial-skip-cancel">${t('common.cancel')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="tutorial-skip-confirm">${t('tutorial.skipConfirm.confirmButton')}</button>
        </div>
      </div>
    </div>
  `;
}

// Bausteine der Tutorial-Bildschirme (Neufassung 2026-09-29): ein Bildschirm, ein
// Thema - Symbol, kurze Überschrift, der eine wichtige Satz fett, Begründungen im
// wiedererkennbaren "Warum?"-Kasten (Leitlinie des Nutzers: nie nur sagen, dass etwas so
// ist, sondern warum; locker statt förmlich, die App als Freund). Fortschritt über die
// Leiste des ganzen Einrichtens (onbProgress), das Tutorial ist darin Etappe "kennenlernen".
// Die Erinnerungen kommen erst nach dem ersten Feld (Nutzer-Entscheidung 2026-10-12): dann
// weiß man, woran erinnert wird, und die Frage kann das Feld nennen.
export const TUTORIAL_STEP_HELLO = 1;
export const TUTORIAL_STEP_FIELD = 2;
export const TUTORIAL_STEP_DONE = 3;
export const TUTORIAL_STEP_REMINDERS = 4; // eigene Etappe, nicht Teil des Tutorials
const TUTORIAL_STEPS = 3; // Unterschritte der Etappe "kennenlernen"
// Im Tutorial: die Etappe "Logbuch kennenlernen" mit dem Tutorial-Schritt als Unterschritt;
// der Erinnerungs-Schritt als eigene Etappe ohne Unterschritte.
function tutorialProgress(step) {
  return step === TUTORIAL_STEP_REMINDERS ? onbProgress('reminders') : onbProgress('setup', [step, TUTORIAL_STEPS]);
}
// "Warum?"/"Genauer erklären": aufklappbar - bei "Schritt für Schritt" von Anfang an offen.
export function whyBox(titleKey, bodyKey) {
  return `<details class="why-box" ${isGuided() ? 'open' : ''}><summary class="why-box-title">${t(titleKey)}</summary><p>${t(bodyKey)}</p></details>`;
}
function tutorialScreen({ step, icon, title, body }) {
  return `
    <div class="auth-box onb">
      ${tutorialProgress(step)}
      <div class="onb-icon" aria-hidden="true">${iconSvg(icon)}</div>
      <h1 tabindex="-1">${title}</h1>
      ${body}
    </div>
    ${state.tutorialSkipConfirm ? renderTutorialSkipConfirm() : ''}
  `;
}
// Zurück/Überspringen als eigene Fußleiste mit Trennlinie (Zurück links, Überspringen
// rechts) - direkt unter dem Inhalt hingen sie vorher so dran, dass nicht erkennbar war,
// ob sie zum Inhalt gehören. Aktionen des Inhalts ("Lieber nicht", "Noch ein Feld")
// bleiben beim Hauptknopf.
function tutorialNav({ back = false, skip = false }) {
  return `
    <nav class="onb-nav" aria-label="${esc(t('tutorial.navLabel'))}">
      ${back ? `<button type="button" class="onb-nav-btn" data-action="tutorial-back"><span aria-hidden="true">← </span>${t('common.back')}</button>` : '<span></span>'}
      ${skip ? `<button type="button" class="onb-nav-btn" data-action="tutorial-skip-arm">${t('tutorial.skip')}</button>` : ''}
    </nav>
  `;
}

function renderTutorialHello() {
  const promises = [['privacy', 'private'], ['sprout', 'noPressure'], ['manage', 'yours']].map(([name, key]) => `
    <li><span class="onb-promise-icon" aria-hidden="true">${iconSvg(name)}</span><span><strong>${t(`tutorial.hello.${key}Title`)}</strong> ${t(`tutorial.hello.${key}Body`)}</span></li>
  `).join('');
  return tutorialScreen({
    step: TUTORIAL_STEP_HELLO, icon: 'hello', title: t('tutorial.hello.title'),
    body: `
      <p class="tutorial-text">${t('tutorial.hello.body')}</p>
      <ul class="onb-promises">${promises}</ul>
      <button type="button" class="auth-submit" data-action="tutorial-next">${t('tutorial.hello.start')}</button>
    `,
  });
}

// Erinnerungen: erst die Frage mit Begründung, die Uhrzeit erst, wenn sie aktiv sind
// (vorher stand sie ausgegraut daneben und wurde übersehen bzw. verwirrte).
function renderTutorialReminders() {
  const firstField = activeHabits()[0];
  let body;
  if (state.pushStatus === 'on') {
    body = `
      <p class="tutorial-text"><strong>${t('tutorial.reminders.activeTitle')}</strong></p>
      <div class="auth-field">
        <span class="settings-label" id="tutorial-default-time-label">${t('tutorial.reminders.timeLabel')}</span>
        ${reminderTimeInputHtml('tutorial-default-time', state.userSettings.defaultReminderMinute, 'menu-default-time', false, 'tutorial-time-note', 'tutorial-default-time-label')}
        <p class="habit-form-lock-note" id="tutorial-time-note">${t('tutorial.reminders.timeNote')}</p>
      </div>
      <button type="button" class="auth-submit" data-action="tutorial-finish">${t('common.next')}</button>
    `;
  } else if (state.pushStatus === 'blocked') {
    body = `
      <p class="tutorial-text">${t('tutorial.reminders.blocked')}</p>
      ${pushBlockedHelp()}
      <button type="button" class="auth-submit" data-action="tutorial-finish">${t('common.next')}</button>
    `;
  } else if (state.pushStatus === 'unsupported') {
    body = `
      <p class="tutorial-text">${isIOSDevice() ? t('tutorial.reminders.iosNeedsInstall') : t('push.unsupported')}</p>
      ${isIOSDevice() && !isStandaloneDisplay() ? `<details class="why-box" ${isGuided() ? 'open' : ''}><summary class="why-box-title">${t('tutorial.reminders.howInstall')}</summary>${installManualHtml()}</details>` : ''}
      <button type="button" class="auth-submit" data-action="tutorial-finish">${t('common.next')}</button>
    `;
  } else {
    const busy = state.pushStatus === 'busy' || state.pushStatus === 'unknown';
    body = `
      <p class="tutorial-text">${firstField ? t('tutorial.reminders.bodyField', { name: firstField.name }) : t('tutorial.reminders.body')}</p>
      ${whyBox('tutorial.reminders.whyTitle', 'tutorial.reminders.whyBody')}
      <p class="onb-hint">${t('tutorial.reminders.permissionNote')}</p>
      ${isGuided() ? sketchHtml(isIOSDevice() ? 'permIos' : 'permAndroid') : ''}
      <button type="button" class="auth-submit" data-action="enable-push" ${busy ? 'disabled' : ''}>${busy ? t('push.checking') : t('tutorial.reminders.yes')}</button>
      <button type="button" class="auth-toggle" data-action="tutorial-finish">${t('tutorial.reminders.no')}</button>
      <p class="onb-hint onb-hint--after onb-center">${t('tutorial.reminders.laterNote')}</p>
    `;
  }
  return tutorialScreen({
    step: TUTORIAL_STEP_REMINDERS, icon: 'reminders', title: t('tutorial.reminders.title'),
    body: `${body}${tutorialNav({ back: true })}`,
  });
}

// Feld-Schritt: zuerst die Vorlagen wie bei "Neues Feld"
// (Nutzer-Entscheidung 2026-10-30: der ganze Ablauf geht von Vorlagen aus); "Eigenes Feld" und
// "Anpassen" führen ins echte Feld-Formular, Stück für Stück aufgedeckt (siehe renderHabitForm,
// f.revealStage), mit Ideen als Text unter dem Namen.
function tutorialStartForm() {
  if (activeHabits().length) return { ...newHabitForm(), revealStage: 1 };
  return { ...defaultHabitForm(), revealStage: 1, packageChosen: packageDefaultChoice(), template: { stage: 'package' } };
}
function renderTutorialFieldForm() {
  if (!state.habitForm) state.habitForm = tutorialStartForm();
  return tutorialScreen({
    step: TUTORIAL_STEP_FIELD, icon: 'manage', title: t('tutorial.field.title'),
    body: `
      <p class="tutorial-text">${t(state.habitForm.template?.stage === 'package' ? 'tutorial.field.introPkg' : state.habitForm.template ? 'tutorial.field.introTpl' : 'tutorial.field.intro')}</p>
      ${renderHabitForm({ titleInHeader: true })}
      ${tutorialNav({ back: true, skip: true })}
    `,
  });
}

function renderTutorialDone() {
  const count = activeHabits().length;
  return tutorialScreen({
    step: TUTORIAL_STEP_DONE, icon: 'sprout', title: count > 1 ? t('tutorial.done.titleMore', { count }) : t('tutorial.done.title'),
    body: `
      <p class="tutorial-text">${t('tutorial.done.body')}</p>
      <button type="button" class="auth-submit" data-action="tutorial-next">${t('tutorial.done.start')}</button>
      <button type="button" class="auth-toggle" data-action="tutorial-add-more">${t('tutorial.done.addMore')}</button>
      ${tutorialNav({ back: true })}
    `,
  });
}

export function renderTutorial() {
  if (!state.tutorialStep) state.tutorialStep = TUTORIAL_STEP_HELLO;
  app.innerHTML =
    state.tutorialStep === TUTORIAL_STEP_HELLO ? renderTutorialHello() :
    state.tutorialStep === TUTORIAL_STEP_FIELD ? renderTutorialFieldForm() :
    state.tutorialStep === TUTORIAL_STEP_DONE ? renderTutorialDone() :
    renderTutorialReminders();
  // Bei jedem Wechsel des Bildschirms die Überschrift fokussieren (Screenreader hören so,
  // wo sie sind) - nicht bei jedem render(), sonst spränge der Fokus z.B. nach dem
  // Aktivieren der Erinnerungen weg.
  const screenKey = `${state.tutorialStep}:${state.habitForm ? 'form' : ''}`;
  if (screenKey !== lastTutorialScreen) {
    lastTutorialScreen = screenKey;
    app.querySelector('.onb h1')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}
let lastTutorialScreen = null;
