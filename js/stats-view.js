import { habitNumericValue, hasDayGoal, inStats, isCounterKind, isMultiKind, isNumberKind, isScoredKind, isTextKind, renderBySection } from './fields.js?v=8aaa0e5b67';
import { PERIODS, addDays, applyGoal, computeHabitStats, dayCellAriaLabel, dayOverallScore, formatKey, habitColor, habitScore, habitVisibleInRange, isFutureKey, isNeutralScale, isPeriodField, isPlannedOn, nextPeriodDisabled, openDayAttrs, parseDateKey, periodStart, scoreColor, scorePatternStyle, scoreTextColor, textOnScore, weekdayOrder } from './dates.js?v=8aaa0e5b67';
import { runtime, state } from './state.js?v=8aaa0e5b67';
import { esc } from './navigation.js?v=8aaa0e5b67';
import { formatNumber, t } from './i18n.js?v=8aaa0e5b67';
import { formatDMY, mondayFirstWeekdayShortNames, monthName, monthShort, weekdayShort } from './format.js?v=8aaa0e5b67';
import { dayHasNote, getNote } from './save.js?v=8aaa0e5b67';
import { hasAnyEntries, periodRangeLabel, renderStatsEmpty, renderStatsLegend, statsFieldName } from './row-view.js?v=8aaa0e5b67';
import { habitAvgLong, habitAvgShort, inFieldStatsList, isYesNoScale, multiWeekRows, renderFieldStatsList, renderNumberCharts, renderStatsRows, renderTextReviews, scaleLabelAt } from './about-view.js?v=8aaa0e5b67';

// --- Auswertung: Zeitraum-Felder ----------------------------------------------
// Je Zeitraum ein eigener Block ganz unten, nach allem zu den Tagesfeldern (wie die Bereiche
// in "Heute" - dazwischen zerrissen sie die Tagesfeld-Ansicht): Woche
// zeigt Wochenfelder, Monat zusätzlich Monatsfelder, Jahr und Gesamt alle. Gerechnet wird
// mit denselben Bausteinen wie bei Tagesfeldern (computeHabitStats, Verläufe, Text-Rückblick)
// - nur über die ersten Tage der Zeiträume statt über alle Tage. Umfasst die Ansicht genau
// einen Zeitraum (Wochenfeld in der Woche), steht einfach dessen Wert da.
function periodAnchors(period, rangeKeys) {
  const inRange = new Set(rangeKeys);
  return [...new Set(rangeKeys.map((k) => formatKey(periodStart(period, parseDateKey(k)))))].filter((k) => inRange.has(k)).sort();
}
function periodFieldsInStats(period, anchors) {
  return state.habits.filter((h) => h.period === period && (h.archivedAt ? h.archivedInStats : !h.hideInStats)
    && (!h.archivedAt || anchors.some((k) => state.entries[k]?.[h.id] !== undefined)));
}
function periodValueText(h, v) {
  if (v === undefined && isCounterKind(h)) v = 0;
  if (v === undefined) return '–';
  if (h.kind === 'scale') return scaleLabelAt(h, v);
  if (isNumberKind(h) || isCounterKind(h)) return formatNumber(v) + (h.unit ? ` ${h.unit}` : '');
  return String(v);
}
function renderPeriodValueRows(fields, anchor) {
  return `<div class="month-stats">${fields.map((h) => {
    const v = state.entries[anchor]?.[h.id];
    const score = h.kind === 'scale' && h.good ? habitScore(h, anchor) : null;
    const color = v === undefined ? 'var(--sand)' : score !== null ? scoreTextColor(habitColor(h, applyGoal(h, score))) : 'var(--ink)';
    const name = `<span class="habit-name">${statsFieldName(h, `period-${anchor}`)}</span>`;
    return isTextKind(h) && v !== undefined
      ? `<div class="month-stat-row month-stat-row--text">${name}<p class="period-text-value">${esc(periodValueText(h, v))}</p></div>`
      : `<div class="month-stat-row">${name}<span class="month-stat-value" style="color:${color}">${esc(periodValueText(h, v))}</span></div>`;
  }).join('')}</div>`;
}
function renderPeriodStats(periods, rangeKeys) {
  return periods.map((period) => {
    const anchors = periodAnchors(period, rangeKeys);
    const fields = periodFieldsInStats(period, anchors);
    if (!fields.length || !anchors.length) return '';
    const label = (k) => periodRangeLabel(period, parseDateKey(k));
    let body;
    if (anchors.length === 1) body = renderPeriodValueRows(fields, anchors[0]);
    else {
      const stats = computeHabitStats(fields.filter(isScoredKind), anchors);
      body = `
        ${stats.length ? `<div class="month-stats">${renderStatsRows(stats)}</div>` : ''}
        ${renderNumberCharts(fields, anchors)}
        ${renderTextReviews(fields, anchors, label)}
      `;
    }
    return `<section class="period-stats"><h2 class="period-stats-title">${t('periodStats.' + period)}</h2>${body}</section>`;
  }).join('');
}

