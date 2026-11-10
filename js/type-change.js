import { supabase } from './config.js?v=8aaa0e5b67';
import { containerMaxSortOrder, invalidateTodayAutoCollapse, isCounterKind, isSinceComputed, layoutBlocks, sinceUsesStages } from './fields.js?v=8aaa0e5b67';
import { formatKey, isPeriodField } from './dates.js?v=8aaa0e5b67';
import { runtime, state } from './state.js?v=8aaa0e5b67';
import { esc, markFormBaseline } from './navigation.js?v=8aaa0e5b67';
import { formatNumber, t, tPlain } from './i18n.js?v=8aaa0e5b67';
import { errorNotice, formatDMY, infoTip } from './format.js?v=8aaa0e5b67';
import { stepperInput } from './notices.js?v=8aaa0e5b67';
import { CHOICE_STEP_CAP, SLIDER_STEP_CAP, habitToForm, resizeLabels, syncHabitFormFromDom } from './field-form.js?v=8aaa0e5b67';
import { NOTE_MAX_LENGTH, PREV_KEY, getNote, saveDay, updateHabitPayload, withPrev } from './save.js?v=8aaa0e5b67';
import { render } from './main-view.js?v=8aaa0e5b67';

// --- Stufen ändern (Skala mit Einträgen) -------------------------------------
// Nutzer-Entscheidung 2026-10-29: die Anzahl Stufen einer Skala mit Einträgen ist änderbar,
// was aus den bisherigen Werten wird, entscheidet man selbst (je alte Stufe eine neue oder
// "entfernen"). Die alten Werte bleiben als Sicherung im selben Tages-Eintrag (withPrev) -
// nicht als archiviertes Zweitfeld: archivierte Felder rechnen in die Tagesfarbe mit
// (dayOverallScore), alte Tage zählten doppelt.
// Ablauf über h.stepChange (verschlüsselt in enc): state 'apply' (Definition noch "from") ->
// Tage umschreiben -> Definition "to", state 'done'. Rückgängig: state 'undo' -> Tage aus der
// Sicherung -> Definition "from", stepChange null. Jeder Tag schreibt Wert und Sicherung in
// einem Zug, und welche Tage fertig sind, steht in den Tagen selbst (_prev.c) - ein Abbruch
// (Netz weg, App zu) läuft beim nächsten Laden weiter (resumeStepChanges).
const STEP_CHANGE_PARALLEL = 6;
const stepChangeRunning = new Set(); // defIds
const stepChangeStarting = new Set(); // defIds - Definition wird gerade markiert (zeigt schon "Wird umgestellt")
// Wie oft jeder Wert eines Felds eingetragen ist: [[Wert, Anzahl], ...] aufsteigend.
function usedStepValues(h) {
  const counts = new Map();
  for (const day of Object.values(state.entries)) {
    const v = day?.[h.id];
    if (typeof v === 'number') counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts].sort((a, b) => a[0] - b[0]);
}
// Vorschlag für eine alte Stufe: 'spread' = niedrigste bleibt niedrigste, höchste bleibt
// höchste, dazwischen anteilig; 'same' = Zahl behalten, oberhalb der neuen Spanne auf die höchste.
function stepChangeTarget(from, to, preset, old) {
  if (preset === 'same') return Math.min(to.max, Math.max(to.min, old));
  const fromSteps = from.max - from.min;
  const pos = fromSteps > 0 ? Math.min(1, Math.max(0, (old - from.min) / fromSteps)) : 0;
  return to.min + Math.round(pos * (to.max - to.min));
}
// Vorschlag für einen alten Wert je nach Quell- und Zieltyp (from/to = Definitions-Stand, ohne
// kind = Skala, so auch alle reinen "Stufen ändern"). Aus Zahlen in eine Skala: 'round' =
// gerundet und in die Spanne geholt, 'spread' = kleinster bis größter eingetragener Wert
// (range) gleichmäßig auf die Stufen.
function stepChangeConvert(from, to, preset, old, range) {
  const fromKind = from.kind ?? 'scale', toKind = to.kind ?? 'scale';
  if (toKind === 'text') return valueAsText(from, old);
  if (toKind !== 'scale') return old;
  if (fromKind === 'scale') return stepChangeTarget(from, to, preset, old);
  if (preset === 'spread' && range && range.hi > range.lo) {
    return to.min + Math.round(Math.min(1, Math.max(0, (old - range.lo) / (range.hi - range.lo))) * (to.max - to.min));
  }
  return Math.min(to.max, Math.max(to.min, Math.round(old)));
}
// Ein Wert als Text: Skala mit Bezeichnung -> die Bezeichnung, sonst die Zahl (mit Einheit).
export function valueAsText(def, v) {
  if ((def.kind ?? 'scale') === 'scale') return def.labels?.[v - def.min] || formatNumber(v);
  return def.unit ? `${formatNumber(v)} ${def.unit}` : formatNumber(v);
}
// Neuer Wert eines alten (null = entfernen): die Zuordnung des Nutzers, sonst der Vorschlag
// (z.B. für Werte, die inzwischen auf einem anderen Gerät eingetragen wurden).
export function stepChangeMapValue(sc, old) {
  const key = String(old);
  return key in sc.map ? sc.map[key] : stepChangeConvert(sc.from, sc.to, sc.preset ?? 'spread', old, sc.range);
}
export function isTypeChange(sc) {
  return (sc.from.kind ?? 'scale') !== (sc.to.kind ?? 'scale');
}
function stepChangeId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
}
// Rückgängig nur, solange seit der Umstellung nichts in dem Feld eingetragen oder geändert
// wurde - sonst holte die Sicherung einen alten Wert über einen neuen zurück.
function stepChangeUndoable(h) {
  const sc = h?.stepChange;
  if (sc?.state !== 'done') return false;
  return Object.values(state.entries).every((day) => {
    const prev = day?.[PREV_KEY]?.[h.id];
    if (prev?.c !== sc.id) return day?.[h.id] === undefined;
    const expected = stepChangeMapValue(sc, prev.v);
    return (day[h.id] ?? null) === expected;
  });
}
// Nach "Stufen ändern" einer Skala: die zählenden Stufen der "Tage seit"-Felder, die auf ihr
// aufbauen, auf die neuen Stufen umrechnen (Rückgängig: die alten Stufen, die auf eine
// gewählte neue abgebildet wurden). Wechselt die Skala zwischen Knöpfen und Regler, gilt
// "ab Wert" mit der kleinsten gewählten Stufe bzw. umgekehrt alle Stufen ab diesem Wert.
async function remapSinceStages(sourceId, sc, undo) {
  const src = state.habits.find((x) => x.id === sourceId);
  if (!src) return;
  for (const h of state.habits.filter((x) => isSinceComputed(x) && x.members?.[0] === sourceId)) {
    await updateHabitPayload(h, { since: remapSince(h.since, sc, undo, sinceUsesStages(src)) });
  }
}
export function remapSince(since, sc, undo, stagesNow) {
  const before = undo ? sc.to : sc.from;
  const oldValues = Array.isArray(since?.values) ? since.values
    : Array.from({ length: before.max - before.min + 1 }, (_, i) => before.min + i).filter((v) => v >= (since?.atLeast ?? Infinity));
  let values;
  if (undo) {
    values = [];
    for (let v = sc.from.min; v <= sc.from.max; v++) if (oldValues.includes(stepChangeMapValue(sc, v))) values.push(v);
  } else {
    values = [...new Set(oldValues.map((v) => stepChangeMapValue(sc, v)).filter((v) => v !== null))].sort((a, b) => a - b);
  }
  const after = undo ? sc.from : sc.to;
  return stagesNow ? { ...since, values, atLeast: null } : { ...since, values: null, atLeast: values.length ? values[0] : after.max + 1 };
}
async function markStepChange(h, stepChange) {
  if (stepChangeStarting.has(h.defId) || stepChangeRunning.has(h.defId)) return false; // zweiter Tipp
  stepChangeStarting.add(h.defId);
  render();
  try {
    return await updateHabitPayload(h, { stepChange });
  } finally {
    stepChangeStarting.delete(h.defId);
  }
}
// to: die neuen Werte der Definition (bei "Stufen ändern" min/max/labels, beim Typwechsel alle
// typabhängigen Eigenschaften samt kind); from hält dieselben Eigenschaften von vorher fest -
// genau das stellt Rückgängig wieder her. extra: { preset, range } für den Vorschlag.
export async function startStepChange(defId, to, map, extra = {}) {
  const h = state.habits.find((x) => x.defId === defId);
  if (!h) return false;
  const from = Object.fromEntries(Object.keys(to).map((k) => [k, h[k] ?? null]));
  const sc = { id: stepChangeId(), date: formatKey(new Date()), state: 'apply', from, to, map, ...extra };
  if (!(await markStepChange(h, sc))) return false;
  return runStepChange(defId);
}
export async function startStepChangeUndo(defId) {
  const h = state.habits.find((x) => x.defId === defId);
  if (!h || !stepChangeUndoable(h)) return false;
  if (!(await markStepChange(h, { ...h.stepChange, state: 'undo' }))) return false;
  return runStepChange(defId);
}
// Schreibt alle noch offenen Tage einer laufenden Umstellung (bzw. Rückgängig) und setzt danach
// die Definition. Rückgabe: true = fertig. Fortschritt direkt ins DOM (#step-change-progress),
// ohne render() je Tag.
// Schreibt viele Tage um (Stufen/Typ ändern, Felder zusammenführen): transform(day, dateKey) gibt
// den neuen Tag zurück, je STEP_CHANGE_PARALLEL Tage gleichzeitig. Ein nicht gespeicherter Tag
// bekommt seinen alten Stand zurück - sonst hielte ein zweiter Lauf ihn für fertig.
export async function rewriteDays(dateKeys, transform, onProgress = () => {}) {
  let done = 0, failed = 0;
  const queue = [...dateKeys];
  onProgress(0, dateKeys.length);
  const worker = async () => {
    while (queue.length) {
      const dateKey = queue.shift();
      const before = state.entries[dateKey];
      const changed = transform(before || {}, dateKey);
      state.entries = { ...state.entries, [dateKey]: changed };
      if (await saveDay(dateKey)) done++;
      else {
        failed++;
        if (state.entries[dateKey] === changed) {
          const { [dateKey]: _, ...rest } = state.entries;
          state.entries = before === undefined ? rest : { ...state.entries, [dateKey]: before };
        }
      }
      onProgress(done + failed, dateKeys.length);
    }
  };
  await Promise.all(Array.from({ length: STEP_CHANGE_PARALLEL }, worker));
  return { done, failed };
}
export async function runStepChange(defId) {
  if (stepChangeRunning.has(defId)) return false;
  let h = state.habits.find((x) => x.defId === defId);
  const sc = h?.stepChange;
  if (!sc || sc.state === 'done') return true;
  stepChangeRunning.add(defId);
  render(); // zeigt im offenen Formular die Fortschrittszeile (stepEditHtml)
  try {
    const undo = sc.state === 'undo';
    const todo = Object.keys(state.entries).filter((k) => {
      const day = state.entries[k];
      const prev = day?.[PREV_KEY]?.[h.id];
      if (undo) return prev?.c === sc.id;
      // Auch Sicherungen früherer Umstellungen ohne Wert (damals entfernt) - die räumt der Lauf weg.
      return prev?.c !== sc.id && (day?.[h.id] !== undefined || prev !== undefined);
    });
    const transform = (day) => {
      if (undo) {
        const next = withPrev(day, h.id, undefined);
        next[h.id] = day[PREV_KEY][h.id].v;
        return next;
      }
      const old = day[h.id];
      const next = withPrev(day, h.id, old === undefined ? undefined : { c: sc.id, v: old });
      if (old !== undefined) {
        const value = stepChangeMapValue(sc, old);
        if (value === null) delete next[h.id];
        else next[h.id] = value;
      }
      return next;
    };
    const { failed } = await rewriteDays(todo, transform, (done, total) => {
      const el = document.getElementById('step-change-progress');
      if (el) el.textContent = tPlain('stepEdit.progress', { done, total });
    });
    if (failed) return false;
    h = state.habits.find((x) => x.defId === defId);
    if (!h) return false;
    const ok = await updateHabitPayload(h, { ...(undo ? sc.from : sc.to), stepChange: undo ? null : { ...sc, state: 'done' } });
    if (ok && !isTypeChange(sc)) await remapSinceStages(h.id, sc, undo);
    // Typwechsel von/zu Zähler: den Erinnerungs-Stand von heute neu schreiben (wie beim Speichern des Formulars).
    const today = formatKey(new Date());
    if (ok && (isTypeChange(sc) || isCounterKind(h)) && state.entries[today]) saveDay(today);
    return ok;
  } finally {
    stepChangeRunning.delete(defId);
  }
}
// Formular-Zustand "Stufen ändern": f.stepEdit = { steps, labels (null ohne Bezeichnungen),
// preset ('spread'|'same'|'custom'), map { "<alt>": neu|null }, confirm }.
export function stepEditKey(se) {
  return JSON.stringify([se.steps, se.labels, se.map]);
}
export function stepEditCap(h) {
  return h.displayStyle === 'buttons' || h.labels ? CHOICE_STEP_CAP : SLIDER_STEP_CAP;
}
function stepEditFrom(h) {
  return { min: h.min, max: h.max, labels: h.labels ?? null };
}
export function stepEditTo(h, se) {
  return { min: h.min, max: h.min + se.steps - 1, labels: se.labels ? se.labels.map((l) => l.trim()) : null };
}
export function applyStepEditPreset(h, se) {
  const from = stepEditFrom(h);
  const to = stepEditTo(h, se);
  se.map = Object.fromEntries(usedStepValues(h).map(([v]) => [String(v), stepChangeTarget(from, to, se.preset, v)]));
  if (h.labels) {
    // Bezeichnungen wandern mit ihren Stufen (dieselbe Rechnung wie die Werte), neue bleiben leer.
    const labels = Array(se.steps).fill('');
    h.labels.forEach((l, i) => {
      const j = stepChangeTarget(from, to, se.preset, from.min + i) - to.min;
      if (!labels[j]) labels[j] = l;
    });
    se.labels = labels;
  }
}
export function stepEditCountChanged(h, se, steps) {
  se.steps = steps;
  if (se.preset !== 'custom') { applyStepEditPreset(h, se); return; }
  // Eigene Zuordnung behalten, nur in die neue Spanne holen.
  const max = h.min + steps - 1;
  for (const k of Object.keys(se.map)) if (se.map[k] !== null) se.map[k] = Math.min(max, se.map[k]);
  if (se.labels) se.labels = resizeLabels(se.labels, steps);
}
function stepValueText(labels, min, v) {
  const label = labels?.[v - min];
  return label ? t('stepEdit.valueLabel', { label, value: v }) : esc(String(v));
}
export function stepEditSummary(h, se) {
  let changed = 0, removed = 0;
  const targets = new Map();
  for (const [v, n] of usedStepValues(h)) {
    const to = se.map[String(v)];
    if (to === null) { removed += n; continue; }
    if (to !== v) changed += n;
    targets.set(to, (targets.get(to) || 0) + 1);
  }
  const parts = [];
  if (changed) parts.push(t(changed === 1 ? 'stepEdit.summary.changedOne' : 'stepEdit.summary.changedMany', { count: changed }));
  if (removed) parts.push(t(removed === 1 ? 'stepEdit.summary.removedOne' : 'stepEdit.summary.removedMany', { count: removed }));
  if ([...targets.values()].some((c) => c > 1)) parts.push(t('stepEdit.summary.merged'));
  if (!parts.length) parts.push(t('stepEdit.summary.none'));
  return parts.join(' ');
}
export function stepEditNothingToDo(h, se) {
  const to = stepEditTo(h, se);
  return to.max === h.max && Object.entries(se.map).every(([k, v]) => v === Number(k))
    && JSON.stringify(to.labels) === JSON.stringify(h.labels ?? null);
}
// Teil "Anzahl Stufen" eines gesperrten Skala-Felds im Formular: Anzeige, Rückgängig,
// "Stufen ändern". Das Ändern selbst läuft im eigenen Dialog (renderStepDialog) - ein eigener
// Mechanismus mit Folgen für alle Einträge, der sich vom übrigen Formular abheben soll.
export function stepEditHtml(f) {
  const h = state.habits.find((x) => x.defId === f.defId);
  if (!h) return '';
  const steps = h.max - h.min + 1;
  // Typwechsel zeigt typeEditHtml (unter den Feld-Typ-Karten).
  const sc = h.stepChange && !isTypeChange(h.stepChange) ? h.stepChange : null;
  const current = `<p class="habit-form-lock-note">${t('habitForm.rangeLocked', { steps, min: h.min, max: h.max })}</p>`;
  if (sc && sc.state !== 'done' && !stepChangeRunning.has(h.defId)) {
    return current + `
      <div class="step-box">
        <p class="habit-form-lock-note" role="status">${t('stepEdit.pending')}</p>
        <button type="button" class="manage-btn" data-action="step-edit-resume">${t('stepEdit.resume')}</button>
      </div>`;
  }
  const undo = !sc || !stepChangeUndoable(h) ? '' : `
    <div class="step-box">
      <p class="habit-form-lock-note">${t('stepEdit.last', { date: formatDMY(sc.date), from: sc.from.max - sc.from.min + 1, to: steps })}</p>
      <button type="button" class="manage-btn" data-action="step-undo">${t('stepEdit.undo')}</button>
    </div>`;
  return current + undo + `
    <div class="step-box">
      <p class="habit-form-lock-note">${t('stepEdit.hint')}</p>
      <button type="button" class="manage-btn" data-action="step-edit-open">${t('stepEdit.open')}</button>
    </div>`;
}
export function stepDialogOpen() {
  const f = state.habitForm;
  return !!f && (!!f.stepEdit || !!f.typeEdit || !!f.stepUndoConfirm || stepChangeRunning.has(f.defId) || stepChangeStarting.has(f.defId));
}
// Escape, Android-Zurück: wie "Abbrechen" bzw. in der Rückfrage "Zurück". Ist im Dialog schon
// etwas eingestellt, erst die übliche Rückfrage "Änderungen verwerfen?". Während des Umstellens
// nichts (der Lauf soll zu Ende kommen).
export function closeStepDialog() {
  const f = state.habitForm;
  if (!f || stepChangeRunning.has(f.defId) || stepChangeStarting.has(f.defId)) return;
  if (f.stepUndoConfirm) { f.stepUndoConfirm = false; return; }
  const se = f.stepEdit ?? f.typeEdit;
  if (!se) return;
  if (se.confirm) { se.confirm = false; return; }
  syncHabitFormFromDom();
  if ((f.stepEdit ? stepEditKey(se) : typeEditKey(se)) === se.initial) { f.stepEdit = null; f.typeEdit = null; return; }
  runtime.pendingFormLeave = () => { if (state.habitForm) { state.habitForm.stepEdit = null; state.habitForm.typeEdit = null; } };
  state.leaveFormConfirm = true;
  runtime.modalTriggerSelector = '#step-dialog-title'; // "Weiter bearbeiten" führt zurück in den Dialog
}
export function renderStepDialog() {
  const f = state.habitForm;
  const h = state.habits.find((x) => x.defId === f.defId);
  if (!h) return '';
  const steps = h.max - h.min + 1;
  const box = (title, body) => `
    <div class="modal-overlay">
      <div class="modal-box step-dialog" role="dialog" aria-modal="true" aria-labelledby="step-dialog-title">
        <h2 id="step-dialog-title" tabindex="-1">${title}</h2>
        ${body}
      </div>
    </div>`;
  if (stepChangeRunning.has(h.defId) || stepChangeStarting.has(h.defId)) {
    const undo = h.stepChange?.state === 'undo';
    const type = f.typeRunning || (h.stepChange && isTypeChange(h.stepChange));
    return box(t(undo ? (type ? 'typeEdit.undoTitle' : 'stepEdit.undoTitle') : (type ? 'typeEdit.title' : 'stepEdit.title')), `
      <p id="step-change-progress" role="status">${t('stepEdit.progress', { done: 0, total: '…' })}</p>`);
  }
  if (f.typeEdit) return renderTypeDialog(h, f.typeEdit, box);
  if (f.stepUndoConfirm && h.stepChange) {
    const sc = h.stepChange;
    const type = isTypeChange(sc);
    return box(t(type ? 'typeEdit.undoTitle' : 'stepEdit.undoTitle'), `
      <p>${type ? t('typeEdit.undoConfirm', { name: h.name, from: kindLabel(sc.from.kind) }) : t('stepEdit.undoConfirm', { name: h.name, from: sc.from.max - sc.from.min + 1 })}</p>
      <div class="habit-form-actions">
        <button type="button" class="habit-form-cancel" data-action="step-undo-cancel">${t('common.cancel')}</button>
        <button type="button" class="auth-submit" data-action="step-undo-confirm">${t('stepEdit.undoDo')}</button>
      </div>`);
  }
  const se = f.stepEdit;
  if (!se) return '';
  if (se.confirm) {
    return box(t('stepEdit.confirmTitle'), `
      <p>${t('stepEdit.confirm', { name: h.name, from: steps, to: se.steps })}</p>
      <p>${stepEditSummary(h, se)}</p>
      <p>${t('stepEdit.safety')}</p>
      <div class="habit-form-actions">
        <button type="button" class="habit-form-cancel" data-action="step-edit-confirm-cancel">${t('common.back')}</button>
        <button type="button" class="auth-submit" data-action="step-edit-confirm">${t('stepEdit.confirmDo')}</button>
      </div>`);
  }
  const to = stepEditTo(h, se);
  const options = (selected) => Array.from({ length: se.steps }, (_, i) => to.min + i)
    .map((v) => `<option value="${v}" ${selected === v ? 'selected' : ''}>${se.labels ? `${v} – ${esc(se.labels[v - to.min] || '…')}` : v}</option>`).join('')
    + `<option value="" ${selected === null ? 'selected' : ''}>${t('stepEdit.remove')}</option>`;
  const rows = usedStepValues(h).map(([v, n]) => `
    <div class="step-map-row">
      <span class="step-map-old">${stepValueText(h.labels, h.min, v)} <span class="step-map-count">${t('stepEdit.count', { count: n })}</span></span>
      <select data-step-map="${v}" aria-label="${esc(tPlain('stepEdit.mapAria', { value: h.labels?.[v - h.min] || v, count: n }))}">${options(se.map[String(v)])}</select>
    </div>`).join('');
  return box(t('stepEdit.title'), `
    <p class="step-dialog-field">${t('stepEdit.fieldNow', { name: h.name, steps })}</p>
    <p class="step-dialog-note">${t('stepEdit.intro')}</p>
    <div class="auth-field">
      <label for="step-edit-steps">${t('stepEdit.newSteps')}</label>
      ${stepperInput('step-edit-steps', se.steps, 2, stepEditCap(h), false, 'data-action="step-edit-count"')}
    </div>
    ${se.labels ? `
      <div class="auth-field">
        <label id="step-edit-labels-label">${t('stepEdit.newLabels')}</label>
        <div class="label-inputs" role="group" aria-labelledby="step-edit-labels-label">
          ${se.labels.map((l, i) => `
            <div class="label-input-row">
              <span class="label-input-step" aria-hidden="true">${to.min + i}</span>
              <input type="text" data-step-label="${i}" value="${esc(l)}" maxlength="20" aria-label="${esc(t('habitForm.labelForStep', { step: to.min + i }))}" />
            </div>`).join('')}
        </div>
      </div>` : ''}
    <div class="auth-field">
      <label id="step-edit-map-label">${t('stepEdit.mapTitle')}${infoTip(t('stepEdit.presetExplain'))}</label>
      <div class="pill-group seg" role="group" aria-labelledby="step-edit-map-label">
        ${['spread', 'same'].map((p) => `<button type="button" class="pill-toggle${se.preset === p ? ' pill-toggle--active' : ''}" data-action="step-edit-preset" data-preset="${p}" aria-pressed="${se.preset === p}">${t('stepEdit.preset.' + p)}</button>`).join('')}
      </div>
      <div class="step-map">${rows}</div>
    </div>
    <p class="step-dialog-note" id="step-edit-summary" aria-live="polite">${stepEditSummary(h, se)}</p>
    <div class="habit-form-actions">
      <button type="button" class="habit-form-cancel" data-action="step-edit-cancel">${t('common.cancel')}</button>
      <button type="button" class="auth-submit" data-action="step-edit-apply">${t('stepEdit.apply')}</button>
    </div>`);
}
// Nach Umstellen/Rückgängig: das offene Formular (und seinen Vergleichsstand für "Änderungen
// verwerfen?") auf die neue Skala bringen, ohne andere, noch ungespeicherte Eingaben zu verlieren.
function refreshFormAfterStepChange(f) {
  const h = state.habits.find((x) => x.defId === f.defId);
  if (!h) return;
  const patch = { min: h.min, max: h.max, labelsEnabled: !!h.labels, labels: h.labels ? [...h.labels] : resizeLabels([], h.max - h.min + 1) };
  Object.assign(f, patch);
  if (f.baseline) f.baseline = JSON.stringify({ ...JSON.parse(f.baseline), ...patch, labels: h.labels ? [...h.labels] : null });
}
// typeChange: der Typ hat gewechselt (bzw. zurück) - dann das Formular neu aus dem Feld aufbauen
// (andere ungespeicherte Eingaben gibt es dabei nicht, siehe 'type-edit-open').
export function finishStepChangeAction(f, ok, doneKey, typeChange = false) {
  const h = state.habits.find((x) => x.defId === f.defId);
  if (ok && h) {
    if (typeChange) {
      Object.assign(f, habitToForm(h), { stepEdit: null, typeEdit: null, stepUndoConfirm: false, typeRunning: false });
    } else {
      refreshFormAfterStepChange(f);
    }
    state.notice = { type: 'ok', text: tPlain(doneKey, { name: h.name, steps: h.max - h.min + 1, kind: kindLabel(h.kind) }) };
  } else {
    f.typeRunning = false;
    state.notice = { type: 'error', text: t('stepEdit.failed') };
  }
  render();
  if (ok && h && typeChange && f.baseline) markFormBaseline();
  // Der Dialog ist zu - zurück auf den Knopf, von dem aus er geöffnet wurde.
  document.querySelector('[data-action="step-edit-open"], [data-action="type-edit-open"], [data-action="step-edit-resume"], [data-action="step-undo"]')?.focus({ preventScroll: true });
}
// Nach dem Laden: abgebrochene Umstellungen fertig machen (im Hintergrund).
export async function resumeStepChanges() {
  for (const h of state.habits.filter((x) => x.stepChange && x.stepChange.state !== 'done')) {
    if (await runStepChange(h.defId)) {
      state.notice = { type: 'ok', text: tPlain('stepEdit.resumed', { name: h.name }) };
      render();
    }
  }
}

