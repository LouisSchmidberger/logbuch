import { parseDateKey, startOfDay, startOfWeek } from './dates.js?v=90bbeaa075';
import { closeModals, currentDek, runtime, state } from './state.js?v=90bbeaa075';
import { isStandaloneDisplay } from './device.js?v=90bbeaa075';
import { rememberOnbIncludesInstall, setOnbInProgress, setOnbMode, signedInHereBefore } from './auth-view.js?v=90bbeaa075';
import { focusTodayField } from './row-view.js?v=90bbeaa075';
import { render } from './main-view.js?v=90bbeaa075';

const DEEP_LINK_VIEWS = ['today', 'week', 'month', 'year'];
export function parseDeepLink(search) {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  if (!DEEP_LINK_VIEWS.includes(view)) return null;
  const dateParam = params.get('date');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam ?? '') ? parseDateKey(dateParam) : null;
  // field: Feld-ID bei Erinnerungen an ein bestimmtes Feld - "Heute" scrollt dann dorthin.
  const fieldParam = params.get('field');
  const field = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fieldParam ?? '') ? fieldParam : null;
  return { view, date: date && !isNaN(date) ? date : startOfDay(new Date()), field };
}
// Feld-ID aus einem Deep-Link, zu der gescrollt werden soll, sobald "Heute" mit geladenen
// Feldern wirklich angezeigt wird - beim Kaltstart kann davor noch Entsperren/Laden liegen,
// deshalb von render() aus eingelöst statt direkt beim Öffnen des Links.
export let pendingFieldFocus = null;
export function consumePendingFieldFocus() {
  if (!pendingFieldFocus || !state.session || !currentDek || state.loading || state.passwordRecovery
      || state.recoveryKeyToShow || !state.userSettings.onboardingCompleted || state.view !== 'today') return;
  const habit = state.habits.find((h) => h.defId === pendingFieldFocus);
  pendingFieldFocus = null;
  if (habit && !habit.archivedAt) focusTodayField(habit.id, { editInput: true });
}
export function applyDeepLink({ view, date, field }) {
  pendingFieldFocus = view === 'today' ? field : null;
  state.view = view;
  state.currentDate = startOfDay(date);
  state.weekAnchor = startOfWeek(date);
  const monthStart = startOfDay(date);
  monthStart.setDate(1);
  state.monthAnchor = monthStart;
  state.yearAnchor = date.getFullYear();
}

// Was beim Start einmal laufen muss (Event-Listener u.ä.). Nicht beim Laden des Moduls, sondern
// vom Einstieg (logbuch.js) aufgerufen, in fester Reihenfolge, wenn alle Module geladen sind.
export function initDeeplinks() {
  // --- Deep-Links aus Push-Benachrichtigungen --------------------------------
  // Jede Benachrichtigung trägt ihr Ziel als URL-Parameter (?view=week&date=YYYY-MM-DD,
  // siehe send-notifications) - date ist der Tag, auf den sie sich bezieht, damit ein
  // späterer Klick (z.B. Wochenübersicht erst Montagmorgen geöffnet) trotzdem den
  // gemeinten Zeitraum zeigt statt den dann aktuellen. Zwei Wege hier an: beim
  // Kaltstart über location.search, bei schon offener App per postMessage vom Service
  // Worker (sw.js, notificationclick) - dort bewusst kein Neuladen, das würde ggf. ein
  // erneutes Entsperren des Schlüssels erzwingen. Setzt nur Ansicht + Zeitraum, das
  // funktioniert unabhängig davon, ob die App gerade noch gesperrt ist.
  // "In Chrome öffnen" aus einem anderen Browser (otherBrowserBox) kommt mit ?onb=<Modus>:
  // Chrome hat einen eigenen Speicher - ohne das begänne das Einrichten wieder auf der
  // Startseite. Steht hier, nach den let-Deklarationen, die setOnbInProgress braucht.
  (() => {
    const mode = new URLSearchParams(location.search).get('onb');
    if (!['guided', 'short'].includes(mode)) return;
    history.replaceState(history.state, '', location.pathname + location.hash);
    if (signedInHereBefore() || isStandaloneDisplay()) return;
    setOnbMode(mode);
    setOnbInProgress(true);
    rememberOnbIncludesInstall();
    state.authMode = 'signup';
  })();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type !== 'logbuch-navigate') return;
      const link = parseDeepLink(new URL(e.data.url, location.href).search);
      if (!link) return;
      applyDeepLink(link);
      // Offene Overlays schließen, sonst läge das Ziel unsichtbar darunter. Während des
      // Tutorials nichts anfassen (dort ist state.habitForm Teil des geführten Ablaufs) -
      // die gesetzte Ansicht greift dann einfach nach dessen Abschluss.
      if (state.userSettings.onboardingCompleted) {
        state.menuOpen = false;
        state.rowMenu = null;
        state.habitForm = null;
        state.habitDeleteConfirm = null;
        state.sectionForm = null;
        if (state.deleteConfirm || state.passwordChange || state.spareKeyCheck || state.emailChange || state.resetConfirm || state.regenKeyConfirm || state.logoutConfirm) { closeModals(); runtime.modalTriggerSelector = null; }
      }
      window.scrollTo(0, 0); // vor render() - das scrollt ggf. danach zum Feld (consumePendingFieldFocus)
      render();
    });
  }
}
