import { ARRIVED_VIA_SIGNUP_CONFIRM, supabase } from './config.js?v=90bbeaa075';
import { PBKDF2_ITERATIONS, bufToBase64, cacheDek, deriveKek, formatRecoveryKey, wrapDek } from './crypto.js?v=90bbeaa075';
import { saveFieldNamesForPush } from './fields.js?v=90bbeaa075';
import { runtime, setCurrentDek, state } from './state.js?v=90bbeaa075';
import { app, esc } from './navigation.js?v=90bbeaa075';
import { currentLocale, t, tPlain } from './i18n.js?v=90bbeaa075';
import { TEXT_SIZES, getTextSize, getThemeOverride } from './theme.js?v=90bbeaa075';
import { AUTH_MIN_PASSWORD_LENGTH, clearableInputHtml, translateAuthError } from './format.js?v=90bbeaa075';
import { renderNotice } from './notices.js?v=90bbeaa075';
import { loadEntries, loadFeatureAccess, loadHabits, loadSections, loadUserSettings } from './data.js?v=90bbeaa075';
import { fetchEncryptionRow, maybeShowSpareKey, setupEncryption, unlockErrorText, unwrapDekWithRecoveryKey } from './keys.js?v=90bbeaa075';
import { isIOSDevice, isMobileDevice, isStandaloneDisplay } from './device.js?v=90bbeaa075';
import { SIGNUP_MIN_FILL_MS } from './account.js?v=90bbeaa075';
import { whyBox } from './tutorial.js?v=90bbeaa075';
import { announce, icon, iconSvg, render } from './main-view.js?v=90bbeaa075';
import { completeAuthFlow } from './session.js?v=90bbeaa075';

// --- Rendering: Auth -------------------------------------------------------
// Hilfe, falls die Bestätigungsmail nicht ankommt: sie landet bei manchen Anbietern im
// Spam (neue Absender-Domain, Link auf eine andere Domain), und wer das nicht weiß, kommt
// ohne diesen Hinweis nicht weiter. Die Adresse steht dabei, damit ein Tippfehler auffällt.
function renderConfirmEmailHelp() {
  const r = state.confirmResend;
  const status = r === 'sent' ? t('auth.confirmHelp.resent') : r?.error ? esc(r.error) : '';
  return `
    <div class="confirm-help">
      <p>${t('auth.confirmHelp.spam')}</p>
      <p>${t('auth.confirmHelp.sentTo', { email: state.confirmEmailFor })}</p>
      <button type="button" class="manage-new-btn manage-new-btn--secondary" data-action="resend-confirm">${r === 'sending' ? t('auth.confirmHelp.resending') : t('auth.confirmHelp.resend')}</button>
      ${status ? `<p class="confirm-help-status">${status}</p>` : ''}
    </div>
  `;
}
export async function resendConfirmEmail() {
  state.confirmResend = 'sending';
  render();
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: state.confirmEmailFor,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (!error) state.confirmResend = 'sent';
  else {
    // Supabase erlaubt eine Mail pro Minute und Adresse (auth.email.max_frequency).
    const wait = /after (\d+) seconds?/.exec(error.message);
    state.confirmResend = { error: wait ? tPlain('auth.confirmHelp.wait', { seconds: wait[1] }) : t('auth.confirmHelp.failed') };
  }
  render();
  // Bewusst nicht deaktiviert, solange gesendet wird (ein doppelter Klick wird oben
  // abgefangen) - ein deaktivierter Button verlöre den Tastatur-Fokus.
  announce(state.confirmResend === 'sent' ? t('auth.confirmHelp.resent') : state.confirmResend.error);
}

// --- Onboarding-Gerüst (seit 2026-10-01) ------------------------------------------
// Einstiegsfrage "Wie möchtest du starten?": Schritt für Schritt (mehr Erklärung offen)
// oder Kurz und knapp. EIN Ablauf für beide - Faustregel: klarer formulieren gilt für
// alle, mehr erklären bekommt nur, wer Schritt für Schritt gewählt hat (aufklappbare
// Erklärungen sind dann von Anfang an offen, siehe whyBox). Gemerkt nur auf dem Gerät.
// iPhone: Safari und die installierte App teilen keinen Speicher - die frisch installierte
// App fragt deshalb noch einmal (authMode 'installed').
function getOnbMode() {
  try { return localStorage.getItem('onboardingMode'); } catch { return null; } // 'guided' | 'short' | null
}
export function setOnbMode(mode) {
  try { localStorage.setItem('onboardingMode', mode); } catch { /* dann eben nur bis zum Neuladen */ }
  runtime.onbModeThisVisit = mode;
}
export function isGuided() { return (getOnbMode() || runtime.onbModeThisVisit) === 'guided'; }
// Läuft gerade das Einrichten eines neuen Kontos (von "Ich bin neu hier" bis zum gesicherten
// Ersatzschlüssel)? Steuert die Fortschrittsleiste auf den Seiten davor und danach.
export function isOnbInProgress() {
  try { return localStorage.getItem('onboardingInProgress') === 'true'; } catch { return runtime.onbInProgressThisVisit; }
}
export function setOnbInProgress(on) {
  runtime.onbInProgressThisVisit = on;
  try { if (on) localStorage.setItem('onboardingInProgress', 'true'); else localStorage.removeItem('onboardingInProgress'); } catch { /* s.o. */ }
}
// Die Etappen des Einrichtens. "Aufs Handy holen" zählt nur mit, wenn der Schritt auf
// diesem Gerät auch kommt (bzw. schon geschafft ist): Handy, und entweder schon installiert
// oder die Installations-Seite wurde hier nicht früher schon weggeklickt. Festgelegt bei der
// Einstiegsfrage (onbIncludesInstall) - wer die Seite mitten im Einrichten überspringt,
// behält dieselbe Zählung, sonst spränge "Schritt 2 von 4" auf "Schritt 1 von 3".
function onbIncludesInstall() {
  try {
    const v = localStorage.getItem('onboardingWithInstall');
    if (v !== null) return v === 'true';
  } catch { /* s.u. */ }
  return isMobileDevice() && (isStandaloneDisplay() || shouldShowInstallGate());
}
export function rememberOnbIncludesInstall() {
  const v = isMobileDevice() && (isStandaloneDisplay() || shouldShowInstallGate());
  try { localStorage.setItem('onboardingWithInstall', String(v)); } catch { /* dann jedes Mal neu bestimmt */ }
}
function onbStages() {
  return [...(onbIncludesInstall() ? ['install'] : []), 'account', 'setup', 'reminders', 'key'];
}
// Fortschrittsleiste "Schritt X von N: …" (optional mit Unterschritt, z.B. im Tutorial).
export function onbProgress(stage, part = null) {
  const stages = onbStages();
  const idx = stages.indexOf(stage);
  if (idx < 0) return '';
  const label = t('onb.progress.label', { n: idx + 1, total: stages.length, name: t(`onb.stage.${stage}`) });
  // Unterschritt (z.B. im Tutorial) als eigene, kleinere Zeile mit Punkten darunter - in
  // derselben Überschrift wirkte "Schritt 2 von 3 … Teil 2 von 4" überladen.
  const sub = part ? `
      <div class="onb-substeps" role="img" aria-label="${esc(t('onb.progress.part', { part: part[0], parts: part[1] }))}">
        ${Array.from({ length: part[1] }, (_, i) => `<span class="onb-substep${i + 1 < part[0] ? ' onb-substep--done' : i + 1 === part[0] ? ' onb-substep--current' : ''}"></span>`).join('')}
      </div>` : '';
  return `
    <div class="onb-progress">
      <div class="onb-progress-bar" aria-hidden="true">${stages.map((st, i) => `<span class="onb-progress-seg${i < idx ? ' onb-progress-seg--done' : i === idx ? ' onb-progress-seg--current' : ''}"></span>`).join('')}</div>
      <p class="onb-progress-label">${label}</p>
      ${sub}
    </div>
  `;
}