// --- Typ ändern (Feld mit Einträgen) -----------------------------------------
// Nutzer-Entscheidung 2026-10-29: Skala -> Zahl, Zahl/Zähler -> Skala und alles -> Text, mit
// demselben Ablauf wie "Stufen ändern" (stepChange mit kind in from/to, Sicherung _prev,
// Rückgängig). Nicht möglich, weil sich daraus kein Wert ableiten lässt: Text -> anderes;
// Berechnet hat keine eigenen Einträge. Felder, die in einem berechneten Feld stecken, erst dort
// herausnehmen (das berechnete Feld verlangt Skalen bzw. Zahlen).
const TYPE_MAP_ROWS_MAX = 20; // mehr verschiedene alte Werte: keine Einzel-Zuordnung, nur die Regel
export function typeChangeTargets(h) {
  if (h.kind === 'scale') return ['number', 'text'];
  if (h.kind === 'number' || h.kind === 'counter') return ['scale', 'text'];
  return [];
}
export function typeChangeBlocker(h) {
  return state.habits.find((x) => x.kind === 'computed' && (x.members || []).includes(h.id)) ?? null;
}
function kindLabel(kind) {
  return tPlain({ scale: 'habitForm.kindScale', number: 'habitForm.kindNumber', text: 'habitForm.kindText', counter: 'habitForm.kindCounter', time: 'habitForm.kindTime', multi: 'habitForm.kindMulti' }[kind] ?? 'habitForm.kindText');
}
export function usedValueRange(h) {
  const used = usedStepValues(h);
  return used.length ? { lo: used[0][0], hi: used[used.length - 1][0] } : { lo: 1, hi: 1 };
}
// Formular-Zustand: f.typeEdit = { kind, steps, preset ('round'|'spread'|'custom', nur Skala),
// unit, map { "<alt>": neu }, confirm }. map hält bei Zahl/Text den Text der Eingabefelder
// (umgerechnet erst in typeEditFinalMap), bei Skala die gewählte Stufe bzw. null.
export function typeEditKey(te) {
  return JSON.stringify([te.kind, te.steps, te.preset, te.unit, te.map]);
}
function typeEditScaleMin(h, te) {
  // "Runden" mit Werten unter 1 (z.B. 0 Gläser): die Skala beginnt bei 0 statt sie alle auf 1 zu legen.
  return te.preset === 'round' && usedValueRange(h).lo < 1 ? 0 : 1;
}
// Alle Eigenschaften, die vom Typ abhängen: startStepChange hält genau diese Schlüssel in from
// fest, Rückgängig stellt sie wieder her.
export function typeEditTo(h, te) {
  const base = {
    min: null, max: null, labels: null, good: null, goalThreshold: null, target: null, unit: null,
    displayStyle: 'buttons', sliderShowValue: true, step: 1, reminderBelow: null, counterSince: null,
  };
  if (te.kind === 'number') return { ...base, kind: 'number', unit: te.unit.trim() || null };
  if (te.kind === 'text') return { ...base, kind: 'text' };
  const min = typeEditScaleMin(h, te);
  // Bewertung: die Richtung des bisherigen Ziels (mindestens = hohe Werte gut), sonst keine.
  return { ...base, kind: 'scale', min, max: min + te.steps - 1, good: h.good || null, displayStyle: te.steps > CHOICE_STEP_CAP ? 'slider' : 'buttons' };
}
function typeEditRows(h) {
  const used = usedStepValues(h);
  return used.length <= TYPE_MAP_ROWS_MAX ? used : null;
}
export function applyTypeEditPreset(h, te) {
  const rows = typeEditRows(h);
  if (!rows) { te.map = {}; return; }
  const to = typeEditTo(h, te);
  const range = usedValueRange(h);
  te.map = Object.fromEntries(rows.map(([v]) => {
    const value = stepChangeConvert(h, to, te.preset, v, range);
    return [String(v), te.kind === 'scale' ? value : String(value)];
  }));
}
export function typeEditKindChanged(h, te, kind) {
  te.kind = kind;
  if (kind === 'scale') {
    // Ganze Zahlen, die als Skala passen (z.B. 0-10): "Runden" behält sie, sonst verteilen.
    const { lo, hi } = usedValueRange(h);
    const fits = usedStepValues(h).every(([v]) => Number.isInteger(v)) && lo >= 0 && hi - Math.min(lo, 1) + 1 <= SLIDER_STEP_CAP;
    te.preset = fits ? 'round' : 'spread';
    te.steps = fits ? Math.max(2, hi - typeEditScaleMin(h, te) + 1) : 5;
  }
  applyTypeEditPreset(h, te);
}
export function typeEditStepsChanged(h, te, steps) {
  te.steps = steps;
  if (te.preset !== 'custom') { applyTypeEditPreset(h, te); return; }
  const max = typeEditTo(h, te).max;
  for (const k of Object.keys(te.map)) if (te.map[k] !== null) te.map[k] = Math.min(max, te.map[k]);
}
// -> { map } oder { error } (Zahl nicht lesbar). Leeres Eingabefeld = Eintrag entfernen.
export function typeEditFinalMap(te) {
  if (te.kind === 'scale') return { map: { ...te.map } };
  const map = {};
  for (const [k, raw] of Object.entries(te.map)) {
    const s = String(raw).trim();
    if (te.kind === 'text') { map[k] = s || null; continue; }
    const n = s === '' ? null : Number(s.replace(',', '.'));
    if (n !== null && !Number.isFinite(n)) return { error: 'typeEdit.error.number' };
    map[k] = n;
  }
  return { map };
}
export function typeEditSummary(h, te) {
  const rows = typeEditRows(h);
  let removed = 0, changed = 0;
  const targets = new Map();
  if (rows) {
    for (const [v, n] of rows) {
      const raw = te.map[String(v)];
      const to = te.kind === 'scale' ? raw : String(raw ?? '').trim() === '' ? null : raw;
      if (to === null) { removed += n; continue; }
      if (te.kind === 'scale') {
        if (to !== v) changed += n;
        targets.set(to, (targets.get(to) || 0) + 1);
      }
    }
  }
  const parts = [];
  if (changed) parts.push(t(changed === 1 ? 'stepEdit.summary.changedOne' : 'stepEdit.summary.changedMany', { count: changed }));
  if (removed) parts.push(t(removed === 1 ? 'stepEdit.summary.removedOne' : 'stepEdit.summary.removedMany', { count: removed }));
  if ([...targets.values()].some((c) => c > 1)) parts.push(t('typeEdit.summary.merged'));
  // Was beim neuen Typ wegfällt.
  if (te.kind === 'text') parts.push(t('typeEdit.loss.text'));
  else if (te.kind === 'number') parts.push(t('typeEdit.loss.scaleToNumber'));
  else parts.push(t('typeEdit.loss.numberToScale'));
  if (h.kind === 'counter') parts.push(t('typeEdit.loss.counter'));
  if (te.kind === 'text' && Object.keys(state.entries).some((k) => getNote(k, h.id))) parts.push(t('typeEdit.loss.notes'));
  return parts.join(' ');
}
// Teil unter den Feld-Typ-Karten eines gesperrten Felds: letzte Umwandlung (Rückgängig), eine
// abgebrochene, und der Knopf "Typ ändern …" (Dialog: renderStepDialog -> renderTypeDialog).
export function typeEditHtml(f) {
  const h = state.habits.find((x) => x.defId === f.defId);
  if (!h || !f.locked || f.revealStage !== undefined) return '';
  const sc = h.stepChange && isTypeChange(h.stepChange) ? h.stepChange : null;
  if (sc && sc.state !== 'done' && !stepChangeRunning.has(h.defId)) {
    return `
      <div class="auth-field step-box">
        <p class="habit-form-lock-note" role="status">${t('stepEdit.pending')}</p>
        <button type="button" class="manage-btn" data-action="step-edit-resume">${t('stepEdit.resume')}</button>
      </div>`;
  }
  const undo = !sc || !stepChangeUndoable(h) ? '' : `
    <div class="auth-field step-box">
      <p class="habit-form-lock-note">${t('typeEdit.last', { date: formatDMY(sc.date), from: kindLabel(sc.from.kind), to: kindLabel(sc.to.kind) })}</p>
      <button type="button" class="manage-btn" data-action="step-undo">${t('stepEdit.undo')}</button>
    </div>`;
  if (!typeChangeTargets(h).length) return undo;
  const blocker = typeChangeBlocker(h);
  return undo + `
    <div class="auth-field step-box">
      ${blocker
        ? `<p class="habit-form-lock-note">${t('typeEdit.blocked', { computed: blocker.name })}</p>`
        : `<p class="habit-form-lock-note">${t('typeEdit.hint')}</p>
           <button type="button" class="manage-btn" data-action="type-edit-open">${t('typeEdit.open')}</button>`}
    </div>`;
}
function renderTypeDialog(h, te, box) {
  const fromLabel = kindLabel(h.kind);
  if (te.confirm) {
    return box(t('typeEdit.confirmTitle'), `
      <p>${t('typeEdit.confirm', { name: h.name, from: fromLabel, to: kindLabel(te.kind) })}</p>
      <p>${typeEditSummary(h, te)}</p>
      <p>${t('stepEdit.safety')}</p>
      <div class="habit-form-actions">
        <button type="button" class="habit-form-cancel" data-action="type-edit-confirm-cancel">${t('common.back')}</button>
        <button type="button" class="auth-submit" data-action="type-edit-confirm">${t('typeEdit.confirmDo')}</button>
      </div>`);
  }
  const used = usedStepValues(h);
  const rows = typeEditRows(h);
  const oldText = (v) => (h.kind === 'scale' ? stepValueText(h.labels, h.min, v) : esc(valueAsText(h, v)));
  const aria = (v, n) => esc(tPlain('stepEdit.mapAria', { value: h.kind === 'scale' ? h.labels?.[v - h.min] || v : valueAsText(h, v), count: n }));
  let settings = '', mapBody;
  if (te.kind === 'scale') {
    const to = typeEditTo(h, te);
    const range = usedValueRange(h);
    const options = (selected) => Array.from({ length: te.steps }, (_, i) => to.min + i)
      .map((v) => `<option value="${v}" ${selected === v ? 'selected' : ''}>${v}</option>`).join('')
      + `<option value="" ${selected === null ? 'selected' : ''}>${t('stepEdit.remove')}</option>`;
    settings = `
      <div class="auth-field">
        <label for="type-edit-steps">${t('typeEdit.steps')}</label>
        ${stepperInput('type-edit-steps', te.steps, 2, SLIDER_STEP_CAP, false, 'data-action="type-edit-count"')}
      </div>`;
    mapBody = `
      <div class="pill-group seg" role="group" aria-labelledby="type-edit-map-label">
        ${['round', 'spread'].map((p) => `<button type="button" class="pill-toggle${te.preset === p ? ' pill-toggle--active' : ''}" data-action="type-edit-preset" data-preset="${p}" aria-pressed="${te.preset === p}">${t('typeEdit.preset.' + p)}</button>`).join('')}
      </div>
      ${rows ? `<div class="step-map">${rows.map(([v, n]) => `
        <div class="step-map-row">
          <span class="step-map-old">${oldText(v)} <span class="step-map-count">${t('stepEdit.count', { count: n })}</span></span>
          <select data-type-map="${v}" aria-label="${aria(v, n)}">${options(te.map[String(v)])}</select>
        </div>`).join('')}</div>`
        : `<p class="step-dialog-note">${t('typeEdit.manyValues', { count: used.length, lo: formatNumber(range.lo), hi: formatNumber(range.hi) })}</p>`}`;
  } else {
    if (te.kind === 'number') {
      settings = `
        <div class="auth-field">
          <label for="type-edit-unit">${t('habitForm.unit')}</label>
          <input type="text" id="type-edit-unit" value="${esc(te.unit)}" maxlength="10" placeholder="${esc(t('habitForm.unitPlaceholder'))}" />
        </div>`;
    }
    const isNumber = te.kind === 'number';
    mapBody = rows ? `
      <p class="step-dialog-note">${t('typeEdit.emptyRemoves')}</p>
      <div class="step-map">${rows.map(([v, n]) => `
        <div class="step-map-row">
          <span class="step-map-old">${oldText(v)} <span class="step-map-count">${t('stepEdit.count', { count: n })}</span></span>
          <input type="text" data-type-map="${v}" value="${esc(te.map[String(v)] ?? '')}" ${isNumber ? 'inputmode="decimal" class="step-map-number"' : `maxlength="${NOTE_MAX_LENGTH}"`} aria-label="${aria(v, n)}" />
        </div>`).join('')}</div>`
      : `<p class="step-dialog-note">${t('typeEdit.manyValuesText', { count: used.length, example: esc(valueAsText(h, used[0][0])) })}</p>`;
  }
  const targets = typeChangeTargets(h);
  return box(t('typeEdit.title'), `
    <p class="step-dialog-field">${t('typeEdit.fieldNow', { name: h.name, kind: fromLabel })}</p>
    <p class="step-dialog-note">${t('typeEdit.intro')}</p>
    <div class="auth-field">
      <label id="type-edit-kind-label">${t('typeEdit.newKind')}</label>
      <div class="pill-group seg" role="group" aria-labelledby="type-edit-kind-label">
        ${targets.map((k) => `<button type="button" class="pill-toggle${te.kind === k ? ' pill-toggle--active' : ''}" data-action="type-edit-kind" data-kind="${k}" aria-pressed="${te.kind === k}">${kindLabel(k)}</button>`).join('')}
      </div>
    </div>
    ${settings}
    <div class="auth-field">
      <label id="type-edit-map-label">${t('stepEdit.mapTitle')}${te.kind === 'scale' ? infoTip(t('typeEdit.presetExplain')) : ''}</label>
      ${mapBody}
    </div>
    <p class="step-dialog-note" id="type-edit-summary" aria-live="polite">${typeEditSummary(h, te)}</p>
    <div class="habit-form-actions">
      <button type="button" class="habit-form-cancel" data-action="step-edit-cancel">${t('common.cancel')}</button>
      <button type="button" class="auth-submit" data-action="type-edit-apply">${t('typeEdit.apply')}</button>
    </div>`);
}