// --- Rendering: Week -----------------------------------------------------
export function renderWeek() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekAnchor, i));
  // Archivierte Felder bleiben sichtbar, solange sie in diesem Zeitraum Daten haben –
  // sonst wuerde die Historie beim Archivieren aus der Auswertung verschwinden.
  const dayKeys = days.map(formatKey);
  const visibleHabits = state.habits.filter(
    (h) => inStats(h) && (!h.archivedAt || habitVisibleInRange(h, dayKeys))
  );
  const weekRow = (h) => {
    if (isMultiKind(h)) return multiWeekRows(h, dayKeys, days);
    const scores = dayKeys.map((k) => habitScore(h, k));
    const valid = scores.filter((s) => s !== null);
    const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    const hits = valid.filter((v) => v >= 0.999).length;
    const numVals = hasDayGoal(h) ? dayKeys.filter((k, i) => scores[i] !== null).map((k) => habitNumericValue(h, k)) : [];
    const numAvg = numVals.length ? numVals.reduce((a, b) => a + b, 0) / numVals.length : null;
    const avgLong = avg !== null ? `${h.name}: ${habitAvgLong(h, avg, valid.length, hits, numAvg)}${isYesNoScale(h) || hasDayGoal(h) ? '' : ` (${valid.length}×)`}` : '';
    // Unbewertete Felder: nur "eingetragen", kein Streifenmuster (das kodiert die
    // Bewertungsstufe) und kein Ø - siehe isNeutralScale.
    const neutral = isNeutralScale(h);
    const avgCell = neutral
      ? '<div class="grid-cell grid-cell--avg grid-cell--blank"></div>'
      : avg === null
        ? `<div class="grid-cell grid-cell--avg" style="background:${habitColor(h, null)}">–</div>`
        // Antippen zeigt den Wert ausgeschrieben (z.B. "an 2 von 5 Tagen „Ja“", "Ø 1,2 · leicht–mittel") -
        // in der schmalen Spalte ist nur die Kurzform ("2/5", "1,2") Platz.
        : `<button type="button" class="grid-cell grid-cell--avg" data-action="avg-info" data-text="${esc(avgLong)}" aria-label="${esc(avgLong)}" style="background:${habitColor(h, applyGoal(h, avg))};color:${textOnScore(habitColor(h, applyGoal(h, avg)))}">${habitAvgShort(h, avg, valid.length, hits, numAvg)}</button>`;
    return `
      <div class="grid-row">
        <div class="grid-label">${statsFieldName(h, 'grid')}</div>
        ${scores.map((s, i) => `<div class="grid-cell${getNote(dayKeys[i], h.id) ? ' has-note' : ''}${s === null && !isPlannedOn(h, days[i]) ? ' grid-cell--unplanned' : ''}" ${isFutureKey(dayKeys[i]) ? '' : `data-action="open-day" data-date="${dayKeys[i]}" data-focus-habit="${h.id}"`} style="background-color:${habitColor(h, applyGoal(h, s))};${neutral ? '' : scorePatternStyle(applyGoal(h, s))}" aria-hidden="true"></div>`).join('')}
        ${avgCell}
      </div>
    `;
  };
  const rows = renderBySection(visibleHabits.filter(inFieldStatsList), 'stats', (list) => list.map(weekRow).join(''));

  return `
    <div class="day-nav">
      <button type="button" class="nav-btn" data-action="nav-week" data-dir="-1" aria-label="${esc(t('ariaLabel.prevWeek'))}">‹</button>
      <div class="day-label"><span class="day-date">${days[0].getDate()}. ${monthName(days[0])} – ${days[6].getDate()}. ${monthName(days[6])}</span></div>
      <button type="button" class="nav-btn" data-action="nav-week" data-dir="1" aria-label="${esc(t('ariaLabel.nextWeek'))}"${nextPeriodDisabled('week')}>›</button>
    </div>
    ${!hasAnyEntries() ? renderStatsEmpty() : `
    <div class="grid-scroll">
      <div class="grid-row grid-row--header">
        <div class="grid-label"></div>
        ${days.map((d) => `<div class="grid-col-header${dayHasNote(formatKey(d)) ? ' has-note' : ''}" ${openDayAttrs(d)} aria-label="${esc(dayCellAriaLabel(d, dayOverallScore(d)) + (dayHasNote(formatKey(d)) ? t('ariaLabel.withNote') : ''))}"><span>${weekdayShort(d)}</span><span class="grid-col-date">${d.getDate()}</span></div>`).join('')}
        <div class="grid-col-header grid-col-header--avg">Ø</div>
      </div>
      ${rows}
    </div>
    ${renderStatsLegend('week')}
    ${renderNumberCharts(visibleHabits, days.map(formatKey), true)}
    ${renderTextReviews(visibleHabits, days.map(formatKey))}
    ${renderPeriodStats(['week'], dayKeys)}
    `}
  `;
}

