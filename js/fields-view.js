import { MAX_REMINDER_TIMES, MULTI_MAX_OPTIONS, computedMemberHabits, formatClock, isDurationComputed, isNumberComputed, isSinceComputed, isTimeKind, layoutBlocks, multiOptionUsed, sinceSourceCandidate, sinceUsesStages } from './fields.js?v=8aaa0e5b67';
import { PERIODS, isNeutralScale, isPeriodField, minutesToTimeStr, reminderTimeInputHtml, scheduleSummary, weekdayOrder } from './dates.js?v=8aaa0e5b67';
import { state } from './state.js?v=8aaa0e5b67';
import { esc, habitHasData } from './navigation.js?v=8aaa0e5b67';
import { t, tPlain } from './i18n.js?v=8aaa0e5b67';
import { infoTip, mondayFirstWeekdayShortNames, weekdayLong } from './format.js?v=8aaa0e5b67';
import { stepperInput } from './notices.js?v=8aaa0e5b67';
import { CHOICE_STEP_CAP, canConvertToCounter, goalControlHtml, habitFormStepCap, habitFormStepCount, habitFormStepValue, habitFormSummable, isOptionalAllowed, lockedChoiceBlocked, numberGoalAllowed, numberGoalField, periodReminderControl, resizeLabels } from './field-form.js?v=8aaa0e5b67';
import { fieldMoveStep, stepEditHtml, typeEditHtml, valueAsText } from './type-change.js?v=8aaa0e5b67';
import { renderSectionForm } from './section-form.js?v=8aaa0e5b67';
import { SECTION_NOTE_PREFIX, keyHasNotes } from './save.js?v=8aaa0e5b67';
import { renderHabitFormPreview, tutorialExamplesHtml } from './row-view.js?v=8aaa0e5b67';
import { renderStarterPackage, renderTemplateConfirm, renderTemplatePicker } from './templates.js?v=8aaa0e5b67';
import { whyBox } from './tutorial.js?v=8aaa0e5b67';
import { icon } from './main-view.js?v=8aaa0e5b67';