export async function handleHabitArchive(defId, archive) {
  const habit = state.habits.find((h) => h.defId === defId);
  const sectionId = habit && state.sections.some((sec) => sec.id === habit.sectionId) ? habit.sectionId : null;
  const sortOrder = archive ? null : containerMaxSortOrder(sectionId) + 1;
  const { error } = await supabase.from('habit_definitions')
    .update({ archived_at: archive ? new Date().toISOString() : null, ...(archive ? {} : { sort_order: sortOrder }) })
    .eq('id', defId);
  if (error) {
    state.notice = errorNotice('notice.actionFailed', error.message);
    render();
    return false;
  }
  state.habits = state.habits
    .map((h) => (h.defId === defId ? { ...h, archivedAt: archive ? new Date().toISOString() : null, ...(archive ? {} : { sortOrder }) } : h))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  render();
  return true;
}

// Persistiert die neue Reihenfolge EINES Behälters (oberste Ebene oder eine Gruppe) -
// items = alle Elemente des Behälters in der gewünschten Reihenfolge, je { type:
// 'habit'|'section', id, moveOut?, sectionId? }. moveOut: Feld verlässt dabei seine Gruppe
// (beim Löschen einer Gruppe); sectionId (auch null): Feld kommt dabei in diesen Behälter
// (Verschieben in/aus einer Gruppe). Der Behälter, aus dem es kommt, braucht keine neue
// Nummerierung - seine übrigen Felder behalten ihre Reihenfolge. Gemeinsamer Pfad für
// Ziehen UND die ↑/↓-Buttons, damit beide exakt gleich speichern.
export async function commitLayoutOrder(items) {
  const order = new Map(items.map((it, i) => [it.id, i + 1]));
  const newSection = (it) => ('sectionId' in it ? it.sectionId : it.moveOut ? null : undefined);
  const sectionOf = new Map(items.filter((it) => newSection(it) !== undefined).map((it) => [it.id, newSection(it)]));
  state.habits = state.habits
    .map((h) => (order.has(h.defId) ? { ...h, sortOrder: order.get(h.defId), sectionId: sectionOf.has(h.defId) ? sectionOf.get(h.defId) : h.sectionId } : h))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  state.sections = state.sections
    .map((sec) => (order.has(sec.id) ? { ...sec, sortOrder: order.get(sec.id) } : sec))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  if (sectionOf.size) invalidateTodayAutoCollapse();
  render();

  const results = await Promise.all(items.map((it, i) => (it.type === 'section'
    ? supabase.from('habit_sections').update({ sort_order: i + 1 }).eq('id', it.id)
    : supabase.from('habit_definitions').update({ sort_order: i + 1, ...(sectionOf.has(it.id) ? { section_id: sectionOf.get(it.id) } : {}) }).eq('id', it.id))));
  const failed = results.find((r) => r.error);
  if (failed) {
    state.notice = errorNotice('notice.reorderFailed', failed.error.message);
    render();
  }
}

