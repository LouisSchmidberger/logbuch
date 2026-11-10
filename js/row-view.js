import { MINUTES_PER_DAY, computedMemberHabits, computedUnit, expandSection, formatClock, hasDayGoal, hasWeekGoal, isCounterKind, isDurationComputed, isMultiKind, isNumberComputed, isNumberKind, isSectionCollapsed, isSinceComputed, isTextKind, isTimeKind, numberComputedDay, renderBySection, sectionDoneOn, sinceWhichText, timeDayOffset, timeValueOn, weekGoalTodayHtml } from './fields.js?v=90bbeaa075';
import { NEUTRAL_SELECTED, NEUTRAL_SELECTED_TEXT, PERIODS, addDays, entryKeyFor, formatKey, formatSeriesValue, goalSuffixHtml, goalValueStyle, habitColor, habitScore, isNeutralScale, isPeriodField, isPlannedOn, nextPeriodDisabled, normalize, parseDateKey, periodEnd, periodStart, scoreColor, startOfDay, textOnScore } from './dates.js?v=90bbeaa075';
import { state } from './state.js?v=90bbeaa075';
import { activeHabits, app, esc, isNoteEditorOpen, syncLayerHistory } from './navigation.js?v=90bbeaa075';
import { formatNumber, t, tPlain } from './i18n.js?v=90bbeaa075';
import { haptic, isDayProgressShown } from './theme.js?v=90bbeaa075';
import { clockUses12h, dtf, formatDMY, longDate, weekdayLong, weekdayShort } from './format.js?v=90bbeaa075';
import { habitFormStepCount, resizeLabels } from './field-form.js?v=90bbeaa075';
import { DAY_NOTE_KEY, NOTE_MAX_LENGTH, findLastValue, getNote } from './save.js?v=90bbeaa075';
import { isGuided } from './auth-view.js?v=90bbeaa075';
import { dayHasValues } from './stats-view.js?v=90bbeaa075';
import { icon, render } from './main-view.js?v=90bbeaa075';

// --- Rendering: Habit-Row ---------------------------------------------
// preview: Vorschau im Feld-Formular (renderHabitFormPreview) - gleiches Aussehen und
// Verhalten, aber eigene Aktionen, die nur den Formular-Zustand ändern, nie echte Daten.
function renderHabitOptions(habit, value, { preview = false } = {}) {
  const options = Array.from({ length: habit.max - habit.min + 1 }, (_, i) => habit.min + i)
    .map((n, i) => [n, habit.labels ? habit.labels[i] : String(n)]);

  return options.map(([v, label]) => {
    const selected = value === v;
    const neutral = isNeutralScale(habit);
    const color = neutral ? NEUTRAL_SELECTED : habitColor(habit, normalize(habit, v));
    const style = selected ? `background:${color};border-color:${color};color:${neutral ? NEUTRAL_SELECTED_TEXT : textOnScore(color)};` : '';
    const isText = label.length > 1;
    return `<button type="button" class="opt-btn${isText ? ' opt-btn--text' : ''}${selected ? ' opt-btn--selected' : ''}" style="${style}"
      data-action="${preview ? 'preview-select' : 'select'}" data-habit="${habit.id}" data-value='${JSON.stringify(v)}' aria-pressed="${selected}">${esc(label)}</button>`;
  }).join('');
}

// Schieberegler-Variante von renderHabitOptions — zeigt nie Min/Max-Beschriftung
// (siehe "Neues Feld"-Formular), nur optional den aktuellen Wert (h.sliderShowValue).
// Live-Vorschau (Wert + Farbe) läuft über den 'input'-Listener weiter unten, ohne
// Re-Render/Speichern — gespeichert wird erst bei 'change' (Loslassen).
// habitSliderValueText: zeigt die Bezeichnung statt der rohen Zahl, wenn das Feld
// eigene Bezeichnungen hat - vorher konnte der Schieberegler gar keine Bezeichnungen
// darstellen, das war eine unbeabsichtigte Lücke, keine bewusste Einschränkung.
export function sliderColor(habit, v) {
  return isNeutralScale(habit) ? NEUTRAL_SELECTED : habitColor(habit, normalize(habit, v));
}
export function habitSliderValueText(habit, v) {
  return habit.labels ? habit.labels[v - habit.min] : String(v);
}
// aria-label: der Feldname (die Zeile hat kein <label>, siehe renderRowHead) - ohne ihn
// las ein Screenreader nur "Schieberegler, 50". aria-valuetext: die Bezeichnung statt
// der rohen Zahl, bzw. "kein Wert", solange nichts eingetragen ist.
function renderHabitSlider(habit, value, { preview = false } = {}) {
  const hasValue = value !== undefined;
  const v = hasValue ? value : Math.round((habit.min + habit.max) / 2);
  const color = hasValue ? sliderColor(habit, v) : 'var(--sand)';
  const pct = ((v - habit.min) / (habit.max - habit.min)) * 100;
  // Eigene --slider-color/--slider-pct-Variablen statt der nativen accent-color: die
  // ließ sich in manchen Browsern bei jedem 'input'-Event nicht glitch-frei neu
  // einfärben (kurzer Flackerer/Farbsprung). Die Füllung wird stattdessen über einen
  // CSS-Gradient auf dem Track selbst gezeichnet (siehe .value-slider-CSS), der bei
  // jedem 'input' einfach per Custom Property aktualisiert wird.
  return `
    <div class="slider-row">
      <input type="range" class="value-slider${hasValue ? '' : ' value-slider--unset'}" data-action="${preview ? 'preview-slider' : 'value-slider'}"
        data-habit="${habit.id}" min="${habit.min}" max="${habit.max}" step="1" value="${v}"
        aria-label="${esc(habit.name)}" aria-valuetext="${esc(hasValue ? habitSliderValueText(habit, v) : t('ariaLabel.noValue'))}"
        style="--slider-color:${color};--slider-pct:${pct}%;" />
      ${habit.sliderShowValue ? `<span class="slider-value" id="slider-value-${habit.id}">${hasValue ? esc(habitSliderValueText(habit, v)) : '–'}</span>` : ''}
      ${hasValue
        ? `<button type="button" class="slider-clear" data-action="${preview ? 'preview-clear' : 'clear-value'}" data-habit="${habit.id}" aria-label="${esc(t('ariaLabel.deleteEntry'))}">×</button>`
        : '<span class="slider-clear slider-clear--placeholder" aria-hidden="true"></span>'}
    </div>
  `;
}

