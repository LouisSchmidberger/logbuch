// Logbuch - Einstieg. Die App-Logik liegt in Modulen unter js/, eins je Bereich (Übersicht:
// docs/module.md). Die Module werden hier in der Reihenfolge des früheren Gesamtskripts
// geladen, damit Code, der beim Laden läuft (Event-Listener, Theme), wie vorher nacheinander läuft.
// Die ?v=-Kennung aller Modul-Adressen setzt der pre-commit-Hook (Cache-Busting, docs/freigabe.md).
import './js/config.js?v=90bbeaa075';
import './js/crypto.js?v=90bbeaa075';
import './js/fields.js?v=90bbeaa075';
import './js/dates.js?v=90bbeaa075';
import './js/state.js?v=90bbeaa075';
import './js/navigation.js?v=90bbeaa075';
import './js/strings.js?v=90bbeaa075';
import './js/i18n.js?v=90bbeaa075';
import './js/theme.js?v=90bbeaa075';
import './js/format.js?v=90bbeaa075';
import './js/notices.js?v=90bbeaa075';
import './js/data.js?v=90bbeaa075';
import './js/keys.js?v=90bbeaa075';
import './js/field-form.js?v=90bbeaa075';
import './js/type-change.js?v=90bbeaa075';
import './js/section-form.js?v=90bbeaa075';
import './js/save.js?v=90bbeaa075';
import './js/device.js?v=90bbeaa075';
import './js/account.js?v=90bbeaa075';
import './js/auth-view.js?v=90bbeaa075';
import './js/row-view.js?v=90bbeaa075';
import './js/stats-view.js?v=90bbeaa075';
import './js/about-view.js?v=90bbeaa075';
import './js/templates.js?v=90bbeaa075';
import './js/fields-view.js?v=90bbeaa075';
import './js/tutorial.js?v=90bbeaa075';
import './js/main-view.js?v=90bbeaa075';
import './js/events.js?v=90bbeaa075';
import './js/gestures.js?v=90bbeaa075';
import './js/deeplinks.js?v=90bbeaa075';
import './js/session.js?v=90bbeaa075';
import { ARRIVED_VIA_EMAIL_CHANGE, ARRIVED_VIA_SIGNUP_CONFIRM, MAIL_LINK_ERROR, supabase } from './js/config.js?v=90bbeaa075';
import { state } from './js/state.js?v=90bbeaa075';
import { applyLocale, detectInitialLocale, t } from './js/i18n.js?v=90bbeaa075';
import { applyTextSize, applyTheme, getTextSize, getThemeOverride } from './js/theme.js?v=90bbeaa075';
import { isMobileDevice, isStandaloneDisplay, resetIOSZoomOnStandaloneStart } from './js/device.js?v=90bbeaa075';
import { isInstallGateSkipped } from './js/auth-view.js?v=90bbeaa075';
import { TUTORIAL_STEP_FIELD } from './js/tutorial.js?v=90bbeaa075';
import { render } from './js/main-view.js?v=90bbeaa075';
import { applyDeepLink, parseDeepLink } from './js/deeplinks.js?v=90bbeaa075';
import { initNavigation } from './js/navigation.js?v=90bbeaa075';
import { initI18n } from './js/i18n.js?v=90bbeaa075';
import { initFormat } from './js/format.js?v=90bbeaa075';
import { initNotices } from './js/notices.js?v=90bbeaa075';
import { initData } from './js/data.js?v=90bbeaa075';
import { initKeys } from './js/keys.js?v=90bbeaa075';
import { initSave } from './js/save.js?v=90bbeaa075';
import { initAuthView } from './js/auth-view.js?v=90bbeaa075';
import { initMainView } from './js/main-view.js?v=90bbeaa075';
import { initEvents } from './js/events.js?v=90bbeaa075';
import { initGestures } from './js/gestures.js?v=90bbeaa075';
import { initDeeplinks } from './js/deeplinks.js?v=90bbeaa075';
import { initSession } from './js/session.js?v=90bbeaa075';

// Start-Code der Module, in der Reihenfolge des früheren Gesamtskripts.
initNavigation();
initI18n();
initFormat();
initNotices();
initData();
initKeys();
initSave();
initAuthView();
initMainView();
initEvents();
initGestures();
initDeeplinks();
initSession();

// Verhindert versehentliches Verlassen/Reload mitten im geführten Feld-Anlegen
// (Tutorial mit offenem Formular, siehe docs/onboarding.md).
window.addEventListener('beforeunload', (e) => {
  if (state.tutorialStep === TUTORIAL_STEP_FIELD && state.habitForm) { e.preventDefault(); e.returnValue = ''; }
});

resetIOSZoomOnStandaloneStart();
state.confirmLanding = ARRIVED_VIA_SIGNUP_CONFIRM && isMobileDevice() && !isStandaloneDisplay() && !isInstallGateSkipped();
applyLocale(detectInitialLocale());
applyTheme(getThemeOverride());
if (ARRIVED_VIA_EMAIL_CHANGE) state.notice = { type: 'ok', text: t('emailChange.landedDone') };
if (MAIL_LINK_ERROR) {
  state.notice = { type: 'error', text: t(MAIL_LINK_ERROR === 'otp_expired' ? 'mailLink.expired' : 'mailLink.failed') };
  // Sonst käme die Meldung bei jedem Neuladen wieder.
  history.replaceState(history.state, '', location.pathname + location.search);
}
applyTextSize(getTextSize());
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!getThemeOverride()) applyTheme(null); // nur relevant, wenn "System" aktiv ist
  });
} catch { /* z.B. sehr alter Browser ohne addEventListener auf MediaQueryList */ }

const initialDeepLink = parseDeepLink(location.search);
if (initialDeepLink) {
  applyDeepLink(initialDeepLink);
  // Parameter wieder entfernen, sonst spränge ein späteres Neuladen erneut dorthin.
  history.replaceState(history.state, '', location.pathname + location.hash);
}

const { data: { session } } = await supabase.auth.getSession();
state.session = session;
state.loading = false;
render();