// Ein Schritt ↑/↓ für ein Feld in der Verwaltung, über Gruppengrenzen hinweg (Nutzer-
// Entscheidung 2026-11-10): am Rand einer Gruppe verlässt es die Gruppe (landet direkt
// davor bzw. dahinter), von außen kommend wandert es in die benachbarte Gruppe hinein
// (von oben an den Anfang, von unten ans Ende). Zeitraum-Felder (Woche/Monat/Jahr) können
// in keiner Gruppe stehen und springen wie bisher über sie hinweg. -> { items, sectionId }
// für commitLayoutOrder (items = der Ziel-Behälter in neuer Reihenfolge) oder null, wenn
// es in die Richtung nicht weitergeht.
export function fieldMoveStep(defId, dir) {
  const blocks = layoutBlocks(state.habits.filter((h) => !h.archivedAt));
  const topItems = (list) => list.map((b) => (b.type === 'habit' ? { type: 'habit', id: b.habit.defId } : { type: 'section', id: b.section.id }));
  const groupItems = (habits) => habits.map((h) => ({ type: 'habit', id: h.defId }));
  const moved = (sectionId) => ({ type: 'habit', id: defId, sectionId });
  const inGroup = blocks.find((b) => b.type === 'section' && b.habits.some((h) => h.defId === defId));
  if (inGroup) {
    const others = inGroup.habits.filter((h) => h.defId !== defId);
    const idx = inGroup.habits.findIndex((h) => h.defId === defId);
    const to = dir === 'up' ? idx - 1 : idx + 1;
    if (to >= 0 && to < inGroup.habits.length) {
      const items = groupItems(others);
      items.splice(to, 0, { type: 'habit', id: defId });
      return { items, sectionId: inGroup.section.id };
    }
    // Hinaus auf die oberste Ebene, direkt vor bzw. hinter die Gruppe.
    const items = topItems(blocks);
    const at = items.findIndex((it) => it.id === inGroup.section.id) + (dir === 'up' ? 0 : 1);
    items.splice(at, 0, moved(null));
    return { items, sectionId: null };
  }
  const idx = blocks.findIndex((b) => b.type === 'habit' && b.habit.defId === defId);
  if (idx < 0) return null;
  const to = dir === 'up' ? idx - 1 : idx + 1;
  if (to < 0 || to >= blocks.length) return null;
  const neighbor = blocks[to];
  if (neighbor.type === 'section' && !isPeriodField(blocks[idx].habit)) {
    const items = groupItems(neighbor.habits);
    items.splice(dir === 'up' ? items.length : 0, 0, moved(neighbor.section.id));
    return { items, sectionId: neighbor.section.id };
  }
  const items = topItems(blocks.filter((_, i) => i !== idx));
  items.splice(to, 0, { type: 'habit', id: defId });
  return { items, sectionId: null };
}
