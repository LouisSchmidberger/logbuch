import { invalidateTodayAutoCollapse } from './fields.js?v=8aaa0e5b67';
import { WEEK_STARTS, reminderTimeInputHtml } from './dates.js?v=8aaa0e5b67';
import { currentDek, runtime, state } from './state.js?v=8aaa0e5b67';
import { app, esc, isNoteEditorOpen, isSubpageView, syncLayerHistory } from './navigation.js?v=8aaa0e5b67';
import { currentLocale, t, tPlain } from './i18n.js?v=8aaa0e5b67';
import { TEXT_SIZES, getTextSize, getThemeOverride, hapticsSupported, isDayProgressShown, isHapticsDisabled, isPatternDisabled } from './theme.js?v=8aaa0e5b67';
import { AUTH_MIN_PASSWORD_LENGTH, closeInfoTip, formatDMY, infoPop, weekdayLong } from './format.js?v=8aaa0e5b67';
import { syncToast } from './notices.js?v=8aaa0e5b67';
import { weekStartChange } from './data.js?v=8aaa0e5b67';
import { renderStepDialog, stepDialogOpen } from './type-change.js?v=8aaa0e5b67';
import { commitPendingNoteDraft } from './save.js?v=8aaa0e5b67';
import { canInstallFromHere, isAboutSectionCollapsed, pushBlockedHelp, renderInstallHint } from './device.js?v=8aaa0e5b67';
import { addOnbDisplayBar, passwordRuleText, renderAuth, renderConfirmLanding, renderInstallGate, renderInstallGuide, renderPasswordRecovery, renderRecoveryKeyDisplay, renderUnlockPrompt, shouldShowInstallGate } from './auth-view.js?v=8aaa0e5b67';
import { closeTimePicker, positionFloatingRowMenu, renderToday, renderTodayDayNav, timePicker } from './row-view.js?v=8aaa0e5b67';
import { renderGlobal, renderMonth, renderWeek, renderYear } from './stats-view.js?v=8aaa0e5b67';
import { renderAbout, renderFeedback, renderWhatsNew } from './about-view.js?v=8aaa0e5b67';
import { habitFormTitleKey, renderManage } from './fields-view.js?v=8aaa0e5b67';
import { renderTutorial } from './tutorial.js?v=8aaa0e5b67';
import { SWIPEABLE_VIEWS, lastPointerType } from './gestures.js?v=8aaa0e5b67';
import { consumePendingFieldFocus, pendingFieldFocus } from './deeplinks.js?v=8aaa0e5b67';

// --- Rendering: Haupt-App --------------------------------------------------
function renderPushRow() {
  if (state.pushStatus === 'unsupported') {
    return `<div class="push-row push-row--muted">${t('push.unsupported')}</div>`;
  }
  if (state.pushStatus === 'unknown' || state.pushStatus === 'busy') {
    return `<div class="push-row push-row--muted">${t('push.checking')}</div>`;
  }
  if (state.pushStatus === 'on') {
    return `<div class="push-row"><span>${icon('reminders')}${t('push.active')}</span> <button type="button" class="push-toggle" data-action="disable-push">${t('push.disable')}</button></div>`;
  }
  if (state.pushStatus === 'blocked') {
    return `<div class="push-row push-row--blocked"><span>${icon('remindersOff')}${t('push.blocked.status')}</span>${pushBlockedHelp()}</div>`;
  }
  return `
    <div class="push-row">
      <span>${icon('remindersOff')}${t('push.none')}</span>
      <button type="button" class="push-toggle" data-action="enable-push">${t('push.enable')}</button>
    </div>
  `;
}