// --- Rendering: Month ------------------------------------------------------
export function renderMonth() {
  const year = state.monthAnchor.getFullYear();
  const month = state.monthAnchor.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() - (runtime.weekStartIso % 7) + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  const cellKeys = cells.filter(Boolean).map(formatKey);
  // Archivierte Felder bleiben sichtbar, solange sie in diesem Monat Daten haben.
  const visibleHabits = state.habits.filter(
    (h) => inStats(h) && (!h.archivedAt || habitVisibleInRange(h, cellKeys))
  );

  return `
    <div class="day-nav">
      <button type="button" class="nav-btn" data-action="nav-month" data-dir="-1" aria-label="${esc(t('ariaLabel.prevMonth'))}">‹</button>
      <div class="day-label"><span class="day-date">${monthName(first)} ${year}</span></div>
      <button type="button" class="nav-btn" data-action="nav-month" data-dir="1" aria-label="${esc(t('ariaLabel.nextMonth'))}"${nextPeriodDisabled('month')}>›</button>
    </div>
    ${!hasAnyEntries() ? renderStatsEmpty() : `
    <div class="month-grid">
      ${weekdayOrder().map((i) => `<div class="month-weekday">${mondayFirstWeekdayShortNames()[i]}</div>`).join('')}
      ${cells.map((d) => {
        if (!d) return `<div class="month-cell month-cell--empty"></div>`;
        const s = dayOverallScore(d);
        const hasNote = dayHasNote(formatKey(d));
        return `<div class="month-cell${hasNote ? ' has-note' : ''}" ${openDayAttrs(d)} style="background:${scoreColor(s)};${scorePatternStyle(s)}" aria-label="${esc(dayCellAriaLabel(d, s) + (hasNote ? t('ariaLabel.withNote') : ''))}"><span class="month-cell-num"${s !== null && s !== undefined ? ` style="color:${textOnScore(scoreColor(s))};background-color:${scoreColor(s)}"` : ''}>${d.getDate()}</span></div>`;
      }).join('')}
    </div>
    <div class="month-stats">${renderFieldStatsList(visibleHabits, cellKeys)}</div>
    ${renderStatsLegend('stats')}
    ${renderNumberCharts(visibleHabits, cellKeys, true)}
    ${renderTextReviews(visibleHabits, cellKeys)}
    ${renderPeriodStats(['week', 'month'], cellKeys)}
    `}
  `;
}

