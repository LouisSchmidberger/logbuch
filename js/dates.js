import { MINUTES_PER_DAY, computedMemberHabits, computedUnit, formatClock, formatDuration, habitNumericValue, hasDayGoal, hasWeekGoal, isDurationComputed, isNumberComputed, isSinceComputed, isTimeKind, numberComputedDay, numberGoalScore } from './fields.js?v=8aaa0e5b67';
import { runtime, state } from './state.js?v=8aaa0e5b67';
import { esc } from './navigation.js?v=8aaa0e5b67';
import { formatNumber, t, tPlain } from './i18n.js?v=8aaa0e5b67';
import { isPatternDisabled } from './theme.js?v=8aaa0e5b67';
import { formatDMY, mondayFirstWeekdayShortNames } from './format.js?v=8aaa0e5b67';
import { saveDefaultReminderMinute } from './data.js?v=8aaa0e5b67';
import { syncHabitFormFromDom } from './field-form.js?v=8aaa0e5b67';
import { render } from './main-view.js?v=8aaa0e5b67';

// --- Feste Tage (habit_definitions.schedule) -------------------------------
// null = täglich, {type:'weekly', days:[0..6]} (0 = Montag) oder "Alle N Tage"
// {type:'interval', every:2..365, unit:'day', start:'YYYY-MM-DD'} - dran ab dem Starttag in
// festem Abstand, davor nicht (monatlich/jährlich decken Zeitraum-Felder ab). Gegenstück zur
// SQL-Funktion public.habit_scheduled_on (Erinnerungen) - beide müssen dieselbe Regel
// umsetzen; unbekannte Pläne gelten als "dran".
export function isScheduledOn(schedule, date) {
  if (schedule?.type === 'interval' && Number.isInteger(schedule.every) && schedule.every >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(schedule.start || '')) {
    const diff = Math.round((startOfDay(date) - parseDateKey(schedule.start)) / 86400000);
    return diff >= 0 && diff % schedule.every === 0;
  }
  if (schedule?.type !== 'weekly' || !Array.isArray(schedule.days)) return true;
  return schedule.days.includes((date.getDay() + 6) % 7);
}
// Ob ein Feld an einem Tag "dran" ist. Berechnete Felder haben keinen eigenen Plan: dran, sobald
// eines ihrer aktiven Mitglieder dran ist.
export function isPlannedOn(h, date) {
  if (h.kind !== 'computed') return isScheduledOn(h.schedule, date);
  return (h.members || []).some((slug) => {
    const m = state.habits.find((x) => x.id === slug);
    return m && !m.archivedAt && isScheduledOn(m.schedule, date);
  });
}
// Kurzbeschreibung für die Verwaltungsliste ('' bei täglich): die Wochentage bzw. "alle N Tage".
export function scheduleSummary(schedule) {
  if (schedule?.type === 'interval') return t('schedule.summary.everyDays', { n: schedule.every });
  if (schedule?.type !== 'weekly') return '';
  const names = mondayFirstWeekdayShortNames();
  return weekdayOrder().filter((d) => schedule.days.includes(d)).map((d) => names[d]).join(', ');
}