// Live-Vorschau im "Neues Feld"/"Feld bearbeiten"-Formular: baut ein synthetisches
// Habit-Objekt aus dem aktuellen Formular-Stand und rendert es mit denselben
// Funktionen wie die echte "Heute"-Ansicht (renderHabitOptions/renderHabitSlider) -
// dadurch sieht die Vorschau genauso aus und verhält sich genauso wie die echte Eingabe,
// ohne eigene Render-Logik zu duplizieren. Zum Ausprobieren bedienbar: der Wert lebt nur
// in f.previewValue (eigene preview-*-Aktionen, siehe setPreviewValue), nie in echten
// Daten. Ein Wert außerhalb der aktuellen Stufen (Stufenzahl geändert) gilt als leer.
export function previewHabitFromForm(f) {
  return {
    id: 'preview',
    kind: 'scale',
    name: f.name.trim() || t('habitForm.preview'),
    min: f.min,
    max: f.max,
    labels: f.labelsEnabled ? resizeLabels(f.labels, habitFormStepCount(f)) : null,
    good: f.good,
    displayStyle: f.displayStyle,
    sliderShowValue: f.sliderShowValue,
  };
}
// Solange man die Vorschau nicht selbst angetippt hat (previewValue undefined), steht der
// beste Wert drin - so sieht man gleich, dass und wie ein Wert eingefärbt wird, und beim
// Umstellen der Bewertung wandert er mit. Selbst entfernt (null) bleibt sie leer.
export function effectivePreviewValue(f) {
  const v = f.previewValue === undefined
    ? (f.good === 'low' ? f.min : f.good === 'high' ? f.max : Math.round((f.min + f.max) / 2))
    : f.previewValue;
  return Number.isInteger(v) && v >= f.min && v <= f.max ? v : undefined;
}
// Beispiele vor dem ersten Feld (Nutzer-Entscheidung 2026-10-28): wie Felder später in
// "Heute" aussehen, nur zum Anschauen - bewusst keine Vorlagen zum Antippen (siehe
// docs/onboarding.md). Nachgebaut aus denselben CSS-Bausteinen wie "Heute", aber als
// reine Bilder (keine Knöpfe), die Beschreibung darunter ist der Text für Screenreader.
export function tutorialExamplesHtml() {
  const scaleOpts = (labels, min, max, good, value) => {
    const habit = { id: 'example', kind: 'scale', min, max, labels, good };
    return Array.from({ length: max - min + 1 }, (_, i) => min + i).map((v, i) => {
      const label = labels ? labels[i] : String(v);
      const color = habitColor(habit, normalize(habit, v));
      const style = v === value ? `background:${color};border-color:${color};color:${textOnScore(color)};` : '';
      return `<span class="opt-btn${label.length > 1 ? ' opt-btn--text' : ''}${v === value ? ' opt-btn--selected' : ''}" style="${style}">${esc(label)}</span>`;
    }).join('');
  };
  const examples = [
    ['mood', `<span class="habit-options">${scaleOpts(null, 1, 5, 'high', 4)}</span>`],
    ['sport', `<span class="habit-options">${scaleOpts([t('tutorial.examples.no'), t('tutorial.examples.yes')], 1, 2, 'high', 2)}</span>`],
    ['water', '<span class="counter-controls"><span class="counter-btn">−</span><span class="counter-value">3</span><span class="counter-btn counter-btn--plus">+</span></span>'],
    ['grateful', `<span class="example-text">${t('tutorial.examples.gratefulValue')}</span>`],
  ];
  return `
    <details class="why-box field-examples">
      <summary class="why-box-title">${t('tutorial.examples.title')}</summary>
      <p>${t('tutorial.examples.intro')}</p>
      <ul class="field-examples-list">
        ${examples.map(([key, widget]) => `
          <li class="field-example">
            <div class="field-example-row" aria-hidden="true">
              <span class="field-example-name">${t(`tutorial.examples.${key}`)}</span>
              ${widget}
            </div>
            <p class="field-example-note">${t(`tutorial.examples.${key}Note`)}</p>
          </li>
        `).join('')}
      </ul>
    </details>
  `;
}
export function renderHabitFormPreview(f) {
  const previewHabit = previewHabitFromForm(f);
  const value = effectivePreviewValue(f);
  const widget = f.displayStyle === 'slider'
    ? renderHabitSlider(previewHabit, value, { preview: true })
    : `<div class="habit-options">${renderHabitOptions(previewHabit, value, { preview: true })}</div>`;
  return `
    <div class="field-preview" role="group" aria-labelledby="habit-form-preview-label" aria-describedby="habit-form-preview-note">
      ${widget}
      <p class="habit-form-lock-note field-preview-note" id="habit-form-preview-note">${t('habitForm.previewNote')}</p>
    </div>
  `;
}
// Tauscht nur die Vorschau aus (kein render(): Fokus/Cursor im Formular bleiben).
// Rückgabe: ob eine Vorschau da war.
export function refreshHabitFormPreview() {
  const preview = document.querySelector('.field-preview');
  if (!preview || !state.habitForm) return false;
  preview.outerHTML = renderHabitFormPreview(state.habitForm);
  return true;
}
// Wert in der Vorschau setzen/entfernen: nur die Vorschau austauschen (kein render(), das
// Formular bleibt, wie es ist) und den Fokus auf dasselbe Element zurückgeben.
export function setPreviewValue(value, focusSelector) {
  const f = state.habitForm;
  if (!f) return;
  f.previewValue = value;
  haptic();
  if (!refreshHabitFormPreview()) return;
  if (focusSelector) document.querySelector(`.field-preview ${focusSelector}`)?.focus({ preventScroll: true });
}

// Nicht-editierbare Info-Zeile für berechnete Felder (kind='computed') — zeigt den
// live berechneten Tageswert seiner Mitglieder, nie einen eigenen Eintrag. Aus Skalen:
// Durchschnitt als Prozent, eingefärbt; aus Zahlen: berechneter Wert mit Einheit,
// neutral (keine Bewertung).
function renderComputedInfo(habit, dateKey) {
  const members = computedMemberHabits(habit);
  if (isDurationComputed(habit)) {
    const { value } = numberComputedDay(habit, dateKey);
    const [from, to] = (habit.members || []).map((key) => state.habits.find((x) => x.id === key));
    return `
      <div class="computed-readout computed-readout--number"><span${value !== null ? goalValueStyle(habit, value) : ''}>${value !== null ? esc(formatSeriesValue(habit, value)) : '–'}</span>${hasDayGoal(habit) ? goalSuffixHtml(habit) : ''}</div>
      ${hasWeekGoal(habit) ? weekGoalTodayHtml(habit, dateKey) : ''}
      <span class="manage-meta">${t('computedInfo.durationOf', { from: from?.name || '–', to: to?.name || '–' })}</span>
    `;
  }
  if (isSinceComputed(habit)) {
    const { value } = numberComputedDay(habit, dateKey);
    return `
      <div class="computed-readout computed-readout--number">${value !== null ? esc(formatSeriesValue(habit, value)) : '–'}</div>
      <span class="manage-meta">${t(habit.since?.mode === 'start' ? 'computedInfo.sinceStart' : 'computedInfo.sinceLast', { name: members[0]?.name || '–', which: sinceWhichText(habit) })}</span>
    `;
  }
  if (isNumberComputed(habit)) {
    const { value, filled, total } = numberComputedDay(habit, dateKey);
    const unit = computedUnit(habit);
    return `
      <div class="computed-readout computed-readout--number"><span${value !== null ? goalValueStyle(habit, value) : ''}>${value !== null ? esc(formatNumber(value)) + (unit ? ' ' + esc(unit) : '') : '–'}</span>${hasDayGoal(habit) ? goalSuffixHtml(habit) : ''}</div>
      ${hasWeekGoal(habit) ? weekGoalTodayHtml(habit, dateKey) : ''}
      <span class="manage-meta">${t('computedInfo.aggOf', { agg: t('aggregate.' + habit.aggregate), names: members.map((m) => m.name).join(', '), filled, total })}</span>
    `;
  }
  const day = state.entries[dateKey] || {};
  const filledCount = members.filter((m) => day[m.id] !== undefined).length;
  const score = habitScore(habit, dateKey);
  return `
    <div class="computed-readout" style="background:${scoreColor(score)};color:${textOnScore(scoreColor(score))}">${score !== null ? Math.round(score * 100) + '%' : '–'}</div>
    <span class="manage-meta">${t('computedInfo.avgOf', { names: members.map((m) => m.name).join(', '), filled: filledCount, total: members.length })}</span>
  `;
}

