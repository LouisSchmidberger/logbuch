import { supabase } from './config.js?v=8aaa0e5b67';
import { encryptData } from './crypto.js?v=8aaa0e5b67';
import { DEF_PLAINTEXT_CLEARED, MAX_REMINDER_TIMES, containerMaxSortOrder, counterReminderThresholds, emptyMultiOptions, habitFromParts, hasNumberGoal, isCounterKind, isMultiKind, isTimeKind, newHabitKey, saveFieldNamesForPush, sinceSourceCandidate, sinceUsesStages } from './fields.js?v=8aaa0e5b67';
import { formatKey, parseDateKey, readTimeInput, weekLastIso, weekdayOrder } from './dates.js?v=8aaa0e5b67';
import { currentDek, runtime, state } from './state.js?v=8aaa0e5b67';
import { closeHabitForm, esc, habitHasData } from './navigation.js?v=8aaa0e5b67';
import { formatNumber, t, tPlain } from './i18n.js?v=8aaa0e5b67';
import { errorNotice, infoTip, monthName, weekdayLong } from './format.js?v=8aaa0e5b67';
import { saveDay } from './save.js?v=8aaa0e5b67';
import { habitFormReminderShown } from './fields-view.js?v=8aaa0e5b67';
import { TUTORIAL_STEP_DONE, TUTORIAL_STEP_FIELD } from './tutorial.js?v=8aaa0e5b67';
import { render } from './main-view.js?v=8aaa0e5b67';