// Symbole an Menüpunkten, Seitenköpfen und Abschnitts-Überschriften - alle an EINER Stelle,
// damit der geplante Wechsel von Emojis zu eigenen, gezeichneten Symbolen (Gestaltungs-
// Durchgang) nur hier passiert. Dekorativ (aria-hidden), der Text daneben sagt dasselbe.
// Symbole (Nutzer-Entscheidung 2026-10-29: eigene, gezeichnete statt Emojis, Stil "Feder +
// Moos-Fläche"): einfarbige Linie in Textfarbe, Flächen (class "f") leicht in Moos - passt sich
// so Dunkelmodus und Textgröße an und sieht auf jedem Gerät gleich aus (Emojis nicht). Raster
// 24x24, Strich/Farbe per CSS (.icon). Alle Symbole stehen hier; neue im selben Stil zeichnen.
const PEN = '<path class="f" d="M4.5 19.5l1-4.2L15.8 5a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L8.7 18.5z"/><path d="M14 7l3 3"/>';
const BELL = '<path class="f" d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>';
const PALETTE = '<path class="f" d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 1.6-2.1-.5-1.3.3-2.4 1.7-2.4H18a2.5 2.5 0 0 0 2.5-2.5c0-5.5-3.8-10-8.5-10z"/><circle cx="8" cy="11" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/>';
const SPARKLE = '<path class="f" d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 16v4M16.5 18h4"/>';
const ICONS = {
  manage: PEN, newField: PEN, fields: PEN, write: PEN,
  settings: '<path class="f" d="M12.0 4.8L13.9 2.7L15.6 3.2L16.0 6.0L17.1 6.9L19.9 6.7L20.8 8.4L19.1 10.6L19.2 12.0L21.3 13.9L20.8 15.6L18.0 16.0L17.1 17.1L17.3 19.9L15.6 20.8L13.4 19.1L12.0 19.2L10.1 21.3L8.4 20.8L8.0 18.0L6.9 17.1L4.1 17.3L3.2 15.6L4.9 13.4L4.8 12.0L2.7 10.1L3.2 8.4L6.0 8.0L6.9 6.9L6.7 4.1L8.4 3.2L10.6 4.9Z"/><circle cx="12" cy="12" r="3"/>',
  about: '<path class="f" d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z"/><path d="M12 6.5v13"/>',
  feedback: '<path class="f" d="M4 5.5h16v10.5H10.5L6.5 20v-4H4z"/>',
  newGroup: '<path class="f" d="M3.5 6.5v12a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2.5h-5a1 1 0 0 0-1 1z"/>',
  reminders: BELL,
  remindersOff: BELL + '<path d="M4 4l16 16"/>',
  display: PALETTE, appearance: PALETTE,
  account: '<circle class="f" cx="12" cy="8" r="3.5"/><path class="f" d="M5 20c.5-3.8 3.3-6 7-6s6.5 2.2 7 6z"/>',
  a11y: '<circle cx="12" cy="4.5" r="1.5"/><path d="M5 8.5l7 1.5 7-1.5M12 10v4.5M12 14.5l-3 6M12 14.5l3 6"/>',
  mentalHealth: '<path class="f" d="M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.6 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  privacy: '<rect class="f" x="5" y="11" width="14" height="9.5" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3M12 14.5v2.5"/>',
  usage: '<circle cx="12" cy="12" r="8"/><circle class="f" cx="12" cy="12" r="3.5"/>',
  news: SPARKLE,
  install: '<rect class="f" x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  hello: '<path class="f" d="M6 17a6 6 0 0 1 12 0z"/><path d="M3.5 17h17M12 5.5V8M5.5 9l1.7 1.7M18.5 9l-1.7 1.7M8 20.5h8"/>',
  calendar: '<rect class="f" x="4" y="5.5" width="16" height="14.5" rx="1.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  mail: '<rect class="f" x="3.5" y="6" width="17" height="12.5" rx="1.5"/><path d="M4 7l8 6 8-6"/>',
  key: '<circle class="f" cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16.5 6.5L19 9M14 9l2 2"/>',
  tip: '<path class="f" d="M8.6 14.2a5.5 5.5 0 1 1 6.8 0c-.8.7-1.2 1.6-1.3 2.8H9.9c-.1-1.2-.5-2.1-1.3-2.8z"/><path d="M10 20h4"/>',
  celebrate: '<path class="f" d="M4 20l4.5-11 6.5 6.5z"/><path d="M14 4.5v2M19.5 10h-2M17 6l1.5-1.5M12 8.5c1-1 1-2.5 0-3.5M15.5 12c1-1 2.5-1 3.5 0"/>',
  sprout: '<path d="M12 21v-8.5"/><path class="f" d="M12 12.5C12 8.5 9 6 4.5 6c0 4.2 3 6.5 7.5 6.5z"/><path class="f" d="M12 14.5c0-3.2 2.4-5.5 6.5-5.5 0 3.3-2.4 5.5-6.5 5.5z"/>',
  photo: '<path class="f" d="M4 8.5h3.5L9 6h6l1.5 2.5H20V19H4z"/><circle cx="12" cy="13.5" r="3.2"/>',
  file: '<path d="M12 4v9.5M8.5 10l3.5 3.5 3.5-3.5"/><path class="f" d="M4 15.5h4l1 2h6l1-2h4v4H4z"/>',
  copy: '<rect class="f" x="5.5" y="5" width="13" height="16" rx="1.5"/><path d="M9 5V3.5h6V5M9 11h6M9 15h4"/>',
  done: '<circle class="f" cx="12" cy="12" r="8.5"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
  stats: '<path d="M4 20h16"/><rect class="f" x="5.5" y="12" width="3" height="6"/><rect class="f" x="10.5" y="7" width="3" height="11"/><rect class="f" x="15.5" y="10" width="3" height="8"/>',
};
export function iconSvg(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}
export function icon(name) {
  return `<span class="item-icon" aria-hidden="true">${iconSvg(name)}</span>`;
}

// Das ☰-Menü enthält seit 2026-10-01 nur noch die Ziele; alle Einstellungen und
// Konto-Aktionen stehen auf der eigenen Seite "Einstellungen" (renderSettings). Vorher
// steckte alles in diesem schmalen Fenster, das dafür in sich scrollen musste (klappte
// nicht zuverlässig) und keinen Platz für Erklärungen hatte.
function renderMenu() {
  return `
    <div class="menu-panel">
      ${[['open-manage', 'manage', 'menu.manageFields'], ['open-settings', 'settings', 'menu.settings'], ['open-about', 'about', 'menu.about'], ['open-feedback', 'feedback', 'menu.feedback'],
        ...(canInstallFromHere() ? [['open-install', 'install', 'menu.install']] : [])]
        .map(([action, iconName, key]) => `<button type="button" class="menu-item-btn" data-action="${action}">${icon(iconName)}${t(key)}</button>`).join('')}
    </div>
  `;
}