// Zeilen-Menü in "Heute": ein ⋮-Button links vor jedem Feld und jeder Gruppen-Überschrift
// (einheitlich für beides - bei Gruppen öffnet ein Tipp auf die Überschrift ja schon das
// Auf-/Zuklappen). Senkrecht und schmal, damit er in Skala-Zeilen neben den Wert-Buttons
// wenig Platz kostet; ein waagerechtes ⋯ hinter jedem Namen wirkte zu unruhig. Das ist
// das einzige Bedienelement für Tastatur/Screenreader. Zusätzliche Abkürzungen für
// Zeige-Geräte: Tipp auf den Feldnamen (row-menu-name) sowie Long-Press/Rechtsklick auf
// die Zeile (siehe "Zeilen-Menü per Long-Press" weiter unten). Disclosure-Muster
// (aria-expanded + normale Buttons) statt role="menu", da letzteres eine eigene
// Pfeiltasten-Navigation verlangen würde.
// state.rowMenu / data-menu: bei Feldern deren id, bei Gruppen 'section:<id>', beim Tag
// DAY_MENU_KEY (siehe renderDayMenuPanel).
export function renderRowMenuButton(key, label) {
  const open = state.rowMenu === key;
  return `<button type="button" class="row-menu-btn row-menu-trigger" data-action="row-menu" data-menu="${key}" aria-expanded="${open}"${open ? ` aria-controls="row-menu-${key}"` : ''} aria-label="${label}"><svg width="4" height="16" viewBox="0 0 4 16" aria-hidden="true"><circle cx="2" cy="2" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="2" cy="14" r="1.6"/></svg></button>`;
}
function renderRowHead(h, nameHtml, extra = '') {
  const open = state.rowMenu === h.id;
  return `
    <div class="row-head">
      ${renderRowMenuButton(h.id, t('today.fieldOptions', { name: h.name }))}
      <div class="row-head-text"><span class="habit-name row-menu-name${open ? ' row-menu-name--open' : ''}" data-action="row-menu" data-menu="${h.id}">${nameHtml}</span>${extra}</div>
    </div>
  `;
}
export function renderSectionMenuPanel(section) {
  const key = `section:${section.id}`;
  if (state.rowMenu !== key) return '';
  return `
    <div class="row-menu" id="row-menu-${key}" role="group" aria-label="${t('today.sectionOptions', { name: section.name })}">
      <button type="button" class="menu-item-btn" data-action="note-edit" data-note="${key}">${getNote(formatKey(state.currentDate), key) ? t('note.edit') : t('note.add')}</button>
      <button type="button" class="menu-item-btn" data-action="section-menu-edit" data-id="${section.id}">${t('common.edit')}</button>
    </div>
  `;
}
// Feldname in den Übersichten: öffnet ein kleines Menü mit "Bearbeiten" (Nutzer-Entscheidung
// 2026-10-28: Menü statt direktem Sprung, damit später z.B. "Verlauf ansehen" dazukommen kann).
// ctx macht den Schlüssel eindeutig, weil ein Feld dort mehrfach steht (Raster, Verlauf,
// Liste). Das Menü ist fixed positioniert (positionFloatingRowMenu), weil das seitlich
// scrollbare Wochenraster ein absolut positioniertes abschneiden würde. Archivierte Felder
// bleiben reiner Text - auch die Verwaltung bietet bei ihnen kein "Bearbeiten".
export function statsFieldName(h, ctx) {
  const name = esc(h.name);
  if (h.archivedAt) return `${name} <span class="manage-meta">(${t('common.archived')})</span>`;
  const key = `stats:${ctx}:${h.id}`;
  const open = state.rowMenu === key;
  const label = t('today.fieldOptions', { name: h.name });
  return `<button type="button" class="stats-name-btn row-menu-trigger" data-action="row-menu" data-menu="${key}" aria-expanded="${open}"${open ? ` aria-controls="row-menu-${key}"` : ''} aria-label="${label}">${name}</button>${open ? `
    <div class="row-menu row-menu--floating" id="row-menu-${key}" role="group" aria-label="${label}">
      <button type="button" class="menu-item-btn" data-action="row-menu-edit" data-id="${h.defId}">${t('common.edit')}</button>
    </div>` : ''}`;
}
export function positionFloatingRowMenu() {
  const menu = app.querySelector('.row-menu--floating');
  const trigger = menu && app.querySelector(`.row-menu-trigger[data-menu="${state.rowMenu}"]`);
  if (!trigger) return;
  const r = trigger.getBoundingClientRect();
  const below = r.bottom + 4;
  menu.style.top = `${below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - 4 - menu.offsetHeight) : below}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
}
// Absolut positioniert (an der Zeile verankert), seine Lage im DOM der Zeile ist egal.
function renderRowMenuPanel(h) {
  if (state.rowMenu !== h.id) return '';
  return `
    <div class="row-menu" id="row-menu-${h.id}" role="group" aria-label="${t('today.fieldOptions', { name: h.name })}">
      ${!isTextKind(h) ? `<button type="button" class="menu-item-btn" data-action="note-edit" data-note="${h.id}">${getNote(formatKey(state.currentDate), h.id) ? t('note.edit') : t('note.add')}</button>` : ''}
      <button type="button" class="menu-item-btn" data-action="row-menu-edit" data-id="${h.defId}">${t('common.edit')}</button>
      <button type="button" class="menu-item-btn menu-item-btn--warn" data-action="row-menu-archive" data-id="${h.defId}">${t('manage.archive')}</button>
    </div>
  `;
}
// Menü zum ganzen Tag (⋮ vor dem Wochentag). Hält bewusst nur Seltenes/Zerstörerisches
// wie "Tag zurücksetzen" - das stand vorher als eigener Link unter der Feldliste und
// machte das Ende von "Heute" unruhig. Die Tagesnotiz bleibt dagegen unten sichtbar.
export const DAY_MENU_KEY = 'day';
function renderDayMenuPanel() {
  if (state.rowMenu !== DAY_MENU_KEY) return '';
  return `
    <div class="row-menu day-menu" id="row-menu-${DAY_MENU_KEY}" role="group" aria-label="${t('today.dayOptions')}">
      <button type="button" class="menu-item-btn menu-item-btn--warn" data-action="reset-day-arm">${t('today.resetDay')}</button>
    </div>
  `;
}
// Nach jedem Öffnen/Schließen nötig, da render() das DOM komplett neu aufbaut und den
// Fokus dabei verwirft: beim Öffnen auf den ersten Menüpunkt, beim Schließen zurück
// auf den ⋮-Button derselben Zeile.
export function openRowMenu(key) {
  state.rowMenu = key;
  render();
  document.querySelector('.row-menu button')?.focus({ preventScroll: true });
}
export function closeRowMenu() {
  const key = state.rowMenu;
  state.rowMenu = null;
  render();
  document.querySelector(`.row-menu-trigger[data-menu="${key}"]`)?.focus({ preventScroll: true });
}

// Notiz unter einem Feld bzw. im Tagesnotiz-Bereich: entweder der offene Editor, oder
// die vorhandene Notiz als antippbarer Text (öffnet den Editor), oder nichts. key: Feld,
// Gruppe ('section:<id>') oder Tag (DAY_NOTE_KEY). Nur Text-Felder haben keine Notizen
// (wären doppelt zum Freitext, siehe renderRowMenuPanel).
export function renderNote(dateKey, key, label) {
  if (isNoteEditorOpen() && state.noteEditor.key === key) {
    return `
      <div class="note-editor">
        <textarea id="note-input" class="note-input" rows="3" maxlength="${NOTE_MAX_LENGTH}" aria-label="${label}">${esc(state.noteEditor.draft)}</textarea>
        <div class="note-editor-actions">
          <button type="button" class="habit-form-cancel" data-action="note-cancel">${t('common.cancel')}</button>
          <button type="button" class="note-save-btn" data-action="note-save">${t('common.save')}</button>
        </div>
      </div>
    `;
  }
  const text = getNote(dateKey, key);
  if (!text) return '';
  return `<button type="button" class="row-note" data-action="note-edit" data-note="${key}"><span class="visually-hidden">${t('note.editPrefix')} </span>${esc(text)}</button>`;
}

// Freies Text-Feld (kind='text'): bewusst immer offenes Textfeld statt Antippen-zum-
// Bearbeiten wie bei Notizen - wer so ein Feld anlegt, will täglich hineinschreiben.
// Gespeichert wird automatisch (siehe updateTextValue), kein Speichern-Button. Keine
// Notizen (wären doppelt zum Freitext).
// "Noch offen" in "Heute" (seit 2026-09-28): heute geplante, direkt ausfüllbare Felder
// (nicht berechnet) ohne Wert - dieselbe Logik wie die Erinnerungen (filledFieldIds,
// get_due_notifications), Notizen zählen also nicht. Markiert wird bewusst nur das
// Offene (kleiner Punkt, wie "ungelesen" in Mail-Apps), eingetragene Zeilen bleiben wie
// sie sind. Unter dem Datum "✓ Alles eingetragen", sobald alles da ist; "3 von 7" nur als
// Option (dayStatusHtml, Nutzer-Entscheidung 2026-10-14: standardmäßig aus, weil eine nicht
// volle Zahl Druck machen kann).
export function isOpenToday(h, dayEntry) { return h.kind !== 'computed' && !isCounterKind(h) && !h.optional && dayEntry[h.id] === undefined; }
function todayTrackedFields() {
  return activeHabits().filter((h) => h.kind !== 'computed' && !isCounterKind(h) && !h.optional && !isPeriodField(h) && isPlannedOn(h, state.currentDate));
}
// Punkt + Screenreader-Text; bleibt (versteckt) im DOM, damit syncTodayOpenMarkers ihn
// beim Tippen in Text-Feldern ohne Re-Render umschalten kann.
function openMarkerHtml(h, dayEntry) {
  if (h.optional) return '';
  return `<span class="open-marker" data-open-for="${h.id}"${isOpenToday(h, dayEntry) ? '' : ' hidden'}><span class="open-dot" aria-hidden="true"></span><span class="visually-hidden">${t('today.openField')}</span></span>`;
}
// Text-Felder speichern beim Tippen ohne render() (updateTextValue) - Punkt und
// Abschluss-Hinweis hier direkt nachziehen.
export function syncTodayOpenMarkers() {
  const dayEntry = state.entries[formatKey(state.currentDate)] || {};
  const dateKey = formatKey(state.currentDate);
  document.querySelectorAll('.open-marker[data-open-for]').forEach((m) => {
    const id = m.dataset.openFor;
    m.hidden = (state.entries[entryKeyFor(id, dateKey)] || {})[id] !== undefined;
  });
  document.querySelectorAll('.section-done[data-done-fields]').forEach((m) => {
    // Dieselbe Regel wie beim Zeichnen (Zähler und "darf leer bleiben" fehlen nie).
    const ids = new Set(m.dataset.doneFields.split(' ').filter(Boolean));
    m.hidden = !sectionDoneOn(state.habits.filter((h) => ids.has(h.id)), dayEntry);
  });
  const status = document.querySelector('.day-status');
  if (status) status.innerHTML = dayStatusHtml(dayEntry);
}

function renderTextBox(h, dayEntry, marker = '') {
  const value = typeof dayEntry[h.id] === 'string' ? dayEntry[h.id] : '';
  return `
    <div class="number-box text-box">
      ${renderRowHead(h, esc(h.name) + marker)}
      <textarea id="text-input-${h.id}" class="text-field-input" data-habit="${h.id}" rows="2" maxlength="${NOTE_MAX_LENGTH}" aria-label="${esc(h.name)}">${esc(value)}</textarea>
      ${renderRowMenuPanel(h)}
    </div>
  `;
}

// Nach einem Sprung aus der Auswertung zu einem bestimmten Feld (Text-Eintrag im
// Rückblick, Punkt im Zahlen-Graphen, Feld-Zelle in der Woche): nicht nur zum Tag,
// sondern auch zum Feld selbst - hinscrollen, kurz hervorheben, Fokus auf dessen ⋮-Button
// (Screenreader lesen dort "Optionen für <Name>")
// (bewusst nicht ins Textfeld: das würde die Tastatur öffnen, man will ja erst lesen).
// Archivierte Felder stehen nicht in "Heute" - dann bleibt es beim Tag.
// editInput (Sprung aus einer Erinnerung): hat das Feld ein Eingabefeld (Zahl, Text), dort
// hinein statt auf die Menü-Punkte - man will ja gleich eintragen. Ob die Tastatur dabei
// aufgeht, entscheidet der Browser (ohne Antippen oft nicht). Beim Sprung aus Woche/Monat
// bewusst nicht: dort tippt man auf eine Zelle zum Nachsehen, eine aufspringende Tastatur
// verdeckte dann die Hälfte.
export function focusTodayField(habitId, { editInput = false } = {}) {
  // Liegt das Feld in einer eingeklappten Gruppe bzw. einem eingeklappten Zeitraum-Bereich,
  // erst aufklappen.
  const target = state.habits.find((h) => h.id === habitId);
  if (isPeriodField(target) && isSectionCollapsed('today', `period-${target.period}`)) {
    expandSection('today', `period-${target.period}`);
    render();
  }
  if (target?.sectionId && document.querySelector(`[data-action="section-toggle"][data-section="${target.sectionId}"][data-scope="today"][aria-expanded="false"]`)) {
    expandSection('today', target.sectionId);
    render();
  }
  let trigger = document.querySelector(`.row-menu-trigger[data-menu="${habitId}"]`);
  // Liegt das Feld im eingeklappten "Heute nicht geplant", erst aufklappen.
  if (trigger?.closest('details.unplanned:not([open])')) {
    state.unplannedOpenFor = formatKey(state.currentDate);
    render();
    trigger = document.querySelector(`.row-menu-trigger[data-menu="${habitId}"]`);
  }
  const row = trigger?.closest('.habit-row, .number-box');
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  const input = editInput && row.querySelector(`#number-input-${habitId}, #text-input-${habitId}, #time-pick-${habitId}`);
  (input || trigger).focus({ preventScroll: true });
  row.classList.add('field-highlight');
  row.addEventListener('animationend', () => row.classList.remove('field-highlight'), { once: true });
}