// --- Felder-Verwaltung -----------------------------------------------------
// Bringt ein Bezeichnungs-Array auf die aktuelle Stufenzahl, ohne bereits eingetippten
// Text an gleicher Position zu verwerfen - gebraucht bei jeder Änderung von Von/Bis
// bzw. der Schieberegler-Stufenzahl (siehe 'habit-range-change'/'habit-labels-toggle'
// weiter unten), unabhängig davon, ob Bezeichnungen aktuell aktiv sind, damit das Array
// beim späteren Aktivieren schon die richtige Länge hat. defaultForIndex (optional)
// befüllt neue/leere Positionen statt mit '' - beim Aktivieren der Bezeichnungen bleibt
// so zunächst die Zahl als Text stehen (siehe 'habit-labels-toggle'), macht sichtbar,
// dass es weiterhin dieselbe Skala ist, bis man sie überschreibt.
export function resizeLabels(labels, newLength, defaultForIndex) {
  return Array.from({ length: Math.max(0, newLength) }, (_, i) => labels[i] || (defaultForIndex ? defaultForIndex(i) : ''));
}
// Aktuelle Stufenzahl eines Skala-Formulars, abgeleitet aus Darstellung + Bereich -
// einzige Quelle dafür, sowohl für die Bezeichnungs-Liste als auch die Live-Vorschau.
// Erinnerungstag eines Zeitraum-Felds (habit_definitions.period_reminder_day): Woche ISO-
// Wochentag 1-7, Monat 1-31 oder -1 = letzter Tag, Jahr MMTT. Standard: letzter Tag der Woche
// (folgt dem Wochenbeginn) / letzter Tag / 31.12. (gespeichert als null).
function periodReminderDefault(period) { return { week: weekLastIso(), month: -1, year: 1231 }[period]; }
export function periodReminderControl(f) {
  const day = f.periodReminderDay ?? periodReminderDefault(f.period);
  const dayOptions = (selected) => Array.from({ length: 31 }, (_, i) => i + 1)
    .map((d) => `<option value="${d}" ${d === selected ? 'selected' : ''}>${d}.</option>`).join('');
  let control;
  if (f.period === 'week') {
    control = `<select id="habit-form-period-day">${weekdayOrder().map((i) => i + 1)
      .map((d) => `<option value="${d}" ${d === day ? 'selected' : ''}>${esc(weekdayLong(new Date(2024, 0, d)))}</option>`).join('')}</select>`;
  } else if (f.period === 'month') {
    control = `<select id="habit-form-period-day">${dayOptions(day)}<option value="-1" ${day === -1 ? 'selected' : ''}>${t('habitForm.schedule.lastDay')}</option></select>`;
  } else {
    const month = Math.floor(day / 100);
    control = `
      <div class="schedule-inline">
        <select id="habit-form-period-yday" aria-label="${esc(t('habitForm.schedule.dayAria'))}">${dayOptions(day % 100)}</select>
        <select id="habit-form-period-ymonth" aria-label="${esc(t('habitForm.schedule.monthAria'))}">
          ${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === month ? 'selected' : ''}>${esc(monthName(new Date(2024, i, 1)))}</option>`).join('')}
        </select>
      </div>`;
  }
  return `
    <div class="auth-field">
      <label ${f.period === 'year' ? '' : 'for="habit-form-period-day"'}>${t('habitForm.periodReminderDay')}</label>
      ${control}
      <p class="habit-form-lock-note">${t('habitForm.periodReminderNote')}</p>
    </div>
  `;
}
function readPeriodReminderFromDom(f) {
  const dayEl = document.getElementById('habit-form-period-day');
  if (dayEl) { f.periodReminderDay = Number(dayEl.value); return; }
  const yd = document.getElementById('habit-form-period-yday');
  const ym = document.getElementById('habit-form-period-ymonth');
  if (yd && ym) f.periodReminderDay = Number(ym.value) * 100 + Number(yd.value);
}

export function habitFormStepCount(f) {
  return f.max - f.min + 1;
}

// Ziel ("ab wann voll erreicht", goalThreshold) je Feldart in natürlichen Begriffen statt
// Prozent (Nutzer-Entscheidung 2026-10-10): Ja/Nein "an 2 von 7 Tagen", mehrstufige Skala
// stufenlos "ab Ø 4,3" (siehe goalSliderText), berechnete Felder weiter in %
// (dort gibt es nichts Natürlicheres). Gespeichert wird wie bisher der Bruchteil 0-1 - als
// genauer Bruch, nicht gerundet: 2/7 als 29 % gespeichert hätte genau 2 von 7 Tagen knapp
// verfehlt.
function goalScaleValue(f, i) { return habitFormStepValue(f, i); }
function goalScaleLabel(f, i) {
  const label = f.labelsEnabled ? (f.labels[i] || '').trim() : '';
  return label || String(goalScaleValue(f, i));
}
function goalForValue(f, value) {
  const raw = (value - f.min) / (f.max - f.min);
  return f.good === 'low' ? 1 - raw : raw;
}
export function goalControlHtml(f) {
  const explain = infoTip(t('habitForm.goalExplain'));
  // Sichtbar statt nur hinter dem "?": das Ziel betrifft nur die Übersichten, nicht "Heute".
  const note = `<p class="habit-form-lock-note" id="habit-form-goal-note">${t('habitForm.goalNote')}</p>`;
  if (f.kind === 'computed') {
    return `
      <div class="auth-field">
        <label for="habit-form-goal">${t('habitForm.goalLabel')}${explain}</label>
        <input type="number" id="habit-form-goal" data-goal-mode="percent" min="1" max="100" step="1" value="${Math.round(f.goal * 100)}" aria-describedby="habit-form-goal-note" />
        ${note}
      </div>
    `;
  }
  const steps = habitFormStepCount(f);
  if (steps === 2) {
    // Bezugsgröße: 7 Tage; bei Zeitraum-Feldern 4 Wochen, 12 Monate bzw. 5 Jahre.
    const total = { day: 7, week: 4, month: 12, year: 5 }[f.period] || 7;
    const unitKey = f.period && f.period !== 'day' ? `.${f.period}` : '';
    const bestIndex = f.good === 'low' ? 0 : 1;
    const n = Math.min(total, Math.max(1, Math.round(f.goal * total)));
    const options = Array.from({ length: total }, (_, i) => total - i).map((d) => `<option value="${d / total}" ${d === n ? 'selected' : ''}>${d === total ? t('habitForm.goalEveryDay' + unitKey) : tPlain('habitForm.goalDays' + unitKey, { n: d })}</option>`).join('');
    return `
      <div class="auth-field">
        <label for="habit-form-goal">${tPlain('habitForm.goalYesNoLabel' + unitKey, { label: goalScaleLabel(f, bestIndex) })}${explain}</label>
        <select id="habit-form-goal" data-goal-mode="choice" aria-describedby="habit-form-goal-note">${options}</select>
        ${note}
      </div>
    `;
  }
  // Skalen ab drei Stufen: stufenlos per Regler in Zehnteln (Nutzer-Entscheidung 2026-10-11) -
  // das Ziel wirkt vor allem auf Durchschnitte, und die liegen beliebig zwischen den Stufen.
  // Der schlechteste Wert ist ausgenommen (Ziel "ab dem schlechtesten" hieße: immer erreicht).
  const lo = f.good === 'low' ? f.min : f.min + 0.1;
  const hi = f.good === 'low' ? f.max - 0.1 : f.max;
  const raw = f.good === 'low' ? f.max - f.goal * (f.max - f.min) : f.min + f.goal * (f.max - f.min);
  const value = Math.min(hi, Math.max(lo, Math.round(raw * 10) / 10));
  const { text, span } = goalSliderText(f, value);
  return `
    <div class="auth-field">
      <label for="habit-form-goal">${t('habitForm.goalValueLabel')}${explain}</label>
      <div class="goal-slider-row">
        <input type="range" id="habit-form-goal" class="value-slider goal-slider" data-goal-mode="value" data-action="goal-slider"
          min="${lo}" max="${hi}" step="0.1" value="${value}" style="--slider-pct:${((value - lo) / (hi - lo)) * 100}%" aria-valuetext="${esc(text + (span ? ' · ' + span : ''))}"
          aria-describedby="habit-form-goal-span habit-form-goal-note" />
        <span class="goal-slider-value" id="habit-form-goal-text" aria-hidden="true">${esc(text)}</span>
      </div>
      <p class="habit-form-lock-note" id="habit-form-goal-span"${span ? '' : ' hidden'}>${esc(span)}</p>
      ${note}
    </div>
  `;
}
// "ab Ø 4,3" (bzw. "bis Ø 1,6" bei "Niedrige Werte erstrebenswert") und - bei eigenen
// Bezeichnungen - wo das zwischen den Stufen liegt: "zwischen „gut“ (4) und „sehr gut“ (5)".
export function goalSliderText(f, value) {
  const text = tPlain(f.good === 'low' ? 'habitForm.goalUpTo' : 'habitForm.goalFrom', { value: formatNumber(value) });
  if (!f.labelsEnabled) return { text, span: '' };
  const lower = Math.floor(value + 0.05);
  const upper = Math.ceil(value - 0.05);
  const at = (v) => tPlain('habitForm.goalLabelAt', { label: goalScaleLabel(f, v - f.min), value: formatNumber(v) });
  return { text, span: lower >= upper ? at(lower) : tPlain('habitForm.goalBetween', { a: at(lower), b: at(upper) }) };
}
// Ziel einer Zahl / eines Zählers / eines berechneten Zahlen-Felds: keins / mindestens /
// höchstens / Bereich + Zahl(en), bei Tagesfeldern dazu "pro Tag" oder "pro Woche" (G3).
export function numberGoalAllowed(f) {
  return f.kind === 'number' || f.kind === 'counter' || (f.kind === 'computed' && (f.computedType === 'number' || f.computedType === 'duration'));
}
function numberGoalFormUnit(f) {
  if (f.kind === 'computed') {
    if (f.computedType === 'duration') return 'h';
    return (state.habits.find((h) => h.id === f.members?.[0])?.unit || '').trim();
  }
  return (f.unit || '').trim();
}
export function numberGoalField(f) {
  const unit = numberGoalFormUnit(f);
  const dirs = [['', 'habitForm.numberGoal.none'], ['high', 'habitForm.numberGoal.min'], ['low', 'habitForm.numberGoal.max'], ['range', 'habitForm.numberGoal.range']];
  const scopeShown = f.period === 'day' && (f.numberGoalDir === 'high' || f.numberGoalDir === 'low');
  const scope = f.numberGoalScope === 'week' ? 'week' : 'day';
  const note = !f.numberGoalDir ? 'habitForm.goalNote'
    : f.numberGoalDir === 'range' ? 'habitForm.numberGoalNoteRange'
    : scopeShown && scope === 'week' ? 'habitForm.numberGoalNoteWeek'
    : 'habitForm.numberGoalNote';
  return `
    <div class="auth-field">
      <label id="habit-form-numgoal-label">${t('habitForm.numberGoal')}</label>
      <div class="pill-group seg" role="group" aria-labelledby="habit-form-numgoal-label">
        ${dirs.map(([d, key]) => `<button type="button" class="pill-toggle${(f.numberGoalDir || '') === d ? ' pill-toggle--active' : ''}" data-action="habit-numgoal" data-dir="${d}" aria-pressed="${(f.numberGoalDir || '') === d}">${t(key)}</button>`).join('')}
      </div>
      ${f.numberGoalDir ? `
        <div class="schedule-inline">
          <input type="number" id="habit-form-numgoal-value" inputmode="decimal" step="any" min="0" value="${esc(f.numberGoalValue)}" aria-labelledby="habit-form-numgoal-label"${f.numberGoalDir === 'range' ? ` aria-label="${esc(tPlain('habitForm.numberGoal.from'))}"` : ''} aria-describedby="habit-form-goal-note" />
          ${f.numberGoalDir === 'range' ? `
            <span>${t('habitForm.numberGoal.to')}</span>
            <input type="number" id="habit-form-numgoal-max" inputmode="decimal" step="any" min="0" value="${esc(f.numberGoalMax)}" aria-label="${esc(tPlain('habitForm.numberGoal.toLabel'))}" aria-describedby="habit-form-goal-note" />
          ` : ''}
          ${unit ? `<span>${esc(unit)}</span>` : ''}
        </div>
      ` : ''}
      ${scopeShown ? `
        <div class="pill-group seg" role="group" aria-label="${esc(tPlain('habitForm.numberGoal.scope'))}">
          ${[['day', 'habitForm.numberGoal.perDay'], ['week', 'habitForm.numberGoal.perWeek']].map(([sc, key]) => `<button type="button" class="pill-toggle${scope === sc ? ' pill-toggle--active' : ''}" data-action="habit-numgoal-scope" data-scope="${sc}" aria-pressed="${scope === sc}">${t(key)}</button>`).join('')}
        </div>
      ` : ''}
      <p class="habit-form-lock-note" id="habit-form-goal-note">${t(note)}</p>
    </div>
  `;
}
// Prüft das Ziel im Formular: { goal } (null = keins) oder { notice }.
export function parseNumberGoal(f) {
  const dir = f.numberGoalDir;
  if (!dir) return { goal: null };
  const num = (x) => (String(x ?? '').trim() === '' ? NaN : Number(String(x).trim().replace(',', '.')));
  const target = num(f.numberGoalValue);
  if (!Number.isFinite(target) || target < 0 || (dir === 'high' && target === 0)) {
    return { notice: { type: 'error', text: t('habitForm.error.numberGoal') } };
  }
  if (dir === 'range') {
    const max = num(f.numberGoalMax);
    if (!Number.isFinite(max) || max < target) return { notice: { type: 'error', text: t('habitForm.error.numberGoalRange') } };
    return { goal: { dir, target, max, scope: 'day' } };
  }
  return { goal: { dir, target, max: null, scope: f.numberGoalScope === 'week' && f.period === 'day' ? 'week' : 'day' } };
}
function readGoalFromDom(f) {
  const el = document.getElementById('habit-form-goal');
  if (!el) return;
  const v = Number(el.value);
  if (!Number.isFinite(v)) return;
  if (el.dataset.goalMode === 'percent') f.goal = v / 100;
  else if (el.dataset.goalMode === 'value') f.goal = Math.min(1, Math.max(0, goalForValue(f, v)));
  else f.goal = v;
}
// Stufenzahl-Obergrenzen, eine Regel für alle Darstellungen (seit 2026-09-28): jede
// Stufe mit eigener Bedeutung muss man sehen und gezielt treffen können. Buttons (mit
// oder ohne Bezeichnungen) und eigene Bezeichnungen beim Schieberegler deshalb höchstens
// CHOICE_STEP_CAP - mehr Abstufungen machen Antworten eher beliebiger als genauer, und
// schon 7 nummerierte Buttons passen auf schmalen Handys nicht mehr neben den Namen
// (siehe .habit-row--buttons). Ein Schieberegler ohne Bezeichnungen steht für "ungefähr
// wie viel": bis SLIDER_STEP_CAP, mehr lässt sich auf einem Handy nicht mehr einzeln
// treffen. Bestehende Felder mit mehr Stufen bleiben unverändert nutzbar
// (lockedChoiceBlocked).
export const CHOICE_STEP_CAP = 7;
export const SLIDER_STEP_CAP = 100;
export function habitFormStepCap(f) {
  return f.displayStyle === 'buttons' || f.labelsEnabled ? CHOICE_STEP_CAP : SLIDER_STEP_CAP;
}
// Gesperrtes Feld (hat Daten, Stufenzahl fest): würde diese Darstellung die Obergrenze
// für gezielt wählbare Stufen erst überschreiten? Was das Feld schon vorher so hatte
// (z.B. 12 Buttons aus der Zeit vor der Grenze), bleibt erlaubt.
export function lockedChoiceBlocked(f, displayStyle, labelsEnabled) {
  if (!f.locked || habitFormStepCount(f) <= CHOICE_STEP_CAP) return false;
  const original = state.habits.find((h) => h.defId === f.defId);
  return (displayStyle === 'buttons' && original?.displayStyle !== 'buttons')
    || (labelsEnabled && !original?.labels);
}
// Der zugrundeliegende Zahlenwert der i-ten Stufe - f.min ist bei neuen/noch leeren
// Feldern immer 1 (siehe defaultHabitForm), bei bereits bestehenden Feldern deren
// echtes, ggf. historisch anderes min (z.B. alte Schieberegler-Felder mit Basis 0).
export function habitFormStepValue(f, i) {
  return f.min + i;
}
// Deckelt die aktuelle Stufenzahl auf den je nach Darstellung/Bezeichnungen gültigen
// Höchstwert (habitFormStepCap) - gebraucht beim Wechsel der Darstellung oder beim
// Aktivieren von Bezeichnungen, da f.max zwischen beiden Darstellungen geteilt wird.
// Gesperrte Felder nie: deren Stufenzahl ist fest (siehe lockedChoiceBlocked).
export function clampHabitFormSteps(f) {
  if (f.locked) return;
  f.max = Math.min(f.max, f.min + habitFormStepCap(f) - 1);
}

// Neue (bzw. noch unbefüllte) Skala-Felder starten immer bei 1 - kein frei wählbares
// "Von" mehr, unabhängig von Buttons/Schieberegler (siehe habitFormStepCount/-StepValue
// unten). Wer andere Bezeichnungen will, nutzt dafür Bezeichnungen statt eines
// verschobenen Zahlenbereichs. Bereits bestehende (ggf. historisch andere) Felder
// behalten beim Bearbeiten ihr echtes min (siehe habitToForm) - nur Von/Bis sind bei
// vorhandenen Daten ohnehin gesperrt (siehe docs/felder.md).
// "Neues Feld": zuerst die Vorlagen (siehe FIELD_TEMPLATES).
export function newHabitForm() {
  return { ...defaultHabitForm(), template: { stage: 'pick' } };
}
export function defaultHabitForm() {
  return {
    defId: null, locked: false, kind: 'scale',
    name: '', min: 1, max: 5, labelsEnabled: false, labels: ['', '', '', '', ''], good: 'high',
    displayStyle: 'buttons', sliderShowValue: true,
    members: [],
    computedType: 'scale', aggregate: 'sum', // nur bei kind='computed', siehe isNumberComputed
    showInStats: true,
    sectionId: null,
    goal: 1, // Ziel-Quote als Bruchteil (siehe goalControlHtml); 1 = nur der beste Wert
    unit: '', reminderEnabled: false, reminderTimes: [state.userSettings.defaultReminderMinute],
    reminderBelow: [''], // nur Zähler: je Zeit "falls weniger als" (Text aus dem Eingabefeld, '' = immer)
    schedule: scheduleToForm(null),
    period: 'day', periodReminderDay: null, // siehe periodReminderControl
    optional: false, // siehe isOptionalAllowed
    step: 1, // nur Zähler
    numberGoalDir: null, numberGoalValue: '', // Ziel 'high' = mindestens, 'low' = höchstens, 'range' = von-bis (siehe parseNumberGoal)
    numberGoalMax: '', numberGoalScope: 'day', // nur 'range': Obergrenze; 'week' = Wochensumme
    summary: 'avg', // Zahlen: in Woche/Monat/Jahr als Durchschnitt oder Summe
    durationFrom: null, durationTo: null, // nur berechnet "Dauer": Schlüssel der beiden Uhrzeit-Felder
    sinceSource: null, sinceValues: [], sinceAtLeast: '1', sinceMode: 'last', // nur berechnet "Tage seit" (siehe isSinceComputed)
    multiOptions: emptyMultiOptions(), // nur Mehrfachauswahl: [{ id, label, hidden }]
  };
}

// Formular-Zustand "An welchen Tagen?": nur Wochentage, Vorbelegung alle sieben (seit
// 2026-10-12; monatlich/jährlich/Intervall entfielen, das decken Zeitraum-Felder ab - kein
// Feld nutzte sie). Alle 7 werden als null (= täglich) gespeichert.
// Dazu "Alle N Tage" (mode 'interval', every als Text aus dem Eingabefeld, start als Datum).
export function scheduleToForm(schedule) {
  const interval = schedule?.type === 'interval';
  return {
    mode: interval ? 'interval' : 'weekdays',
    days: schedule?.type === 'weekly' ? [...schedule.days] : [0, 1, 2, 3, 4, 5, 6],
    every: interval ? String(schedule.every) : '2',
    start: interval ? schedule.start : formatKey(new Date()),
  };
}
// -> { schedule } oder { error: <i18n-Key> }.
function formToSchedule(fs) {
  if (fs.mode === 'interval') {
    const every = Number(fs.every);
    if (!Number.isInteger(every) || every < 2 || every > 365) return { error: 'habitForm.error.scheduleEvery' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fs.start || '') || formatKey(parseDateKey(fs.start)) !== fs.start) return { error: 'habitForm.error.scheduleStart' };
    return { schedule: { type: 'interval', every, unit: 'day', start: fs.start } };
  }
  const days = [...new Set(fs.days)].sort((a, b) => a - b);
  if (!days.length) return { error: 'habitForm.error.scheduleNoDays' };
  return { schedule: days.length === 7 ? null : { type: 'weekly', days } };
}
// Zahlen-Felder (auch berechnete aus Zahlen): in Woche/Monat/Jahr als Durchschnitt oder Summe.
export function habitFormSummable(f) {
  return f.kind === 'number' || f.kind === 'counter' || (f.kind === 'computed' && f.computedType !== 'scale' && f.computedType !== 'since');
}

export function habitToForm(h) {
  const min = h.min ?? 1;
  const max = h.max ?? 5;
  const displayStyle = h.displayStyle || 'buttons';
  const stepCount = max - min + 1;
  return {
    defId: h.defId,
    locked: habitHasData(h.id),
    kind: h.kind,
    name: h.name,
    min,
    max,
    labelsEnabled: !!h.labels,
    labels: h.labels ? [...h.labels] : Array.from({ length: stepCount }, () => ''),
    // Bei Skala-Feldern h.good unverändert übernehmen (kann null = "Keine Wertung" sein)
    // - der "|| 'high'"-Fallback gilt nur für number/computed, deren h.good in der DB immer
    // null ist, als sinnvoller Startwert falls im Formular noch auf "Skala" gewechselt wird.
    good: h.kind === 'scale' ? h.good : 'high',
    displayStyle,
    sliderShowValue: h.sliderShowValue ?? true,
    members: h.kind === 'computed' ? [...(h.members || [])] : [],
    computedType: h.aggregate === 'duration' || h.aggregate === 'since' ? h.aggregate : h.aggregate ? 'number' : 'scale',
    aggregate: h.aggregate && h.aggregate !== 'duration' && h.aggregate !== 'since' ? h.aggregate : 'sum',
    sinceSource: h.aggregate === 'since' ? h.members?.[0] ?? null : null,
    sinceValues: h.aggregate === 'since' ? [...(h.since?.values || [])].sort((a, b) => a - b) : [],
    sinceAtLeast: h.aggregate === 'since' && Number.isFinite(h.since?.atLeast) ? String(h.since.atLeast) : '1',
    sinceMode: h.aggregate === 'since' && h.since?.mode === 'start' ? 'start' : 'last',
    durationFrom: h.aggregate === 'duration' ? h.members?.[0] ?? null : null,
    durationTo: h.aggregate === 'duration' ? h.members?.[1] ?? null : null,
    showInStats: !h.hideInStats,
    sectionId: h.sectionId,
    goal: h.goalThreshold ?? 1,
    unit: h.unit || '',
    reminderEnabled: h.reminderTimes.length > 0,
    reminderTimes: h.reminderTimes.length ? [...h.reminderTimes] : [state.userSettings.defaultReminderMinute],
    reminderBelow: h.reminderTimes.length && isCounterKind(h)
      ? counterReminderThresholds(h).map((x) => (x === null ? '' : String(x)))
      : [''],
    schedule: scheduleToForm(h.schedule),
    period: h.period || 'day',
    periodReminderDay: h.periodReminderDay ?? null,
    optional: !!h.optional,
    step: h.step ?? 1,
    numberGoalDir: hasNumberGoal(h) ? h.goal.dir : null,
    numberGoalValue: hasNumberGoal(h) ? String(h.goal.target) : '',
    numberGoalMax: hasNumberGoal(h) && h.goal.dir === 'range' ? String(h.goal.max) : '',
    numberGoalScope: hasNumberGoal(h) ? h.goal.scope : 'day',
    summary: h.summary,
    multiOptions: isMultiKind(h) ? (h.options || []).map((o) => ({ ...o })) : emptyMultiOptions(),
  };
}

// Liest die gerade sichtbaren Formularfelder (Name, Bereich, ggf. Bezeichnungen) ins
// State-Objekt, bevor eine Struktur-Änderung (Darstellung/Stufenzahl) das Formular neu
// aufbaut — sonst gingen bereits eingegebene Werte beim Re-Render verloren.
function readReminderTimesFromDom(f) {
  const enabledEl = document.getElementById('habit-form-reminder-enabled');
  if (enabledEl) f.reminderEnabled = enabledEl.checked;
  f.reminderTimes = f.reminderTimes.map((m, i) => readTimeInput(`habit-form-reminder-time-${i}`) ?? m);
  f.reminderBelow = f.reminderTimes.map((_, i) => document.getElementById(`habit-form-reminder-below-${i}`)?.value ?? f.reminderBelow[i] ?? '');
}
export function syncHabitFormFromDom() {
  const f = state.habitForm;
  if (!f) return;
  const nameEl = document.getElementById('habit-form-name');
  if (nameEl) f.name = nameEl.value;
  if (f.typeEdit) {
    // Typ ändern: Einheit und die Eingabefelder der Zuordnung (Auswahllisten setzt der change-Handler).
    const unitEl = document.getElementById('type-edit-unit');
    if (unitEl) f.typeEdit.unit = unitEl.value;
    document.querySelectorAll('input[data-type-map]').forEach((el) => { f.typeEdit.map[el.dataset.typeMap] = el.value; });
  }
  if (f.kind === 'scale') {
    // Bereichs-Input unabhängig von labelsEnabled synchronisieren - Darstellung und
    // Bezeichnungen sind seit dem Formular-Umbau unabhängig voneinander wählbar, nicht
    // mehr zwei sich ausschließende Modi. Nur noch eine "Anzahl Stufen"-Eingabe für
    // beide Darstellungen (kein "Von" mehr, siehe defaultHabitForm) - f.min bleibt bei
    // neuen/unbefüllten Feldern unverändert bei 1.
    const stepsEl = document.getElementById('habit-form-steps');
    if (stepsEl) f.max = f.min + Number(stepsEl.value) - 1;
    if (f.displayStyle === 'slider') {
      const showValueEl = document.getElementById('habit-form-slider-show-value');
      if (showValueEl) f.sliderShowValue = showValueEl.checked;
    }
    // f.labelsEnabled NICHT hier aus der Checkbox neu lesen - das wird bereits vom
    // dedizierten 'habit-labels-toggle'-Handler gepflegt. Ein erneutes Lesen hier würde
    // bei genau diesem Klick den NEUEN (schon umgeschalteten) Checkbox-Zustand vorzeitig
    // übernehmen, während die Bezeichnungs-Inputs im DOM noch den ALTEN Zustand zeigen -
    // dadurch wurden beim Zurückschalten fälschlich die (noch alten) Zahlen statt der
    // zuvor eingetragenen Bezeichnungen eingelesen und der echte Text ging verloren.
    if (f.labelsEnabled) {
      document.querySelectorAll('[data-label-index]').forEach((el) => {
        f.labels[Number(el.dataset.labelIndex)] = el.value;
      });
    }
    if (f.stepEdit?.labels) {
      document.querySelectorAll('[data-step-label]').forEach((el) => {
        f.stepEdit.labels[Number(el.dataset.stepLabel)] = el.value;
      });
    }
    readGoalFromDom(f);
  } else if (f.kind === 'multi') {
    f.multiOptions.forEach((o) => {
      const el = document.getElementById(`habit-form-multi-option-${o.id}`);
      if (el) o.label = el.value;
    });
  } else if (f.kind === 'computed') {
    const aggregateEl = document.getElementById('habit-form-computed-aggregate');
    if (aggregateEl) f.aggregate = aggregateEl.value;
    const fromEl = document.getElementById('habit-form-duration-from');
    if (fromEl) f.durationFrom = fromEl.value || null;
    const toEl = document.getElementById('habit-form-duration-to');
    if (toEl) f.durationTo = toEl.value || null;
    const sinceSourceEl = document.getElementById('habit-form-since-source');
    if (sinceSourceEl) f.sinceSource = sinceSourceEl.value || null;
    const sinceAtLeastEl = document.getElementById('habit-form-since-atleast');
    if (sinceAtLeastEl) f.sinceAtLeast = sinceAtLeastEl.value;
    document.querySelectorAll('[data-member-key]').forEach((el) => {
      const slug = el.dataset.memberKey;
      if (el.checked) { if (!f.members.includes(slug)) f.members.push(slug); }
      else { f.members = f.members.filter((s) => s !== slug); }
    });
    readGoalFromDom(f);
  } else {
    const unitEl = document.getElementById('habit-form-unit');
    if (unitEl) f.unit = unitEl.value;
    const stepEl = document.getElementById('habit-form-step');
    if (stepEl) f.step = Number(String(stepEl.value).replace(',', '.'));
  }
  const numGoalEl = document.getElementById('habit-form-numgoal-value');
  if (numGoalEl) f.numberGoalValue = numGoalEl.value;
  const numGoalMaxEl = document.getElementById('habit-form-numgoal-max');
  if (numGoalMaxEl) f.numberGoalMax = numGoalMaxEl.value;
  readPeriodReminderFromDom(f);
  readReminderTimesFromDom(f);
  const everyEl = document.getElementById('habit-form-every');
  if (everyEl) f.schedule.every = everyEl.value;
  const startEl = document.getElementById('habit-form-every-start');
  if (startEl) f.schedule.start = startEl.value;
  const showInStatsEl = document.getElementById('habit-form-show-in-stats');
  if (showInStatsEl) f.showInStats = showInStatsEl.checked;
  const optionalEl = document.getElementById('habit-form-optional');
  if (optionalEl) f.optional = optionalEl.checked;
  const sectionEl = document.getElementById('habit-form-section');
  if (sectionEl) f.sectionId = sectionEl.value || null;
}

export async function handleHabitSave() {
  // Verhindert Doppel-Submits (z.B. mehrfaches schnelles Klicken auf "Speichern",
  // während der erste Request noch läuft, etwa bei einer langsamen Verbindung) - ohne
  // diese Sperre konnten zwei parallele Inserts mit demselben Namen/Slug entstehen,
  // von denen der zweite mit einem kryptischen "duplicate key"-Fehler fehlschlug.
  if (state.habitFormSaving) return;
  // Muss VOR dem render() für den "Wird gespeichert …"-Zustand passieren: dieses
  // render() baut das Formular aus state.habitForm neu auf und hätte sonst gerade erst
  // eingetippte, noch nicht synchronisierte Werte (z.B. Bezeichnungen) gelöscht, bevor
  // handleHabitSaveInner() sie überhaupt prüfen konnte — wirkte wie ein zufälliger
  // Reset der Eingabe.
  syncHabitFormFromDom();
  state.habitFormSaving = true;
  render();
  try {
    await handleHabitSaveInner();
  } finally {
    state.habitFormSaving = false;
    render();
  }
}

// Aus einem Formular-Zustand die zu speichernde Definition - nur aus f, nie aus der Seite
// (das Formular liest syncHabitFormFromDom vorher ein), damit Vorlagen dieselben Felder anlegen
// wie das Formular, ohne dass es angezeigt wird. -> { name, fields, period, periodReminderDay,
// reminderTimes, reminderBelow } oder { notice } bei einer ungültigen Eingabe.
export function habitFormDefinition(f) {
  const name = f.name.trim();
  if (!name) {
    return { notice: { type: 'error', text: t('habitForm.error.nameRequired') } };
  }

  // Mehrere Zeiten nur bei Tagesfeldern; Zähler-Zeitraumfelder erinnern gar nicht (siehe
  // habitFormReminderShown). Doppelte Zeiten fallen still weg, sortiert wird erst hier (beim
  // Umsortieren während der Eingabe spränge die gerade bearbeitete Zeile weg).
  const reminderPairs = !f.reminderEnabled || !habitFormReminderShown(f) ? []
    : f.reminderTimes.map((m, i) => ({ m, below: String(f.reminderBelow[i] ?? '').trim().replace(',', '.') }))
      .filter((p, i, all) => all.findIndex((q) => q.m === p.m) === i)
      .sort((a, b) => a.m - b.m)
      .slice(0, f.period === 'day' ? MAX_REMINDER_TIMES : 1);
  const reminderTimes = reminderPairs.map((p) => p.m);
  // Zähler: "falls weniger als" - alle leer (= immer erinnern) oder alle Zahlen > 0, zur
  // späteren Zeit nicht kleiner (siehe counterReminderThresholds).
  let reminderBelow;
  if (f.kind === 'counter' && reminderPairs.length) {
    reminderBelow = reminderPairs.map((p) => (p.below === '' ? null : Number(p.below)));
    const error = reminderBelow.some((x) => x !== null && (!Number.isFinite(x) || x <= 0)) ? 'habitForm.error.reminderBelowNumber'
      : reminderBelow.some((x) => x === null) && reminderBelow.some((x) => x !== null) ? 'habitForm.error.reminderBelowAll'
      : reminderBelow.some((x, i) => i > 0 && x < reminderBelow[i - 1]) ? 'habitForm.error.reminderBelowOrder'
      : null;
    if (error) {
      return { notice: { type: 'error', text: t(error) } };
    }
  }

  // Ziel-Quote ergibt bei "Keine Wertung" keinen Sinn (kein Gut/Schlecht zum Stauchen)
  // - das Formularfeld ist dann versteckt (siehe scaleBody), aber f.goal könnte noch einen
  // alten Wert von vor dem Umschalten auf "Keine Wertung" tragen.
  const goalThreshold = ((f.kind === 'scale' && f.good) || (f.kind === 'computed' && f.computedType === 'scale')) && Number.isFinite(f.goal) && f.goal > 0 && f.goal < 1
    ? f.goal
    : null;

  let numberGoal = null;
  if (numberGoalAllowed(f)) {
    const g = parseNumberGoal(f);
    if (g.notice) return g;
    numberGoal = g.goal;
  }

  let fields; // { kind, min, max, labels, good, unit, display_style, slider_show_value, group_members, goal_threshold }
  if (f.kind === 'text') {
    fields = { kind: 'text', min: null, max: null, labels: null, good: null, unit: null, display_style: 'buttons', slider_show_value: true, group_members: null, goal_threshold: null };
  } else if (f.kind === 'time') {
    fields = { kind: 'time', min: null, max: null, labels: null, good: null, unit: null, display_style: 'buttons', slider_show_value: true, group_members: null, goal_threshold: null };
  } else if (f.kind === 'multi') {
    const options = f.multiOptions.map((o) => ({ id: o.id, label: o.label.trim().slice(0, 40), ...(o.hidden ? { hidden: true } : {}) }));
    const names = options.map((o) => o.label.toLocaleLowerCase());
    const error = options.some((o) => !o.label) ? 'habitForm.error.multiEmpty'
      : new Set(names).size !== names.length ? 'habitForm.error.multiDuplicate'
      : options.filter((o) => !o.hidden).length < 2 ? 'habitForm.error.multiMin'
      : null;
    if (error) {
      return { notice: { type: 'error', text: t(error) } };
    }
    fields = { kind: 'multi', min: null, max: null, labels: null, good: null, unit: null, display_style: 'buttons', slider_show_value: true, group_members: null, goal_threshold: null, options };
  } else if (f.kind === 'computed' && f.computedType === 'duration') {
    const isTimeField = (key) => state.habits.some((h) => h.id === key && isTimeKind(h));
    if (!isTimeField(f.durationFrom) || !isTimeField(f.durationTo) || f.durationFrom === f.durationTo) {
      return { notice: { type: 'error', text: t('habitForm.error.durationMembers') } };
    }
    fields = { kind: 'computed', min: null, max: null, labels: null, good: null, unit: null, display_style: 'buttons', slider_show_value: true, group_members: [f.durationFrom, f.durationTo], goal_threshold: null, aggregate: 'duration' };
  } else if (f.kind === 'computed' && f.computedType === 'since') {
    const src = state.habits.find((h) => h.id === f.sinceSource && sinceSourceCandidate(h));
    const stages = src && sinceUsesStages(src);
    const values = stages ? f.sinceValues.filter((v) => v >= src.min && v <= src.max) : null;
    const atLeast = src && !stages ? Number(String(f.sinceAtLeast).replace(',', '.')) : null;
    if (!src || (stages ? !values.length : !Number.isFinite(atLeast))) {
      return { notice: { type: 'error', text: t('habitForm.error.sinceSource') } };
    }
    fields = { kind: 'computed', min: null, max: null, labels: null, good: null, unit: null, display_style: 'buttons', slider_show_value: true, group_members: [src.id], goal_threshold: null, aggregate: 'since',
      since: { values, atLeast, mode: f.sinceMode === 'start' ? 'start' : 'last' } };
  } else if (f.kind === 'number' || f.kind === 'counter') {
    const unit = (f.unit || '').trim();
    if (f.kind === 'counter') {
      const step = Number(String(f.step).replace(',', '.'));
      if (!Number.isFinite(step) || step <= 0 || step > 1000) {
        return { notice: { type: 'error', text: t('habitForm.error.counterStep') } };
      }
      f.step = step;
    }
    // Ziel (siehe goalFromPayload): "mindestens/höchstens pro Tag" wie bisher in good/target, alles
    // Neue nur in numberGoal.
    const plain = numberGoal && numberGoal.scope === 'day' && numberGoal.dir !== 'range';
    fields = { kind: f.kind, min: null, max: null, labels: null, good: plain ? numberGoal.dir : null, target: plain ? numberGoal.target : null, numberGoal: plain ? null : numberGoal, unit: unit || null, display_style: 'buttons', slider_show_value: true, group_members: null, goal_threshold: null };
  } else if (f.kind === 'computed') {
    const memberKeys = f.members.filter((key) => state.habits.some((h) => h.id === key));
    if (memberKeys.length < 2) {
      return { notice: { type: 'error', text: t('habitForm.error.minComputedMembers') } };
    }
    const isNumber = f.computedType === 'number';
    if (isNumber) {
      // Das Formular sperrt Felder mit anderer Einheit schon - hier nur als letzte Absicherung.
      const units = new Set(memberKeys.map((key) => (state.habits.find((h) => h.id === key)?.unit || '').trim()));
      if (units.size > 1) {
        return { notice: { type: 'error', text: t('habitForm.error.computedUnitMismatch') } };
      }
    }
    fields = { kind: 'computed', min: null, max: null, labels: null, good: null, unit: null, display_style: 'buttons', slider_show_value: true, group_members: memberKeys, goal_threshold: goalThreshold, aggregate: isNumber ? f.aggregate : null };
  } else if (f.locked) {
    // Bereich/Anzahl bleiben unangetastet (original.min/max) – die Darstellung
    // (Buttons/Slider) und die Sichtbarkeit des Werts beim Eintragen sind reine
    // Anzeige-Einstellungen ohne Auswirkung auf bestehende Daten, deshalb aus dem
    // aktuellen Formular übernommen statt wie der Rest vom Original beibehalten.
    // Bezeichnungen (an/aus + Text) sind trotz Sperre editierbar (siehe scaleBody) -
    // reine Beschriftung derselben Werte/Positionen, keine Verschiebung. Die Anzahl
    // bleibt dabei immer gleich (Von/Bis bzw. Stufenzahl sind weiterhin gesperrt).
    const original = state.habits.find((h) => h.defId === f.defId);
    const stepCount = original.max - original.min + 1;
    if (lockedChoiceBlocked(f, f.displayStyle, f.labelsEnabled)) {
      // Die Stufenzahl ändert nur "Stufen ändern" (startStepChange) - hier im Formular sind
      // Buttons/Bezeichnungen für so ein Feld also nicht wählbar. Das Formular sperrt beides
      // schon (scaleBody).
      return { notice: { type: 'error', text: tPlain('habitForm.lockedStepCap', { steps: stepCount, cap: CHOICE_STEP_CAP }) } };
    }
    if (f.labelsEnabled && (f.labels.length !== stepCount || f.labels.some((l) => !l.trim()))) {
      return { notice: { type: 'error', text: t('habitForm.error.fillAllLabels') } };
    }
    fields = { kind: 'scale', min: original.min, max: original.max, labels: f.labelsEnabled ? f.labels : null, good: f.good, unit: null, display_style: f.displayStyle, slider_show_value: f.sliderShowValue, group_members: null, goal_threshold: goalThreshold };
  } else {
    // Neue/unbefüllte Skala-Felder starten bei 1, Zahlenskalen ohne eigene Bezeichnungen
    // wahlweise bei 0 (Schmerz/Stress "0 bis 10", Nutzer-Entscheidung 2026-10-11). Mit
    // eigenen Bezeichnungen sieht man die Zahlen nie - dort immer 1.
    const min = !f.labelsEnabled && f.min === 0 ? 0 : 1;
    const steps = Math.round(habitFormStepCount(f));
    const isSlider = f.displayStyle === 'slider';
    const stepCap = habitFormStepCap(f);
    if (!Number.isFinite(steps) || steps < 2 || steps > stepCap) {
      return { notice: { type: 'error', text: tPlain('habitForm.error.stepsRange', { max: stepCap }) } };
    }
    const max = min + steps - 1;
    const displayStyle = isSlider ? 'slider' : 'buttons';
    const sliderShowValue = isSlider ? f.sliderShowValue : true;
    let labels = null;
    if (f.labelsEnabled) {
      labels = resizeLabels(f.labels, steps).map((l) => String(l ?? '').trim());
      if (labels.length !== steps || labels.some((l) => !l)) {
        return { notice: { type: 'error', text: t('habitForm.error.fillAllLabels') } };
      }
    }
    fields = { kind: 'scale', min, max, labels, good: f.good, unit: null, display_style: displayStyle, slider_show_value: sliderShowValue, group_members: null, goal_threshold: goalThreshold };
  }

  // Wiederholung - berechnete Felder haben keinen eigenen Plan (DB-Check erzwingt das ebenfalls).
  // Auch bei gesperrten Feldern änderbar: ändert nur, an welchen Tagen das Feld dran ist,
  // deutet keine vorhandenen Werte um.
  // Zeitraum-Felder: keine Wiederholung, keine Gruppe, nie "Berechnet" (DB-Check
  // habit_definitions_period_combination_check). Der Erinnerungstag als null, wenn er dem
  // Standard entspricht (letzter Tag der Woche / des Monats / 31.12.) - eine Darstellung für "Standard".
  // Uhrzeiten nur als Tagesfeld - "ins Bett" einmal pro Woche ergibt keinen Sinn. Mehrfachauswahl
  // vorerst auch (ihre Auswertung zählt Tage).
  const period = f.kind === 'computed' || f.kind === 'time' || f.kind === 'multi' ? 'day' : f.period;
  const periodReminderDay = period === 'day' || f.periodReminderDay === null || f.periodReminderDay === periodReminderDefault(period)
    ? null : f.periodReminderDay;
  if (f.kind === 'computed' || period !== 'day') {
    fields.schedule = null;
  } else {
    const result = formToSchedule(f.schedule);
    if (result.error) {
      return { notice: { type: 'error', text: t(result.error) } };
    }
    fields.schedule = result.schedule;
  }

  if (f.kind === 'computed' && fields) fields.numberGoal = numberGoal;
  const optional = isOptionalAllowed({ kind: f.kind, period }) && !!f.optional;
  return { name, fields, period, periodReminderDay, reminderTimes, reminderBelow, optional };
}
// "Darf leer bleiben" (K6, Nutzer-Entscheidung 2026-11-10, z. B. Mittagsschlaf: kein Eintrag =
// keiner gehalten): ein leeres Feld fehlt nicht - kein Punkt "noch offen", zählt nicht gegen
// "Alles eingetragen" und das Zuklappen der Gruppe, keine Standard- und Gruppen-Erinnerung (eigene
// Zeiten erinnern weiter, die setzt man bewusst). Nur Tagesfelder, die überhaupt fehlen können
// (nicht berechnet, kein Zähler - der zählt leer als 0). Klartext-Spalte, weil
// get_due_notifications sie braucht.
export function isOptionalAllowed(f) { return f.period === 'day' && f.kind !== 'computed' && f.kind !== 'counter'; }

async function handleHabitSaveInner() {
  const f = state.habitForm;
  // Muss VOR jedem möglichen frühen Return (Validierungsfehler) passieren — sonst baut
  // render() das Formular aus dem noch nicht synchronisierten (veralteten) f neu auf und
  // wirft dabei unbeteiligte, bereits eingegebene Werte weg (wirkte wie zufälliger Reset).
  syncHabitFormFromDom();
  const def = habitFormDefinition(f);
  if (def.notice) {
    state.notice = def.notice;
    return;
  }
  const result = await persistHabitForm(f, def);
  if (result.notice) {
    state.notice = result.notice;
    return;
  }
  closeHabitForm();
  // Im Tutorial (Schritt 2, erstes Feld) gilt jedes erfolgreich angelegte (oder über
  // "Zurück" nochmal bearbeitete) Feld als Abschluss des Schritts – automatischer Sprung zu
  // "Geschafft", kein zusätzlicher Klick.
  if (state.tutorialStep === TUTORIAL_STEP_FIELD) state.tutorialStep = TUTORIAL_STEP_DONE;
}

// Alles Inhaltliche verschlüsselt in enc (siehe habitFromParts), im Klartext nur, was
// die Erinnerungen brauchen. Immer die vollständige payload - bei gesperrten Feldern
// enthält fields schon die unveränderten Original-Werte für min/max.
export function habitPayloadFromDefinition(f, def, key) {
  const { name, fields, reminderBelow } = def;
  return {
    key,
    name,
    unit: fields.unit,
    min: fields.min,
    max: fields.max,
    labels: fields.labels,
    good: fields.good,
    displayStyle: fields.display_style,
    sliderShowValue: fields.slider_show_value,
    groupMembers: fields.group_members,
    goalThreshold: fields.goal_threshold,
    aggregate: fields.aggregate ?? null,
    since: fields.since ?? undefined,
    options: fields.options ?? undefined,
    hideInStats: !f.showInStats,
    step: f.kind === 'counter' ? f.step : undefined,
    target: fields.target ?? undefined,
    numberGoal: fields.numberGoal ?? undefined,
    summary: habitFormSummable(f) && f.summary === 'sum' ? 'sum' : undefined,
    archivedInStats: f.defId ? !!state.habits.find((h) => h.defId === f.defId)?.archivedInStats : false,
    counterSince: f.kind === 'counter' && f.defId ? state.habits.find((h) => h.defId === f.defId)?.counterSince ?? undefined : undefined,
    reminderBelow,
    stepChange: f.kind === 'scale' && f.defId ? state.habits.find((h) => h.defId === f.defId)?.stepChange ?? undefined : undefined,
  };
}
// Speichert ein Formular (neu oder geändert) -> { habit } oder { notice }. Gemeinsam für das
// Formular und die Vorlagen (createFromTemplate).
export async function persistHabitForm(f, def) {
  const { fields, period, periodReminderDay, reminderTimes, optional } = def;
  const key = f.defId ? state.habits.find((h) => h.defId === f.defId).id : newHabitKey();
  const payload = habitPayloadFromDefinition(f, def, key);
  const sectionId = period === 'day' && state.sections.some((sec) => sec.id === f.sectionId) ? f.sectionId : null;
  const row = {
    kind: fields.kind,
    schedule: fields.schedule,
    reminder_minute: reminderTimes[0] ?? null,
    reminder_minutes: reminderTimes.length > 1 ? reminderTimes : null,
    section_id: sectionId,
    period,
    period_reminder_day: periodReminderDay,
    // Spalte nur mitschicken, wenn gesetzt oder schon gesetzt war - so läuft Speichern auch,
    // solange die Spalte (Migration) noch nicht überall angekommen ist.
    ...(optional || (f.defId && state.habits.find((h) => h.defId === f.defId)?.optional) ? { optional } : {}),
    enc: await encryptData(currentDek, payload),
    ...DEF_PLAINTEXT_CLEARED,
  };
  // Neues oder in eine andere Gruppe verschobenes Feld: ans Ende seines Behälters.
  const original = f.defId ? state.habits.find((h) => h.defId === f.defId) : null;
  if (!original || (original.sectionId || null) !== sectionId) row.sort_order = containerMaxSortOrder(sectionId) + 1;
  let habit;
  if (f.defId) {
    const { data, error } = await supabase.from('habit_definitions').update(row).eq('id', f.defId).select().single();
    if (error) return { notice: errorNotice('notice.saveFailed', error.message) };
    const idx = state.habits.findIndex((h) => h.defId === f.defId);
    state.habits[idx] = habitFromParts(data, payload);
    habit = state.habits[idx];
  } else {
    const { data, error } = await supabase.from('habit_definitions')
      .insert({ user_id: state.session.user.id, ...row })
      .select().single();
    if (error) return { notice: errorNotice('notice.createFailed', error.message) };
    habit = habitFromParts(data, payload);
    state.habits = [...state.habits, habit];
    if (state.tutorialStep === TUTORIAL_STEP_FIELD) runtime.tutorialLastFieldDefId = data.id;
  }
  saveFieldNamesForPush();
  // Ziel oder Zeiten eines Zählers geändert: den Erinnerungs-Stand von heute neu schreiben.
  const today = formatKey(new Date());
  if (fields.kind === 'counter' && state.entries[today]) saveDay(today);
  return { habit };
}

// Beim Reaktivieren kommt das Feld ans Ende seines Bereichs (seiner Gruppe bzw. der
// obersten Ebene): sein alter sort_order kann inzwischen mitten zwischen anderen
// liegen - etwa wenn seine Gruppe gelöscht wurde, während es archiviert war (dann ist
// es ohne Gruppe, trägt aber noch seine Position von innerhalb der Gruppe).
// In einen Zähler umwandeln (Nutzer-Entscheidung 2026-10-11, nur auf Wunsch): Zahlenfelder und
// Skalen, die bei 0 beginnen (frühere "Anzahl"-Skalen wie Zähne 0-2). Die Einträge bleiben
// unverändert - es sind schon Zahlen -, nur die Definition wird ein Zähler. "Leer = 0" gilt
// erst ab heute (counterSince): frühere leere Tage waren evtl. vergessen, nicht 0. Bezeichnungen
// und Bewertung einer Skala entfallen. Kein Zurück (bewusst nicht gebaut).
export function canConvertToCounter(f) {
  return !!f.defId && f.locked && (f.kind === 'number' || (f.kind === 'scale' && f.min === 0));
}
export async function convertHabitToCounter(defId) {
  const h = state.habits.find((x) => x.defId === defId);
  if (!h) return;
  const result = await convertToCounterRow(h);
  if (result.notice) {
    state.notice = result.notice;
    render();
    return;
  }
  closeHabitForm();
  state.notice = { type: 'ok', text: tPlain('habitForm.convertDone', { name: h.name }) };
  render();
}
// Der eigentliche Umbau (auch für Vorlagen, takeIntoTemplate): Ziel übernehmen, Erinnerungszeiten
// leeren (Zähler erinnern über eigene Zeiten mit "unter"), leer = 0 erst ab heute.
export async function convertToCounterRow(h) {
  // Ziel übernehmen: aus einer Skala mit Bewertung wird "mindestens/höchstens" der Wert, ab dem
  // sie voll erreicht war (z.B. Zähne 0-2, hohe Werte gut -> mindestens 2).
  let good = null, target = null, numberGoal;
  if (h.kind === 'number') { good = h.good || null; target = h.target ?? null; numberGoal = h.goalRaw ?? undefined; }
  else if (h.good) {
    const g = h.goalThreshold ?? 1;
    good = h.good;
    target = h.good === 'high' ? h.min + g * (h.max - h.min) : h.min + (1 - g) * (h.max - h.min);
    target = Math.round(target * 10) / 10;
  }
  const payload = {
    key: h.id, name: h.name, unit: h.kind === 'number' ? h.unit ?? null : null, target, numberGoal,
    min: null, max: null, labels: null, good, displayStyle: 'buttons', sliderShowValue: true,
    groupMembers: null, goalThreshold: null, aggregate: null,
    hideInStats: !!h.hideInStats, archivedInStats: !!h.archivedInStats,
    step: 1, counterSince: formatKey(new Date()),
  };
  const { data, error } = await supabase.from('habit_definitions')
    .update({ kind: 'counter', reminder_minute: null, reminder_minutes: null, enc: await encryptData(currentDek, payload), ...DEF_PLAINTEXT_CLEARED })
    .eq('id', h.defId).select().single();
  if (error) return { notice: errorNotice('notice.saveFailed', error.message) };
  const habit = habitFromParts(data, payload);
  state.habits = state.habits.map((x) => (x.defId === h.defId ? habit : x));
  saveFieldNamesForPush();
  return { habit };
}