// Einstellungen: Erinnerungen, Anzeige, Konto, je einklappbar. Erklärungen stehen direkt unter der
// jeweiligen Einstellung statt hinter einem "?" (Neulinge fanden die nicht). data-menu-
// target: Sprungziel für die Links aus "Über Logbuch" (focusSettingsTarget).
function renderSettings() {
  return `
    ${settingsSectionStart('reminders', 'settings.reminders')}
      <div data-menu-target="push">${renderPushRow()}</div>
      <div class="settings-row">
        <span class="settings-label" id="menu-default-time-label">${t('menu.defaultReminderTime')}</span>
        ${reminderTimeInputHtml('menu-default-time', state.userSettings.defaultReminderMinute, 'menu-default-time', false, 'menu-timezone-note', 'menu-default-time-label')}
        <p class="settings-note" id="menu-timezone-note">${t('settings.defaultReminderNote')} ${t('menu.timezoneNote', { tz: state.userSettings.timezone.replace(/_/g, ' ') })}</p>
      </div>
      <div class="settings-row">
        <label class="checkbox-field">
          <input type="checkbox" data-action="summary-notifications-toggle" aria-describedby="settings-summary-note" ${state.userSettings.summaryNotifications ? 'checked' : ''} />
          ${t('menu.summaryNotifications')}
        </label>
        <p class="settings-note" id="settings-summary-note">${t('menu.summaryNotificationsExplain')}</p>
      </div>
    </details>
    <div class="manage-section-divider"></div>
    ${settingsSectionStart('display', 'settings.display')}
      <div class="settings-row" data-menu-target="text-size">
        <span class="settings-label" id="menu-text-size-label">${t('textSize.label')}</span>
        <div class="pill-group seg" role="group" aria-labelledby="menu-text-size-label">
          ${TEXT_SIZES.map((size) => `<button type="button" class="pill-toggle${getTextSize() === size ? ' pill-toggle--active' : ''}" data-action="text-size-set" data-size="${size}" aria-pressed="${getTextSize() === size}">${t('textSize.' + (size || 'normal'))}</button>`).join('')}
        </div>
      </div>
      <div class="settings-row" data-menu-target="theme">
        <span class="settings-label" id="menu-theme-label">${t('theme.label')}</span>
        <div class="pill-group seg" role="group" aria-labelledby="menu-theme-label">
          <button type="button" class="pill-toggle${!getThemeOverride() ? ' pill-toggle--active' : ''}" data-action="theme-set" data-theme="" aria-pressed="${!getThemeOverride()}">${t('theme.system')}</button>
          <button type="button" class="pill-toggle${getThemeOverride() === 'light' ? ' pill-toggle--active' : ''}" data-action="theme-set" data-theme="light" aria-pressed="${getThemeOverride() === 'light'}">${t('theme.light')}</button>
          <button type="button" class="pill-toggle${getThemeOverride() === 'dark' ? ' pill-toggle--active' : ''}" data-action="theme-set" data-theme="dark" aria-pressed="${getThemeOverride() === 'dark'}">${t('theme.dark')}</button>
        </div>
      </div>
      <div class="settings-row" data-menu-target="language">
        <label for="menu-locale">${t('menu.language')}</label>
        <select id="menu-locale" data-action="menu-locale">
          <option value="de" ${currentLocale === 'de' ? 'selected' : ''}>Deutsch</option>
          <option value="en" ${currentLocale === 'en' ? 'selected' : ''}>English</option>
        </select>
      </div>
      <div class="settings-row" data-menu-target="week-start">
        <label for="menu-week-start">${t('settings.weekStart')}</label>
        <select id="menu-week-start" data-action="menu-week-start" aria-describedby="settings-week-start-note" ${weekStartChange.running ? 'disabled' : ''}>
          ${WEEK_STARTS.map((iso) => `<option value="${iso}" ${state.userSettings.weekStart === iso ? 'selected' : ''}>${esc(weekdayLong(new Date(2024, 0, iso)))}</option>`).join('')}
        </select>
        <p class="settings-note" id="settings-week-start-note">${t('settings.weekStartNote')}</p>
        ${weekStartChange.running ? `<p class="settings-note" id="week-start-progress" role="status">${t('settings.weekStartRunning')}</p>` : ''}
      </div>
      <div class="settings-row" data-menu-target="pattern">
        <label class="checkbox-field">
          <input type="checkbox" data-action="pattern-toggle" aria-describedby="settings-pattern-note" ${isPatternDisabled() ? '' : 'checked'} />
          ${t('pattern.enableLabel')}
        </label>
        <p class="settings-note" id="settings-pattern-note">${t('pattern.explain')}</p>
      </div>
      <div class="settings-row" data-menu-target="day-progress">
        <label class="checkbox-field">
          <input type="checkbox" data-action="day-progress-toggle" aria-describedby="settings-day-progress-note" ${isDayProgressShown() ? 'checked' : ''} />
          ${t('dayProgress.label')}
        </label>
        <p class="settings-note" id="settings-day-progress-note">${t('dayProgress.explain')}</p>
      </div>
      ${hapticsSupported() ? `
        <div class="settings-row">
          <label class="checkbox-field">
            <input type="checkbox" data-action="haptics-toggle" ${isHapticsDisabled() ? '' : 'checked'} />
            ${t('haptics.enableLabel')}
          </label>
        </div>
      ` : ''}
    </details>
    <div class="manage-section-divider"></div>
    ${settingsSectionStart('account', 'menu.groupAccount')}
      <div class="settings-row" data-menu-target="password">
        <button type="button" class="menu-item-btn" data-action="open-password-change">${t('menu.changePassword')}</button>
      </div>
      <div class="settings-row" data-menu-target="email">
        <button type="button" class="menu-item-btn" data-action="open-email-change">${t('menu.changeEmail')}</button>
        <p class="settings-note">${state.session?.user?.new_email
          ? t('settings.emailPending', { email: state.session.user.new_email })
          : t('settings.emailCurrent', { email: state.session?.user?.email ?? '' })}</p>
      </div>
      <div class="settings-row" data-menu-target="export">
        <button type="button" class="menu-item-btn" data-action="export-data">${t('menu.exportData')}</button>
        <p class="settings-note">${t('settings.exportNote')}</p>
      </div>
      <div class="settings-row" data-menu-target="spare-key-check">
        <button type="button" class="menu-item-btn" data-action="open-spare-key-check">${t('menu.checkSpareKey')}</button>
        <p class="settings-note">${t('settings.checkSpareKeyNote')}</p>
      </div>
      <div class="settings-row" data-menu-target="recovery-key">
        <button type="button" class="menu-item-btn" data-action="regenerate-recovery-key">${t('menu.regenerateRecoveryKey')}</button>
        <p class="settings-note">${t('settings.recoveryKeyNote')}</p>
      </div>
      <div class="settings-row settings-row--buttons">
        <button type="button" class="menu-item-btn" data-action="logout-arm">${t('common.logout')}</button>
        <button type="button" class="menu-item-btn menu-item-btn--danger" data-action="open-delete-confirm">${t('menu.deleteAccount')}</button>
      </div>
    </details>
  `;
}
// Wie die Abschnitte in "Über Logbuch": bei jedem Öffnen der Seite zugeklappt (siehe
// openAboutSections), so ist auf einen Blick zu sehen, was es gibt.
function settingsSectionStart(id, titleKey) {
  const key = `settings:${id}`;
  return `
    <details class="tip-group settings-section" data-collapse-key="${key}" ${isAboutSectionCollapsed(key) ? '' : 'open'}>
      <summary class="manage-section-title">${icon(id)}${t(titleKey)}</summary>`;
}