function renderNumberBox(h, dateKey, dayEntry, marker = '') {
  const currentValue = dayEntry[h.id] !== undefined ? dayEntry[h.id] : '';
  const last = findLastValue(h.id, dateKey);
  const unitSuffix = h.unit ? ` ${h.unit}` : '';
  const lastNote =
    last && last.dateKey !== dateKey
      ? t('numberBox.last', { value: formatNumber(last.value) + unitSuffix, date: formatDMY(last.dateKey) })
      : '';
  // Der Name öffnet per Tipp das Zeilen-Menü (siehe renderRowHead), kann also kein
  // <label> sein (das würde zusätzlich das Eingabefeld fokussieren) - das Eingabefeld
  // bekommt seinen Namen deshalb per aria-label.
  const nameWithUnit = `${esc(h.name)}${h.unit ? ` (${esc(h.unit)})` : ''}`;
  return `
    <div class="number-box">
      ${renderRowHead(h, nameWithUnit + marker, `${lastNote ? `<span class="number-last">${lastNote}</span>` : ''}${hasWeekGoal(h) ? weekGoalTodayHtml(h, dateKey) : ''}`)}
      <input type="number" inputmode="decimal" step="any" id="number-input-${h.id}" class="number-input" data-action="number-input" data-habit="${h.id}" value="${esc(currentValue)}" aria-label="${nameWithUnit}"${currentValue === '' ? '' : goalValueStyle(h, currentValue)} />${hasDayGoal(h) ? goalSuffixHtml(h) : ''}
      ${renderNote(dateKey, h.id, noteLabel(h))}
      ${renderRowMenuPanel(h)}
    </div>
  `;
}

// Uhrzeit: ein Knopf mit der Uhrzeit ("--:--" solange leer), der die eigene Uhrzeit-Auswahl
// öffnet (openTimePicker). Liegt die Uhrzeit nach Mitternacht, steht der Wochentag dahinter
// ("0:30 · Fr."): eine 0:30 kann früh an diesem Tag oder spät in der Nacht danach meinen -
// für die Dauer macht das 24 Stunden aus.
function renderTimeBox(h, dateKey, dayEntry, marker = '') {
  const value = dayEntry[h.id];
  const has = typeof value === 'number';
  const nextDay = has && timeDayOffset(value) > 0 ? addDays(parseDateKey(dateKey), timeDayOffset(value)) : null;
  const aria = !has ? tPlain('timeBox.ariaEmpty', { name: h.name })
    : nextDay ? tPlain('timeBox.ariaNextDay', { name: h.name, time: formatClock(value), day: weekdayLong(nextDay) })
    : tPlain('timeBox.aria', { name: h.name, time: formatClock(value) });
  return `
    <div class="number-box">
      ${renderRowHead(h, esc(h.name) + marker)}
      <button type="button" class="time-pick${has ? '' : ' time-pick--empty'}" id="time-pick-${h.id}" data-action="time-pick" data-habit="${h.id}" aria-label="${esc(aria)}">${has ? esc(formatClock(value)) : '--:--'}${nextDay ? `<span class="time-pick-day"> · ${esc(weekdayShort(nextDay))}</span>` : ''}</button>
      ${has /* × wie beim Schieberegler; leer ein unsichtbarer Platzhalter, damit nichts springt */
        ? `<button type="button" class="slider-clear" data-action="clear-value" data-habit="${h.id}" aria-label="${esc(t('ariaLabel.deleteEntry'))}">×</button>`
        : '<span class="slider-clear slider-clear--placeholder" aria-hidden="true"></span>'}
      ${renderNote(dateKey, h.id, noteLabel(h))}
      ${renderRowMenuPanel(h)}
    </div>
  `;
}