export function signedInHereBefore() {
  try { return localStorage.getItem('signedInHere') === 'true'; } catch { return false; }
}
export function rememberSignedInHere() {
  try { localStorage.setItem('signedInHere', 'true'); } catch { /* dann eben nicht */ }
}
// Startseite vor dem Anmelde-Formular: zwei Knöpfe, die die Lage der Person beschreiben
// statt des Fachbegriffs - ein "Anmelden" klingt für Neulinge nach "ich bin neu, also melde
// ich mich an". Wer sich auf dem Gerät schon einmal angemeldet hat, startet direkt beim
// Anmelden (signedInHereBefore).
function renderAuthWelcome() {
  app.innerHTML = `
    <div class="auth-box auth-box--welcome">
      <h1 tabindex="-1">Logbuch</h1>
      <p class="auth-welcome-lead">${t('auth.welcome.lead')}</p>
      ${renderNotice()}
      ${choiceCard({ action: 'auth-choose', mode: 'mode', title: t('auth.welcome.new'), note: t('auth.welcome.newNote') })}
      ${choiceCard({ action: 'auth-choose', mode: 'signin', title: t('auth.welcome.existing'), note: t('auth.welcome.existingNote') })}
      <div class="onb-display onb-display--welcome">
        <p class="onb-display-title">${t('onbDisplay.welcomeTitle')}</p>
        ${onbDisplayChoicesHtml()}
      </div>
    </div>
  `;
}

// Textgröße und Hell/Dunkel schon vor dem Konto: sonst muss, wer schlecht sieht, die ganze
// Einführung in normaler Schrift schaffen (die Einstellungen kommen erst danach). Startseite:
// offen unter den Karten; alle weiteren Seiten der Einführung: Knopf "Aa Anzeige" oben rechts
// (addOnbDisplayBar) - auch, weil auf dem iPhone die installierte App einen eigenen Speicher
// hat und eine im Browser gewählte Größe dort wieder weg ist.
function onbDisplayChoicesHtml() {
  const seg = (labelId, label, buttons) => `
    <span class="onb-display-label" id="${labelId}">${label}</span>
    <div class="pill-group seg" role="group" aria-labelledby="${labelId}">${buttons}</div>`;
  const theme = getThemeOverride() || '';
  return `
    ${seg('onb-text-size-label', t('textSize.label'), TEXT_SIZES.map((size) => `<button type="button" class="pill-toggle${getTextSize() === size ? ' pill-toggle--active' : ''}" data-action="text-size-set" data-size="${size}" aria-pressed="${getTextSize() === size}">${t('textSize.' + (size || 'normal'))}</button>`).join(''))}
    ${seg('onb-theme-label', t('theme.label'), [['', 'theme.system'], ['light', 'theme.light'], ['dark', 'theme.dark']].map(([v, key]) => `<button type="button" class="pill-toggle${theme === v ? ' pill-toggle--active' : ''}" data-action="theme-set" data-theme="${v}" aria-pressed="${theme === v}">${t(key)}</button>`).join(''))}
  `;
}
// Zentral aus render() statt in jeder der vielen Seiten der Einführung: Zeile mit Zurück-Pfeil
// (falls die Seite einen hat) links und "Aa Anzeige" rechts, darunter aufgeklappt die Auswahl.
// Auf der nächsten Seite wieder zu (sonst schöbe die offene Auswahl jeden Inhalt nach unten).
let onbDisplayPage = null;
export function addOnbDisplayBar() {
  const box = app.querySelector('.auth-box');
  if (!box || box.classList.contains('auth-box--welcome')) return;
  const page = box.querySelector('h1')?.textContent ?? '';
  if (page !== onbDisplayPage) { onbDisplayPage = page; state.onbDisplayOpen = false; }
  const back = box.firstElementChild?.classList.contains('auth-back') ? box.firstElementChild : null;
  box.insertAdjacentHTML('afterbegin', `
    <div class="onb-topbar">
      <span class="onb-topbar-back"></span>
      <button type="button" class="onb-display-btn" data-action="onb-display-toggle" aria-expanded="${state.onbDisplayOpen}"${state.onbDisplayOpen ? ' aria-controls="onb-display-panel"' : ''}><span class="onb-display-btn-icon" aria-hidden="true">A<span>a</span></span>${t('onbDisplay.button')}</button>
    </div>
    ${state.onbDisplayOpen ? `<div class="onb-display" id="onb-display-panel">${onbDisplayChoicesHtml()}</div>` : ''}
  `);
  if (back) box.querySelector('.onb-topbar-back').replaceWith(back);
}
// Gleichwertige Antworten auf eine Frage (Startseite, Einstiegsfrage): gleich aussehende
// Karten mit dem erklärenden Satz IM Knopf. Ein gefüllter Knopf neben einem umrandeten
// wirkte wie eine Empfehlung, und der Satz darunter wurde überlesen - Testpersonen wählten
// so oft das, was nicht zu ihnen passte. Gefüllt bleibt nur ein empfohlener Weg (z.B.
// Installieren, Erinnerungen).
function choiceCard({ action, mode, title, note }) {
  return `
    <button type="button" class="onb-choice" data-action="${action}" data-mode="${mode}">
      <span class="onb-choice-title">${title}</span>
      <span class="onb-choice-note">${note}</span>
    </button>
  `;
}

// Nach dem Registrieren: was jetzt zu tun ist, als nummerierte Schritte - vorher standen
// Meldung, Hilfe und Anmelde-Formular untereinander, und alle drei wollten etwas.
function renderCheckMail() {
  const steps = ['auth.checkMail.step1', 'auth.checkMail.step2', 'auth.checkMail.step3'];
  app.innerHTML = `
    <div class="auth-box onb">
      ${authBackButton('signup')}
      ${onbProgress('account')}
      <div class="onb-icon" aria-hidden="true">${iconSvg('mail')}</div>
      <h1 tabindex="-1">${t('auth.checkMail.title')}</h1>
      <p class="tutorial-text">${t('auth.checkMail.body')}</p>
      <details class="why-box" ${isGuided() ? 'open' : ''}>
        <summary class="why-box-title">${t('auth.checkMail.howTitle')}</summary>
        <ol class="onb-steps">${steps.map((k) => `<li>${t(k)}</li>`).join('')}</ol>
      </details>
      <p class="onb-hint">${t('auth.checkMail.after')}</p>
      <button type="button" class="auth-submit" data-action="check-mail-done">${t('auth.checkMail.continue')}</button>
      ${renderConfirmEmailHelp()}
    </div>
  `;
}