// --- Datum-Helfer ----------------------------------------------------------
export function formatKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
export function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
// Parst einen 'YYYY-MM-DD'-Key als lokales Datum (nicht new Date(string), das UTC
// interpretiert und je nach Zeitzone einen Tag daneben liegen kann).
export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
// Tage nach heute lassen sich nicht öffnen und nichts eintragen (Nutzer-Entscheidung
// 2026-10-30, Grenze Mitternacht ohne Einstellung): Pfeil, Wischen, Kalender und die Zellen
// der Übersicht enden bei heute. Uhrzeiten nach Mitternacht auf der heutigen Seite bleiben.
export function isFutureKey(dateKey) { return dateKey > formatKey(new Date()); }
function isPastKey(dateKey) { return dateKey < formatKey(new Date()); }
// Steht die Ansicht schon beim laufenden Tag/Woche/Monat/Jahr? Dann geht es nicht weiter.
export function atCurrentPeriod(view = state.view) {
  const now = new Date();
  if (view === 'today') return !isPastKey(formatKey(state.currentDate));
  if (view === 'week') return formatKey(startOfWeek(state.weekAnchor)) >= formatKey(startOfWeek(now));
  if (view === 'month') return state.monthAnchor.getFullYear() * 12 + state.monthAnchor.getMonth() >= now.getFullYear() * 12 + now.getMonth();
  if (view === 'year') return state.yearAnchor >= now.getFullYear();
  return false;
}
export const nextPeriodDisabled = (view) => (atCurrentPeriod(view) ? ' aria-disabled="true"' : '');
// Zellen der Übersicht, die einen Tag öffnen - zukünftige sind keine Knöpfe.
export function openDayAttrs(d) {
  const key = formatKey(d);
  return isFutureKey(key) ? 'role="img"' : `data-action="open-day" data-date="${key}" tabindex="0" role="button"`;
}
// Wochenbeginn (G2, Nutzer-Entscheidung 2026-11-10): ISO-Wochentag des ersten Tags, 1 Montag
// (Standard), 7 Sonntag, 6 Samstag - aus user_settings.week_start, gesetzt in loadUserSettings.
// Eigene Variable statt state, weil startOfWeek schon beim Anlegen von state gebraucht wird.
// Gespeicherte Wochentage (schedule.days, 0 = Montag) bleiben Montag-basiert; nur Anzeige-
// Reihenfolge und Zeiträume folgen dem Wochenbeginn.
export const WEEK_STARTS = [1, 7, 6];
export function startOfWeekWith(date, iso) { const d = startOfDay(date); const off = (d.getDay() - (iso % 7) + 7) % 7; d.setDate(d.getDate() - off); return d; }
export function startOfWeek(date) { return startOfWeekWith(date, runtime.weekStartIso); }
// Letzter Tag der Woche als ISO-Wochentag (Gegenstück zu public.habit_week_last_isodow).
export function weekLastIso(iso = runtime.weekStartIso) { return ((iso + 5) % 7) + 1; }
// Wochentage (0 = Montag) in Anzeige-Reihenfolge ab dem Wochenbeginn.
export function weekdayOrder() { return Array.from({ length: 7 }, (_, i) => (runtime.weekStartIso - 1 + i) % 7); }
// Zeitraum-Felder (period 'week'/'month'/'year', siehe docs/datenmodell.md): ein Wert pro
// Zeitraum, gespeichert im Eintrag des ersten Tags des Zeitraums. Gegenstück zu
// public.habit_period_start (SQL) - synchron halten.
export const PERIODS = ['week', 'month', 'year'];
export function isPeriodField(h) { return !!h && !!h.period && h.period !== 'day'; }
export function periodStart(period, date) { return periodStartWith(period, date, runtime.weekStartIso); }
export function periodStartWith(period, date, iso) {
  const d = startOfDay(date);
  if (period === 'week') return startOfWeekWith(d, iso);
  if (period === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  if (period === 'year') return new Date(d.getFullYear(), 0, 1);
  return d;
}
export function periodEnd(period, date) {
  const start = periodStart(period, date);
  if (period === 'week') return addDays(start, 6);
  if (period === 'month') return new Date(start.getFullYear(), start.getMonth() + 1, 0);
  if (period === 'year') return new Date(start.getFullYear(), 11, 31);
  return start;
}
// Unter welchem Tag der Wert eines Felds steht: Tagesfelder am Tag selbst, Zeitraum-Felder am
// ersten Tag ihres Zeitraums. Alle Speicher-Wege (handleSelect & Co., Notizen) laufen hier
// durch - so bleibt der Rest (saveDay, mergeDay, Verschlüsselung) unverändert.
export function entryKeyFor(habitId, dateKey) {
  const h = state.habits.find((x) => x.id === habitId);
  return isPeriodField(h) ? formatKey(periodStart(h.period, parseDateKey(dateKey))) : dateKey;
}
export function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }

// --- Erinnerungszeit-Helfer (Minuten seit Mitternacht <-> "HH:MM") ---------
// Erinnerungszeiten werden seit dem Onboarding-Tutorial in 15-Minuten-Schritten
// statt nur zur vollen Stunde gespeichert (siehe docs/erinnerungen.md), als Minuten seit
// Mitternacht (0-1439) statt Stunde (0-23).
export function minutesToTimeStr(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
export const REMINDER_TIME_STEP = 15; // Minuten — muss zum Cron-Intervall in send-notifications passen
// Uhrzeit als Knopf, der die eigene Uhrzeit-Auswahl öffnet (openTimePicker), Minuten nur
// 00/15/30/45 - so oft läuft der Versand. dataAction sagt, was nach der Auswahl passiert
// (reminderTimePicked). Wert lesen über readTimeInput(id).
export function reminderTimeInputHtml(id, minutes, dataAction, disabled, describedBy, labelledBy) {
  const label = labelledBy ? `aria-labelledby="${labelledBy} ${id}"` : `aria-label="${esc(t('time.label'))}: ${esc(formatClock(minutes))}"`;
  return `<button type="button" class="time-pick" id="${id}" data-time-input data-action="reminder-time-pick" data-then="${dataAction || ''}" data-value="${minutes}" ${disabled ? 'disabled' : ''} ${describedBy ? `aria-describedby="${describedBy}"` : ''} ${label}>${esc(formatClock(minutes))}</button>`;
}
// Minuten seit Mitternacht aus reminderTimeInputHtml (id oder das Element), null wenn es
// nicht im DOM steht.
export function readTimeInput(idOrEl) {
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl?.closest('[data-time-input]');
  return el ? Number(el.dataset.value) : null;
}
// Nach der Auswahl: Knopf nachziehen, dann je nach Stelle speichern bzw. ins Formular übernehmen.
export function reminderTimePicked(id, v) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.value = String(v);
  el.textContent = formatClock(v);
  if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', `${t('time.label')}: ${formatClock(v)}`);
  if (el.dataset.then === 'menu-default-time') saveDefaultReminderMinute(v);
  else if (el.dataset.then === 'habit-reminder-time-changed' && state.habitForm) { syncHabitFormFromDom(); render(); }
  else if (state.sectionForm && id === 'section-form-reminder-time') state.sectionForm.reminderMinute = v;
}

// 0 = schlechtester, 1 = bester Wert
export function normalize(habit, value) {
  if (value === undefined || value === null) return null;
  const raw = (value - habit.min) / (habit.max - habit.min);
  return habit.good === 'low' ? 1 - raw : raw;
}

// Normalisierter Score (0-1) eines Feldes an einem bestimmten Tag. Bei normalen
// Skala-Feldern der direkt eingetragene Wert; bei berechneten Feldern (kind='computed')
// der Durchschnitt der normalisierten Werte seiner Mitglieder an dem Tag (null, wenn
// an dem Tag kein Mitglied befüllt ist — ein berechnetes Feld hält nie einen eigenen Eintrag,
// ihr Slug taucht nie als Key in state.entries auf). Ändert man die Mitgliederliste
// eines berechneten Felds, wirkt sich das rückwirkend auf die gesamte Historie aus, da hier bei
// jedem Aufruf live neu gerechnet wird — beabsichtigt, siehe docs/felder.md.
export function habitScore(h, dateKey) {
  if (hasDayGoal(h)) return numberGoalScore(h, habitNumericValue(h, dateKey));
  if (hasWeekGoal(h)) return null; // bewertet wird nur die Woche, siehe weekGoalWeeks
  if (isTimeKind(h)) return null; // eine Uhrzeit ist weder gut noch schlecht
  const day = state.entries[dateKey];
  if (!day) return null;
  if (isNumberComputed(h)) return null; // keine Bewertung, siehe isNumberComputed
  if (h.kind === 'computed') {
    const memberScores = computedMemberHabits(h)
      .filter((m) => !isNeutralScale(m)) // unbewertete Mitglieder haben kein Gut/Schlecht zum Mitteln
      .map((m) => normalize(m, day[m.id]))
      .filter((s) => s !== null);
    if (!memberScores.length) return null;
    return memberScores.reduce((a, b) => a + b, 0) / memberScores.length;
  }
  return normalize(h, day[h.id]);
}

