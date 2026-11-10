import { runtime, state } from './state.js?v=8aaa0e5b67';
import { esc } from './navigation.js?v=8aaa0e5b67';
import { t } from './i18n.js?v=8aaa0e5b67';
import { announce, announceAlert } from './main-view.js?v=8aaa0e5b67';

// --- Meldungen als schwebender Kasten unten (seit 2026-10-01) -------------------
// Vorher standen Meldungen oben unter dem Kopf - wer weiter unten etwas tat (z.B. im
// langen Feld-Formular auf "Speichern"), sah den Fehler nicht. Jetzt immer im Blick am
// unteren Rand, in einem eigenen Element außerhalb von #app (render() ersetzt #app, der
// Kasten soll aber nicht bei jedem Neuzeichnen neu einfliegen). Erfolgsmeldungen
// verschwinden nach ein paar Sekunden von selbst (länger bei längerem Text; antippen oder
// fokussieren hält sie fest), Fehler bleiben bis × oder zur nächsten Aktion. Ausnahme:
// Anmelde-Seiten zeigen Meldungen weiter im Text (dort sind es Anleitungen wie "Ich hab
// dir eine Mail geschickt", die nicht verschwinden dürfen, und die Seite ist kurz).
let toastShown = null;
let toastTimer = null;
function toastDuration(n) { return Math.min(12000, Math.max(n.action ? 7000 : 0, 4000 + n.text.length * 50)); }
export function syncToast(hidden = false) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const n = hidden ? null : state.notice;
  if (n === toastShown) return;
  toastShown = n;
  clearTimeout(toastTimer);
  document.documentElement.classList.toggle('has-toast', !!n);
  if (!n) { root.innerHTML = ''; return; }
  const isErr = n.type !== 'ok';
  root.innerHTML = `
    <div class="toast${isErr ? ' toast--error' : ''}">
      <div class="toast-body">
        <p class="toast-text">${esc(n.text)}</p>
        ${n.detail ? `<details class="toast-details"><summary>${t('notice.details')}</summary><p>${esc(n.detail)}</p></details>` : ''}
      </div>
      ${n.action ? `<button type="button" class="toast-action">${esc(n.action.label)}</button>` : ''}
      <button type="button" class="toast-close" aria-label="${esc(t('ariaLabel.closeNotice'))}">×</button>
    </div>
  `;
  if (isErr) announceAlert(n.text); else announce(n.text);
  if (!isErr) toastTimer = setTimeout(() => dismissToast(n), toastDuration(n));
}
function dismissToast(n = toastShown) {
  if (n && state.notice === n) state.notice = null;
  syncToast();
}

export function renderNotice() {
  if (!state.notice) return '';
  const isErr = state.notice.type !== 'ok';
  return isErr
    ? `<div class="notice" role="alert" aria-live="assertive">${esc(state.notice.text)}</div>`
    : `<div class="notice notice--ok" role="status" aria-live="polite">${esc(state.notice.text)}</div>`;
}

// Zahlen-Eingabe mit +/- Buttons daneben, für kurze/eingeschränkte Wertebereiche
// (z.B. Anzahl Stufen) — spart das Eintippen. Ändert direkt das Input-Element und
// feuert ein 'change'-Event (siehe stepper-inc/-dec im Klick-Handler), damit ein
// evtl. daran hängender bestehender Change-Listener (z.B. für die Label-Stufenzahl)
// weiterhin greift.
export function stepperInput(id, value, min, max, disabled, extraAttrs = '') {
  return `
    <div class="stepper-row">
      <button type="button" class="stepper-btn" data-action="stepper-dec" data-target="${id}" ${disabled ? 'disabled' : ''} aria-label="${esc(t('ariaLabel.decrease'))}">−</button>
      <input type="number" id="${id}" min="${min}" max="${max}" value="${value}" ${extraAttrs} ${disabled ? 'disabled' : ''} />
      <button type="button" class="stepper-btn" data-action="stepper-inc" data-target="${id}" ${disabled ? 'disabled' : ''} aria-label="${esc(t('ariaLabel.increase'))}">+</button>
    </div>
  `;
}

// Einen Schritt am Zahlenfeld eines Steppers, begrenzt auf dessen min/max. Rückgabe: ob
// sich der Wert geändert hat.
export function stepInput(target, delta) {
  const min = target.min !== '' ? Number(target.min) : -Infinity;
  const max = target.max !== '' ? Number(target.max) : Infinity;
  const before = Math.round(Number(target.value));
  const n = Math.max(min, Math.min(max, before + delta));
  target.value = n;
  return n !== before;
}
// Gedrückthalten zählt weiter (seit 2026-09-29) - bei z.B. 100 Stufen sonst 99 einzelne
// Tipps. Nach einer kurzen Wartezeit (ein normaler Tipp bleibt ein Schritt) immer
// schneller. Währenddessen ändert sich nur die Zahl im Feld; gespeichert/neu gerendert
// wird einmal beim Loslassen (sonst ersetzte jedes render() mitten im Halten den Knopf).
const STEPPER_HOLD_DELAY_MS = 400;
let stepperHold = null;
function stopStepperHold() {
  if (!stepperHold) return;
  clearTimeout(stepperHold.timer);
  const { target, ticks } = stepperHold;
  stepperHold = null;
  if (ticks > 0) {
    runtime.stepperHoldSwallowClick = true;
    // Ließ man neben dem Knopf los, kommt kein Klick - dann nicht den nächsten verschlucken.
    setTimeout(() => { runtime.stepperHoldSwallowClick = false; }, 400);
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Was beim Start einmal laufen muss (Event-Listener u.ä.). Nicht beim Laden des Moduls, sondern
// vom Einstieg (logbuch.js) aufgerufen, in fester Reihenfolge, wenn alle Module geladen sind.
export function initNotices() {
  {
    const root = document.getElementById('toast-root');
    root?.addEventListener('click', (e) => {
      if (e.target.closest('.toast-close')) dismissToast();
      if (e.target.closest('.toast-action')) {
        const n = toastShown;
        dismissToast(n);
        n?.action?.run();
      }
    });
    const hold = () => clearTimeout(toastTimer);
    root?.addEventListener('pointerdown', hold);
    root?.addEventListener('focusin', hold);
  }
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-action="stepper-inc"], [data-action="stepper-dec"]');
    runtime.stepperHoldSwallowClick = false;
    if (!btn || btn.disabled || e.button > 0) return;
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;
    const delta = btn.dataset.action === 'stepper-inc' ? 1 : -1;
    const tick = () => {
      if (!stepperHold) return;
      if (!stepInput(target, delta)) { stopStepperHold(); return; } // am Rand angekommen
      stepperHold.ticks += 1;
      stepperHold.timer = setTimeout(tick, Math.max(35, 110 - stepperHold.ticks * 5));
    };
    stepperHold = { target, ticks: 0, timer: setTimeout(tick, STEPPER_HOLD_DELAY_MS) };
  });
  ['pointerup', 'pointercancel'].forEach((type) => document.addEventListener(type, stopStepperHold));
  document.addEventListener('pointerleave', stopStepperHold);
}