function authBackButton(target) {
  return `
    <button type="button" class="back-btn auth-back" data-action="auth-choose" data-mode="${target}" aria-label="${esc(t('ariaLabel.back'))}">
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  `;
}
// Die zwei Antworten der Einstiegsfrage - fragt nach dem Wunsch, nicht nach dem Können
// ("kennst du dich aus?" schätzen viele falsch ein und kann herablassend wirken).
function onbModeChoices() {
  return `
    ${choiceCard({ action: 'onb-mode', mode: 'guided', title: t('onb.mode.guided'), note: t('onb.mode.guidedNote') })}
    ${choiceCard({ action: 'onb-mode', mode: 'short', title: t('onb.mode.short'), note: t('onb.mode.shortNote') })}
  `;
}
function renderOnbMode() {
  app.innerHTML = `
    <div class="auth-box onb">
      ${authBackButton('welcome')}
      <h1 tabindex="-1">${t('onb.mode.title')}</h1>
      ${onbModeChoices()}
    </div>
  `;
}
// Persönliche Nachricht nach der Einstiegsfrage, bei beiden Varianten (Nutzer-Entscheidung
// 2026-10-12): Testpersonen lasen die Erklärungen oft nicht - ein paar Dinge muss man aber
// verstehen, um Logbuch richtig zu nutzen.
function renderOnbIntro() {
  app.innerHTML = `
    <div class="auth-box onb">
      ${authBackButton('mode')}
      <div class="onb-icon" aria-hidden="true">${iconSvg('feedback')}</div>
      <h1 tabindex="-1">${t('onb.intro.title')}</h1>
      <p class="tutorial-text">${t('onb.intro.body')}</p>
      <p class="tutorial-text">${t('onb.intro.help')}</p>
      <button type="button" class="auth-submit" data-action="auth-choose" data-mode="${isGuided() ? 'overview' : 'signup'}">${t('onb.intro.ok')}</button>
    </div>
  `;
}
function renderOnbOverview() {
  const icons = { install: 'install', account: 'mail', setup: 'manage', reminders: 'reminders', key: 'key' };
  app.innerHTML = `
    <div class="auth-box onb">
      ${authBackButton('intro')}
      <h1 tabindex="-1">${t('onb.overview.title')}</h1>
      <ol class="onb-overview">${onbStages().map((st) => `<li>${icon(icons[st])}${t(`onb.overview.${st}`)}</li>`).join('')}</ol>
      <p class="onb-hint">${t('onb.overview.duration')}</p>
      <div class="why-box"><p>${icon('tip')}${t('onb.overview.helper')}</p></div>
      <button type="button" class="auth-submit" data-action="auth-choose" data-mode="signup">${t('onb.overview.start')}</button>
    </div>
  `;
}
// Frisch installierte App ohne Anmeldung (Startzustand 'installed'): erst einmal
// bestätigen, dass es geklappt hat. Ist die Einstiegsfrage auf diesem Speicher schon
// beantwortet (Android teilt ihn mit dem Browser), geht es direkt weiter, sonst kommt sie
// hier noch einmal (iPhone).
function renderOnbInstalled() {
  app.innerHTML = `
    <div class="auth-box onb">
      ${onbProgress('account')}
      <div class="onb-icon" aria-hidden="true">${iconSvg('celebrate')}</div>
      <h1 tabindex="-1">${t('onb.installed.title')}</h1>
      <p class="tutorial-text">${t('onb.installed.body')}</p>
      ${getOnbMode()
        ? `<button type="button" class="auth-submit auth-choice" data-action="auth-choose" data-mode="signup">${t('onb.installed.continue')}</button>`
        : `<p class="tutorial-text">${t('onb.mode.title')}</p>${onbModeChoices()}`}
      <button type="button" class="auth-toggle" data-action="auth-choose" data-mode="signin">${t('auth.welcome.existing')}</button>
    </div>
  `;
}

let authSubmitBusy = false;
// Mindestlänge beim Registrieren als Bedingung, die sich beim Erreichen abhakt - so sieht
// man vor dem Absenden, ob sie erfüllt ist. Ein laufender Zähler ("0 von mindestens 10
// Zeichen") las sich verwirrend; der Haken zeigt es auch ohne Farbe.
export function passwordRuleText(len) {
  return `${len >= AUTH_MIN_PASSWORD_LENGTH ? '✓ ' : ''}${t('auth.passwordRule', { min: AUTH_MIN_PASSWORD_LENGTH })}`;
}
export function renderAuth() {
  if (state.authMode === 'welcome') { renderAuthWelcome(); return; }
  if (state.authMode === 'mode') { renderOnbMode(); return; }
  if (state.authMode === 'intro') { renderOnbIntro(); return; }
  if (state.authMode === 'overview') { renderOnbOverview(); return; }
  if (state.authMode === 'installed') { renderOnbInstalled(); return; }
  if (state.authMode === 'checkMail') { renderCheckMail(); return; }
  const isSignup = state.authMode === 'signup';
  const isForgot = state.authMode === 'forgot';
  const title = isForgot ? t('auth.title.forgot') : isSignup ? t('auth.title.signup') : t('auth.title.login');

  app.innerHTML = `
    <div class="auth-box">
      ${!isForgot ? authBackButton(isSignup ? (isStandaloneDisplay() ? 'installed' : 'mode') : (isStandaloneDisplay() && !signedInHereBefore() ? 'installed' : 'welcome')) : ''}
      ${!isForgot && isOnbInProgress() ? onbProgress('account') : ''}
      <h1>Logbuch</h1>
      <p class="sub" tabindex="-1">${title}</p>
      ${state.authError ? `<div class="notice" role="alert">${esc(state.authError)}</div>` : ''}
      ${renderNotice()}
      ${isForgot ? `<p class="habit-form-lock-note">${t('auth.forgotRecoveryNote')}</p>` : ''}
      ${!isSignup && !isForgot && state.confirmEmailFor ? renderConfirmEmailHelp() : ''}
      <form id="auth-form">
        <div class="auth-field">
          <label for="email">${t('auth.email')}</label>
          ${clearableInputHtml('email', 'email', state.authEmail, { autocomplete: 'email' })}
          ${isSignup ? `<p class="onb-hint auth-email-hint">${t('auth.emailWhy')}</p>` : ''}
        </div>
        ${!isForgot ? `
          <div class="auth-field">
            <div class="auth-field-label-row">
              <label for="password">${t('auth.password')}</label>
              <button type="button" class="push-toggle" data-action="toggle-password-visibility">${state.authPasswordVisible ? t('auth.hide') : t('auth.show')}</button>
            </div>
            ${clearableInputHtml('password', 'password', state.authPassword, {
              autocomplete: isSignup ? 'new-password' : 'current-password',
              minlength: AUTH_MIN_PASSWORD_LENGTH,
              showVisibilityToggle: true,
              visible: state.authPasswordVisible,
            })}
            ${isSignup ? `
              <p class="password-count${state.authPassword.length >= AUTH_MIN_PASSWORD_LENGTH ? ' password-count--ok' : ''}" id="password-count" aria-live="polite">${passwordRuleText(state.authPassword.length)}</p>
              <p class="onb-hint auth-password-hint">${t('auth.passwordHint')}</p>
              <details class="why-details" ${isGuided() ? 'open' : ''}><summary>${t('auth.passwordWhyTitle')}</summary><p>${t('auth.passwordWhy')}</p></details>
            ` : ''}
          </div>
        ` : ''}
        ${isSignup ? `
          <div class="auth-field honeypot-field" aria-hidden="true">
            <label for="website">Website</label>
            <input type="text" id="website" name="website" tabindex="-1" autocomplete="off" />
          </div>
        ` : ''}
        <button type="submit" class="auth-submit">${isForgot ? t('auth.sendResetLink') : isSignup ? t('auth.createAccount') : t('auth.login')}</button>
      </form>
      ${!isSignup ? `
        <button type="button" class="auth-toggle" data-action="${isForgot ? 'cancel-forgot' : 'start-forgot'}">
          ${isForgot ? t('auth.backToLogin') : t('auth.forgotPassword')}
        </button>
      ` : ''}
    </div>
  `;

  // Nur beim ERSTEN Aufbau des Signup-Formulars starten, nicht bei jedem Re-Render
  // (z.B. durch den ×-Button, den Passwort-sichtbar-Umschalter oder einen
  // Validierungsfehler) — sonst würde ein Re-Render kurz vor dem Absenden die
  // tatsächliche Ausfüllzeit fälschlich auf ~0 zurücksetzen und echte Nutzer träfe
  // der "zu schnell ausgefüllt"-Bot-Filter.
  if (isSignup) { if (runtime.signupFormShownAt === null) runtime.signupFormShownAt = Date.now(); }
  else runtime.signupFormShownAt = null;

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Registrieren dauert ein paar Sekunden - ohne sichtbare Rückmeldung tippten viele
    // nochmal, und der zweite Versuch meldete einen Fehler, obwohl der erste geklappt hatte.
    // Knopf deshalb sofort sperren und beschriften; das nächste render() baut ihn neu auf.
    if (authSubmitBusy) return;
    authSubmitBusy = true;
    const submitBtn = e.target.querySelector('.auth-submit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = t(isForgot ? 'auth.busy.forgot' : isSignup ? 'auth.busy.signup' : 'auth.busy.login'); }
    try {
    const email = document.getElementById('email').value.trim();
    state.authError = null;
    state.notice = null;
    if (isForgot) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
      });
      if (error) { state.authError = translateAuthError(error.message); render(); return; }
      state.notice = { type: 'ok', text: t('auth.resetLinkSent') };
      render();
      return;
    }
    const password = document.getElementById('password').value;
    // Muss VOR dem signUp/signInWithPassword-Aufruf gesetzt werden, nicht erst danach:
    // onAuthStateChange kann schon in der Lücke dazwischen feuern (siehe Kommentar bei
    // authFlowInFlight weiter unten im Skript).
    runtime.authFlowInFlight = true;
    try {
      if (isSignup) {
        const honeypotFilled = document.getElementById('website')?.value;
        const filledTooFast = runtime.signupFormShownAt !== null && Date.now() - runtime.signupFormShownAt < SIGNUP_MIN_FILL_MS;
        if (honeypotFilled || filledTooFast) {
          // Stillschweigend ablehnen statt konkret zu sagen warum — sonst lässt sich
          // der Filter durch einen Bot leicht anpassen ("Website"-Feld leer lassen,
          // langsamer abschicken).
          state.authError = t('auth.signupFailedGeneric');
          render();
          return;
        }
        const { data, error } = await supabase.auth.signUp({
          email, password,
          // locale landet in den Nutzer-Metadaten - die Vorlage der Bestätigungsmail
          // (Supabase-Dashboard, siehe docs/i18n.md) wählt damit Deutsch oder Englisch.
          options: { emailRedirectTo: window.location.origin + window.location.pathname, data: { locale: currentLocale } },
        });
        if (error) { state.authError = translateAuthError(error.message); render(); return; }
        if (!data.session) {
          state.confirmEmailFor = email;
          state.confirmResend = null;
          state.authMode = 'checkMail';
          render();
          return;
        }
        // E-Mail-Bestätigung war nicht nötig (sofortige Session) - Verschlüsselung kann
        // gleich eingerichtet werden.
        await completeAuthFlow(data.user.id, password);
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          state.authError = translateAuthError(error.message);
          if (error.message === 'Email not confirmed' && state.confirmEmailFor !== email) {
            state.confirmEmailFor = email;
            state.confirmResend = null;
          }
          render();
          return;
        }
        state.confirmEmailFor = null;
        state.confirmResend = null;
        await completeAuthFlow(data.user.id, password);
      }
    } catch (err) {
      // Angemeldet, aber Entsperren gescheitert (z.B. Verbindung weg) - die Entsperr-Maske
      // übernimmt und zeigt, woran es lag.
      state.unlockError = unlockErrorText(err);
      state.loading = false;
      render();
    } finally {
      runtime.authFlowInFlight = false;
    }
    } finally {
      authSubmitBusy = false;
    }
  });
}