// --- Rendering: Year ---------------------------------------------------------
export function renderYear() {
  const year = state.yearAnchor;
  const monthsGrid = Array.from({ length: 12 }, (_, mIdx) => {
    const daysInMonth = new Date(year, mIdx + 1, 0).getDate();
    const cells = Array.from({ length: daysInMonth }, (_, i) => new Date(year, mIdx, i + 1));
    return `
      <div class="year-month">
        <div class="year-month-label">${monthShort(new Date(year, mIdx, 1))}</div>
        <div class="year-month-grid">
          ${cells.map((d) => { const s = dayOverallScore(d); return `<div class="year-day-cell" ${openDayAttrs(d)} style="background:${scoreColor(s)};${scorePatternStyle(s, true)}" aria-label="${esc(dayCellAriaLabel(d, s))}"></div>`; }).join('')}
        </div>
      </div>
    `;
  }).join('');

  const yearKeys = Object.keys(state.entries).filter((k) => k.startsWith(`${year}-`)).sort();
  // Archivierte Felder bleiben sichtbar, solange sie in diesem Jahr Daten haben.
  const visibleHabits = state.habits.filter(
    (h) => inStats(h) && (!h.archivedAt || habitVisibleInRange(h, yearKeys))
  );

  return `
    <div class="day-nav">
      <button type="button" class="nav-btn" data-action="nav-year" data-dir="-1" aria-label="${esc(t('ariaLabel.prevYear'))}">‹</button>
      <div class="day-label"><span class="day-date">${year}</span></div>
      <button type="button" class="nav-btn" data-action="nav-year" data-dir="1" aria-label="${esc(t('ariaLabel.nextYear'))}"${nextPeriodDisabled('year')}>›</button>
    </div>
    ${!hasAnyEntries() ? renderStatsEmpty() : `
    <div class="year-grid">${monthsGrid}</div>
    <div class="month-stats">${renderFieldStatsList(visibleHabits, yearKeys)}</div>
    ${renderStatsLegend('stats')}
    ${renderNumberCharts(visibleHabits, yearKeys)}
    ${renderTextReviews(visibleHabits, yearKeys)}
    ${renderPeriodStats(PERIODS, yearKeys)}
    `}
  `;
}

// --- Rendering: Gesamt (alle Einträge seit Beginn) ---------------------------
// Tage mit mindestens einem Feldwert - ohne zurückgesetzte (leere) Tage, Tage mit nur
// einer Notiz (_-Schlüssel) und nicht entschlüsselbare Tage.
export function dayHasValues(day) {
  return Object.keys(day || {}).some((k) => !k.startsWith('_'));
}
function dayHasDayValues(day) {
  return Object.keys(day || {}).some((k) => !k.startsWith('_') && !isPeriodField(state.habits.find((h) => h.id === k)));
}
export function renderGlobal() {
  const dateKeys = Object.keys(state.entries).filter((k) => dayHasDayValues(state.entries[k])).sort();
  const statsHabits = state.habits.filter(inStats);
  const rangeNote = dateKeys.length
    ? t('global.rangeNote', { since: formatDMY(dateKeys[0]), count: dateKeys.length })
    : t('global.noEntries');

  return `
    <div class="day-nav">
      <div class="day-label"><span class="day-date">${t('global.title')}</span></div>
    </div>
    ${!dateKeys.length ? renderStatsEmpty() : `
    <p class="manage-meta" style="margin: -8px 0 14px;">${rangeNote}</p>
    <div class="month-stats">${renderFieldStatsList(statsHabits, dateKeys)}</div>
    ${renderStatsLegend('stats')}
    ${renderNumberCharts(statsHabits, dateKeys)}
    ${renderTextReviews(statsHabits, dateKeys)}
    ${renderPeriodStats(PERIODS, Object.keys(state.entries).sort())}
    `}
  `;
}