// --- Rendering: Felder-Verwaltung -------------------------------------------
// Titel des Formulars - in der Verwaltung steht er im Seitenkopf (titleInHeader),
// im Tutorial als eigene Überschrift im Formular.
export function habitFormTitleKey(f) {
  return f.defId ? 'habitForm.title.editField' : 'habitForm.title.newField';
}
export function renderHabitForm({ titleInHeader = false } = {}) {
  const f = state.habitForm;
  if (f.template?.stage === 'package') return renderStarterPackage(f);
  if (f.template?.stage === 'pick') return renderTemplatePicker(f);
  if (f.template?.stage === 'confirm') return renderTemplateConfirm(f);
  const goalField = goalControlHtml(f);
  // Selten Gebrauchtes je Abschnitt zugeklappt unter "Mehr: …" (Nutzer-Entscheidung 2026-10-30:
  // das Formular war für Neulinge zu unübersichtlich). Offen, sobald dort etwas vom Standard
  // abweicht; offen/zu übersteht Re-Renders (f.partMore, gesetzt vom toggle-Listener).
  const partMore = (key, names, nonDefault, body) => (body.trim() ? `
    <details class="part-more" data-more="${key}" ${(f.partMore?.[key] ?? nonDefault) ? 'open' : ''}>
      <summary>${t('habitForm.partMore', { what: names.map((n) => tPlain('habitForm.partMore.' + n)).join(', ') })}</summary>
      ${body}
    </details>
  ` : '');

  // Ein gesperrtes Feld mit mehr Stufen als CHOICE_STEP_CAP kann seine Stufenzahl nicht
  // mehr verkleinern - Buttons/Bezeichnungen sind dann direkt hier gesperrt (mit
  // Erklärung), statt erst beim Speichern mit einer Fehlermeldung abzulehnen.
  const stepCount = habitFormStepCount(f);
  const buttonsBlocked = f.kind === 'scale' && lockedChoiceBlocked(f, 'buttons', f.labelsEnabled);
  const labelsBlocked = f.kind === 'scale' && lockedChoiceBlocked(f, f.displayStyle, true);
  const lockedCapNote = `<p class="habit-form-lock-note">${t('habitForm.lockedStepCap', { steps: stepCount, cap: CHOICE_STEP_CAP })}</p>`;
  // Am Deckel für gezielt wählbare Stufen: sagen, wie es weitergeht (Schieberegler ohne
  // Bezeichnungen), statt das Hochzählen stumm enden zu lassen.
  const atChoiceCap = !f.locked && habitFormStepCap(f) === CHOICE_STEP_CAP && stepCount >= CHOICE_STEP_CAP;
  const currentLabels = resizeLabels(f.labels, stepCount);

  const scaleBody = `
    <div class="auth-field">
      <label for="habit-form-steps">${t('habitForm.numberOfSteps')}${infoTip(t('habitForm.stepsExplain') + (f.displayStyle === 'slider' ? ' ' + t('habitForm.sliderRangeExplain') : ''))}</label>
      ${f.locked
        ? stepEditHtml(f)
        : stepperInput('habit-form-steps', stepCount, 2, habitFormStepCap(f), false, 'data-action="habit-range-change"')}
      ${atChoiceCap ? `
        <p class="habit-form-lock-note">${t('habitForm.stepCapHint', { cap: CHOICE_STEP_CAP })}</p>
        <button type="button" class="link-btn tip-link" data-action="habit-steps-to-slider">${t(f.displayStyle === 'buttons' ? 'habitForm.stepCapToSlider' : 'habitForm.stepCapLabelsOff')}</button>
      ` : ''}
    </div>
    <div class="auth-field">
      <label class="checkbox-field">
        <input type="checkbox" id="habit-form-labels-toggle" data-action="habit-labels-toggle" ${f.labelsEnabled ? 'checked' : ''} ${labelsBlocked ? 'disabled' : ''} />
        ${t('habitForm.ownLabels')}
      </label>
      ${labelsBlocked && !buttonsBlocked ? lockedCapNote : ''}
    </div>
    ${f.labelsEnabled ? `
      <div class="auth-field">
        <div class="label-inputs">
          ${currentLabels.map((l, i) => `
            <div class="label-input-row">
              <span class="label-input-step" aria-hidden="true">${habitFormStepValue(f, i)}</span>
              <input type="text" data-label-index="${i}" value="${esc(l)}" maxlength="20" aria-label="${esc(t('habitForm.labelForStep', { step: habitFormStepValue(f, i) }))}" />
            </div>`).join('')}
        </div>
        ${f.locked ? `<p class="habit-form-lock-note">${t('habitForm.labelsLockedWarn')}</p>` : ''}
      </div>
    ` : ''}
    <div class="auth-field">
      <label id="habit-form-preview-label">${t('habitForm.preview')}</label>
      ${renderHabitFormPreview(f)}
    </div>
    <div class="auth-field">
      <label id="habit-form-good-label">${t('habitForm.goalDirection')}${infoTip(t('habitForm.goalDirectionExplain'))}</label>
      <div class="pill-group seg seg--stack" role="group" aria-labelledby="habit-form-good-label">
        <button type="button" class="pill-toggle${f.good === 'high' ? ' pill-toggle--active' : ''}" data-action="habit-good" data-good="high">${t('habitForm.highIsGood')}</button>
        <button type="button" class="pill-toggle${f.good === 'low' ? ' pill-toggle--active' : ''}" data-action="habit-good" data-good="low">${t('habitForm.lowIsGood')}</button>
        <button type="button" class="pill-toggle${!f.good ? ' pill-toggle--active' : ''}" data-action="habit-good" data-good="">${t('habitForm.noValuation')}</button>
      </div>
      ${f.locked && f.good !== (state.habits.find((h) => h.defId === f.defId)?.good ?? null) ? `<p class="habit-form-lock-note" role="status">${t('habitForm.goodChangedWarn')}</p>` : ''}
    </div>
    ${partMore('entry', ['slider', ...(!f.locked && !f.labelsEnabled ? ['numbers'] : [])], f.displayStyle === 'slider' || (f.min === 0 && !f.labelsEnabled) || buttonsBlocked, `
      <div class="auth-field">
        <label id="habit-form-display-label">${t('habitForm.display')}${f.locked ? infoTip(t('habitForm.displayLockedExplain')) : ''}</label>
        <div class="pill-group seg" role="group" aria-labelledby="habit-form-display-label">
          <button type="button" class="pill-toggle${f.displayStyle === 'buttons' ? ' pill-toggle--active' : ''}" data-action="habit-display-style" data-style="buttons" ${buttonsBlocked ? 'disabled' : ''}>${t('habitForm.buttons')}</button>
          <button type="button" class="pill-toggle${f.displayStyle === 'slider' ? ' pill-toggle--active' : ''}" data-action="habit-display-style" data-style="slider">${t('habitForm.slider')}</button>
        </div>
        ${buttonsBlocked ? lockedCapNote : ''}
      </div>
      ${f.displayStyle === 'slider' ? `
        <div class="auth-field">
          <label class="checkbox-field">
            <input type="checkbox" id="habit-form-slider-show-value" data-action="habit-slider-show-value" ${f.sliderShowValue ? 'checked' : ''} />
            ${t('habitForm.showValueWhileEntering')}
          </label>
        </div>
      ` : ''}
      ${!f.locked && !f.labelsEnabled ? `
        <div class="auth-field">
          <label id="habit-form-numbers-label">${t('habitForm.numbers')}${infoTip(t('habitForm.numbersExplain'))}</label>
          <div class="pill-group seg" role="group" aria-labelledby="habit-form-numbers-label">
            ${[1, 0].map((start) => `<button type="button" class="pill-toggle${(f.min === 0 ? 0 : 1) === start ? ' pill-toggle--active' : ''}" data-action="habit-start" data-start="${start}">${tPlain('habitForm.numbersRange', { min: start, max: start + stepCount - 1 })}</button>`).join('')}
          </div>
        </div>
      ` : ''}
    `)}
  `;

  const textBody = `<p class="habit-form-lock-note">${t('habitForm.textShort')}</p>`;

  const numberBody = `
    <div class="auth-field">
      <label for="habit-form-unit">${t('habitForm.unit')}</label>
      <input type="text" id="habit-form-unit" value="${esc(f.unit)}" maxlength="10" placeholder="${esc(t('habitForm.unitPlaceholder'))}" />
    </div>
  `;
  // "Wie trägst du ein?" - eintippen oder hochzählen; nicht im Tutorial (dort nur eintippen).
  const entryModeField = f.revealStage !== undefined ? '' : `
    <div class="auth-field">
      <div class="pill-group seg" role="group" aria-labelledby="habit-form-part-entry">
        ${[['number', 'habitForm.entryMode.type'], ['counter', 'habitForm.entryMode.count']].map(([k, key]) => `<button type="button" class="pill-toggle${f.kind === k ? ' pill-toggle--active' : ''}" data-action="habit-entry-mode" data-kind="${k}" aria-pressed="${f.kind === k}" ${f.locked ? 'disabled' : ''}>${t(key)}</button>`).join('')}
      </div>
    </div>
  `;
  // Vorschau wie bei der Skala: wie das Feld in "Heute" aussieht (nur Bild, nicht bedienbar).
  const entryPreview = `
    <div class="auth-field">
      <span class="settings-label" id="habit-form-entry-preview-label">${t('habitForm.preview')}</span>
      <div class="field-preview entry-preview" role="img" aria-label="${esc(t(f.kind === 'counter' ? 'habitForm.entryPreviewAria.counter' : 'habitForm.entryPreviewAria.number'))}">
        <span class="entry-preview-name" aria-hidden="true">${esc(f.name.trim() || t('habitForm.preview'))}</span>
        ${f.kind === 'counter'
          ? '<span class="counter-controls" aria-hidden="true"><span class="counter-btn">−</span><span class="counter-value">0</span><span class="counter-btn counter-btn--plus">+</span></span>'
          : '<span class="number-input entry-preview-input" aria-hidden="true"></span>'}
        <p class="habit-form-lock-note field-preview-note">${t('habitForm.entryPreviewNote')}</p>
      </div>
    </div>
  `;
  const counterBody = `
    ${entryModeField}
    ${entryPreview}
    ${numberBody}
    <div class="auth-field">
      <label for="habit-form-step">${t('habitForm.counterStep')}</label>
      <input type="number" id="habit-form-step" inputmode="decimal" min="0.01" step="any" value="${esc(f.step)}" aria-describedby="habit-form-step-note" />
      <p class="habit-form-lock-note" id="habit-form-step-note">${t('habitForm.counterStepNote')}</p>
    </div>
  `;

  // Mitglieder-Auswahl: aktive, bewertete Skala-Felder (nicht sich selbst, keine
  // unbewerteten - die haben kein Gut/Schlecht zum Mitteln), plus bereits gewählte
  // Mitglieder, die inzwischen archiviert wurden (sonst würde man sie beim nächsten
  // Bearbeiten des berechneten Felds unsichtbar wieder verlieren).
  // Aus Zahlen: aktive Zahlenwert-Felder; sobald eins gewählt ist, lassen sich nur
  // noch Felder mit derselben Einheit dazunehmen (andere erscheinen deaktiviert) - sonst
  // käme still eine falsche Zahl heraus (5 km + 800 m).
  const isNumberComputedForm = f.computedType === 'number';
  // Nur Tagesfelder: Tages- und Zeitraum-Werte zu mitteln ergibt nichts Sinnvolles.
  const memberCandidates = state.habits.filter((h) => h.defId !== f.defId && (!h.archivedAt || f.members.includes(h.id))
    && !isPeriodField(h)
    && (isNumberComputedForm ? h.kind === 'number' : h.kind === 'scale' && !isNeutralScale(h)));
  const chosenUnit = isNumberComputedForm
    ? (() => { const first = memberCandidates.find((h) => f.members.includes(h.id)); return first ? (first.unit || '').trim() : null; })()
    : null;
  // Dauer: genau zwei Uhrzeit-Felder, "von" und "bis" (Reihenfolge zählt, deshalb zwei
  // Auswahllisten statt Häkchen). Archivierte nur, wenn schon gewählt.
  const isDurationForm = f.computedType === 'duration';
  const timeCandidates = state.habits.filter((h) => isTimeKind(h)
    && (!h.archivedAt || h.id === f.durationFrom || h.id === f.durationTo));
  const durationSelect = (id, labelKey, selected) => `
    <div class="auth-field">
      <label for="${id}">${t(labelKey)}</label>
      <select id="${id}">
        <option value="">${t('habitForm.durationChoose')}</option>
        ${timeCandidates.map((h) => `<option value="${esc(h.id)}" ${h.id === selected ? 'selected' : ''}>${esc(h.name)}${h.archivedAt ? ` (${t('common.archived')})` : ''}</option>`).join('')}
      </select>
    </div>
  `;
  const durationBody = timeCandidates.length >= 2 ? `
    ${durationSelect('habit-form-duration-from', 'habitForm.durationFrom', f.durationFrom)}
    ${durationSelect('habit-form-duration-to', 'habitForm.durationTo', f.durationTo)}
    <p class="habit-form-lock-note">${t('habitForm.durationNote')}</p>
  ` : `<p class="habit-form-lock-note">${t('habitForm.noDurationCandidates')}</p>`;
  // "Tage seit": ein Quellfeld (Skala, Zahl, Zähler; archivierte nur, wenn schon gewählt), dazu
  // welche Einträge zählen - bei Skalen mit Knöpfen die Stufen zum Antippen (mehrere, deshalb
  // Pillen), sonst "zählt ab dem Wert".
  const isSinceForm = f.computedType === 'since';
  const sinceCandidates = state.habits.filter((h) => h.defId !== f.defId && sinceSourceCandidate(h) && (!h.archivedAt || h.id === f.sinceSource));
  const sinceSrc = sinceCandidates.find((h) => h.id === f.sinceSource) || null;
  const sinceStages = sinceSrc && sinceUsesStages(sinceSrc) ? Array.from({ length: sinceSrc.max - sinceSrc.min + 1 }, (_, i) => sinceSrc.min + i) : null;
  const sinceBody = sinceCandidates.length ? `
    <div class="auth-field">
      <label for="habit-form-since-source">${t('habitForm.sinceSource')}</label>
      <select id="habit-form-since-source">
        <option value="">${t('habitForm.durationChoose')}</option>
        ${sinceCandidates.map((h) => `<option value="${esc(h.id)}" ${h.id === f.sinceSource ? 'selected' : ''}>${esc(h.name)}${h.archivedAt ? ` (${t('common.archived')})` : ''}</option>`).join('')}
      </select>
    </div>
    ${sinceSrc ? (sinceStages ? `
      <div class="auth-field">
        <label id="habit-form-since-values-label">${t('habitForm.sinceValues')}</label>
        <div class="pill-group" role="group" aria-labelledby="habit-form-since-values-label">
          ${sinceStages.map((v) => `<button type="button" class="pill-toggle${f.sinceValues.includes(v) ? ' pill-toggle--active' : ''}" data-action="since-value" data-value="${v}" aria-pressed="${f.sinceValues.includes(v)}">${esc(valueAsText(sinceSrc, v))}</button>`).join('')}
        </div>
      </div>
    ` : `
      <div class="auth-field">
        <label for="habit-form-since-atleast">${t('habitForm.sinceAtLeast')}</label>
        <input type="number" id="habit-form-since-atleast" inputmode="decimal" step="any" value="${esc(f.sinceAtLeast)}" />
      </div>
    `) : ''}
    <div class="auth-field">
      <label id="habit-form-since-mode-label">${t('habitForm.sinceMode')}</label>
      <div class="pill-group seg seg--stack" role="group" aria-labelledby="habit-form-since-mode-label">
        ${['last', 'start'].map((m) => `<button type="button" class="pill-toggle${f.sinceMode === m ? ' pill-toggle--active' : ''}" data-action="since-mode" data-mode="${m}" aria-pressed="${f.sinceMode === m}">${t('habitForm.sinceMode.' + m)}</button>`).join('')}
      </div>
    </div>
    <p class="habit-form-lock-note">${t('habitForm.sinceNote.' + f.sinceMode)}</p>
  ` : `<p class="habit-form-lock-note">${t('habitForm.noSinceCandidates')}</p>`;
  const computedTypes = [['scale', 'habitForm.computedType.scale'], ['number', 'habitForm.computedType.number'], ['duration', 'habitForm.computedType.duration'], ['since', 'habitForm.computedType.since']];
  const computedBody = `
    <div class="auth-field">
      <label id="habit-form-computed-type-label">${t('habitForm.computedType')}</label>
      <div class="pill-group seg" role="group" aria-labelledby="habit-form-computed-type-label">
        ${computedTypes.map(([type, key]) => `<button type="button" class="pill-toggle${f.computedType === type ? ' pill-toggle--active' : ''}" data-action="computed-type" data-type="${type}" aria-pressed="${f.computedType === type}">${t(key)}</button>`).join('')}
      </div>
    </div>
    ${isSinceForm ? sinceBody : isDurationForm ? durationBody : `
    ${isNumberComputedForm ? `
      <div class="auth-field">
        <label for="habit-form-computed-aggregate">${t('habitForm.aggregate')}</label>
        <select id="habit-form-computed-aggregate">
          ${['sum', 'avg', 'min', 'max'].map((a) => `<option value="${a}" ${f.aggregate === a ? 'selected' : ''}>${t('aggregate.' + a)}</option>`).join('')}
        </select>
      </div>
    ` : ''}
    <div class="auth-field">
      <label>${t('habitForm.members')}</label>
      ${memberCandidates.length ? `
        <div class="member-list">
          ${memberCandidates.map((h) => {
            const unit = (h.unit || '').trim();
            const blocked = isNumberComputedForm && chosenUnit !== null && unit !== chosenUnit && !f.members.includes(h.id);
            return `
              <label class="checkbox-field member-check${blocked ? ' member-check--blocked' : ''}">
                <input type="checkbox" data-member-key="${esc(h.id)}" ${f.members.includes(h.id) ? 'checked' : ''} ${blocked ? 'disabled' : ''} />
                ${esc(h.name)}${isNumberComputedForm && unit ? ` <span class="manage-meta">(${esc(unit)})</span>` : ''}${h.archivedAt ? ` <span class="manage-meta">(${t('common.archived')})</span>` : ''}
              </label>
            `;
          }).join('')}
        </div>
        ${isNumberComputedForm ? `<p class="habit-form-lock-note">${t('habitForm.computedUnitNote')}</p>` : ''}
      ` : `<p class="habit-form-lock-note">${t(isNumberComputedForm ? 'habitForm.noNumberComputedCandidates' : 'habitForm.noComputedCandidates')}</p>`}
    </div>
    `}
  `;

  // Uhrzeit: Erklärung und Vorschau.
  const timeBody = `
    <div class="auth-field">
      <span class="settings-label" id="habit-form-time-preview-label">${t('habitForm.preview')}</span>
      <div class="field-preview entry-preview" role="img" aria-label="${esc(t('habitForm.entryPreviewAria.time'))}">
        <span class="entry-preview-name" aria-hidden="true">${esc(f.name.trim() || t('habitForm.preview'))}</span>
        <span class="time-pick time-pick--empty" aria-hidden="true">--:--</span>
        <p class="habit-form-lock-note field-preview-note">${t('habitForm.entryPreviewNote')}</p>
      </div>
    </div>
  `;

  // Optionen der Mehrfachauswahl: schon gewählte nur umbenennen/ausblenden (siehe isMultiKind).
  const multiKey = f.defId ? state.habits.find((h) => h.defId === f.defId)?.id : null;
  const multiAnyUsed = !!multiKey && f.multiOptions.some((o) => multiOptionUsed(multiKey, o.id));
  const multiBody = f.kind !== 'multi' ? '' : `
    <div class="auth-field">
      <span class="settings-label" id="habit-form-multi-label">${t('habitForm.multiOptions')}</span>
      <ul class="multi-option-list" aria-labelledby="habit-form-multi-label">
        ${f.multiOptions.map((o, i) => {
          const used = !!multiKey && multiOptionUsed(multiKey, o.id);
          const n = i + 1;
          return `
          <li class="multi-option-row${o.hidden ? ' multi-option-row--hidden' : ''}">
            <input type="text" id="habit-form-multi-option-${o.id}" value="${esc(o.label)}" maxlength="40" aria-label="${esc(tPlain('habitForm.multiOptionAria', { n }))}" />
            ${used
              ? `<button type="button" class="manage-btn" data-action="multi-option-hide" data-option="${o.id}" aria-pressed="${!!o.hidden}">${t(o.hidden ? 'habitForm.multiShow' : 'habitForm.multiHide')}</button>`
              : `<button type="button" class="manage-btn" data-action="multi-option-remove" data-option="${o.id}" aria-label="${esc(tPlain('habitForm.multiRemove', { n }))}">×</button>`}
          </li>`;
        }).join('')}
      </ul>
      ${f.multiOptions.length < MULTI_MAX_OPTIONS ? `<button type="button" class="manage-btn" data-action="multi-option-add">${t('habitForm.multiAdd')}</button>` : ''}
      ${multiAnyUsed ? `<p class="habit-form-lock-note">${t('habitForm.multiUsedNote')}</p>` : ''}
    </div>
  `;

  // Bis zu MAX_REMINDER_TIMES Zeiten bei Tagesfeldern, bei Zeitraum-Feldern eine.
  const times = f.reminderTimes.length ? f.reminderTimes : [state.userSettings.defaultReminderMinute];
  const maxTimes = f.period === 'day' ? MAX_REMINDER_TIMES : 1;
  const timesNote = habitFormReminderTimesNote(f, times.length);
  const reminderBody = `
    <div class="auth-field">
      <label class="checkbox-field">
        <input type="checkbox" id="habit-form-reminder-enabled" data-action="habit-reminder-toggle" ${f.reminderEnabled ? 'checked' : ''} />
        ${t('habitForm.ownReminderTime')}
      </label>
      ${f.reminderEnabled ? `
        ${times.slice(0, maxTimes).map((m, i) => `
          <div class="reminder-time-row${f.kind === 'counter' && f.period === 'day' ? ' reminder-time-row--counter' : ''}">
            ${reminderTimeInputHtml(`habit-form-reminder-time-${i}`, m, 'habit-reminder-time-changed', false, timesNote ? 'habit-form-reminder-times-note' : null)}
            ${f.kind === 'counter' && f.period === 'day' ? `
              <label class="reminder-below">
                ${t('habitForm.reminderBelow')}
                <input type="number" id="habit-form-reminder-below-${i}" inputmode="decimal" step="any" min="0" value="${esc(f.reminderBelow[i] ?? '')}" aria-describedby="habit-form-reminder-times-note" />
              </label>
            ` : ''}
            ${times.length > 1 ? `<button type="button" class="manage-btn" data-action="habit-reminder-remove" data-index="${i}">${t('habitForm.reminderRemove')}<span class="visually-hidden"> ${formatClock(m)}</span></button>` : ''}
          </div>
        `).join('')}
        ${times.length < maxTimes ? `<button type="button" class="manage-btn reminder-time-add" data-action="habit-reminder-add">${t('habitForm.reminderAdd')}</button>` : ''}
        ${timesNote ? `<p class="habit-form-lock-note" id="habit-form-reminder-times-note">${timesNote}</p>` : ''}
      ` : `<p class="habit-form-lock-note" id="habit-form-reminder-note">${habitFormReminderNote(f)}</p>`}
    </div>
  `;

  // "An welchen Tagen?": Wochentage (alle sieben vorbelegt) oder "Alle N Tage" ab einem
  // Starttag (Details siehe isScheduledOn).
  const sch = f.schedule;
  const shortNames = mondayFirstWeekdayShortNames();
  const isInterval = sch.mode === 'interval';
  const optionalShown = isOptionalAllowed(f);
  const scheduleBody = `
    <div class="auth-field">
      <label id="habit-form-days-label">${t('habitForm.days')}${infoTip(tPlain(isInterval ? 'habitForm.days.intervalHint' : sch.days.length === 7 ? 'habitForm.days.hint' : 'habitForm.days.explain'))}</label>
      ${isInterval ? `
        <div class="schedule-inline schedule-interval">
          <label for="habit-form-every">${t('habitForm.days.every')}</label>
          <input type="number" id="habit-form-every" class="schedule-every" inputmode="numeric" min="2" max="365" step="1" value="${esc(sch.every)}" />
          <span>${t('habitForm.days.everyUnit')}</span>
        </div>
        <div class="schedule-inline schedule-interval">
          <label for="habit-form-every-start">${t('habitForm.days.everyStart')}</label>
          <input type="date" id="habit-form-every-start" class="schedule-start" value="${esc(sch.start)}" />
        </div>
      ` : `
        <div class="pill-group weekday-group" role="group" aria-label="${esc(t('habitForm.days.modeWeekdays'))}">
          ${weekdayOrder().map((i) => {
            const name = shortNames[i];
            const on = sch.days.includes(i);
            return `<button type="button" class="pill-toggle weekday-toggle${on ? ' pill-toggle--active' : ''}" data-action="habit-schedule-day" data-day="${i}" aria-pressed="${on}" aria-label="${esc(weekdayLong(new Date(2024, 0, 1 + i)))}">${esc(name)}</button>`;
          }).join('')}
        </div>
      `}
    </div>
    ${partMore('when', ['interval', ...(optionalShown ? ['optional'] : [])], isInterval || (optionalShown && f.optional), `
      ${optionalShown ? `
        <label class="checkbox-field">
          <input type="checkbox" id="habit-form-optional" ${f.optional ? 'checked' : ''} />
          ${t('habitForm.optional')}${infoTip(tPlain('habitForm.optionalNote'))}
        </label>
      ` : ''}
      <div class="auth-field">
        <div class="pill-group seg" role="group" aria-label="${esc(tPlain('habitForm.days'))}">
          ${[['weekdays', 'habitForm.days.modeWeekdays'], ['interval', 'habitForm.days.modeInterval']].map(([m, key]) => `<button type="button" class="pill-toggle${sch.mode === m ? ' pill-toggle--active' : ''}" data-action="habit-schedule-mode" data-mode="${m}" aria-pressed="${sch.mode === m}">${t(key)}</button>`).join('')}
        </div>
      </div>
    `)}
  `;

  const isComputed = f.kind === 'computed';
  // Im Tutorial (f.revealStage gesetzt) dasselbe echte Formular, aber Stück für Stück
  // aufgedeckt: 1 Name, 2 + Feld-Typ, 3 + Einstellungen zum Typ, Vorschau, Mehr
  // Einstellungen, Anlegen. Ausgefülltes bleibt stehen; zu jedem neuen Teil ein Tipp-Kasten
  // (Nutzer-Entscheidung 2026-10-01: das Tutorial soll auf die echte Oberfläche vorbereiten,
  // nicht nur ein Feld erzeugen - ein eigener Frage-Antwort-Assistent wurde verworfen).
  const tutorialForm = f.revealStage !== undefined;
  const stage = tutorialForm ? f.revealStage : 3;
  const tipBox = (key, moreTitleKey, moreKey) => `
    <div class="form-tip">${icon('tip')}<div><p>${t(key)}</p>${moreKey ? whyBox(moreTitleKey, moreKey) : ''}</div></div>`;
  // Tipp zu einem schon erledigten Teil: zugeklappt (nur die Überschrift), damit offen
  // immer nur der Tipp zum Teil steht, um den es gerade geht - mehrere offene Kästen
  // untereinander wurden nicht mehr gelesen (Testpersonen, 2026-10-12).
  const pastTipBox = (titleKey, key, moreTitleKey, moreKey) => `
    <details class="form-tip form-tip--past"><summary>${icon('tip')}${t(titleKey)}</summary><div><p>${t(key)}</p>${moreKey ? whyBox(moreTitleKey, moreKey) : ''}</div></details>`;
  // Seltener Gebrauchtes steht unter "Mehr Einstellungen" (seit 2026-10-01; das Formular
  // war für Neulinge zu lang - und das Tutorial nutzt dasselbe Formular). Aufgeklappt, wenn
  // dort schon etwas vom Standard abweicht, sonst zu; offen/zu übersteht Re-Renders
  // (f.moreOpen, gesetzt vom toggle-Listener).
  const showGoal = (f.kind === 'scale' && f.good) || (isComputed && f.computedType === 'scale');
  const moreOpen = f.moreOpen ?? ((showGoal && f.goal < 1) || !!f.numberGoalDir || f.summary === 'sum' || (!isComputed && (f.schedule.mode === 'interval' || f.schedule.days.length < 7 || f.reminderEnabled))
    || (state.sections.length > 0 && !!f.sectionId) || !f.showInStats);
  // "Berechnet" nur anbieten, wenn es etwas zu berechnen gibt (mind. 2 passende Felder) -
  // beim allerersten Feld im Tutorial führte die Auswahl sonst nur zu "noch keine Felder".
  const others = state.habits.filter((h) => !h.archivedAt && h.defId !== f.defId && !isPeriodField(h));
  const computedPossible = isComputed || (!tutorialForm && (
    others.filter((h) => h.kind === 'scale' && !isNeutralScale(h)).length >= 2
    || others.filter((h) => h.kind === 'number').length >= 2
    || others.filter(isTimeKind).length >= 2
    || others.some(sinceSourceCandidate)));
  // Zähler ist für Nutzer eine Art, eine Zahl einzutragen ("hochzählen"), kein eigener Typ -
  // intern 'counter', weil der Server ihn für Erinnerungen unterscheiden muss.
  const kinds = [['scale', 'habitForm.kindScale'], ['number', 'habitForm.kindNumber']]
    .concat(tutorialForm ? [] : [['time', 'habitForm.kindTime']])
    .concat(!tutorialForm || f.kind === 'multi' ? [['multi', 'habitForm.kindMulti']] : [])
    .concat([['text', 'habitForm.kindText']])
    .concat(computedPossible ? [['computed', 'habitForm.kindComputed']] : []);
  // Zeitraum (Tag/Woche/Monat/Jahr): nicht im Tutorial (das erste Feld ist ein Tagesfeld) und
  // nicht bei "Berechnet". Mit Daten gesperrt - die Werte stünden sonst am falschen Tag.
  const isTime = f.kind === 'time';
  const isMulti = f.kind === 'multi';
  const isPeriod = !isComputed && !isTime && !isMulti && f.period !== 'day';
  const isCounter = f.kind === 'counter';
  const periodField = tutorialForm || isComputed || isTime || isMulti ? '' : `
    <div class="auth-field">
      <label id="habit-form-period-label">${t('habitForm.period')}</label>
      <div class="pill-group seg" role="group" aria-labelledby="habit-form-period-label">
        ${['day', ...PERIODS].map((p) => `<button type="button" class="pill-toggle${f.period === p ? ' pill-toggle--active' : ''}" data-action="habit-period" data-period="${p}" aria-pressed="${f.period === p}" ${f.locked ? 'disabled' : ''}>${t('habitForm.period.' + p)}</button>`).join('')}
      </div>
      ${isPeriod ? `<p class="habit-form-lock-note">${t('habitForm.periodHint.' + f.period)}</p>` : ''}
    </div>
  `;
  // Abschnitte nach Thema (Nutzer-Entscheidung 2026-10-12): Was? / Wie trägst du ein? /
  // Wann? / Auswertung / Gruppe - vorher standen rund 15 Einstellungen gleichförmig
  // untereinander, getrennt nur nach "wichtig" und "Mehr Einstellungen". Leere Abschnitte
  // entfallen. Im Tutorial stehen Wann/Auswertung/Gruppe weiter zugeklappt unter "Mehr
  // Einstellungen" (Formular sonst zu lang für das erste Feld).
  const part = (key, body, tip = '') => (body.trim() ? `
    <section class="form-part" aria-labelledby="habit-form-part-${key}">
      <h3 class="form-part-title" id="habit-form-part-${key}">${t('habitForm.part.' + key)}${tip ? infoTip(tip) : ''}</h3>
      ${body}
    </section>
  ` : '');
  const summaryField = habitFormSummable(f) ? `
    <div class="auth-field">
      <label id="habit-form-summary-label">${t('habitForm.summary')}</label>
      <div class="pill-group seg" role="group" aria-labelledby="habit-form-summary-label">
        ${['avg', 'sum'].map((k) => `<button type="button" class="pill-toggle${f.summary === k ? ' pill-toggle--active' : ''}" data-action="habit-summary" data-summary="${k}" aria-pressed="${f.summary === k}">${t('habitForm.summary.' + k)}</button>`).join('')}
      </div>
      <p class="habit-form-lock-note">${t(f.summary === 'sum' ? 'habitForm.summary.noteSum' : 'habitForm.summary.noteAvg')}</p>
    </div>
  ` : '';
  const entryBody = isComputed ? computedBody : f.kind === 'scale' ? scaleBody : f.kind === 'text' ? textBody : isTime ? timeBody : isMulti ? multiBody
    : f.kind === 'counter' ? counterBody : entryModeField + entryPreview + numberBody;
  const whenBody = isComputed ? '' : `
    ${periodField}
    ${isPeriod ? (isCounter ? '' : periodReminderControl(f)) : scheduleBody}
    ${habitFormReminderShown(f) ? reminderBody : ''}
  `;
  const hasGoalField = showGoal || f.kind === 'number' || f.kind === 'counter' || numberGoalAllowed(f);
  const statsBody = `
    ${summaryField}
    ${partMore('stats', [...(hasGoalField ? ['goal'] : []), 'showInStats'], (showGoal && f.goal < 1) || !!f.numberGoalDir || !f.showInStats, `
      ${showGoal ? goalField : ''}
      ${numberGoalAllowed(f) ? numberGoalField(f) : ''}
      <div class="auth-field">
        <label class="checkbox-field">
          <input type="checkbox" id="habit-form-show-in-stats" ${f.showInStats ? 'checked' : ''} />
          ${t('habitForm.showInStats')}${infoTip(tPlain('habitForm.showInStatsNote'))}
        </label>
      </div>
    `)}
  `;
  const groupBody = state.sections.length && !isPeriod ? `
    <div class="auth-field">
      <select id="habit-form-section" aria-labelledby="habit-form-part-group">
        <option value="">${t('habitForm.sectionNone')}</option>
        ${[...state.sections].sort((a, b) => a.sortOrder - b.sortOrder).map((sec) => `<option value="${sec.id}" ${f.sectionId === sec.id ? 'selected' : ''}>${esc(sec.name)}</option>`).join('')}
      </select>
    </div>
  ` : '';
  // Was die Feld-Art in "Heute" bedeutet: hinter dem "?" am Abschnitt statt als Absatz darin.
  const kindExplainKey = { text: 'habitForm.textNote', counter: 'habitForm.counterNote', computed: 'habitForm.computedExplain', time: 'habitForm.timeNote', multi: 'habitForm.multiNote' }[f.kind];
  const kindExplain = kindExplainKey ? tPlain(kindExplainKey) : '';
  const laterParts = part('when', whenBody) + part('stats', statsBody) + part('group', groupBody);
  const kindCards = `
    <div class="kind-cards" role="group" aria-labelledby="habit-form-kind-label">
      ${kinds.map(([kind, key]) => {
        const on = (f.kind === 'counter' ? 'number' : f.kind) === kind;
        return `<button type="button" class="kind-card${on ? ' kind-card--active' : ''}" data-action="habit-kind" data-kind="${kind}" aria-pressed="${on}" ${f.locked ? 'disabled' : ''}><span class="kind-card-title">${t(key)}</span><span class="kind-card-note">${t(key + 'Note')}</span></button>`;
      }).join('')}
    </div>
  `;
  return `
    <div class="habit-form" id="habit-form">
      ${titleInHeader ? '' : `<h2>${t(habitFormTitleKey(f))}</h2>`}
      ${f.locked ? `<p class="habit-form-lock-note">${t(f.kind === 'text' ? 'habitForm.lockedNoteText' : f.kind === 'multi' ? 'habitForm.lockedNoteMulti' : 'habitForm.lockedNote')}</p>` : ''}
      ${part('what', `
        <div class="auth-field">
          <label for="habit-form-name">${t('habitForm.name')}</label>
          <input type="text" id="habit-form-name" value="${esc(f.name)}" maxlength="40" ${tutorialForm ? 'aria-describedby="habit-form-name-ideas"' : ''} />
          ${tutorialForm ? `<p class="onb-hint auth-password-hint" id="habit-form-name-ideas">${t('tutorial.form.nameIdeas')}</p>` : ''}
        </div>
        ${tutorialForm && stage === 1 ? tutorialExamplesHtml() : ''}
        ${stage < 2 ? '' : `
          ${!tutorialForm ? '' : stage > 2
            ? pastTipBox('tutorial.form.tipKindTitle', 'tutorial.form.tipKind', 'tutorial.form.tipKindMoreTitle', 'tutorial.form.tipKindMore')
            : tipBox('tutorial.form.tipKind', 'tutorial.form.tipKindMoreTitle', 'tutorial.form.tipKindMore')}
          <div class="auth-field" id="habit-form-kind-field">
            <label id="habit-form-kind-label">${t('habitForm.fieldType')}</label>
            ${kindCards}
          </div>
          ${typeEditHtml(f)}
          ${canConvertToCounter(f) ? `
            <div class="auth-field convert-box">
              ${f.convertConfirm ? `
                <p class="habit-form-lock-note" role="status">${t(f.kind === 'scale' ? 'habitForm.convertConfirm.scale' : 'habitForm.convertConfirm.number')}</p>
                <div class="manage-group-tip-actions">
                  <button type="button" class="manage-btn" data-action="habit-convert-cancel">${t('common.cancel')}</button>
                  <button type="button" class="manage-btn" data-action="habit-convert-confirm">${t('habitForm.convertCounterDo')}</button>
                </div>
              ` : `
                <p class="habit-form-lock-note">${t(f.kind === 'scale' ? 'habitForm.convertHint.scale' : 'habitForm.convertHint.number')}</p>
                <button type="button" class="manage-btn" data-action="habit-convert-counter">${t('habitForm.convertCounter')}</button>
              `}
            </div>
          ` : ''}
        `}
      `)}
      ${stage < 3 ? `<button type="button" class="auth-submit" data-action="habit-reveal-next">${t('common.next')}</button>` : `
      ${tutorialForm ? tipBox(`tutorial.form.tip.${f.kind}`, 'tutorial.form.tipScaleMoreTitle', f.kind === 'scale' ? 'tutorial.form.tipScaleMore' : null) : ''}
      <div id="habit-form-details"></div>
      ${part('entry', entryBody, kindExplain)}
      ${tutorialForm ? `
        <details class="habit-form-more" ${moreOpen ? 'open' : ''}>
          <summary><span class="habit-form-more-title">${t('habitForm.more')}</span><span class="habit-form-more-sub">${t(isPeriod ? 'habitForm.moreSubPeriod' : 'habitForm.moreSub')}</span></summary>
          ${laterParts}
        </details>
      ` : laterParts}
      <div class="habit-form-actions">
        ${tutorialForm ? '' : `<button type="button" class="habit-form-cancel" data-action="habit-cancel" ${state.habitFormSaving ? 'disabled' : ''}>${t('common.cancel')}</button>`}
        <button type="button" class="auth-submit" data-action="habit-save" ${state.habitFormSaving ? 'disabled' : ''}>${state.habitFormSaving ? t('common.saving') : t(tutorialForm && !f.defId ? 'tutorial.form.create' : 'common.save')}</button>
      </div>
      `}
    </div>
  `;
}