export function renderPasswordRecovery() {
  const fallback = state.recoveryFallbackConfirm;
  app.innerHTML = `
    <div class="auth-box">
      <h1>Logbuch</h1>
      <p class="sub">${t('recovery.title')}</p>
      ${state.authError ? `<div class="notice" role="alert">${esc(state.authError)}</div>` : ''}
      <form id="recovery-form">
        <div class="auth-field">
          <label for="new-password">${t('recovery.newPassword')}</label>
          <input type="password" id="new-password" required autocomplete="new-password" minlength="${AUTH_MIN_PASSWORD_LENGTH}" ${state.recoveryBusy ? 'disabled' : ''} />
        </div>
        ${!fallback ? `
          <div class="auth-field">
            <label for="recovery-key-input">${t('recovery.key')}</label>
            <input type="text" id="recovery-key-input" placeholder="${esc(t('recovery.keyPlaceholder'))}" autocomplete="off" ${state.recoveryBusy ? 'disabled' : ''} />
          </div>
          <button type="submit" class="auth-submit" ${state.recoveryBusy ? 'disabled' : ''}>${state.recoveryBusy ? t('recovery.saving') : t('recovery.savePassword')}</button>
          <button type="button" class="auth-toggle" data-action="toggle-recovery-fallback">${t('recovery.keyAlsoLost')}</button>
        ` : `
          <div class="notice">${t('recovery.fallbackWarning')}</div>
          <button type="submit" class="auth-submit" ${state.recoveryBusy ? 'disabled' : ''}>${state.recoveryBusy ? t('recovery.saving') : t('recovery.setAnyway')}</button>
          <button type="button" class="auth-toggle" data-action="toggle-recovery-fallback">${t('recovery.cancelHaveKey')}</button>
        `}
      </form>
    </div>
  `;

  document.getElementById('recovery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('new-password').value;
    state.authError = null;
    state.notice = null;
    state.recoveryBusy = true;
    runtime.authFlowInFlight = true; // siehe Kommentar bei der Deklaration weiter unten im Skript
    render();
    try {
      const userId = state.session.user.id;
      let cleanupFailed = false;
      if (fallback) {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        await setupEncryption(userId, password, { replace: true });
        cleanupFailed = !(await deleteUndecryptableData(userId));
      } else {
        const recoveryKeyHex = document.getElementById('recovery-key-input').value;
        let dek;
        let dekId;
        let keyConfirmed;
        try {
          const row = await fetchEncryptionRow(userId);
          if (!row) throw new Error(t('recovery.error.noConfig'));
          dek = await unwrapDekWithRecoveryKey(row, recoveryKeyHex);
          dekId = row.dek_id;
          keyConfirmed = row.recovery_key_confirmed;
        } catch {
          throw new Error(t('recovery.error.wrongKey'));
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const kek = await deriveKek(password, salt, PBKDF2_ITERATIONS);
        const { iv: wrapIv, wrapped: wrappedDek } = await wrapDek(dek, kek);
        const { error: updErr } = await supabase.from('user_encryption')
          .update({ salt: bufToBase64(salt), kdf_iterations: PBKDF2_ITERATIONS, wrap_iv: wrapIv, wrapped_dek: wrappedDek })
          .eq('user_id', userId);
        if (updErr) throw updErr;
        // Gleicher DEK wie vorher, also auch gleiche Kennung - Caches anderer Geräte bleiben gültig.
        setCurrentDek(dek, dekId, userId);
        runtime.spareKeyPending = !keyConfirmed;
        await cacheDek(userId, dek, dekId);
      }
      // Supabase invalidiert andere Sessions beim Passwort-Ändern NICHT automatisch
      // (bekannte Lücke, siehe supabase/auth#797) - sonst bliebe ein anderes Gerät mit
      // dem alten Passwort/DEK-Stand eingeloggt. Best effort: schlägt der Aufruf fehl,
      // ist das eigentliche Passwort-Update trotzdem schon durch, deshalb kein throw.
      try { await supabase.auth.signOut({ scope: 'others' }); } catch { /* best effort */ }
      state.recoveryBusy = false;
      state.passwordRecovery = false;
      state.recoveryFallbackConfirm = false;
      state.notice = cleanupFailed
        ? { type: 'error', text: t('recovery.cleanupFailed') }
        : { type: 'ok', text: t('recovery.passwordSaved') };
      state.loading = true;
      render();
      await Promise.all([loadEntries(), loadHabits(), loadUserSettings(), loadSections(), loadFeatureAccess()]);
      state.loading = false;
      saveFieldNamesForPush(); // siehe completeAuthFlow
      render();
      maybeShowSpareKey();
    } catch (err) {
      state.recoveryBusy = false;
      state.authError = err.message || String(err);
      render();
    } finally {
      runtime.authFlowInFlight = false;
    }
  });
}