// Ob ein Feld irgendwo in den übergebenen Datums-Keys einen (ggf. errechneten) Score
// hat — für archivierte Felder in Auswertungs-Ansichten: normale Felder prüfen direkt
// state.entries, berechnete Felder (die nie selbst einen Entry-Key haben) über habitScore.
export function habitVisibleInRange(h, dateKeys) {
  if (isNumberComputed(h)) return dateKeys.some((k) => numberComputedDay(h, k).value !== null);
  if (h.kind === 'computed') return dateKeys.some((k) => habitScore(h, k) !== null);
  return dateKeys.some((k) => state.entries[k]?.[h.id] !== undefined);
}

export function scoreColor(score) {
  if (score === null || score === undefined) return 'transparent';
  const rust = [162, 80, 58], sand = [150, 142, 124], moss = [75, 107, 79];
  let c;
  if (score < 0.5) { const t = score / 0.5; c = rust.map((v, i) => Math.round(v + (sand[i] - v) * t)); }
  else { const t = (score - 0.5) / 0.5; c = sand.map((v, i) => Math.round(v + (moss[i] - v) * t)); }
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Skala-Felder ohne Gut/Schlecht-Bewertung (good = null, siehe habitForm.noValuation) -
// bewusstes Tracken ohne Wertung. Werden bewusst gar nicht nach Wert eingefärbt, auch
// nicht in Graustufen (Nutzer-Entscheidung 2026-09-28): eine Abstufung hell -> dunkel
// setzt eine Reihenfolge der Stufen voraus, die es bei vielen solchen Feldern nicht gibt
// (z.B. "sonnig/bewölkt/Regen"), und wirkte trotzdem wie eine Wertung. Stattdessen nur
// "eingetragen" (NEUTRAL_FILL) bzw. in "Heute" die übliche Auswahl-Farbe
// (NEUTRAL_SELECTED, wie .pill-toggle--active), und keine %-Durchschnitte.
export function isNeutralScale(h) { return h.kind === 'scale' && !h.good; }
export const NEUTRAL_FILL = 'var(--sand)';
export const NEUTRAL_SELECTED = 'var(--ink)';
export const NEUTRAL_SELECTED_TEXT = 'var(--paper)';
// Zentrale Weiche für jede farbliche Score-Darstellung eines konkreten Feldes -
// scoreColor() für bewertete (auch berechnete) Felder, NEUTRAL_FILL für unbewertete.
export function habitColor(habit, score) {
  if (isNeutralScale(habit)) return score === null || score === undefined ? 'transparent' : NEUTRAL_FILL;
  return scoreColor(score);
}
// Textfarbe auf einer Score-Farbe (rgb()-String aus scoreColor): hell oder dunkel, je
// nachdem was mehr Kontrast hat (WCAG-Leuchtdichte). Ein fester heller Text (--on-score)
// war auf den hellen Stufen kaum lesbar (Sandton in der Mitte der Skala ~3:1). Bewusst
// reines Weiß/Schwarz statt der warmen App-Töne: die Mittelstufen liegen genau im
// ungünstigsten Helligkeitsbereich, nur damit erreicht jede Stufe mind. 4,5:1
// (nachgerechnet über alle Stufen; mit #f5f3ee/#2b2620 nur 3,7:1).
const ON_SCORE_LIGHT = '#ffffff';
const ON_SCORE_DARK = '#000000';
export function textOnScore(rgb) {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(rgb || '');
  if (!m) return 'inherit'; // kein Score (transparent) - normaler Text, z.B. für "–"
  const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * channel(+m[1]) + 0.7152 * channel(+m[2]) + 0.0722 * channel(+m[3]);
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  // Leuchtdichte von Weiß = 1, von Schwarz = 0
  return contrast(lum, 1) >= contrast(lum, 0) ? ON_SCORE_LIGHT : ON_SCORE_DARK;
}
// Score-Farbe als Schriftfarbe auf --paper (Werte in Monat/Jahr/Gesamt): pur erreichen die
// Mittelstufen nur ~2,6:1 (hell) bzw. ~2,9:1 (dunkel). 60 % Score-Farbe + 40 % --ink hält
// den Farbton und kommt über alle Stufen auf mind. 4,8:1 (hell) bzw. 5,9:1 (dunkel) –
// --ink ist im Dark Mode hell, die Mischung hellt dort also auf.
export function scoreTextColor(color) {
  return `color-mix(in srgb, ${color} 60%, var(--ink))`;
}
// Zahlen/Zähler mit Ziel in "Heute": der Wert gefärbt nach Zielnähe (auch 0 - Nutzer-
// Entscheidung 2026-10-14: neutral bis zum ersten Eintrag hilft nicht, nach einem von acht
// Gläsern wäre es trotzdem rot), dahinter "/ Ziel". Bewusst ohne "max"/Haken: ob mindestens
// oder höchstens, weiß man bei den eigenen Feldern selbst (Nutzer-Entscheidung, störte optisch).
export function goalValueStyle(h, value) {
  if (!hasDayGoal(h)) return '';
  const v = Number(value);
  return Number.isFinite(v) ? ` style="color:${scoreTextColor(scoreColor(numberGoalScore(h, v)))}"` : '';
}
export function goalSuffixHtml(h) {
  const g = h.goal;
  const shown = g.dir === 'range' ? `${formatNumber(g.target)}–${formatNumber(g.max)}` : formatNumber(g.target);
  const sr = g.dir === 'range' ? tPlain('today.goalRange', { min: formatNumber(g.target), max: formatNumber(g.max) }) : tPlain('today.goalOf', { target: formatNumber(g.target) });
  return `<span class="goal-suffix"><span aria-hidden="true">/ ${esc(shown)}</span><span class="visually-hidden">${esc(sr)}</span></span>`;
}

// Zusätzlich zur Farbe (scoreColor) ein Streifenmuster, dessen Dichte/Deckkraft mit
// dem Score steigt — macht die Bewertung auch für Rot-Grün-Farbenblinde ohne Farbe
// erkennbar, nicht als Ersatz für die Farbe, sondern als Ergänzung. Bewusst diskrete
// Stufen statt stufenloser Variation: bei 8-22px Zellgröße wäre ein kontinuierlicher
// Verlauf visuelles Rauschen, diskrete Stufen sind als "Sprosse auf einer Leiter"
// erkennbar unabhängig vom Farbton. coarse=true (Jahres-Ansicht, ~8px Zellen) nutzt
// nur 3 statt 5 Stufen mit weiter auseinanderliegenden Streifen.
export function scorePatternStyle(score, coarse) {
  if (score === null || score === undefined || isPatternDisabled()) return '';
  const spacing = coarse ? [6, 4, 2] : [6, 5, 4, 3, 2];
  const opacity = coarse ? [0.15, 0.25, 0.35] : [0, 0.12, 0.2, 0.28, 0.35];
  const buckets = spacing.length;
  const step = Math.min(buckets - 1, Math.floor(score * buckets));
  if (opacity[step] === 0) return '';
  return `background-image:repeating-linear-gradient(45deg, rgba(0,0,0,${opacity[step]}) 0, rgba(0,0,0,${opacity[step]}) 1px, transparent 1px, transparent ${spacing[step]}px);`;
}

// Beschreibung für Kalender-Tage (Wochentage der Woche, Monat, Jahr), die nur per
// Hintergrundfarbe bewertet sind — macht den Tages-Gesamtwert über alle Felder per
// Tastatur/Screenreader zugänglich. tPlain: die Aufrufer escapen das Ergebnis fürs Attribut.
export function dayCellAriaLabel(date, score) {
  const scoreText = score === null || score === undefined ? t('common.noData') : `${Math.round(score * 100)}%`;
  return tPlain('ariaLabel.dayCell', { date: formatDMY(date), score: scoreText });
}

// Verschiebt einen normalisierten Score (0-1) anhand der pro Feld einstellbaren
// Ziel-Quote (goalThreshold, Standard 1 = 100%) für die FARBGEBUNG — z.B. bei
// "Kraftsport gemacht" kann eine 50%-Quote schon als voll erreicht (Score 1) gelten.
// Ändert NIE angezeigte Prozentzahlen, nur die Farbe, und wird bewusst NICHT in der
// "Heute"-Ansicht verwendet (siehe renderHabitOptions). Bei Standard-Ziel (1) exakter
// Durchreicher, keine Änderung ggü. vorher.
export function applyGoal(habit, score) {
  if (score === null || score === undefined) return null;
  const threshold = habit.goalThreshold ?? 1;
  if (threshold >= 1) return score;
  return Math.min(1, score / threshold);
}

// Gesamt-Score eines Tages über alle bewerteten Skala-Felder gemittelt (für Monats-/
// Jahres-Heatmap). Zahlenwert-Felder (kind='number') UND unbewertete Skala-Felder
// (isNeutralScale) fließen bewusst nicht ein — beide haben kein Gut/Schlecht, würden
// die Tages-Gesamtwertung sonst verfälschen. Berechnete Felder ebenfalls nicht: ihre Mitglieder
// sind schon als eigene Felder drin, sonst zählte jedes Mitglied doppelt (bis
// 2026-09-27 so, unbeabsichtigt). Unabhängig davon, ob ein Feld in der Auswertung
// ausgeblendet ist - das betrifft nur die Anzeige.
export function dayOverallScore(date) {
  const dateKey = formatKey(date);
  const day = state.entries[dateKey];
  if (!day) return null;
  const scores = state.habits.filter((h) => ((h.kind === 'scale' && !isNeutralScale(h)) || hasDayGoal(h)) && !isPeriodField(h))
    .map((h) => applyGoal(h, habitScore(h, dateKey)))
    .filter((s) => s !== null);
  if (!scores.length) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// Durchschnitt + Anzahl je Skala-/berechnetem Feld über eine Menge von Datums-Keys
// ('YYYY-MM-DD').
export function computeHabitStats(habits, dateKeys) {
  return habits.map((h) => {
    let sum = 0, count = 0, hits = 0, numSum = 0;
    for (const k of dateKeys) {
      const s = habitScore(h, k);
      if (s !== null) {
        sum += s; count++; if (s >= 0.999) hits++;
        if (hasDayGoal(h)) numSum += habitNumericValue(h, k);
      }
    }
    return { habit: h, avg: count ? sum / count : null, count, hits, numAvg: count ? numSum / count : null };
  });
}

// Werte-Reihe + Kennzahlen eines Zahlenwert-Felds bzw. berechneten Zahlen-Felds über eine
// Menge von Datums-Keys.
export function numberFieldStats(habit, dateKeys) {
  let series = dateKeys
    .map((k) => ({ key: k, value: habitNumericValue(habit, k) }))
    .filter((p) => p.value !== undefined && p.value !== null);
  if (!series.length) return null;
  if (isTimeKind(habit)) series = unwrapClockSeries(series);
  const values = series.map((p) => p.value);
  return {
    series,
    count: series.length,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    sum: values.reduce((a, b) => a + b, 0),
    last: series[series.length - 1].value,
  };
}

// Uhrzeiten liegen auf einem Kreis: 23:30 und 0:30 sind eine Stunde auseinander, nicht 23.
// Mittelpunkt = Kreis-Mittel, dann jeder Wert auf die Seite davon, auf der er näher liegt -
// danach stimmen Durchschnitt, Minimum/Maximum und Verlauf (Anzeige über formatClock).
function unwrapClockSeries(series) {
  const angle = (v) => ((v % MINUTES_PER_DAY) / MINUTES_PER_DAY) * 2 * Math.PI;
  const sin = series.reduce((a, p) => a + Math.sin(angle(p.value)), 0);
  const cos = series.reduce((a, p) => a + Math.cos(angle(p.value)), 0);
  const center = ((Math.atan2(sin, cos) / (2 * Math.PI)) * MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const half = MINUTES_PER_DAY / 2;
  return series.map((p) => ({ ...p, value: center + ((((p.value - center) % MINUTES_PER_DAY) + MINUTES_PER_DAY + half) % MINUTES_PER_DAY) - half }));
}
// Ein Wert eines Felds mit Verlauf, wie er angezeigt wird: Uhrzeit, Dauer oder Zahl + Einheit.
export function formatSeriesValue(h, v) {
  if (isTimeKind(h)) return formatClock(v);
  if (isDurationComputed(h)) return `${formatDuration(v)} h`;
  if (isSinceComputed(h)) {
    if (h.since?.mode === 'start') return tPlain('since.dayN', { n: formatNumber(v) });
    return v === 0 ? tPlain('since.today') : tPlain(v === 1 ? 'since.oneDay' : 'since.days', { n: formatNumber(v) });
  }
  const unit = isNumberComputed(h) ? computedUnit(h) : h.unit;
  return formatNumber(v) + (unit ? ` ${unit}` : '');
}