// Zähler mit Zeitraum Woche/Monat/Jahr erinnern nicht (kein "fehlt noch", und Zwischenziele
// über mehrere Tage gibt es nicht).
export function habitFormReminderShown(f) {
  return f.kind !== 'computed' && !(f.kind === 'counter' && f.period !== 'day');
}
// Hinweis unter den eigenen Zeiten: wann zu einer Zeit tatsächlich erinnert wird. Bei einem
// Feld mit nur einer Zeit selbsterklärend (kein Hinweis), bei Zählern immer nötig - sie stehen
// nie leer.
function habitFormReminderTimesNote(f, count) {
  if (f.kind === 'counter') return t('habitForm.counterReminderNote');
  return count > 1 ? t('habitForm.reminderTimesNote') : '';
}
// Hinweis unter "Eigene Erinnerungszeit" (ausgeschaltet): welche Zeit stattdessen gilt -
// die der Gruppe, falls das Feld in einer Gruppe mit eigener Zeit liegt, sonst die
// Standardzeit. Wird beim Wechsel der Gruppe im Formular direkt ausgetauscht.
export function habitFormReminderNote(f) {
  const sec = f.sectionId ? state.sections.find((x) => x.id === f.sectionId) : null;
  return sec && sec.reminderMinute !== null
    ? t('habitForm.sectionReminderNote', { name: sec.name, time: formatClock(sec.reminderMinute) })
    : t('habitForm.defaultReminderNote', { time: formatClock(state.userSettings.defaultReminderMinute) });
}