// Reset ohne Recovery-Key: alles mit dem alten DEK Verschlüsselte ist ab jetzt
// unlesbar - löschen statt es liegen zu lassen (sonst dauerhaft die Meldung "Feld(er)
// konnten nicht entschlüsselt werden", alte Tage erschienen leer und würden beim
// Eintragen überschrieben). Erst NACH setupEncryption: schlägt die fehl, bleibt der alte
// Stand erhalten, und wer den Recovery-Key doch noch findet, kommt wieder an alles.
// Feld-Definitionen nur mit enc - noch unverschlüsselte (Konto seit der Umstellung nicht
// geöffnet) bleiben lesbar und damit erhalten; Gruppen sind immer verschlüsselt.
// Best effort: das neue Passwort ist zu diesem Zeitpunkt schon gesetzt, ein Fehler hier
// darf den Reset nicht abbrechen (ein zweiter Versuch mit demselben Passwort würde von
// Supabase abgelehnt). Rückgabe: true = alles gelöscht.
async function deleteUndecryptableData(userId) {
  const results = await Promise.all([
    supabase.from('habit_entries').delete().eq('user_id', userId),
    supabase.from('habit_definitions').delete().eq('user_id', userId).not('enc', 'is', null),
    supabase.from('habit_sections').delete().eq('user_id', userId),
  ]).catch((err) => [{ error: err }]);
  const failed = results.filter((r) => r.error);
  failed.forEach((r) => console.error('Alte Daten nach Reset nicht gelöscht:', r.error.message || r.error));
  return failed.length === 0;
}

// "Ersatzschlüssel" (intern weiter recoveryKey): eigener Schritt NACH dem Tutorial, im
// Stil der Tutorial-Bildschirme (Symbol, Begründung, "Warum?"-Kasten, Details hinter
// "Mehr erfahren"). Nur über die Bestätigungs-Checkbox schließbar (auch Escape/Zurück
// greifen hier bewusst nicht).
// Ersatzschlüssel anzeigen (neu gestaltet 2026-10-01 nach einem Onboarding-Test: "Kopieren"
// und Zwischenablage waren unbekannt, die wichtigsten Knöpfe die unscheinbarsten, und ein
// ausgegrautes "Fertig" sagte nicht, warum es nicht geht). Vier gleich große Wege zum
// Aufbewahren, die bekanntesten (Aufschreiben, Foto) vorn; jeder zeigt danach, was zu tun
// ist. Der Abschluss-Knopf geht immer, fragt aber nach, wenn noch kein Weg benutzt wurde.
// Zustand je angezeigtem Schlüssel in state.recoveryKeyToShow (method, ask).
const SPARE_KEY_METHODS = ['write', 'photo', 'file', 'copy']; // zugleich die Namen ihrer Symbole (ICONS)
function spareKeyMethodHelp(method) {
  if (method === 'photo') {
    return t(isIOSDevice() ? 'recoveryDisplay.help.photoIos' : /Android/.test(navigator.userAgent) ? 'recoveryDisplay.help.photoAndroid' : 'recoveryDisplay.help.photoOther');
  }
  if (method === 'file') {
    return t(isIOSDevice() ? 'recoveryDisplay.help.fileIos' : /Android/.test(navigator.userAgent) ? 'recoveryDisplay.help.fileAndroid' : 'recoveryDisplay.help.fileOther');
  }
  if (method === 'copy') return t(isGuided() ? 'recoveryDisplay.help.copyGuided' : 'recoveryDisplay.help.copy');
  return t('recoveryDisplay.help.write');
}
// "Was, wenn ich beides verliere?" ist nur für den Ausnahmefall und deshalb auch bei
// "Schritt für Schritt" zugeklappt (kein whyBox) - die Seite war sonst zu lang.
export function renderRecoveryKeyDisplay() {
  const shown = state.recoveryKeyToShow;
  const formatted = formatRecoveryKey(shown.hex);
  const ask = shown.ask;
  app.innerHTML = `
    <div class="auth-box onb">
      ${isOnbInProgress() ? onbProgress('key') : ''}
      <div class="onb-icon" aria-hidden="true">${iconSvg('key')}</div>
      <h1 tabindex="-1">${t('recoveryDisplay.title')}</h1>
      <p class="tutorial-text">${t('recoveryDisplay.lead')}</p>
      ${whyBox('recoveryDisplay.whyTitle', 'recoveryDisplay.explain')}
      <p class="recovery-key-code" aria-label="${esc(t('recoveryDisplay.codeLabel'))}">${formatted.split('-').map((g) => `<span>${esc(g)}</span>`).join(' ')}</p>
      <p class="onb-hint"><strong>${t('recoveryDisplay.secret')}</strong></p>
      <h2 class="spare-key-question">${t('recoveryDisplay.how')}</h2>
      <div class="spare-key-methods" role="group" aria-label="${esc(t('recoveryDisplay.how'))}">
        ${SPARE_KEY_METHODS.map((m) => `<button type="button" class="spare-key-method${shown.method === m ? ' spare-key-method--active' : ''}" data-action="spare-key-method" data-method="${m}" aria-pressed="${shown.method === m}"><span class="spare-key-method-icon" aria-hidden="true">${iconSvg(m)}</span>${t(`recoveryDisplay.method.${m}`)}</button>`).join('')}
      </div>
      ${shown.method ? `<div class="form-tip spare-key-help" role="status">${icon('tip')}<p>${spareKeyMethodHelp(shown.method)}</p></div>` : ''}
      <details class="why-box"><summary class="why-box-title">${t('recoveryDisplay.moreLabel')}</summary><p>${t('recoveryDisplay.more')}</p></details>
      ${ask ? `
        <div class="spare-key-ask" role="alert">
          <p>${t(shown.method === 'write' ? 'recoveryDisplay.askWritten' : 'recoveryDisplay.askNone')}</p>
          <div class="habit-form-actions">
            <button type="button" class="habit-form-cancel" data-action="spare-key-ask-back">${t('recoveryDisplay.notYet')}</button>
            <button type="button" class="auth-submit" data-action="spare-key-finish">${t(shown.method === 'write' ? 'recoveryDisplay.yesWritten' : 'recoveryDisplay.yesKept')}</button>
          </div>
        </div>
      ` : `<button type="button" class="auth-submit" data-action="spare-key-done">${t('recoveryDisplay.done')}</button>`}
    </div>
  `;
}