// --- Uhrzeit-Auswahl ----------------------------------------------------------------
// Eigenes Fenster für Uhrzeit-Felder und Erinnerungszeiten statt der Auswahl des Geräts
// (Nutzer-Entscheidung 2026-10-30): die von Android schnitt bei großer Schrift ihren
// Bestätigen-Knopf ab, kennt kein "Jetzt" und passt nicht zur App.
// Ein <dialog> außerhalb von #app statt eines Modals im State: render() baut #app komplett
// neu, ein offenes Formular dahinter (Erinnerungszeiten) verlöre dabei seinen
// ungespeicherten Stand. showModal() sperrt die Seite dahinter, hält den Tab-Fokus im
// Fenster und meldet Escape ('cancel'); Android-Zurück über currentLayerCount/popstate.
// timePicker: { title, value (Minuten; bei Uhrzeit-Feldern ab 1440 = nach Mitternacht),
// dateKey (nur Uhrzeit-Felder), step (1 oder 15), nowAllowed, triggerId, onPick(v), onClear }.
export let timePicker = null;
const TIME_PICKER_STEPS = [5, 15, 60];
// Höchstens 23:59 am nächsten Tag. Funktion statt Konstante: MINUTES_PER_DAY (fields.js) ist beim
// Laden dieses Moduls noch nicht ausgewertet.
const timePickerMax = () => 2 * MINUTES_PER_DAY - 1;

function timePickerHtml(p) {
  const twelve = clockUses12h();
  const field = !!p.dateKey;
  const day = field ? parseDateKey(p.dateKey) : null;
  const wheel = (id, label) => `
    <div class="tp-wheel" id="${id}" role="spinbutton" tabindex="0" aria-label="${esc(label)}">
      ${'<div class="tp-item" aria-hidden="true"></div>'.repeat(WHEEL_ROWS)}
    </div>`;
  const seg = (labelId, label, buttons, hiddenLabel) => `
    <span class="settings-label tp-label${hiddenLabel ? ' visually-hidden' : ''}" id="${labelId}">${label}</span>
    <div class="pill-group seg" role="group" aria-labelledby="${labelId}">${buttons}</div>`;
  const pill = (tp, attrs, text) => `<button type="button" class="pill-toggle" data-tp="${tp}" ${attrs} aria-pressed="false">${text}</button>`;
  return `
    <h2 id="time-picker-title">${esc(p.title)}</h2>
    <div class="tp-clock">
      ${wheel('tp-hour', t('time.hour'))}
      <span class="tp-sep" aria-hidden="true">:</span>
      ${wheel('tp-minute', t('time.minute'))}
    </div>
    ${twelve ? seg('tp-ampm-label', t('time.label'), pill('ampm', 'data-pm="0"', 'AM') + pill('ampm', 'data-pm="1"', 'PM'), true) : ''}
    ${field ? `<div class="tp-quick">
      ${p.nowAllowed ? `<button type="button" class="manage-btn" data-tp="now">${t('timeBox.now')}</button>` : ''}
      ${TIME_PICKER_STEPS.map((n) => `<button type="button" class="manage-btn" data-tp="add" data-n="${n}" aria-label="${esc(tPlain('timePicker.addAria', { n }))}">${tPlain('timePicker.addLabel', { n })}</button>`).join('')}
    </div>
    ${seg('tp-day-label', t('timePicker.dayLabel'),
      pill('day', 'data-offset="0"', esc(tPlain('timePicker.sameDay', { day: weekdayLong(day) })))
      + pill('day', 'data-offset="1"', esc(tPlain('timePicker.nextDay', { day: weekdayShort(addDays(day, 1)) }))))}` : ''}
    ${p.onClear ? `<button type="button" class="manage-btn manage-btn--danger tp-clear" data-tp="clear">${t('timePicker.clear')}</button>` : ''}
    <div class="habit-form-actions">
      <button type="button" class="habit-form-cancel" data-tp="cancel">${t('common.cancel')}</button>
      <button type="button" class="auth-submit" data-tp="apply">${t('timePicker.apply')}</button>
    </div>
  `;
}

// Drehräder für Stunde und Minute (wie am iPhone, Nutzer-Entscheidung 2026-10-30): Wischen
// mit einem Finger statt Tippen, keine Tastatur, sieht auf jedem Gerät gleich aus.
// Eigene Wischsteuerung (Pointer-Events, gezeichnet per transform) statt einer scrollenden
// Liste: mit Browser-Scrollen + Einrasten war das Rad nicht endlos (eine Liste hat ein Ende),
// der Schwung je Gerät verschieden und oft viel zu weit, und die krummen Zeilenhöhen bei
// größerer Schrift verschoben die Anzeige gegen den Wert.
// Ein Rad ist eine durchgehende Zeitachse ab timePicker.value: Zeile r zeigt die Stunde bzw.
// Minute von value + r Stunden/Minuten (Erinnerungen: r * 15 Minuten). Über 59 hinaus geht so
// die Stunde weiter, über 23 hinaus der Tag. w._c = Stand des Rads in Zeilen (beim Ziehen
// krumm); steht es, wird value um die gedrehten Zeilen verschoben und w._c wieder 0.
// Für Tastatur/Screenreader ist es ein role="spinbutton" (↑ ↓, Bild ↑ ↓, Ziffern).
const WHEEL_ROWS = 8; // gezeichnete Zeilen: drei sichtbare und Vorrat zum Drehen
const wheelUnit = (w) => (w.id === 'tp-hour' ? 60 : timePicker.step);
const wheelRowHeight = (w) => w.getBoundingClientRect().height / 3;
function wheelLabel(w, v) {
  const clock = ((v % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (w.id === 'tp-minute') return String(clock % 60).padStart(2, '0');
  const h = Math.floor(clock / 60);
  return clockUses12h() ? String(h % 12 || 12) : String(h).padStart(2, '0');
}
// Erlaubte Zeilen: Uhrzeit-Felder von 0:00 dieses Tages bis 23:59 des nächsten,
// Erinnerungszeiten (ohne Tag) im Kreis.
function clampWheelRow(w, r) {
  const p = timePicker, u = wheelUnit(w);
  if (!p.dateKey) return r;
  return Math.max(Math.ceil(-p.value / u), Math.min(Math.floor((timePickerMax() - p.value) / u), r));
}
function drawWheel(w) {
  const p = timePicker, c = w._c || 0, h = wheelRowHeight(w), u = wheelUnit(w);
  const first = Math.floor(c) - 3;
  [...w.children].forEach((el, i) => {
    const r = first + i;
    el.style.transform = `translateY(${(r - c) * h}px)`;
    el.textContent = wheelLabel(w, p.value + r * u);
    el.classList.toggle('tp-item--on', Math.abs(r - c) < 0.5);
  });
  w.setAttribute('aria-valuetext', wheelLabel(w, p.value + Math.round(c) * u));
}
// Rad steht auf Zeile r: Uhrzeit um r Zeilen verschieben, Rad zurück auf 0.
function commitWheel(w, r) {
  const p = timePicker;
  if (!p) return;
  const v = p.value + Math.round(r) * wheelUnit(w);
  p.value = p.dateKey ? Math.max(0, Math.min(timePickerMax(), v)) : ((v % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  w._c = 0;
  syncTimePicker();
}
// Rad auf Zeile target drehen, danach übernehmen. Mehrere Anstöße hintereinander (Mausrad,
// zweimal "+15") laufen in einer Bewegung weiter.
function animateWheel(w, target, ms) {
  cancelAnimationFrame(w._anim);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) ms = 0;
  const from = w._c || 0, t0 = performance.now();
  w._target = target;
  const step = (now) => {
    const k = ms ? Math.min(1, (now - t0) / ms) : 1;
    w._c = from + (target - from) * (1 - Math.pow(1 - k, 3));
    drawWheel(w);
    if (k < 1) { w._anim = requestAnimationFrame(step); return; }
    w._anim = null;
    w._target = null;
    commitWheel(w, target);
  };
  w._anim = requestAnimationFrame(step);
}
// Wohin das Rad gerade will (läuft eine Drehung, ihr Ziel).
const wheelAim = (w) => (w._target ?? Math.round(w._c || 0));
// Laufende Drehung sofort zu Ende bringen (vor "Übernehmen", "Jetzt" usw.).
function finishWheel(w) {
  if (w._anim == null) return;
  cancelAnimationFrame(w._anim);
  w._anim = null;
  const target = w._target;
  w._target = null;
  commitWheel(w, target);
}

function attachWheel(w) {
  let drag = null;
  w.addEventListener('pointerdown', (e) => {
    cancelAnimationFrame(w._anim); // ins drehende Rad greifen hält es an
    w._anim = null;
    w._target = null;
    w.setPointerCapture(e.pointerId);
    drag = { y0: e.clientY, c0: w._c || 0, moved: false, samples: [[e.timeStamp, e.clientY]] };
  });
  w.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y0;
    if (Math.abs(dy) > 4) drag.moved = true;
    // Über das Ende (0:00 / 23:59 am nächsten Tag) hinaus nur ein Stück, dann federt es zurück.
    const c = drag.c0 - dy / wheelRowHeight(w);
    w._c = Math.max(clampWheelRow(w, -1e6) - 0.4, Math.min(clampWheelRow(w, 1e6) + 0.4, c));
    drawWheel(w);
    drag.samples.push([e.timeStamp, e.clientY]);
    if (drag.samples.length > 6) drag.samples.shift();
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const h = wheelRowHeight(w), c = w._c || 0;
    if (!d.moved) { // Tipp auf eine blasse Nachbarzahl: dorthin drehen
      const rect = w.getBoundingClientRect();
      const r = Math.round((e.clientY - (rect.top + rect.height / 2)) / h);
      animateWheel(w, clampWheelRow(w, Math.round(c) + r), 220);
      return;
    }
    // Schwung aus den letzten ~100 ms, gebremst und gedeckelt: ein schneller Wisch dreht
    // höchstens ein paar Dutzend Zeilen weiter, nicht ins Unendliche.
    const recent = d.samples.filter(([t]) => e.timeStamp - t < 100);
    const [t1, y1] = recent[0] || [e.timeStamp, e.clientY];
    const velocity = (e.clientY - y1) / Math.max(16, e.timeStamp - t1) / h; // Zeilen pro ms
    const fling = Math.max(-20, Math.min(20, -velocity * 180));
    const target = clampWheelRow(w, Math.round(c + fling));
    animateWheel(w, target, Math.min(800, 160 + Math.abs(target - c) * 35));
  };
  w.addEventListener('pointerup', end);
  w.addEventListener('pointercancel', end);
  // Mausrad / Touchpad: je Raste eine Zeile.
  let wheelAcc = 0;
  w.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheelAcc += e.deltaMode === 0 ? e.deltaY / 40 : e.deltaY;
    const rows = Math.trunc(wheelAcc);
    if (!rows) return;
    wheelAcc -= rows;
    animateWheel(w, clampWheelRow(w, wheelAim(w) + rows), 140);
  }, { passive: false });
}