function renderResetConfirm() {
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="reset-confirm-title">
        <h2 id="reset-confirm-title">${t('resetConfirm.title')}</h2>
        <p>${t('resetConfirm.body', { date: formatDMY(state.resetConfirm) })}</p>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="reset-day-cancel">${t('common.cancel')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="reset-day-confirm">${t('resetConfirm.confirm')}</button>
        </div>
      </div>
    </div>
  `;
}

// Ein neuer Ersatzschlüssel macht den alten sofort ungültig - auch den, den man
// aufgeschrieben oder abgelegt hat. Ohne Rückfrage genügte ein neugieriger Tipp im Menü.
function renderRegenKeyConfirm() {
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="regen-key-confirm-title">
        <h2 id="regen-key-confirm-title">${t('regenKeyConfirm.title')}</h2>
        <p>${t('regenKeyConfirm.body')}</p>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="regen-key-cancel">${t('common.cancel')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="regen-key-confirm">${t('regenKeyConfirm.confirm')}</button>
        </div>
      </div>
    </div>
  `;
}

// Abmelden beendet die Erinnerungen auf diesem Gerät und verlangt danach wieder das
// Passwort - beides sollte man vorher wissen (und nicht per Versehen auslösen).
function renderLogoutConfirm() {
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="logout-confirm-title">
        <h2 id="logout-confirm-title">${t('logoutConfirm.title')}</h2>
        <p>${t('logoutConfirm.body')}</p>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="logout-cancel">${t('common.cancel')}</button>
          <button type="button" class="auth-submit" data-action="logout">${t('common.logout')}</button>
        </div>
      </div>
    </div>
  `;
}

// Siehe leaveFormGuarded. "Weiter bearbeiten" links als sichere Wahl (Anfangsfokus).
function renderLeaveFormConfirm() {
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="leave-form-title" aria-describedby="leave-form-body">
        <h2 id="leave-form-title">${t('leaveForm.title')}</h2>
        <p id="leave-form-body">${t(state.sectionForm ? 'leaveForm.bodyGroup' : 'leaveForm.bodyField')}</p>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="leave-form-stay">${t('leaveForm.stay')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="leave-form-discard">${t('leaveForm.discard')}</button>
        </div>
      </div>
    </div>
  `;
}

// Eigenes Formular statt der Anmelde-Felder: Passwort-Manager erkennen am versteckten
// Benutzernamen (autocomplete="username") und an current-/new-password, zu welchem Konto das
// neue Passwort gehört, und bieten an, es zu ersetzen.
function renderPasswordChange() {
  const pc = state.passwordChange;
  const off = pc.busy ? 'disabled' : '';
  const type = pc.visible ? 'text' : 'password';
  const ok = pc.next.length >= AUTH_MIN_PASSWORD_LENGTH;
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="password-change-title">
        <h2 id="password-change-title">${t('passwordChange.title')}</h2>
        ${pc.error ? `<div class="notice" role="alert">${esc(pc.error)}</div>` : ''}
        <form id="password-change-form">
          <input type="email" class="visually-hidden" autocomplete="username" value="${esc(state.session?.user?.email ?? '')}" readonly tabindex="-1" aria-hidden="true" />
          <div class="auth-field">
            <div class="auth-field-label-row">
              <label for="password-change-current">${t('passwordChange.current')}</label>
              <button type="button" class="push-toggle" data-action="password-change-visibility" ${off}>${pc.visible ? t('auth.hide') : t('auth.show')}</button>
            </div>
            <input type="${type}" id="password-change-current" value="${esc(pc.current)}" required autocomplete="current-password" data-autofocus ${off} />
          </div>
          <div class="auth-field">
            <label for="password-change-new">${t('passwordChange.new')}</label>
            <input type="${type}" id="password-change-new" value="${esc(pc.next)}" required autocomplete="new-password" minlength="${AUTH_MIN_PASSWORD_LENGTH}" aria-describedby="password-change-count" ${off} />
            <p class="password-count${ok ? ' password-count--ok' : ''}" id="password-change-count" aria-live="polite">${passwordRuleText(pc.next.length)}</p>
          </div>
          <p class="settings-note">${t('passwordChange.note')}</p>
          <div class="habit-form-actions">
            <button type="button" class="habit-form-cancel" data-action="password-change-cancel" ${off}>${t('common.cancel')}</button>
            <button type="submit" class="auth-submit" ${off}>${pc.busy ? t('passwordChange.saving') : t('passwordChange.submit')}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// Prüft nur auf dem Gerät (entpackt der Schlüssel den DEK?) - nichts wird gespeichert oder
// verändert. Wer erst beim Passwort-Reset merkt, dass der aufgeschriebene Schlüssel nicht
// (mehr) passt, verliert sonst alle Daten.
function renderSpareKeyCheck() {
  const sc = state.spareKeyCheck;
  const off = sc.busy ? 'disabled' : '';
  const result = sc.result === 'ok'
    ? `<div class="notice notice--ok" role="status">${t('spareKeyCheck.ok')}</div>`
    : sc.result === 'wrong' ? `<div class="notice" role="alert">${t('spareKeyCheck.wrong')}</div>`
    : sc.result === 'error' ? `<div class="notice" role="alert">${esc(sc.errorText)}</div>` : '';
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="spare-key-check-title">
        <h2 id="spare-key-check-title">${t('spareKeyCheck.title')}</h2>
        <p>${t('spareKeyCheck.body')}</p>
        <form id="spare-key-check-form">
          <div class="auth-field">
            <label for="spare-key-check-input">${t('recovery.key')}</label>
            <input type="text" id="spare-key-check-input" value="${esc(sc.value)}" required autocomplete="off" autocapitalize="off" spellcheck="false" data-autofocus ${off} />
          </div>
          ${result}
          <div class="habit-form-actions">
            <button type="button" class="habit-form-cancel" data-action="spare-key-check-close" ${off}>${t('common.close')}</button>
            <button type="submit" class="auth-submit" ${off}>${sc.busy ? t('spareKeyCheck.checking') : t('spareKeyCheck.submit')}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// Supabase ändert die Adresse erst, wenn in der Mail an die neue bestätigt wurde - bis dahin
// gilt die bisherige weiter. Die bisherige muss nicht zustimmen (man hat oft keinen Zugang
// mehr), deshalb hier das Passwort (siehe docs/datenschutz-sicherheit.md).
function renderEmailChange() {
  const ec = state.emailChange;
  const off = ec.busy ? 'disabled' : '';
  if (ec.sentTo) {
    return `
      <div class="modal-overlay">
        <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="email-change-title">
          <h2 id="email-change-title">${t('emailChange.sentTitle')}</h2>
          <p>${t('emailChange.sentBody', { email: ec.sentTo })}</p>
          <p class="settings-note">${t('emailChange.sentSpam')}</p>
          <div class="habit-form-actions">
            <button type="button" class="auth-submit" data-action="email-change-close">${t('common.close')}</button>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="email-change-title">
        <h2 id="email-change-title">${t('emailChange.title')}</h2>
        <p>${t('emailChange.current', { email: state.session?.user?.email ?? '' })}</p>
        ${ec.error ? `<div class="notice" role="alert">${esc(ec.error)}</div>` : ''}
        <form id="email-change-form">
          <div class="auth-field">
            <label for="email-change-input">${t('emailChange.new')}</label>
            <input type="email" id="email-change-input" value="${esc(ec.value)}" required autocomplete="email" data-autofocus ${off} />
          </div>
          <div class="auth-field">
            <label for="email-change-password">${t('emailChange.password')}</label>
            <input type="password" id="email-change-password" value="${esc(ec.password)}" required autocomplete="current-password" ${off} />
          </div>
          <p class="settings-note">${t('emailChange.note')}</p>
          <div class="habit-form-actions">
            <button type="button" class="habit-form-cancel" data-action="email-change-close" ${off}>${t('common.cancel')}</button>
            <button type="submit" class="auth-submit" ${off}>${ec.busy ? t('emailChange.sending') : t('emailChange.submit')}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderDeleteConfirm() {
  const busy = state.deleteConfirm.busy;
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
        <h2 id="delete-confirm-title">${t('deleteAccount.title')}</h2>
        <p class="delete-account-email">${t('deleteAccount.whichAccount', { email: state.session?.user?.email ?? '' })}</p>
        <p>${t('deleteAccount.warning')}</p>
        <div class="auth-field">
          <label for="delete-confirm-input">${t('deleteAccount.typeToConfirm', { word: t('deleteAccount.confirmWord') })}</label>
          <input type="text" id="delete-confirm-input" autocomplete="off" ${busy ? 'disabled' : ''} />
        </div>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="delete-confirm-cancel" ${busy ? 'disabled' : ''}>${t('common.cancel')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="delete-confirm-submit" ${busy ? 'disabled' : ''}>${busy ? t('deleteAccount.deleting') : t('deleteAccount.deletePermanently')}</button>
        </div>
      </div>
    </div>
  `;
}

// Link aus "Über Logbuch" (siehe renderTip): Einstellungen sind schon offen - zur
// Einstellung scrollen, kurz hervorheben und fokussieren (bei einer Pill-Gruppe die gerade
// aktive Pill; Auswahllisten nicht nach Bedienung per Finger, siehe focusReopensPicker).
export function focusSettingsTarget(target) {
  const row = document.querySelector(`[data-menu-target="${target}"]`);
  if (!row) return;
  const section = row.closest('details');
  if (section) section.open = true; // eingeklappten Abschnitt aufklappen (merkt sich der toggle-Listener)
  row.scrollIntoView({ block: 'center' });
  row.classList.add('field-highlight');
  row.addEventListener('animationend', () => row.classList.remove('field-highlight'), { once: true });
  const focusEl = row.querySelector('[aria-pressed="true"]') || row.querySelector('button, input, select');
  if (focusEl && !focusReopensPicker(focusEl)) focusEl.focus({ preventScroll: true });
}

// Header+☰-Menü sind für Tabs und Unterseiten identisch aufgebaut (nur der linke Teil
// unterscheidet sich: "Logbuch"-Wortmarke vs. ←-Button + Seitentitel) - deshalb hier
// als eigener Baustein statt zweimal dupliziert.
function renderMenuButton() {
  return `
    <div class="header-menu-wrap">
      <button type="button" class="menu-btn" data-action="toggle-menu" aria-expanded="${state.menuOpen}"><span aria-hidden="true">☰</span> ${t('ariaLabel.menu')}</button>
      ${state.menuOpen ? renderMenu() : ''}
    </div>
  `;
}

function renderSubpageHeader(titleKey, iconName) {
  return `
    <div class="header subpage-header">
      <div class="subpage-header-title">
        <button type="button" class="back-btn" data-action="subpage-back" aria-label="${esc(t('ariaLabel.back'))}">
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <h1 tabindex="-1">${iconName ? icon(iconName) : ''}${t(titleKey)}</h1>
      </div>
      ${renderMenuButton()}
    </div>
  `;
}

let lastFocusedSubpageLevel = null;
function renderApp() {
  // Ein Re-Render, während in einer Textarea getippt wird (Notiz-Editor oder Text-Feld,
  // z.B. durch einen im Hintergrund fertig werdenden Push-Status-Check), ersetzt sie -
  // der Text selbst überlebt über state (noteEditor.draft bzw. state.entries, siehe
  // updateTextValue), Fokus und Cursor-Position hier.
  const active = document.activeElement;
  const caret = active?.tagName === 'TEXTAREA' && active.id ? { id: active.id, range: [active.selectionStart, active.selectionEnd] } : null;
  const subpage = isSubpageView(state.view);
  // Rutsch-Animation nach einem Zeitraum-Wechsel (shiftPeriod): der neue Zeitraum kommt
  // aus der Richtung, in die man gewischt/geblättert hat. Bewusst nur um den Inhalt, nicht
  // um die Dialoge (position: fixed verträgt kein verschobenes Elternelement).
  const slide = !state.loading && SWIPEABLE_VIEWS.includes(state.view) ? runtime.pendingPeriodSlide : 0;
  const slideClass = slide > 0 ? ' view-slide-next' : slide < 0 ? ' view-slide-prev' : '';
  runtime.pendingPeriodSlide = 0;
  const body = state.loading ? `<div class="loading">${t('common.loading')}</div>` :
    state.view === 'today' ? renderToday() :
    state.view === 'week' ? renderWeek() :
    state.view === 'month' ? renderMonth() :
    state.view === 'year' ? renderYear() :
    state.view === 'global' ? renderGlobal() :
    state.view === 'about' ? renderAbout() :
    state.view === 'feedback' ? renderFeedback() :
    state.view === 'settings' ? renderSettings() :
    state.view === 'install' ? renderInstallGuide() : renderManage();

  app.innerHTML = `
    <div class="sticky-top">
      ${subpage
        ? renderSubpageHeader(state.view === 'manage' && state.habitForm
          ? habitFormTitleKey(state.habitForm)
          : state.view === 'manage' && state.sectionForm
            ? (state.sectionForm.id ? 'habitForm.title.editGroup' : 'habitForm.title.newGroup')
            : { manage: 'menu.manageFields', about: 'about.title', feedback: 'feedback.title', settings: 'menu.settings', install: 'menu.install' }[state.view], state.view === 'manage' ? (state.sectionForm ? 'newGroup' : 'manage') : state.view)
        : `
          <div class="header">
            <h1>Logbuch</h1>
            ${renderMenuButton()}
          </div>
          <div class="tabs">
            <button type="button" class="tab${state.view === 'today' ? ' tab--active' : ''}" data-action="set-view" data-view="today">${t('tabs.today')}</button>
            <button type="button" class="tab${state.view === 'week' ? ' tab--active' : ''}" data-action="set-view" data-view="week">${t('tabs.week')}</button>
            <button type="button" class="tab${state.view === 'month' ? ' tab--active' : ''}" data-action="set-view" data-view="month">${t('tabs.month')}</button>
            <button type="button" class="tab${state.view === 'year' ? ' tab--active' : ''}" data-action="set-view" data-view="year">${t('tabs.year')}</button>
            <button type="button" class="tab${state.view === 'global' ? ' tab--active' : ''}" data-action="set-view" data-view="global">${t('tabs.global')}</button>
          </div>
          ${state.view === 'today' && !state.loading ? renderTodayDayNav() : ''}
        `}
    </div>
    ${renderInstallHint()}
    <div class="view-body${slideClass}">${body}</div>
    ${state.deleteConfirm ? renderDeleteConfirm() : ''}
    ${state.passwordChange ? renderPasswordChange() : ''}
    ${state.spareKeyCheck ? renderSpareKeyCheck() : ''}
    ${state.emailChange ? renderEmailChange() : ''}
    ${state.resetConfirm ? renderResetConfirm() : ''}
    ${state.regenKeyConfirm ? renderRegenKeyConfirm() : ''}
    ${state.logoutConfirm ? renderLogoutConfirm() : ''}
    ${state.leaveFormConfirm ? renderLeaveFormConfirm() : ''}
    ${state.view === 'manage' && stepDialogOpen() && !state.leaveFormConfirm ? renderStepDialog() : ''}
    ${state.whatsNew && !state.deleteConfirm && !state.passwordChange && !state.spareKeyCheck && !state.emailChange && !state.resetConfirm && !state.regenKeyConfirm && !state.logoutConfirm && !state.leaveFormConfirm ? renderWhatsNew() : ''}
  `;
  // preventScroll: der Header ist ohnehin (sticky) sichtbar - der native
  // Scroll-in-View-Effekt beim Fokussieren kennt "position: sticky" nicht und hat
  // dadurch leicht falsch/zu weit gescrollt (Header wirkte oben angeschnitten).
  // Überschrift nur beim Betreten einer Unterseite bzw. Wechsel ihrer Ebene (Liste ↔
  // Feld-Formular) fokussieren - vorher bei JEDEM render(), wodurch z.B. jede
  // Umschaltung im Feld-Formular den Tastatur-Fokus wieder ganz nach oben warf.
  const subpageLevel = subpage ? state.view + (state.view === 'manage' && state.habitForm ? ':form' : state.view === 'manage' && state.sectionForm ? ':section-form' : '') : null;
  if (subpageLevel && subpageLevel !== lastFocusedSubpageLevel) document.querySelector('.subpage-header h1')?.focus({ preventScroll: true });
  lastFocusedSubpageLevel = subpageLevel;
  const caretInput = caret && document.getElementById(caret.id);
  if (caretInput) {
    caretInput.focus({ preventScroll: true });
    caretInput.setSelectionRange(...caret.range);
  }
  // Screenreader erfahren so, welcher Zeitraum jetzt gezeigt wird (der Pfeil sagt nur
  // "Nächster Tag").
  if (slide) announce(document.querySelector('.day-nav .day-label')?.textContent.replace(/\s+/g, ' ').trim() ?? '');
}
export function announceAlert(text) {
  const el = document.getElementById('sr-alert');
  if (!el || !text) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 50);
}
export function announce(text) {
  const el = document.getElementById('sr-announcer');
  if (!el || !text) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 50); // leeren + neu setzen: auch Gleiches wird erneut angesagt
}

// Fokussiert nach einem Re-Render das erste fokussierbare Element im gerade
// offenen Modal (falls eins offen ist) — zentral hier statt an jeder
// Öffnungsstelle einzeln, da render() das DOM immer komplett neu aufbaut und
// damit jeden zuvor gesetzten Fokus ohnehin verwirft.
function focusModalIfOpen() {
  const modalBox = document.querySelector('.modal-box');
  if (!modalBox) return;
  const focusable = modalBox.querySelector('[data-autofocus]')
    || modalBox.querySelector('input, button, select, textarea, [tabindex]:not([tabindex="-1"])');
  focusable?.focus();
}

// Merkt sich die zuletzt gerenderte Ansicht, um beim tatsächlichen Wechsel (Tab oder
// Unterseite) nach oben zu scrollen - sonst behält der Browser die Scroll-Position
// einer SPA über einen kompletten Inhaltswechsel hinweg bei (kein echter
// Seitenwechsel), z.B. wäre man nach dem Wechsel von einem herunter gescrollten
// "Heute" zu "Monat" dort ebenfalls mitten in der Seite statt oben gelandet.
let lastRenderedView = null;
// Startbildschirm statt Passwort-Abfrage, solange der Schlüssel gerade ohne Zutun geladen
// wird: beim Öffnen mit gespeicherter Anmeldung (runtime.sessionRestoreInFlight, siehe
// onAuthStateChange) und nach dem Absenden der Anmeldung (runtime.authFlowInFlight). Vorher
// stand dort sekundenlang "Passwort eingeben" - man tippte es ein, obwohl die App gleich von
// selbst aufging. startupShownAt: seit wann er steht (für den Hinweis bei langem Laden).
let startupShownAt = null;
const STARTUP_SLOW_HINT_MS = 8000;
function isOpeningAccount() {
  return Boolean(state.session) && !currentDek && (runtime.sessionRestoreInFlight || runtime.authFlowInFlight)
    && !state.unlockError && !state.unlockBusy;
}
function renderStartupScreen() {
  startupShownAt ??= Date.now();
  // Der Hinweis erscheint per CSS-Verzögerung - gerechnet ab dem ersten Anzeigen, damit
  // ein zwischendurch neu gezeichneter Bildschirm die Wartezeit nicht neu startet.
  const hintDelay = Math.max(0, STARTUP_SLOW_HINT_MS - (Date.now() - startupShownAt));
  app.innerHTML = `
    <div class="auth-box startup" role="status">
      <h1>Logbuch</h1>
      <p class="sub">${t('startup.opening')}</p>
      <p class="onb-hint startup-slow" style="animation-delay:${hintDelay}ms">${t('startup.slow')}</p>
    </div>
  `;
}
// Tastatur-Fokus über render() hinweg erhalten: render() ersetzt das ganze #app, das
// fokussierte Element verschwindet also bei jeder Aktion - wer per Tastatur, Schalter-
// Steuerung oder Screenreader einen Wert wählt, eine Gruppe aufklappt oder im Formular
// etwas umschaltet, stünde danach wieder am Seitenanfang. Deshalb vorher merken, WAS
// fokussiert war (id bzw. data-action + übrige data-Merkmale - bei den neu gebauten
// Elementen gleich), und nachher das entsprechende neue Element fokussieren. Nur wenn
// nichts anderes den Fokus bekommen hat (Dialog, Überschrift einer neuen Unterseite) -
// Aktionen, die bewusst woandershin fokussieren, tun das nach render() und gewinnen.
function focusKeyOf(el) {
  if (!el || el === document.body || !app.contains(el)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (!el.dataset.action) return null;
  return [...el.attributes]
    .filter((a) => a.name.startsWith('data-') && a.name !== 'data-dirty')
    .map((a) => `[${a.name}="${CSS.escape(a.value)}"]`)
    .join('');
}
function restoreFocus(key) {
  const active = document.activeElement;
  if (!key || (active && active !== document.body && app.contains(active))) return;
  let el = null;
  try { el = app.querySelector(key); } catch { /* ungültiger Selektor - egal */ }
  if (el && !focusReopensPicker(el)) el.focus({ preventScroll: true });
}
// Eine Auswahlliste (<select>) nach einer Bedienung per Finger nicht per Skript
// fokussieren: auf iOS öffnet das sofort wieder ihr Auswahl-Menü - nach jeder Auswahl, die
// ein render() auslöst, sah es aus, als müsse man zweimal wählen. Tastatur-Nutzer (letzte
// Zeige-Eingabe Maus bzw. keine) behalten ihren Platz.
export function focusReopensPicker(el) {
  return (el.tagName === 'SELECT' || el.type === 'date') && lastPointerType !== 'mouse';
}

// Sanftes Erscheinen von Menüs, Dialogen und Notiz-Editor (.layer-in, CSS). render() baut
// #app jedes Mal neu - eine CSS-Animation am Element liefe deshalb bei jedem render()
// erneut ab (beim Notiz-Editor bei jedem Tastendruck). Darum bekommt nur eine Ebene die
// Klasse, die vor diesem render() noch nicht da war (Schlüssel aus Klasse + id/Titel).
const LAYER_SELECTOR = '.menu-panel, .row-menu, .modal-overlay, .note-editor';
function layerKey(el) {
  return `${el.classList[0]}|${el.id || el.querySelector('[id]')?.id || ''}|${el.querySelector('[aria-label]')?.getAttribute('aria-label') || ''}`;
}
function openLayerKeys() {
  return new Set([...app.querySelectorAll(LAYER_SELECTOR)].map(layerKey));
}
function markNewLayers(before) {
  app.querySelectorAll(LAYER_SELECTOR).forEach((el) => { if (!before.has(layerKey(el))) el.classList.add('layer-in'); });
}

// Zeichenzähler "35/40" unter Eingabefeldern mit maxlength - erst, wenn man sich der Grenze
// nähert (sonst merkte man nicht, warum das Feld plötzlich nichts mehr annimmt bzw. beim
// Einfügen abschneidet). Hängt am Feld selbst, gilt so für alle Felder mit maxlength.
function syncCharCounter(el) {
  const max = Number(el.getAttribute('maxlength'));
  if (!max) return;
  let counter = el.nextElementSibling?.classList.contains('char-count') ? el.nextElementSibling : null;
  const len = el.value.length;
  if (max - len > Math.max(3, Math.round(max * 0.15))) { counter?.remove(); return; }
  if (!counter) {
    counter = document.createElement('span');
    counter.className = 'char-count';
    counter.setAttribute('aria-live', 'polite');
    el.after(counter);
  }
  counter.classList.toggle('char-count--full', len >= max);
  counter.innerHTML = `<span aria-hidden="true">${len}/${max}</span><span class="visually-hidden">${esc(tPlain('charCount.sr', { n: len, max }))}</span>`;
}
function syncCharCounters() {
  app.querySelectorAll('input[maxlength], textarea[maxlength]').forEach(syncCharCounter);
}

export function render() {
  if (infoPop) closeInfoTip();
  const focusKey = focusKeyOf(document.activeElement);
  const layersBefore = openLayerKeys();
  // Ein Notiz-Editor, der durch einen Tag-/Tab-Wechsel o.ä. nicht mehr sichtbar ist,
  // wird hier zentral gespeichert und geschlossen, statt an jeder der vielen Stellen,
  // die Tag oder Ansicht ändern (Klicks, Wischen, Deep-Links, Kalenderzellen, ...).
  if (state.noteEditor && !isNoteEditorOpen()) commitPendingNoteDraft();
  if (!isOpeningAccount()) startupShownAt = null;
  if (!state.session || state.view !== 'today') invalidateTodayAutoCollapse();
  if (state.passwordRecovery) { renderPasswordRecovery(); }
  else if (!state.session) {
    // Die Installations-Seite kommt erst nach Startseite bzw. Einstiegsfrage - direkt vor
    // dem Formular (so registriert man sich gleich in der installierten App).
    if (['signup', 'signin'].includes(state.authMode) && shouldShowInstallGate()) renderInstallGate(); else renderAuth();
  }
  else if (state.confirmLanding) { renderConfirmLanding(); }
  else if (state.recoveryKeyToShow) { renderRecoveryKeyDisplay(); }
  else if (state.encryptionSetupInProgress) { app.innerHTML = `<div class="loading">${t('common.encryptingData')}</div>`; }
  else if (isOpeningAccount()) { renderStartupScreen(); }
  else if (!currentDek) { renderUnlockPrompt(); }
  else if (!state.loading && !state.userSettings.onboardingCompleted) { renderTutorial(); }
  else { renderApp(); }
  // Uhrzeit-Auswahl offen, aber ihr Knopf ist weg (z.B. Abmelden auf einem anderen Weg): schließen.
  if (timePicker && !document.getElementById(timePicker.triggerId)) closeTimePicker({ focus: false });
  if (!app.querySelector('.view-body')) addOnbDisplayBar();
  syncCharCounters();
  markNewLayers(layersBefore);
  positionFloatingRowMenu();
  syncToast(state.passwordRecovery || !state.session); // Anmelde-Seiten: Meldung im Text
  focusModalIfOpen();
  restoreFocus(focusKey);
  syncLayerHistory();
  if (state.view !== lastRenderedView) {
    lastRenderedView = state.view;
    window.scrollTo(0, 0);
  }
  if (runtime.pendingScrollRestore !== null) {
    window.scrollTo(0, runtime.pendingScrollRestore);
    runtime.pendingScrollRestore = null;
  }
  if (pendingFieldFocus) consumePendingFieldFocus();
}

// Was beim Start einmal laufen muss (Event-Listener u.ä.). Nicht beim Laden des Moduls, sondern
// vom Einstieg (logbuch.js) aufgerufen, in fester Reihenfolge, wenn alle Module geladen sind.
export function initMainView() {
  app.addEventListener('input', (e) => {
    if (e.target.matches?.('input[maxlength], textarea[maxlength]')) syncCharCounter(e.target);
  });
}