// --- Installation vor dem Anmelden (seit 2026-09-29) ------------------------------
// Auf dem Handy im Browser kommt als Allererstes die Bitte, Logbuch auf den Home-
// Bildschirm zu holen - noch vor dem Registrieren, damit man sich gleich in der
// installierten App registriert bzw. anmeldet (vorher kam der Hinweis erst nach dem
// Anmelden, und man musste sich in der App ein zweites Mal anmelden; oft wurde er
// einfach weggeklickt). Mit Begründung ("Warum?") statt nur einer Aufforderung. Wer im
// Browser bleiben will, sieht die Seite auf diesem Gerät nicht wieder (localStorage).
export function isInstallGateSkipped() {
  try { return localStorage.getItem('installGateSkipped') === 'true'; } catch { return false; }
}
export function shouldShowInstallGate() {
  return isMobileDevice() && !isStandaloneDisplay() && !isInstallGateSkipped() && !runtime.installGateSkippedThisVisit;
}
// Welcher Browser? Die Anleitung unterscheidet sich je nachdem, wo Teilen/Menü sitzen.
function installBrowser() {
  const ua = navigator.userAgent;
  if (isIOSDevice()) return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  if (/Android/.test(ua)) {
    if (/SamsungBrowser/.test(ua)) return 'samsung';
    if (/Firefox/.test(ua)) return 'firefox';
    // Opera, Edge, Vivaldi, Yandex & Co. tragen "Chrome" in der Kennung, haben aber andere
    // Menüs - dort lieber die allgemeine Anleitung als eine falsche genaue.
    if (/OPR\//.test(ua)) return 'opera';
    if (/EdgA|Vivaldi|YaBrowser|DuckDuckGo|MiuiBrowser|HuaweiBrowser/.test(ua)) return 'other';
    return 'chrome';
  }
  return 'other';
}
// Gezeichnete Skizzen statt Screenshots (Nutzer-Entscheidung 2026-10-01): vereinfachte
// Handy-Ansicht, der richtige Knopf grün eingekreist, Beschriftung aus der App (eine Skizze
// für beide Sprachen), passt sich Hell/Dunkel an und altert langsamer als Screenshots.
// viewBox 200x300; Klassen sk-* siehe CSS.
function sketchFrame(content, label) {
  return `<svg class="install-sketch" viewBox="0 0 200 300" role="img" aria-label="${esc(label)}">
    <rect x="12" y="4" width="176" height="292" rx="22" class="sk-frame"/>
    ${content}
  </svg>`;
}
function sketchPage(top = 56) {
  return [0, 1, 2, 3, 4].map((i) => `<rect x="30" y="${top + i * 18}" width="${[140, 110, 130, 90, 120][i]}" height="7" rx="3" class="sk-line"/>`).join('');
}
function sketchText(x, y, text, opts = '') {
  return `<text x="${x}" y="${y}" class="sk-text" ${opts}>${esc(text)}</text>`;
}
const SK_SHARE = (x, y) => `<g class="sk-icon" transform="translate(${x - 7} ${y - 9})"><path d="M7 1v10M3.5 4.5 7 1l3.5 3.5"/><path d="M4 7H2.5v9h9V7H10"/></g>`;
export function sketchHtml(kind) {
  const L = (k) => t(`installSketch.${k}`);
  switch (kind) {
    case 'iosShare':
      return sketchFrame(`${sketchPage()}
        <rect x="26" y="226" width="148" height="22" rx="11" class="sk-bar"/>${sketchText(100, 241, 'logbuch', 'text-anchor="middle"')}
        ${['‹', '›', '', '▢', '⧉'].map((c, i) => (c ? sketchText(44 + i * 28, 274, c, 'text-anchor="middle"') : '')).join('')}
        ${SK_SHARE(100, 270)}<circle cx="100" cy="268" r="14" class="sk-hl"/>`, L('ariaIosShare'));
    case 'iosShareTop':
      return sketchFrame(`<rect x="26" y="18" width="148" height="24" rx="12" class="sk-bar"/>${sketchText(90, 34, 'logbuch', 'text-anchor="middle"')}
        ${SK_SHARE(160, 31)}<circle cx="160" cy="29" r="13" class="sk-hl"/>${sketchPage(60)}`, L('ariaIosShareTop'));
    case 'iosSheet': {
      const rows = [L('copy'), L('readingList'), L('addHome'), L('bookmark')];
      return sketchFrame(`${sketchPage()}<rect x="16" y="120" width="168" height="170" rx="14" class="sk-sheet"/>
        ${rows.map((r, i) => `<rect x="30" y="${136 + i * 36}" width="12" height="12" rx="3" class="sk-line"/>${sketchText(50, 146 + i * 36, r)}`).join('')}
        <rect x="22" y="${128 + 2 * 36}" width="156" height="28" rx="8" class="sk-hl"/>`, L('ariaIosSheet'));
    }
    case 'iosAdd':
      return sketchFrame(`<rect x="16" y="20" width="168" height="270" rx="14" class="sk-sheet"/>
        ${sketchText(28, 44, L('cancel'))}${sketchText(172, 44, L('add'), 'text-anchor="end" font-weight="600"')}
        <rect x="106" y="28" width="76" height="24" rx="8" class="sk-hl"/>
        <rect x="30" y="72" width="40" height="40" rx="10" class="sk-appicon"/>${sketchText(82, 96, 'Logbuch')}`, L('ariaIosAdd'));
    case 'chromeMenu':
      return sketchFrame(`<rect x="24" y="18" width="128" height="24" rx="12" class="sk-bar"/>${sketchText(88, 34, 'logbuch', 'text-anchor="middle"')}
        ${[24, 30, 36].map((y) => `<circle cx="170" cy="${y}" r="1.8" class="sk-dot"/>`).join('')}<circle cx="170" cy="30" r="13" class="sk-hl"/>${sketchPage(60)}`, L('ariaChromeMenu'));
    case 'chromeList': {
      const rows = [[L('newTab')], [L('history')], [L('bookmarks')], [L('addHomeAndroid1'), L('addHomeAndroid2')]];
      return sketchFrame(`${sketchPage(60)}<rect x="62" y="16" width="122" height="176" rx="8" class="sk-sheet"/>
        ${rows.map((r, i) => r.map((line, j) => sketchText(74, 42 + i * 34 + j * 13, line)).join('')).join('')}
        <rect x="66" y="${24 + 3 * 34}" width="114" height="40" rx="6" class="sk-hl"/>`, L('ariaChromeList'));
    }
    case 'samsungMenu':
      return sketchFrame(`${sketchPage()}<rect x="24" y="18" width="152" height="24" rx="12" class="sk-bar"/>${sketchText(100, 34, 'logbuch', 'text-anchor="middle"')}
        ${['‹', '›', '⌂', '▢'].map((c, i) => sketchText(36 + i * 34, 274, c, 'text-anchor="middle"')).join('')}
        ${[264, 269, 274].map((y) => `<rect x="161" y="${y - 0.9}" width="14" height="1.8" rx="0.9" class="sk-dot"/>`).join('')}<circle cx="168" cy="269" r="14" class="sk-hl"/>`, L('ariaSamsungMenu'));
    case 'samsungList': {
      const tiles = [[L('bookmarks')], [L('history')], [L('addPageTo1'), L('addPageTo2')], [L('downloads')]];
      return sketchFrame(`${sketchPage()}<rect x="16" y="150" width="168" height="140" rx="14" class="sk-sheet"/>
        ${tiles.map((tile, i) => { const cx = 58 + (i % 2) * 84, y = 166 + Math.floor(i / 2) * 56; return `<rect x="${cx - 8}" y="${y - 4}" width="16" height="16" rx="4" class="sk-line"/>${tile.map((line, j) => sketchText(cx, y + 24 + j * 10, line, 'text-anchor="middle" font-size="9"')).join('')}`; }).join('')}
        <rect x="18" y="${166 + 56 - 6}" width="80" height="46" rx="8" class="sk-hl"/>`, L('ariaSamsungList'));
    }
    case 'genericMenu':
      // Zwei übliche Stellen fürs Menü, beide gestrichelt markiert: "hier oder hier".
      return sketchFrame(`<rect x="24" y="18" width="128" height="24" rx="12" class="sk-bar"/>${sketchText(88, 34, 'logbuch', 'text-anchor="middle"')}
        ${[24, 30, 36].map((y) => `<circle cx="170" cy="${y}" r="1.8" class="sk-dot"/>`).join('')}<circle cx="170" cy="30" r="13" class="sk-hl sk-hl--maybe"/>
        ${sketchPage(60)}
        ${[264, 269, 274].map((y) => `<rect x="161" y="${y - 0.9}" width="14" height="1.8" rx="0.9" class="sk-dot"/>`).join('')}<circle cx="168" cy="269" r="14" class="sk-hl sk-hl--maybe"/>
        ${sketchText(100, 210, L('or'), 'text-anchor="middle" font-style="italic"')}`, L('ariaGenericMenu'));
    case 'genericList': {
      const rows = [[L('newTab')], [L('history')], [L('addHomeGeneric1'), L('addHomeGeneric2')], [L('settings')]];
      return sketchFrame(`${sketchPage(60)}<rect x="62" y="16" width="122" height="176" rx="8" class="sk-sheet"/>
        ${rows.map((r, i) => r.map((line, j) => sketchText(74, 42 + i * 34 + j * 13, line)).join('')).join('')}
        <rect x="66" y="${24 + 2 * 34}" width="114" height="40" rx="6" class="sk-hl"/>`, L('ariaGenericList'));
    }
    case 'operaList': {
      const rows = [[L('reload')], [L('share')], [L('addTo')], [L('zoom')]];
      return sketchFrame(`${sketchPage(60)}<rect x="62" y="16" width="122" height="176" rx="8" class="sk-sheet"/>
        ${rows.map((r, i) => r.map((line, j) => sketchText(74, 42 + i * 34 + j * 13, line)).join('')).join('')}
        ${sketchText(172, 110, '›', 'text-anchor="middle"')}
        <rect x="66" y="${26 + 2 * 34}" width="114" height="30" rx="6" class="sk-hl"/>`, L('ariaOperaList'));
    }
    case 'permIos':
      return sketchFrame(`${sketchPage()}<rect x="30" y="110" width="140" height="96" rx="14" class="sk-sheet"/>
        ${sketchText(100, 136, L('permIosLine1'), 'text-anchor="middle" font-weight="600"')}${sketchText(100, 150, L('permIosLine2'), 'text-anchor="middle" font-weight="600"')}
        <line x1="30" y1="170" x2="170" y2="170" class="sk-sep"/><line x1="100" y1="170" x2="100" y2="206" class="sk-sep"/>
        ${sketchText(65, 192, L('permDeny'), 'text-anchor="middle" font-size="9"')}${sketchText(135, 192, L('permAllow'), 'text-anchor="middle" font-weight="600"')}
        <rect x="104" y="174" width="62" height="28" rx="8" class="sk-hl"/>`, L('ariaPerm'));
    case 'permAndroid':
      // Drei kurze Zeilen: "Benachrichtigungen zu senden?" in einer Zeile ragte über den Dialog.
      return sketchFrame(`${sketchPage()}<rect x="26" y="104" width="148" height="122" rx="14" class="sk-sheet"/>
        ${['permAndroidLine1', 'permAndroidLine2', 'permAndroidLine3'].map((k, i) => sketchText(100, 128 + i * 14, L(k), 'text-anchor="middle" font-weight="600" font-size="10"')).join('')}
        ${sketchText(100, 192, L('permAllowAndroid'), 'text-anchor="middle" font-weight="600"')}${sketchText(100, 214, L('permDenyAndroid'), 'text-anchor="middle" font-size="10"')}
        <rect x="46" y="178" width="108" height="22" rx="8" class="sk-hl"/>`, L('ariaPerm'));
    default: return '';
  }
}
// Schritte je Browser: [Text-Schlüssel, Skizze]. Danach immer eine kurze Vorwarnung
// (der Browser schließt sich meist von selbst - laut Nutzer-Erfahrung kein Problem, daher
// kein eigener Schritt).
function installSteps() {
  switch (installBrowser()) {
    case 'ios-safari': return [['iosSafari1', 'iosShare'], ['ios2', 'iosSheet'], ['ios3', 'iosAdd']];
    case 'ios-other': return [['iosOther1', 'iosShareTop'], ['ios2', 'iosSheet'], ['ios3', 'iosAdd']];
    case 'samsung': return [['samsung1', 'samsungMenu'], ['samsung2', 'samsungList'], ['confirm', null]];
    case 'firefox': return [['firefox1', null], ['firefox2', null], ['confirm', null]];
    case 'chrome': return [['chrome1', 'chromeMenu'], ['chrome2', 'chromeList'], ['confirm', null]];
    case 'opera': return [['opera1', 'chromeMenu'], ['opera2', 'operaList'], ['confirm', null]];
    default: return [['other1', 'genericMenu'], ['other2', 'genericList'], ['confirm', null]];
  }
}
// Faustregel: bei "Schritt für Schritt" die Skizzen direkt im Ablauf, sonst die kurze
// Text-Fassung mit den Skizzen zum Aufklappen.
// Teilen-Symbol von iOS klein im Text statt einer Beschreibung ("Quadrat mit Pfeil nach oben") -
// das Wort "Teilen-Symbol" bleibt davor stehen, für Screenreader ist das Bild ausgeblendet.
const SHARE_ICON_SVG = '<svg class="inline-icon" width="0.9em" height="1.1em" viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 7.5H2.5v11h11v-11h-3"/><path d="M8 1.5v11"/><path d="M4.75 4.5L8 1.5l3.25 3"/></svg>';
// forceSketches: Skizzen direkt im Ablauf (wie bei "Schritt für Schritt") - auf der Seite
// "Logbuch aufs Handy holen" in der App ist man gezielt wegen der Anleitung da.
export function installManualHtml(forceSketches = false) {
  const steps = installSteps();
  const list = (withSketches) => `
    <p class="onb-hint">${t('installGate.vary')}</p>
    <ol class="onb-steps install-steps">
      ${steps.map(([key, sketch]) => `<li><span>${t(`installGate.step.${key}`).replace('[share]', SHARE_ICON_SVG)}</span>${withSketches && sketch ? sketchHtml(sketch) : ''}</li>`).join('')}
    </ol>
  `;
  return isGuided() || forceSketches
    ? list(true)
    : `${list(false)}<details class="why-box"><summary class="why-box-title">${t('installGate.showPictures')}</summary>${list(true)}</details>`;
}
// Installieren-Knopf (falls der Browser einen anbietet) bzw. Anleitung von Hand - gemeinsam
// für die Installations-Seite der Einführung und die Seite "Logbuch aufs Handy holen".
function installHowHtml({ forceSketches = false } = {}) {
  const manual = installManualHtml(forceSketches);
  return runtime.appJustInstalled
    ? `<p class="tutorial-text"><strong>${t('installGate.installed')}</strong></p>`
    : `
      ${otherBrowserBox()}
      ${runtime.deferredInstallPrompt ? `
        <button type="button" class="auth-submit" data-action="install-prompt">${t('installGate.installButton')}</button>
        <p class="onb-hint onb-hint--after">${t('installGate.installButtonNote')}</p>
        <details class="why-box install-fallback"><summary class="why-box-title">${t('installGate.manualFallback')}</summary>${manual}</details>
      ` : manual}
      <p class="onb-hint">${t('installGate.afterwards')}</p>
    `;
}
// Seite "Logbuch aufs Handy holen" (Menü bzw. "Zeig mir, wie" im Hinweis): dieselbe Anleitung
// wie in der Einführung, für alle, die dort "Ich bleib erst mal im Browser" gewählt haben.
export function renderInstallGuide() {
  return `
    <div class="onb install-guide">
      <p class="tutorial-text">${t('installGate.body')}</p>
      ${whyBox('installGate.whyTitle', isIOSDevice() ? 'installGate.whyIos' : 'installGate.whyAndroid')}
      ${installHowHtml({ forceSketches: true })}
    </div>
  `;
}
export function renderInstallGate() {
  const ios = isIOSDevice();
  const how = installHowHtml();
  app.innerHTML = `
    <div class="auth-box onb">
      ${authBackButton(state.authMode === 'signup' ? (isGuided() ? 'overview' : 'intro') : 'welcome')}
      ${isOnbInProgress() ? onbProgress('install') : ''}
      <div class="onb-icon" aria-hidden="true">${iconSvg('install')}</div>
      <h1 tabindex="-1">${t('installGate.title')}</h1>
      <p class="tutorial-text">${t('installGate.body')}</p>
      ${whyBox('installGate.whyTitle', ios ? 'installGate.whyIos' : 'installGate.whyAndroid')}
      ${how}
      <button type="button" class="auth-toggle" data-action="install-gate-skip">${t('installGate.skip')}</button>
      <p class="onb-hint onb-hint--after onb-center">${t(ios ? 'installGate.skipNoteIos' : 'installGate.skipNote')}</p>
    </div>
  `;
}
// Android-Browser außer Chrome/Samsung Internet: nach unserem Wissen erzeugt nur Chrome (und
// Samsung Internet) eine eigenständige App; Opera, Firefox & Co.
// legen eine Verknüpfung an, deren Mitteilungen an den Browser-Einstellungen hängen (am
// Gerät des Nutzers so gesehen: "Logbuch (Opera Verknüpfung)", App-Info zeigt auf Opera).
// Erkennen lässt sich nur der Browser, nicht, was er anlegt - deshalb informieren und den
// Weg über Chrome anbieten, nicht drängen. Auch wenn der Browser selbst einen
// Installieren-Knopf anbietet (beforeinstallprompt) - ob der dann eine echte App anlegt,
// ist bei Opera & Co. nicht belegt. Der Intent-Link öffnet die Seite direkt in
// Chrome; ?onb= nimmt dort das Einrichten wieder auf (Chrome hat einen eigenen Speicher).
function otherBrowserBox() {
  const browser = installBrowser();
  if (!/Android/.test(navigator.userAgent) || !['opera', 'firefox', 'other'].includes(browser)) return '';
  const name = t(browser === 'opera' ? 'installGate.browserOpera' : browser === 'firefox' ? 'installGate.browserFirefox' : 'installGate.browserOther');
  const intent = `intent://${location.host}${location.pathname}?onb=${isGuided() ? 'guided' : 'short'}#Intent;scheme=https;package=com.android.chrome;end`;
  const address = `${location.host}${location.pathname.replace(/logbuch\.html$/, '')}`;
  return `
    <div class="why-box install-other-browser">
      <p>${t('installGate.otherBrowser', { browser: name })}</p>
      <a class="auth-toggle install-chrome-link" href="${esc(intent)}">${t('installGate.openInChrome')}</a>
      <p class="onb-hint onb-hint--after">${t('installGate.openInChromeNote', { address })}</p>
    </div>
  `;
}
// Der Bestätigungslink aus der Registrierungs-Mail öffnet sich im Browser, nicht in der
// installierten App. Statt sich dann im Browser anzumelden: zurück in die App schicken
// (dort meldet man sich einmal an). Nur auf dem Handy und nur, wenn man nicht bewusst im
// Browser geblieben ist; "hier weitermachen" bleibt möglich.
export function renderConfirmLanding() {
  app.innerHTML = `
    <div class="auth-box onb">
      <div class="onb-icon" aria-hidden="true">${iconSvg('done')}</div>
      <h1 tabindex="-1">${t('confirmLanding.title')}</h1>
      <p class="tutorial-text">${t('confirmLanding.body')}</p>
      ${spamFeedbackHtml()}
      <button type="button" class="auth-toggle" data-action="confirm-landing-continue">${t('confirmLanding.continueHere')}</button>
    </div>
  `;
}

// Freiwillige Frage auf der Seite, die der Bestätigungslink öffnet (Nutzer-Entscheidung
// 2026-10-28): lag die Mail im Spam? Der Server speichert nur Antwort + großen Mail-Anbieter,
// ohne Konto-Bezug (record_signup_mail_feedback). Nach der Antwort nur ein Dank, danach weg.
function spamFeedbackHtml() {
  if (runtime.spamFeedbackAnswered) return '';
  return `
    <div class="spam-feedback" role="group" aria-labelledby="spam-feedback-q">
      <p id="spam-feedback-q" class="spam-feedback-q">${t('spamFeedback.question')}</p>
      <div class="spam-feedback-actions">
        <button type="button" class="manage-btn" data-action="spam-feedback" data-in-spam="true">${t('spamFeedback.yes')}</button>
        <button type="button" class="manage-btn" data-action="spam-feedback" data-in-spam="false">${t('spamFeedback.no')}</button>
      </div>
      <p class="habit-form-lock-note">${t('spamFeedback.why')}</p>
    </div>
  `;
}

export function renderUnlockPrompt() {
  app.innerHTML = `
    <div class="auth-box">
      ${isOnbInProgress() ? onbProgress('account') : ''}
      <h1>Logbuch</h1>
      <p class="sub">${t('unlock.title')}</p>
      ${state.session?.user?.email ? `<p class="unlock-account">${t('unlock.account', { email: state.session.user.email })}</p>` : ''}
      ${ARRIVED_VIA_SIGNUP_CONFIRM && !isStandaloneDisplay() ? `<div class="notice notice--ok">${t('unlock.afterConfirm')}</div>` : ''}
      ${ARRIVED_VIA_SIGNUP_CONFIRM ? spamFeedbackHtml() : ''}
      <p class="onb-hint">${t('unlock.explain')}</p>
      <details class="why-details" ${isGuided() ? 'open' : ''}><summary>${t('unlock.whyTitle')}</summary><p>${t('unlock.why')}</p></details>
      ${state.unlockError ? `<div class="notice" role="alert">${esc(state.unlockError)}</div>` : ''}
      <form id="unlock-form">
        <div class="auth-field">
          <label for="unlock-password">${t('auth.password')}</label>
          <input type="password" id="unlock-password" required autocomplete="current-password" ${state.unlockBusy ? 'disabled' : ''} />
        </div>
        <button type="submit" class="auth-submit" ${state.unlockBusy ? 'disabled' : ''}>${state.unlockBusy ? t('unlock.unlocking') : t('unlock.unlock')}</button>
      </form>
      <button type="button" class="auth-toggle" data-action="logout">${t('common.logout')}</button>
    </div>
  `;

  document.getElementById('unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('unlock-password').value;
    state.unlockBusy = true;
    state.unlockError = null;
    state.notice = null;
    render();
    try {
      // unlockEncryption deckt beide Fälle ab: bestehende Verschlüsselung entsperren
      // (Passwort falsch -> wirft) UND, falls noch keine user_encryption-Zeile
      // existiert (z.B. Konto gerade erst per E-Mail-Bestätigungslink angemeldet,
      // ohne dass je ein Passwort-Formular durchlaufen wurde), sie mit diesem
      // Passwort neu einrichten — bisher landete dieser Fall in einer Sackgasse
      // (immer "Falsches Passwort", obwohl gar keine Konfiguration existierte).
      // verifyPassword: hier hat niemand das Passwort bei Supabase geprüft (siehe
      // unlockEncryption); die Prüfung meldet sich neu an - authFlowInFlight hält
      // onAuthStateChange dabei heraus.
      runtime.authFlowInFlight = true;
      await completeAuthFlow(state.session.user.id, password, { verifyPassword: true });
      state.unlockBusy = false;
    } catch (err) {
      state.unlockBusy = false;
      state.unlockError = unlockErrorText(err);
      render();
    } finally {
      runtime.authFlowInFlight = false;
    }
  });
}

// Was beim Start einmal laufen muss (Event-Listener u.ä.). Nicht beim Laden des Moduls, sondern
// vom Einstieg (logbuch.js) aufgerufen, in fester Reihenfolge, wenn alle Module geladen sind.
export function initAuthView() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    runtime.deferredInstallPrompt = e;
    // Nur neu zeichnen, wenn die Installations-Seite gerade zu sehen ist - nicht mitten ins
    // Anmelde-Formular hinein.
    if (!state.session && shouldShowInstallGate()) render();
  });
  window.addEventListener('appinstalled', () => {
    runtime.deferredInstallPrompt = null;
    runtime.appJustInstalled = true;
    if (!state.session && shouldShowInstallGate()) render();
  });
}