// Schreibt timePicker.value in Räder und Knöpfe.
function syncTimePicker() {
  const p = timePicker;
  const dlg = document.getElementById('time-picker');
  if (!p || !dlg) return;
  dlg.querySelectorAll('.tp-wheel').forEach((w) => { if (w._anim == null) drawWheel(w); });
  const h = Math.floor((p.value % MINUTES_PER_DAY) / 60);
  const press = (sel, on) => dlg.querySelectorAll(sel).forEach((b) => {
    const active = on(b);
    b.classList.toggle('pill-toggle--active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  press('[data-tp="ampm"]', (b) => (b.dataset.pm === '1') === (h >= 12));
  press('[data-tp="day"]', (b) => Number(b.dataset.offset) === timeDayOffset(p.value));
}
const finishWheels = () => document.querySelectorAll('#time-picker .tp-wheel').forEach(finishWheel);

export function openTimePicker(p) {
  if (timePicker) return;
  timePicker = { ...p };
  const dlg = document.createElement('dialog');
  dlg.id = 'time-picker';
  dlg.className = 'time-picker';
  dlg.setAttribute('aria-labelledby', 'time-picker-title');
  dlg.innerHTML = timePickerHtml(timePicker);
  document.body.appendChild(dlg);
  dlg.addEventListener('click', onTimePickerClick);
  dlg.querySelectorAll('.tp-wheel').forEach(attachWheel);
  let typed = '', typedAt = 0;
  dlg.addEventListener('keydown', (e) => {
    const w = e.target.closest('.tp-wheel');
    if (!w) return;
    const rows = { ArrowUp: 1, ArrowDown: -1, PageUp: 5, PageDown: -5 }[e.key];
    if (rows) { e.preventDefault(); animateWheel(w, clampWheelRow(w, wheelAim(w) + rows), 120); return; }
    if (e.key === 'Enter') { e.preventDefault(); applyTimePicker(); return; }
    if (!/^\d$/.test(e.key)) return;
    // Ziffern tippen (am PC): "2", "3" = 23; nach einer Sekunde Pause beginnt es neu. Setzt nur
    // die Stunde bzw. Minute, der Tag bleibt.
    e.preventDefault();
    finishWheels();
    typed = Date.now() - typedAt < 1000 ? (typed + e.key).slice(-2) : e.key;
    typedAt = Date.now();
    const v = Number(typed);
    const clock = timePicker.value % MINUTES_PER_DAY, base = timePicker.value - clock;
    if (w.id === 'tp-hour') {
      const hh = clockUses12h() ? (v >= 1 && v <= 12 ? (v % 12) + (clock >= 720 ? 12 : 0) : null) : (v <= 23 ? v : null);
      if (hh !== null) timePicker.value = base + hh * 60 + (clock % 60);
    } else if (v <= 59 && v % timePicker.step === 0) timePicker.value = base + clock - (clock % 60) + v;
    syncTimePicker();
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeTimePicker(); });
  dlg.showModal();
  syncTimePicker(); // erst nach showModal: vorher haben die Räder keine Höhe
  dlg.querySelector('[data-tp="cancel"]').focus(); // wie alle Dialoge: Anfangsfokus auf "Abbrechen"
  syncLayerHistory();
}

function onTimePickerClick(e) {
  const p = timePicker;
  const btn = e.target.closest('[data-tp]');
  if (!p || !btn) return;
  const tp = btn.dataset.tp;
  if (tp === 'cancel') { closeTimePicker(); return; }
  if (tp === 'apply') { applyTimePicker(); return; }
  if (tp === 'clear') {
    closeTimePicker({ focus: false });
    p.onClear();
    document.getElementById(p.triggerId)?.focus({ preventScroll: true });
    return;
  }
  if (tp === 'add') { // +5/+15 dreht die Minuten, +60 die Stunde
    const n = Number(btn.dataset.n);
    const w = document.getElementById(n % 60 === 0 ? 'tp-hour' : 'tp-minute');
    animateWheel(w, clampWheelRow(w, wheelAim(w) + n / wheelUnit(w)), 320);
    return;
  }
  finishWheels();
  const clock = p.value % MINUTES_PER_DAY;
  const base = timeDayOffset(p.value) * MINUTES_PER_DAY;
  if (tp === 'now') p.value = timeValueOn(p.dateKey, new Date());
  else if (tp === 'day') p.value = Number(btn.dataset.offset) * MINUTES_PER_DAY + clock;
  else if (tp === 'ampm') p.value = base + (clock % 720) + (btn.dataset.pm === '1' ? 720 : 0);
  syncTimePicker();
}

function applyTimePicker() {
  const p = timePicker;
  if (!p) return;
  finishWheels(); // ein noch drehendes Rad zählt mit seinem Ziel
  const value = p.value;
  closeTimePicker({ focus: false });
  p.onPick(value);
  document.getElementById(p.triggerId)?.focus({ preventScroll: true });
}

// viaPopstate: Android-Zurück hat den History-Eintrag schon verbraucht.
export function closeTimePicker({ viaPopstate = false, focus = true } = {}) {
  const p = timePicker;
  if (!p) return;
  timePicker = null;
  const dlg = document.getElementById('time-picker');
  if (dlg) { if (dlg.open) dlg.close(); dlg.remove(); }
  if (!viaPopstate) syncLayerHistory();
  if (focus) document.getElementById(p.triggerId)?.focus({ preventScroll: true });
}

// Eine Feld-Zeile in "Heute" - gemeinsam für geplante Felder und den eingeklappten
// Bereich "Heute nicht geplant" (dort ohne "noch offen"-Markierung, trackOpen=false:
// nicht geplante Felder fehlen nicht).
// Zähler: Zahl groß, daneben "−" und "+" (Korrigieren statt Rückgängig-Meldung, Nutzer-
// Entscheidung 2026-10-11). Ohne Antippen steht 0.
function renderCounterBox(h, dateKey, dayEntry) {
  const value = dayEntry[h.id] ?? 0;
  const nameWithUnit = `${esc(h.name)}${h.unit ? ` (${esc(h.unit)})` : ''}`;
  const step = formatNumber(h.step);
  const goal = hasDayGoal(h);
  return `
    <div class="habit-row habit-row--counter">
      ${renderRowHead(h, nameWithUnit, hasWeekGoal(h) ? weekGoalTodayHtml(h, dateKey) : '')}
      <div class="counter-controls" role="group" aria-label="${esc(h.name)}">
        <button type="button" class="counter-btn" data-action="counter-step" data-habit="${h.id}" data-dir="-1" ${value <= 0 ? 'disabled' : ''} aria-label="${esc(tPlain('counter.less', { step }))}">−</button>
        <span class="counter-value${goal ? ' counter-value--goal' : ''}" aria-live="polite"><span${goalValueStyle(h, value)}>${esc(formatNumber(value))}</span>${goal ? goalSuffixHtml(h) : ''}</span>
        <button type="button" class="counter-btn counter-btn--plus" data-action="counter-step" data-habit="${h.id}" data-dir="1" aria-label="${esc(tPlain('counter.more', { step }))}">+</button>
      </div>
      ${renderNote(dateKey, h.id, noteLabel(h))}
      ${renderRowMenuPanel(h)}
    </div>
  `;
}

export function renderTodayHabitRow(h, dateKey, dayEntry, { trackOpen = false } = {}) {
  const marker = trackOpen && h.kind !== 'computed' ? openMarkerHtml(h, dayEntry) : '';
  if (isCounterKind(h)) return renderCounterBox(h, dateKey, dayEntry);
  if (isNumberKind(h)) return renderNumberBox(h, dateKey, dayEntry, marker);
  if (isTextKind(h)) return renderTextBox(h, dayEntry, marker);
  if (isTimeKind(h)) return renderTimeBox(h, dateKey, dayEntry, marker);
  if (isMultiKind(h)) return renderMultiRow(h, dateKey, dayEntry, marker);
  if (h.kind === 'computed') return `
    <div class="habit-row habit-row--computed">
      ${renderRowHead(h, esc(h.name))}
      ${renderComputedInfo(h, dateKey)}
      ${renderNote(dateKey, h.id, noteLabel(h))}
      ${renderRowMenuPanel(h)}
    </div>
  `;
  if (h.displayStyle === 'slider') return `
    <div class="habit-row habit-row--slider">
      ${renderRowHead(h, esc(h.name) + marker)}
      ${renderHabitSlider(h, dayEntry[h.id])}
      ${renderNote(dateKey, h.id, noteLabel(h))}
      ${renderRowMenuPanel(h)}
    </div>
  `;
  return `
    <div class="habit-row habit-row--buttons">
      ${renderRowHead(h, esc(h.name) + marker)}
      <div class="habit-options" role="group" aria-label="${esc(h.name)}">${renderHabitOptions(h, dayEntry[h.id])}</div>
      ${renderNote(dateKey, h.id, noteLabel(h))}
      ${renderRowMenuPanel(h)}
    </div>
  `;
}

// Mehrfachauswahl: jede Option ein Knopf zum An-/Abwählen, dahinter "nichts davon" (= eingetragen,
// aber keine Option). Gewählt in der neutralen Auswahl-Farbe - es gibt keine Bewertung.
function renderMultiRow(h, dateKey, dayEntry, marker) {
  const value = Array.isArray(dayEntry[h.id]) ? dayEntry[h.id] : null;
  const shown = (h.options || []).filter((o) => !o.hidden || value?.includes(o.id));
  const pill = (action, attrs, label, selected, extraClass = '') => `<button type="button" class="opt-btn opt-btn--text${extraClass}${selected ? ' opt-btn--selected' : ''}"${selected ? ` style="background:${NEUTRAL_SELECTED};border-color:${NEUTRAL_SELECTED};color:${NEUTRAL_SELECTED_TEXT};"` : ''} data-action="${action}" data-habit="${h.id}"${attrs} aria-pressed="${selected}">${label}</button>`;
  return `
    <div class="habit-row habit-row--buttons habit-row--multi">
      ${renderRowHead(h, esc(h.name) + marker)}
      <div class="habit-options" role="group" aria-label="${esc(h.name)}">
        ${shown.map((o) => pill('multi-toggle', ` data-option="${esc(o.id)}"`, esc(o.label), !!value?.includes(o.id))).join('')}
        ${pill('multi-none', '', t('today.multiNone'), value?.length === 0, ' opt-btn--none')}
      </div>
      ${renderNote(dateKey, h.id, noteLabel(h))}
      ${renderRowMenuPanel(h)}
    </div>
  `;
}

function noteLabel(h) {
  return t('note.labelField', { name: h.name });
}
// Notiz zum ganzen Tag, unabhängig von einem Feld. Ohne Notiz nur ein dezenter
// Platzhalter-Button, mit Notiz deren Text (wie bei den Feld-Notizen antippbar).
function renderDayNote(dateKey) {
  const note = renderNote(dateKey, DAY_NOTE_KEY, t('note.labelDay'));
  return `
    <div class="day-note">
      ${note
        ? `<h2 class="day-note-title">${t('note.labelDay')}</h2>${note}`
        : `<button type="button" class="day-note-add" data-action="note-edit" data-note="${DAY_NOTE_KEY}">${t('note.addDay')}</button>`}
    </div>
  `;
}

// Einmalige Karte(n) oben in "Heute" direkt nach dem Einrichten eines neuen Kontos (nicht
// für Bestandsnutzer): Kurz und knapp eine Karte, Schritt für Schritt drei nacheinander.
// Erklärungen gehören dorthin, wo man sie braucht - vorher standen sie nur in "Über Logbuch".
function isTodayIntroPending() {
  try { return localStorage.getItem('todayIntroPending') === 'true'; } catch { return false; }
}
export function setTodayIntroPending(on) {
  try { if (on) localStorage.setItem('todayIntroPending', 'true'); else localStorage.removeItem('todayIntroPending'); } catch { /* dann eben ohne Karte */ }
}
function renderTodayIntro() {
  if (!isTodayIntroPending() || !activeHabits().length) return '';
  const cards = isGuided() ? ['enter', 'days', 'menu'] : ['enter'];
  const i = Math.min(state.todayIntroStep || 0, cards.length - 1);
  const last = i === cards.length - 1;
  return `
    <div class="today-intro" role="region" aria-label="${esc(t('todayIntro.label'))}">
      <p>${{ enter: icon('usage'), days: icon('calendar') }[cards[i]] ?? ''}${t(`todayIntro.${cards[i]}`)}</p>
      <div class="today-intro-actions">
        ${cards.length > 1 ? `<span class="today-intro-count">${i + 1}/${cards.length}</span>` : ''}
        <button type="button" class="push-toggle" data-action="today-intro-next">${t(last ? 'todayIntro.done' : 'common.next')}</button>
      </div>
    </div>
  `;
}

// Bereich "Diese Woche" / "Dieser Monat" / "Dieses Jahr" unten in "Heute" - nur, wenn es
// Felder dieses Zeitraums gibt. Optik wie eine Gruppe (getönter Block, einklappbar von Hand,
// Zustand pro Gerät); zählt nicht für "alles eingetragen". Blättert man zu einem anderen
// Tag, zeigt er dessen Zeitraum.
export function periodRangeLabel(period, date) {
  const start = periodStart(period, date);
  return period === 'week'
    ? dtf({ day: 'numeric', month: 'short' }).formatRange(start, periodEnd(period, date))
    : period === 'month' ? dtf({ month: 'long', year: 'numeric' }).format(start) : String(start.getFullYear());
}
function periodBlockTitle(period, date) {
  const current = formatKey(periodStart(period, date)) === formatKey(periodStart(period, new Date()));
  return { title: t(`period.${period}.${current ? 'current' : 'other'}`), range: periodRangeLabel(period, date) };
}
function renderPeriodBlock(period, fields) {
  if (!fields.length) return '';
  const id = `period-${period}`;
  const anchorKey = formatKey(periodStart(period, state.currentDate));
  const entry = state.entries[anchorKey] || {};
  const collapsed = isSectionCollapsed('today', id);
  const hasOpen = fields.some((h) => isOpenToday(h, entry));
  const { title, range } = periodBlockTitle(period, state.currentDate);
  return `
    <div class="section-block section-block--today period-block${collapsed ? ' section-block--collapsed' : ''}">
      <div class="section-head">
        <button type="button" class="section-toggle section-toggle--today" data-action="section-toggle" data-section="${id}" data-scope="today" aria-expanded="${!collapsed}">
          <svg class="section-chevron" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>${esc(title)}<span class="period-range"> · ${esc(range)}</span>${collapsed && hasOpen ? `<span class="open-dot" aria-hidden="true"></span><span class="visually-hidden">${t('today.sectionHasOpen')}</span>` : ''}</span>
        </button>
      </div>
      ${collapsed ? '' : `<div class="section-content">${fields.map((h) => renderTodayHabitRow(h, anchorKey, entry, { trackOpen: true })).join('')}</div>`}
    </div>
  `;
}

// Tageskopf von "Heute" (Wochentag, Datum, Pfeile, Stand des Tages) - steht im angehefteten
// Kopf (renderApp), damit man beim Scrollen immer sieht, welchen Tag man gerade ausfüllt
// (nach Wischen/Sprung trug man sonst leicht unbemerkt in "gestern" ein).
// Das Datum ist zugleich die Datumsauswahl des Geräts: ein unsichtbares <input type="date">
// liegt darüber, so öffnet ein Tipp darauf auf jedem Handy den eigenen Kalender, ohne
// eigenen Nachbau. Am PC öffnet ein Klick ihn per showPicker() (sonst nur Tastatur-Eingabe).
export function renderTodayDayNav() {
  const dateKey = formatKey(state.currentDate);
  const dayEntry = state.entries[dateKey] || {};
  // "Heute"/"Gestern"/"Morgen" neben dem Datum - zwei Tage sehen in "Heute" oft fast gleich
  // aus, so sieht man auf einen Blick, welcher gerade gezeigt wird.
  const dayOffset = Math.round((startOfDay(state.currentDate) - startOfDay(new Date())) / 86400000);
  const relativeDay = { 0: t('day.today'), [-1]: t('day.yesterday') }[dayOffset] || '';
  return `
    <div class="day-nav">
      <button type="button" class="nav-btn" data-action="nav-day" data-dir="-1" aria-label="${esc(t('ariaLabel.prevDay'))}">‹</button>
      <div class="day-label">
        <span class="day-weekday">${renderRowMenuButton(DAY_MENU_KEY, t('today.dayOptions'))}${weekdayLong(state.currentDate)}</span>
        <span class="day-date day-date-pick">${relativeDay ? `<span class="day-relative">${relativeDay}</span> · ` : ''}${longDate(state.currentDate)}<input type="date" id="day-date-input" class="day-date-input" data-action="pick-date" value="${dateKey}" max="${formatKey(new Date())}" aria-label="${esc(t('today.pickDate'))}" /></span>
        <span class="day-status">${dayStatusHtml(dayEntry)}</span>
      </div>
      <button type="button" class="nav-btn" data-action="nav-day" data-dir="1" aria-label="${esc(t('ariaLabel.nextDay'))}"${nextPeriodDisabled('today')}>›</button>
      ${renderDayMenuPanel()}
    </div>
  `;
}
// Stand des Tages unter dem Datum: "✓ Alles eingetragen", mit der Option dayProgress auch
// vorher "3 von 7 eingetragen". Die Zeile ist immer da (leer, wenn nichts anzuzeigen ist),
// damit der Kopf nicht springt, sobald das letzte Feld ausgefüllt wird.
function dayStatusHtml(dayEntry) {
  const tracked = todayTrackedFields();
  if (!tracked.length) return '';
  const done = tracked.filter((h) => !isOpenToday(h, dayEntry)).length;
  if (done === tracked.length) return `<span class="day-status-done"><span aria-hidden="true">✓ </span>${t('today.statusDone')}</span>`;
  return isDayProgressShown() ? esc(tPlain('today.statusProgress', { done, total: tracked.length })) : '';
}

export function renderToday() {
  const dateKey = formatKey(state.currentDate);
  const isToday = dateKey === formatKey(new Date());
  const dayEntry = state.entries[dateKey] || {};
  // Felder, die heute laut Wiederholung nicht dran sind, stehen eingeklappt unter
  // "Heute nicht geplant" - ausnahmsweise eintragen geht so trotzdem. Die Einteilung
  // richtet sich nur nach dem Plan, nicht nach vorhandenen Werten (sonst spränge ein
  // Feld beim ersten Antippen aus dem Bereich heraus); stattdessen ist der Bereich
  // automatisch offen, sobald dort an diesem Tag etwas eingetragen ist.
  const allActive = activeHabits();
  const habits = allActive.filter((h) => !isPeriodField(h));
  const planned = habits.filter((h) => isPlannedOn(h, state.currentDate));
  const unplanned = habits.filter((h) => !isPlannedOn(h, state.currentDate));
  const unplannedOpen = state.unplannedOpenFor === dateKey
    || unplanned.some((h) => dayEntry[h.id] !== undefined || getNote(dateKey, h.id));
  const renderTodayRow = (h) => renderTodayHabitRow(h, dateKey, dayEntry);
  const renderPlannedRow = (h) => renderTodayHabitRow(h, dateKey, dayEntry, { trackOpen: true });

  return `
    ${!isToday ? `<button type="button" class="today-jump" data-action="jump-today">${t('today.jumpToday')}</button>` : ''}
    ${renderTodayIntro()}
    <div class="habit-list">
      ${renderBySection(planned, 'today', (list) => list.map(renderPlannedRow).join(''))}
      ${!allActive.length ? `
        <div class="today-empty-pkg">
          <p class="manage-meta">${t('pkg.todayEmpty')}</p>
          <button type="button" class="manage-new-btn" data-action="today-starter-package">${t('pkg.todayOpen')}</button>
        </div>` : habits.length && !planned.length ? `<p class="manage-meta">${t('today.nothingPlanned')}</p>` : ''}
    </div>
    ${unplanned.length ? `
      <details class="unplanned"${unplannedOpen ? ' open' : ''}>
        <summary>${t('today.unplanned', { count: unplanned.length })}</summary>
        <div class="habit-list">${unplanned.map(renderTodayRow).join('')}</div>
      </details>
    ` : ''}
    ${PERIODS.map((period) => renderPeriodBlock(period, allActive.filter((h) => h.period === period))).join('')}
    ${renderDayNote(dateKey)}
    <div class="today-footer">
      <button type="button" class="manage-new-btn manage-new-btn--secondary" data-action="today-new-field">${icon('newField')}${t('habitForm.title.newField')}</button>
    </div>
  `;
}

// Noch gar nichts eingetragen (z.B. direkt nach dem Onboarding): statt leerer grauer
// Kästchen ein Satz, was hier bald zu sehen ist - sonst wirkt die Auswertung kaputt.
export function hasAnyEntries() {
  return Object.values(state.entries).some((day) => dayHasValues(day));
}
export function renderStatsEmpty() {
  return `<div class="stats-empty">${icon('stats')}${t('stats.empty')}</div>`;
}
// "Was bedeuten Farben und Zahlen?" - dauerhaft, zugeklappt, unter Woche/Monat/Jahr/Gesamt
// (kind 'week' oder 'stats'). Klein gehalten; die große Überarbeitung der Auswertung ist ein
// eigenes Thema.
export function renderStatsLegend(kind) {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((v) => `${scoreColor(v)} ${v * 100}%`).join(', ');
  return `
    <details class="why-box stats-legend">
      <summary class="why-box-title">${t('stats.legend.title')}</summary>
      <div class="stats-legend-scale" aria-hidden="true">
        <span>${t('stats.legend.bad')}</span>
        <span class="stats-legend-bar" style="background: linear-gradient(to right, ${stops})"></span>
        <span>${t('stats.legend.good')}</span>
      </div>
      <p>${t(kind === 'week' ? 'stats.legend.week' : 'stats.legend.stats')}</p>
      <p>${t('stats.legend.common')}</p>
    </details>
  `;
}