// Zusatzinfo pro Feld in der Verwaltungsliste: nur, was vom Standard abweicht
// (Wiederholung, eigene Erinnerungszeit) - siehe "Verwaltungsliste entschlackt".
function manageFieldMeta(h) {
  const parts = [
    isPeriodField(h) ? t('manage.period.' + h.period) : scheduleSummary(h.schedule),
    h.reminderTimes.length ? t('manage.reminderAt', { time: h.reminderTimes.map(minutesToTimeStr).join(', ') }) : '',
    h.hideInStats && !h.archivedAt ? t('manage.hiddenInStats') : '',
    h.optional ? t('manage.optional') : '',
  ].filter(Boolean);
  return parts.length ? `<span class="manage-meta">${parts.join(' · ')}</span>` : '';
}

// Alle Felder (auch berechnete, erkennbar an ihrer Mitglieder-Zeile "Ø aus …"/"Summe
// aus …") stehen in EINER frei sortierbaren Liste, dazwischen Gruppen als Blöcke (intern
// "sections", siehe layoutBlocks).
const GROUP_TIP_MIN_FIELDS = 6;
function isGroupTipDismissed() {
  try { return localStorage.getItem('groupTipDismissed') === 'true'; } catch { return false; }
}
export function renderManage() {
  const active = state.habits.filter((h) => !h.archivedAt);
  const archived = state.habits.filter((h) => h.archivedAt);

  const row = (h, idx, list) => {
    const hasData = habitHasData(h.id);
    const confirmingDelete = state.habitDeleteConfirm === h.defId;
    // Löschen mit vorhandenen historischen Einträgen bleibt möglich, aber erst nach
    // explizitem zweiten Bestätigungsklick — die Rohdaten bleiben zwar als verwaistes
    // JSON in habit_entries.data liegen (kein Cascade auf einzelne Slugs), sind ohne
    // die Feld-Definition in der App aber nicht mehr nutzbar/auswertbar.
    const deleteAction = !hasData
      ? `<button type="button" class="manage-btn manage-btn--danger" data-action="habit-delete" data-id="${h.defId}">${t('common.delete')}</button>`
      : confirmingDelete
        ? `
          <button type="button" class="manage-btn" data-action="habit-delete-cancel">${t('common.cancel')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="habit-delete" data-id="${h.defId}">${t('manage.deleteConfirmFinal')}</button>
        `
        : `<button type="button" class="manage-btn manage-btn--danger" data-action="habit-delete-arm" data-id="${h.defId}">${t('common.delete')}</button>`;
    return `
      <div class="manage-row manage-item${h.archivedAt ? ' manage-row--archived' : ''}${confirmingDelete ? ' manage-row--confirm-delete' : ''}" data-def-id="${h.defId}" data-order-type="habit" data-order-id="${h.defId}">
        ${!h.archivedAt ? `
          <span class="drag-handle" data-action="drag-handle" aria-label="${esc(t('ariaLabel.reorder'))}"><span></span><span></span></span>
          <span class="move-buttons">
            <button type="button" class="move-btn" data-action="habit-move" data-id="${h.defId}" data-dir="up" ${!fieldMoveStep(h.defId, 'up') ? 'disabled' : ''} aria-label="${esc(t('ariaLabel.moveUp'))}">↑</button>
            <button type="button" class="move-btn" data-action="habit-move" data-id="${h.defId}" data-dir="down" ${!fieldMoveStep(h.defId, 'down') ? 'disabled' : ''} aria-label="${esc(t('ariaLabel.moveDown'))}">↓</button>
          </span>
        ` : ''}
        <div class="manage-info">
          <span class="manage-name">${esc(h.name)}</span>
          ${confirmingDelete
            ? `<span class="manage-delete-warning">${t('manage.deleteWarning')}</span>`
            : h.kind === 'computed'
              ? `<span class="manage-meta"><span class="manage-tag">${t('manage.computedTag')}</span> ${isDurationComputed(h)
                  ? t('manage.computedDuration', { from: state.habits.find((x) => x.id === h.members?.[0])?.name || '–', to: state.habits.find((x) => x.id === h.members?.[1])?.name || '–' })
                  : isSinceComputed(h)
                  ? t(h.since?.mode === 'start' ? 'manage.computedSinceStart' : 'manage.computedSinceLast', { name: computedMemberHabits(h)[0]?.name || '–' })
                  : isNumberComputed(h)
                  ? t('manage.computedAggregate', { agg: t('aggregate.' + h.aggregate), names: computedMemberHabits(h).map((m) => m.name).join(', ') || '–' })
                  : t('manage.computedMembers', { names: computedMemberHabits(h).map((m) => m.name).join(', ') || '–' })}${h.hideInStats && !h.archivedAt ? ' · ' + t('manage.hiddenInStats') : ''}</span>`
              : manageFieldMeta(h)}
          ${h.archivedAt && !confirmingDelete ? `
            <label class="checkbox-field manage-inline-check">
              <input type="checkbox" data-action="archived-stats-toggle" data-id="${h.defId}" ${h.archivedInStats ? 'checked' : ''} />
              ${t('habitForm.showInStats')}
            </label>
          ` : ''}
        </div>
        <div class="manage-actions">
          ${!h.archivedAt ? `
            <button type="button" class="manage-btn" data-action="habit-edit" data-id="${h.defId}">${t('common.edit')}</button>
            <button type="button" class="manage-btn manage-btn--warn" data-action="habit-archive" data-id="${h.defId}">${t('manage.archive')}</button>
          ` : confirmingDelete ? deleteAction : `
            <button type="button" class="manage-btn" data-action="habit-reactivate" data-id="${h.defId}">${t('manage.reactivate')}</button>
            ${deleteAction}
          `}
        </div>
      </div>
    `;
  };

  // Offenes Formular = eigene Ebene, ohne die Liste darunter (siehe openHabitForm).
  if (state.habitForm) return renderHabitForm({ titleInHeader: true });
  if (state.sectionForm) return renderSectionForm();

  // Eine Gruppe ist in der Liste ein Block (Kopfzeile + eingerückte Felder), der sich auf
  // oberster Ebene wie ein Feld verschieben lässt. Felder wandern per Ziehen und ↑/↓ auch in
  // Gruppen hinein und heraus (fieldMoveStep, fieldDragModel).
  const sectionBlock = (b, idx, list) => {
    const sec = b.section;
    const confirmingDelete = state.sectionDeleteConfirm === sec.id;
    return `
      <div class="manage-item manage-section" data-order-type="section" data-order-id="${sec.id}">
        <div class="manage-row manage-section-head">
          <span class="drag-handle" data-action="drag-handle" aria-label="${esc(t('ariaLabel.reorder'))}"><span></span><span></span></span>
          <span class="move-buttons">
            <button type="button" class="move-btn" data-action="habit-move" data-dir="up" ${idx === 0 ? 'disabled' : ''} aria-label="${esc(t('ariaLabel.moveUp'))}">↑</button>
            <button type="button" class="move-btn" data-action="habit-move" data-dir="down" ${idx === list.length - 1 ? 'disabled' : ''} aria-label="${esc(t('ariaLabel.moveDown'))}">↓</button>
          </span>
          ${`
            <div class="manage-info">
              <span class="manage-name manage-section-name">${esc(sec.name)}</span>
              ${confirmingDelete
                ? `<span class="manage-delete-warning">${t('manage.sectionDeleteWarning')}${keyHasNotes(SECTION_NOTE_PREFIX + sec.id) ? ' ' + t('manage.sectionDeleteNotesWarning') : ''}</span>`
                : `<span class="manage-meta"><span class="manage-tag">${t('manage.sectionTag')}</span>${sec.reminderMinute !== null ? ' ' + t('manage.reminderAt', { time: formatClock(sec.reminderMinute) }) : ''}</span>`}
            </div>
            <div class="manage-actions">
              ${confirmingDelete ? `
                <button type="button" class="manage-btn" data-action="section-delete-cancel">${t('common.cancel')}</button>
                <button type="button" class="manage-btn manage-btn--danger" data-action="section-delete" data-id="${sec.id}">${t('manage.deleteConfirmFinal')}</button>
              ` : `
                <button type="button" class="manage-btn" data-action="section-edit" data-id="${sec.id}">${t('common.edit')}</button>
                <button type="button" class="manage-btn manage-btn--danger" data-action="section-delete-arm" data-id="${sec.id}">${t('common.delete')}</button>
              `}
            </div>
          `}
        </div>
        <div class="manage-section-children">
          ${b.habits.length ? b.habits.map((h, i) => row(h, i, b.habits)).join('') : `<p class="habit-form-lock-note manage-section-empty">${t('manage.sectionEmpty')}</p>`}
        </div>
      </div>
    `;
  };
  const activeBlocks = layoutBlocks(active);
  // Einmaliger Tipp, sobald die Liste lang wird und es noch keine Gruppe gibt.
  const showGroupTip = active.length >= GROUP_TIP_MIN_FIELDS && !state.sections.length && !isGroupTipDismissed();

  return `
    <div class="manage-new-row">
      <button type="button" class="manage-new-btn" data-action="habit-new">${icon('newField')}${t('habitForm.title.newField')}</button>
      <button type="button" class="manage-new-btn manage-new-btn--secondary" data-action="group-new">${icon('newGroup')}${t('habitForm.title.newGroup')}</button>
    </div>
    ${showGroupTip ? `
      <div class="form-tip manage-group-tip">
        ${icon('tip')}
        <div>
          <p>${t('manage.groupTip')}</p>
          <div class="manage-group-tip-actions">
            <button type="button" class="manage-btn" data-action="group-tip-hide">${t('manage.groupTipHide')}</button>
          </div>
        </div>
      </div>
    ` : ''}
    <div class="manage-list">${activeBlocks.map((b, i) => (b.type === 'habit' ? row(b.habit, i, activeBlocks) : sectionBlock(b, i, activeBlocks))).join('')}</div>
    ${active.length ? `<p class="habit-form-lock-note">${t('manage.archiveNote')}</p>` : ''}
    ${archived.length ? `
      <p class="habit-form-lock-note">${t('manage.archivedSectionLabel')}</p>
      <div class="manage-list">${archived.map(row).join('')}</div>
    ` : ''}
  `;
}
