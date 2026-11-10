import { supabase } from './config.js?v=90bbeaa075';
import { decryptData, encryptData } from './crypto.js?v=90bbeaa075';
import { addDays, formatKey, isFutureKey, isPeriodField, minutesToTimeStr, parseDateKey, periodStart, scoreColor, scoreTextColor, startOfWeek } from './dates.js?v=90bbeaa075';
import { currentDek, state } from './state.js?v=90bbeaa075';
import { esc } from './navigation.js?v=90bbeaa075';
import { formatNumber, t, tPlain } from './i18n.js?v=90bbeaa075';
import { clockUses12h } from './format.js?v=90bbeaa075';
import { CHOICE_STEP_CAP } from './field-form.js?v=90bbeaa075';
import { valueAsText } from './type-change.js?v=90bbeaa075';
import { isOpenToday, renderNote, renderRowMenuButton, renderSectionMenuPanel } from './row-view.js?v=90bbeaa075';
import { round1 } from './about-view.js?v=90bbeaa075';

// --- Habit-Definitionen ----------------------------------------------------
// Kommen jetzt aus der Tabelle habit_definitions (pro Nutzer frei verwaltbar, siehe
// renderManage weiter unten), nicht mehr aus einer festen Konstante hier im Code.
// `id` bleibt (wie vorher bei der festen Liste) der Schlüssel in habit_entries.data
// (= slug in der DB); `defId` ist die UUID der Definitions-Zeile, nur für Verwaltungs-
// Aktionen (bearbeiten/archivieren/löschen) gebraucht.
// - labels === null  → Zahlenwerte (0, 1, 2, ...)
// - labels === [...] → eigene Bezeichnungen, Länge muss max-min+1 entsprechen
//
// Verschlüsselt (seit 2026-09-27): alles, was den Inhalt eines Feldes verrät, steht in
// habit_definitions.enc (gleicher DEK wie die Einträge) - der Betreiber soll nicht sehen,
// WORÜBER jemand Buch führt. Im Klartext bleibt nur, was get_due_notifications für die
// Erinnerungen braucht: kind, reminder_minute, schedule, archived_at (+ sort_order).
// "payload" = der entschlüsselte Inhalt von enc; "key" darin ist der Schlüssel in
// habit_entries.data (früher die Klartext-Spalte slug). Die Datenbank lehnt eine
// verschlüsselte Zeile mit Klartext-Resten ab (habit_definitions_enc_no_plaintext_check).
export function habitFromParts(row, payload) {
  return {
    id: payload.key,
    defId: row.id,
    name: payload.name,
    kind: row.kind,          // 'scale' | 'number' | 'computed' | 'text'
    schedule: row.schedule ?? null, // Wiederholung, null = täglich (siehe isScheduledOn)
    unit: payload.unit,      // nur bei kind === 'number', z.B. 'kg'
    min: payload.min,
    max: payload.max,
    labels: payload.labels,
    good: payload.good,
    displayStyle: payload.displayStyle,   // 'buttons' | 'slider', nur bei kind === 'scale' + Zahlenwerte relevant
    sliderShowValue: payload.sliderShowValue,
    members: payload.groupMembers,        // nur bei kind === 'computed': Array von Schlüsseln (id) der Mitglieder (payload-Schlüssel heißt historisch groupMembers)
    aggregate: payload.aggregate ?? null, // nur bei berechneten Feldern aus Zahlen: 'sum'|'avg'|'min'|'max' (null = aus Skalen)
    since: payload.since ?? null,         // nur aggregate 'since': { values, atLeast, mode }, siehe isSinceComputed
    options: Array.isArray(payload.options) ? payload.options : null, // nur kind 'multi', siehe isMultiKind
    hideInStats: !!payload.hideInStats,   // in Woche/Monat/Jahr/Gesamt ausgeblendet (nur Anzeige, siehe inStats)
    archivedInStats: !!payload.archivedInStats, // archiviert, aber trotzdem in der Auswertung (siehe inStats)
    sectionId: row.section_id ?? null,    // Gruppe (intern "section", Klartext-Spalte, siehe layoutBlocks)
    reminderMinute: row.reminder_minute, // Minuten seit Mitternacht (0-1439) oder null (= Standardzeit); bei mehreren Zeiten die erste
    reminderTimes: reminderTimesOf(row),  // alle eigenen Zeiten, aufsteigend (leer = keine eigene Zeit)
    reminderBelow: Array.isArray(payload.reminderBelow) ? payload.reminderBelow : null, // nur Zähler, siehe counterReminderThresholds
    goalThreshold: payload.goalThreshold, // nur bei kind === 'scale'/'computed', 0-1 oder null (= 1 = 100%)
    sortOrder: row.sort_order,
    archivedAt: row.archived_at,
    period: row.period || 'day',          // 'day' | 'week' | 'month' | 'year' (Klartext, siehe periodStart)
    step: payload.step ?? 1,              // nur kind 'counter': um wie viel "+"/"−" ändern
    summary: payload.summary === 'sum' ? 'sum' : 'avg', // Zahlen: in Woche/Monat/Jahr als Durchschnitt oder Summe
    target: payload.target ?? null,       // Zahl/Zähler: Zielwert; good 'high' = mindestens, 'low' = höchstens
    goal: goalFromPayload(row.kind, payload), // Ziel einer Zahl/eines Zählers/eines berechneten Zahlen-Felds, siehe goalFromPayload
    goalRaw: payload.numberGoal ?? null,  // payload.numberGoal unverändert (zum Weiterreichen beim Neu-Verschlüsseln)
    createdAt: row.created_at,            // Zähler: ab wann ein leerer Tag als 0 zählt
    counterSince: payload.counterSince ?? null, // umgewandelter Zähler: 0 erst ab diesem Tag (siehe convertHabitToCounter)
    periodReminderDay: row.period_reminder_day ?? null, // Tag der Erinnerung im Zeitraum, null = Standard
    optional: !!row.optional,             // leer = nichts eingetragen, fehlt nie (Klartext, siehe isOptionalAllowed)
    stepChange: payload.stepChange ?? null, // Stufen ändern: laufende bzw. letzte Umstellung (siehe runStepChange)
  };
}
// Eigene Erinnerungszeiten einer Zeile: bis zu MAX_REMINDER_TIMES (reminder_minutes, nur
// Tagesfelder), sonst die eine reminder_minute. Die DB hält reminder_minute immer auf der
// ersten Zeit (Trigger, für ältere App-Versionen).
export const MAX_REMINDER_TIMES = 4;
function reminderTimesOf(row) {
  if (Array.isArray(row.reminder_minutes) && row.reminder_minutes.length) return [...row.reminder_minutes];
  return row.reminder_minute !== null && row.reminder_minute !== undefined ? [row.reminder_minute] : [];
}
// Bedingung je Erinnerungszeit eines Zählers (Nutzer-Entscheidung 2026-10-28): "erinnere zur
// i-ten Zeit, falls weniger als X" - X aus payload.reminderBelow (verschlüsselt), null = zu
// jeder Zeit. Entweder alle Zeiten haben eine Zahl oder keine, aufsteigend (geprüft beim
// Speichern) - nur so ergeben die erreichten Bedingungen eine Stufe, die der Server mit der
// Position der Zeit vergleichen kann (siehe reminderProgress). Felder, die noch ohne
// reminderBelow gespeichert sind, verteilen ein Ziel "mindestens G" gleichmäßig: ceil(G·i/n).
export function counterReminderThresholds(h) {
  const n = h.reminderTimes.length;
  if (Array.isArray(h.reminderBelow)) return h.reminderTimes.map((_, i) => (Number.isFinite(h.reminderBelow[i]) ? h.reminderBelow[i] : null));
  if (hasDayGoal(h) && h.goal.dir !== 'low') return h.reminderTimes.map((_, i) => Math.ceil((h.goal.target * (i + 1)) / n - 1e-9));
  return h.reminderTimes.map(() => null);
}
// Noch nicht umgestellte Zeile (Klartext-Spalten) -> dieselbe payload-Form.
export function defPayloadFromPlainRow(row) {
  return {
    key: row.slug,
    name: row.name,
    unit: row.unit ?? null,
    min: row.min ?? null,
    max: row.max ?? null,
    labels: row.labels ?? null,
    good: row.good ?? null,
    displayStyle: row.display_style ?? 'buttons',
    sliderShowValue: row.slider_show_value ?? true,
    groupMembers: row.group_members ?? null,
    goalThreshold: row.goal_threshold ?? null,
    aggregate: null, // Berechnungen aus Zahlen gibt es erst seit der Verschlüsselung - Klartext-Zeilen sind nie welche
    hideInStats: false,
    archivedInStats: false,
  };
}
// Klartext-Spalten einer verschlüsselten Zeile - leer bzw. auf dem neutralen Default
// (display_style/slider_show_value sind NOT NULL), genau wie die DB-Schutzregel verlangt.
export const DEF_PLAINTEXT_CLEARED = {
  slug: null, name: null, min: null, max: null, labels: null, good: null, unit: null,
  goal_threshold: null, group_members: null, display_style: 'buttons', slider_show_value: true,
};
// Neue Felder bekommen einen zufälligen Schlüssel statt eines aus dem Namen abgeleiteten
// (der frühere slug "gekifft" verriet den Namen). Bestehende Felder behalten ihren alten
// Schlüssel - der steht nur noch verschlüsselt (in enc und in habit_entries.data).
export function newHabitKey() {
  const existing = new Set([...state.habits, ...state.unsupportedHabits].map((h) => h.id));
  let key;
  do {
    key = 'f' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');
  } while (existing.has(key));
  return key;
}
// Stellt noch unverschlüsselte Felder auf enc um (beim Laden, im Hintergrund - nur das
// Gerät hat den Schlüssel, der Server kann das nicht selbst). Vor dem Speichern wird
// lokal zur Kontrolle wieder entschlüsselt und verglichen - stimmt das nicht exakt,
// bleibt die Zeile unverändert (lieber noch Klartext als ein unlesbares Feld). Nur für
// Zeilen, die noch kein enc haben (.is('enc', null)) - läuft die Umstellung auf zwei
// Geräten gleichzeitig, gewinnt einfach die erste.
export async function migrateHabitDefinitions(rows) {
  for (const row of rows) {
    try {
      const payload = defPayloadFromPlainRow(row);
      const enc = await encryptData(currentDek, payload);
      const check = await decryptData(currentDek, enc);
      if (JSON.stringify(check) !== JSON.stringify(payload)) {
        console.error('[Logbuch] Kontroll-Entschlüsselung weicht ab, Feld bleibt vorerst unverschlüsselt', row.id);
        continue;
      }
      const { error } = await supabase.from('habit_definitions')
        .update({ enc, ...DEF_PLAINTEXT_CLEARED })
        .eq('id', row.id)
        .is('enc', null);
      if (error) console.error('[Logbuch] Feld-Umstellung fehlgeschlagen, nächster Versuch beim nächsten Laden', row.id, error.message);
    } catch (err) {
      console.error('[Logbuch] Feld-Umstellung fehlgeschlagen', row.id, err);
    }
  }
}
// Lokale Namensliste für Erinnerungen (siehe sw.js): der Server schickt nur Feld- bzw.
// Gruppen-IDs, der Service Worker setzt daraus auf dem Gerät die Namen ein. Liegt nur auf diesem
// Gerät (wie der DEK-Cache), wird bei jeder Änderung der Felder oder der Sprache neu
// geschrieben (auch der Gruppen) und bei der Konto-Löschung entfernt.
function openPushDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('logbuch-push', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('meta');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function saveFieldNamesForPush() {
  try {
    const names = Object.fromEntries(state.habits.filter((h) => h.kind !== 'computed').map((h) => [h.defId, h.name]));
    const sectionNames = Object.fromEntries(state.sections.map((sec) => [sec.id, sec.name]));
    const db = await openPushDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({
        names, template: t('push.customReminder'), counterTemplate: t('push.counterReminder'),
        sectionNames, sectionTemplate: t('push.sectionReminder'),
      }, 'fieldNames');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* IndexedDB nicht verfügbar - Erinnerungen bleiben dann beim allgemeinen Text */ }
}
export async function clearFieldNamesForPush() {
  try {
    const db = await openPushDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').delete('fieldNames');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* egal, nur lokaler Cache */ }
}

export function isNumberKind(h) { return h.kind === 'number'; }
// Zähler (kind 'counter', Nutzer-Entscheidung 2026-10-11): eine Zahl, die man im Lauf des
// Zeitraums per "+" hochzählt. Ohne Antippen gilt 0 - auch in der Auswertung (ab dem Anlegen,
// bis heute) und für Erinnerungen (nie "fehlend", siehe Migration add_counter_kind).
export function isCounterKind(h) { return h.kind === 'counter'; }

// --- Gruppen (intern: sections): Anordnung -------------------------------------
// "Gruppe" in der App = "section" im Code/in der DB (habit_sections) - NICHT zu
// verwechseln mit berechneten Feldern (kind='computed'), die bis 2026-09-27 "Gruppen"
// hießen. Oberste Ebene: Felder ohne Gruppe und Gruppen gemeinsam nach sort_order (frei
// untereinander anordenbar), die Felder einer Gruppe darin nach ihrem eigenen
// sort_order (gilt nur innerhalb ihres Behälters). Ein Feld mit unbekannter Gruppe
// (sollte nicht vorkommen) gilt als "ohne Gruppe". Leere Gruppen werden mitgeliefert,
// die Aufrufer entscheiden, ob sie sie zeigen.
export function layoutBlocks(habits) {
  const sectionIds = new Set(state.sections.map((sec) => sec.id));
  const blocks = [
    ...habits.filter((h) => !h.sectionId || !sectionIds.has(h.sectionId))
      .map((h) => ({ type: 'habit', habit: h, sortOrder: h.sortOrder })),
    ...state.sections.map((sec) => ({
      type: 'section', section: sec, sortOrder: sec.sortOrder,
      habits: habits.filter((h) => h.sectionId === sec.id).sort((a, b) => a.sortOrder - b.sortOrder),
    })),
  ];
  return blocks.sort((a, b) => a.sortOrder - b.sortOrder || (a.type === b.type ? 0 : a.type === 'section' ? 1 : -1));
}
// Höchster sort_order in einem Behälter (Gruppe bzw. oberste Ebene) - neue oder in
// eine andere Gruppe verschobene Felder kommen ans Ende.
export function containerMaxSortOrder(sectionId) {
  const active = state.habits.filter((h) => !h.archivedAt);
  if (sectionId) return Math.max(0, ...active.filter((h) => h.sectionId === sectionId).map((h) => h.sortOrder));
  const sectionIds = new Set(state.sections.map((sec) => sec.id));
  return Math.max(0,
    ...active.filter((h) => !h.sectionId || !sectionIds.has(h.sectionId)).map((h) => h.sortOrder),
    ...state.sections.map((sec) => sec.sortOrder));
}
// Eingeklappt-Zustand pro Gerät, getrennt für "Heute" (scope 'today') und die
// Auswertungs-Ansichten (scope 'stats') - in "Heute" klappt man eher Seltenes weg, in
// der Auswertung will man es trotzdem sehen können.
export function isSectionCollapsed(scope, id) {
  try { return localStorage.getItem(`sectionCollapsed:${scope}:${id}`) === '1'; } catch { return false; }
}
export function setSectionCollapsed(scope, id, collapsed) {
  try {
    if (collapsed) localStorage.setItem(`sectionCollapsed:${scope}:${id}`, '1');
    else localStorage.removeItem(`sectionCollapsed:${scope}:${id}`);
  } catch { /* privater Modus o.ä. - wirkt dann nur bis zum nächsten Neuladen nicht */ }
}
// Wie sich eine Gruppe in "Heute" einklappt (Gruppen-Formular, verschlüsselt mit dem Namen
// in habit_sections.enc): 'done' (Standard) klappt eine Gruppe zu, in der für den Tag alles
// eingetragen ist - aber nur beim Betreten des Tages (Öffnen der App, Tag- oder
// Ansichtswechsel, Rückkehr nach längerer Pause), nie während man einträgt: wer einen Wert
// nach kurzem Innehalten nochmal ändert, dem darf die Gruppe nicht unter den Fingern
// zuklappen. 'start' startet bei jedem Betreten eingeklappt, 'manual' nur von Hand,
// 'never' ist eine reine Überschrift ohne Zuklappen (auch in der Auswertung).
export const SECTION_COLLAPSE_MODES = ['done', 'manual', 'start', 'never'];
// Für den aktuellen Besuch eines Tages automatisch eingeklappte Gruppen. null = beim
// nächsten Zeichnen von "Heute" neu bestimmen (siehe invalidateTodayAutoCollapse).
let todayAutoCollapse = null; // { dateKey, ids: Set }
export function invalidateTodayAutoCollapse() { todayAutoCollapse = null; }
export function sectionDoneOn(habits, dayEntry) {
  const tracked = habits.filter((h) => h.kind !== 'computed' && !h.optional);
  return tracked.length > 0 && !tracked.some((h) => isOpenToday(h, dayEntry));
}
function todayAutoCollapsedIds(blocks, dateKey) {
  if (todayAutoCollapse?.dateKey === dateKey) return todayAutoCollapse.ids;
  const dayEntry = state.entries[dateKey] || {};
  const ids = new Set(blocks
    .filter((b) => b.type === 'section' && (b.section.collapse === 'start' || (b.section.collapse === 'done' && sectionDoneOn(b.habits, dayEntry))))
    .map((b) => b.section.id));
  // Erst mit geladenen Einträgen festhalten - sonst wäre beim Start noch nichts "erledigt".
  if (!state.loading) todayAutoCollapse = { dateKey, ids };
  return ids;
}
// Aufklappen (von Hand oder per Sprung zu einem Feld) hebt beides auf.
export function expandSection(scope, id) {
  setSectionCollapsed(scope, id, false);
  if (scope === 'today') todayAutoCollapse?.ids.delete(id);
}
// doneFields (nur "Heute"): die Felder, die für "✓ erledigt" eingetragen sein müssen. Die
// Markierung steht immer im DOM (versteckt, solange etwas offen ist), damit
// syncTodayOpenMarkers sie beim Tippen in Text-Feldern ohne Neuzeichnen umschalten kann.
function renderSectionToggle(section, scope, collapsed, hasOpen = false, doneFields = null) {
  const doneMarker = doneFields
    ? `<span class="section-done" data-done-fields="${doneFields.map((h) => h.id).join(' ')}"${sectionDoneOn(doneFields, state.entries[formatKey(state.currentDate)] || {}) ? '' : ' hidden'}>${t('today.sectionDone')}</span>`
    : '';
  const marker = hasOpen
    ? `<span class="open-dot" aria-hidden="true"></span><span class="visually-hidden">${t('today.sectionHasOpen')}</span>`
    : doneMarker;
  const toggle = section.collapse === 'never'
    ? `<div class="section-toggle section-toggle--${scope} section-toggle--static"><span>${esc(section.name)}${doneMarker}</span></div>`
    : `
    <button type="button" class="section-toggle section-toggle--${scope}" data-action="section-toggle" data-section="${section.id}" data-scope="${scope}" aria-expanded="${!collapsed}">
      <svg class="section-chevron" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>${esc(section.name)}${marker}</span>
    </button>
  `;
  // Nur in "Heute" mit Zeilen-Menü (siehe renderRowMenuButton), in der Auswertung nicht.
  if (scope !== 'today') return toggle;
  return `
    <div class="section-head">
      ${renderRowMenuButton(`section:${section.id}`, t('today.sectionOptions', { name: section.name }))}
      ${toggle}
      ${renderSectionMenuPanel(section)}
    </div>
    ${renderNote(formatKey(state.currentDate), `section:${section.id}`, t('note.labelSection', { name: section.name }))}
  `;
}
// Rendert Felder nach Gruppen geordnet, in der Reihenfolge der Verwaltung:
// aufeinanderfolgende Felder ohne Gruppe als ein Stück, jede (nicht leere) Gruppe
// mit einklappbarer Überschrift. renderList bekommt jeweils ein Array von Feldern.
export function renderBySection(habits, scope, renderList) {
  const out = [];
  let run = [];
  const flush = () => { if (run.length) { out.push(renderList(run)); run = []; } };
  const blocks = layoutBlocks(habits);
  const dateKey = formatKey(state.currentDate);
  const autoCollapsed = scope === 'today' ? todayAutoCollapsedIds(blocks, dateKey) : new Set();
  for (const block of blocks) {
    if (block.type === 'habit') { run.push(block.habit); continue; }
    if (!block.habits.length) continue;
    flush();
    const collapsed = block.section.collapse !== 'never'
      && (isSectionCollapsed(scope, block.section.id) || autoCollapsed.has(block.section.id));
    // Eingeklappt verdeckt die Gruppe die Punkte ihrer offenen Felder - dann trägt die
    // Überschrift den Punkt (siehe isOpenToday), bzw. "erledigt", wenn nichts mehr offen ist.
    const dayEntry = state.entries[dateKey] || {};
    const hasOpen = scope === 'today' && collapsed && block.habits.some((h) => isOpenToday(h, dayEntry));
    const doneFields = scope === 'today' ? block.habits.filter((h) => h.kind !== 'computed') : null;
    out.push(`<div class="section-block section-block--${scope}${collapsed ? ' section-block--collapsed' : ''}">${renderSectionToggle(block.section, scope, collapsed, hasOpen, doneFields)}${collapsed ? '' : `<div class="section-content">${renderList(block.habits)}</div>`}</div>`);
  }
  flush();
  return out.join('');
}
// Ob ein Feld in den Auswertungs-Ansichten (Woche/Monat/Jahr/Gesamt) auftaucht - pro Feld
// abschaltbar ("In der Auswertung anzeigen"), z.B. wenn einem ein berechnetes Feld daraus
// reicht. Archivierte Felder sind dort standardmäßig ausgeblendet (seit 2026-09-27), lassen
// sich aber in der Verwaltung einzeln wieder einblenden (archivedInStats) - z.B. um die
// Vorgeschichte eines abgelösten Felds zu sehen (Skala ändern = archivieren + neu anlegen).
// Wirkt nur auf die Anzeige: die Tages-Gesamtfarbe (dayOverallScore) und berechnete
// Felder, in denen das Feld Mitglied ist, rechnen unverändert mit.
// Zeitraum-Felder haben (noch) keine eigene Darstellung in der Auswertung - ihr Wert steht
// am ersten Tag des Zeitraums und sähe dort wie ein Tageswert aus.
export function inStats(h) { return !isPeriodField(h) && (h.archivedAt ? h.archivedInStats : !h.hideInStats); }
// Berechnete Felder (kind='computed', bis 2026-09-27 "Gruppen" genannt) gibt es in zwei
// Arten: aus Skalen (Durchschnitt der normalisierten Bewertungen, mit Farbe/Ziel-Quote -
// der ursprüngliche Fall) und aus Zahlen (fassen Zahlenwert-Felder derselben Einheit per
// Summe/Durchschnitt/Minimum/Maximum zusammen, ohne Bewertung - verhalten sich in der
// Auswertung wie ein Zahlenwert-Feld). Unterschieden über aggregate: gesetzt = aus Zahlen.
export function isNumberComputed(h) { return h.kind === 'computed' && !!h.aggregate; }
// Dauer zwischen zwei Uhrzeit-Feldern (aggregate 'duration', Mitglieder [von, bis]): verhält
// sich wie ein berechnetes Zahlen-Feld in Stunden.
export function isDurationComputed(h) { return h.kind === 'computed' && h.aggregate === 'duration'; }
// "Tage seit …" (aggregate 'since', genau ein Mitglied = das Quellfeld): zählt die Tage seit
// einem passenden Eintrag im Quellfeld. h.since = { values, atLeast, mode }: values = die
// zählenden Stufen einer Skala mit Knöpfen (bis CHOICE_STEP_CAP Stufen), sonst atLeast =
// zählt ab diesem Wert (Zahl, Zähler, Skala mit Regler). mode 'last' = seit dem letzten
// passenden Tag (am Tag selbst 0), 'start' = seit dem ersten Tag einer Reihe (Tag 1), wobei
// Lücken bis SINCE_RUN_GAP_DAYS noch zur Reihe gehören - so wird aus "Periode" der Zyklustag,
// ohne dass ein vergessener Tag mitten in der Periode neu zu zählen beginnt.
export function isSinceComputed(h) { return h.kind === 'computed' && h.aggregate === 'since'; }
const SINCE_SOURCE_KINDS = ['scale', 'number', 'counter'];
const SINCE_RUN_GAP_DAYS = 7;
export function sinceUsesStages(src) { return src.kind === 'scale' && src.max - src.min + 1 <= CHOICE_STEP_CAP; }
export function sinceSourceCandidate(h) { return SINCE_SOURCE_KINDS.includes(h.kind) && !isPeriodField(h); }
function sinceMatches(h, src, v) {
  if (typeof v !== 'number') return false;
  if (sinceUsesStages(src)) return Array.isArray(h.since?.values) && h.since.values.includes(v);
  return Number.isFinite(h.since?.atLeast) && v >= h.since.atLeast;
}
// Passende Tage (Tagesnummern, aufsteigend) samt Beginn ihrer Reihe - einmal je Stand der
// Einträge berechnet (state.entries wird bei jeder Änderung durch ein neues Objekt ersetzt),
// sonst liefe die Jahresansicht für jeden Tag erneut über alle Einträge.
let sinceCache = { entries: null, byHabit: new Map() };
function sinceDays(h) {
  if (sinceCache.entries !== state.entries) sinceCache = { entries: state.entries, byHabit: new Map() };
  const src = computedMemberHabits(h)[0];
  const cached = sinceCache.byHabit.get(h);
  if (cached && cached.src === src) return cached;
  const days = src ? Object.keys(state.entries).filter((k) => sinceMatches(h, src, state.entries[k]?.[src.id])).map(dayIndex).sort((a, b) => a - b) : [];
  const runStart = [];
  days.forEach((d, i) => runStart.push(i > 0 && d - days[i - 1] <= SINCE_RUN_GAP_DAYS ? runStart[i - 1] : d));
  const result = { src, days, runStart };
  sinceCache.byHabit.set(h, result);
  return result;
}
export function sinceComputedDay(h, dateKey) {
  if (isFutureKey(dateKey)) return { value: null, filled: 0, total: 1 }; // weiter gezählt wird erst, wenn der Tag da ist
  const { days, runStart } = sinceDays(h);
  const d = dayIndex(dateKey);
  let lo = 0, hi = days.length - 1, i = -1; // letzter passender Tag <= d
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] <= d) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  const value = i < 0 ? null : h.since?.mode === 'start' ? d - runStart[i] + 1 : d - days[i];
  return { value, filled: value === null ? 0 : 1, total: 1 };
}
// Welche Einträge zählen, als Text ("leicht, mittel, stark" bzw. "ab 2").
export function sinceWhichText(h) {
  const src = computedMemberHabits(h)[0];
  if (!src) return '–';
  if (sinceUsesStages(src)) return (h.since?.values || []).map((v) => valueAsText(src, v)).join(', ') || '–';
  return tPlain('since.atLeast', { n: formatNumber(h.since?.atLeast ?? 0) });
}
// Felder mit Gut/Schlecht-Score (Farben, Heatmap, Prozent-Statistik).
// Zahlen und Zähler mit Ziel ("mindestens/höchstens X", Nutzer-Entscheidung 2026-10-11) sind
// ebenfalls bewertet - ohne Ziel bleiben sie ein neutraler Verlauf.
// Ziel als { dir: 'high'|'low'|'range', target, max (nur 'range'), scope: 'day'|'week' } (G3,
// Nutzer-Entscheidung 2026-11-10). "Mindestens/höchstens pro Tag" einer Zahl bzw. eines Zählers
// steht weiter in good/target - so lesen es auch ältere App-Versionen. Bereich, Wochensumme und
// Ziele berechneter Felder stehen in payload.numberGoal: ältere Versionen kennen den Schlüssel
// nicht und zeigen das Feld dann ohne Ziel statt falsch bewertet (eine Wochensumme in good/target
// wäre dort ein Tagesziel). Berechnete Felder tragen in good teils ein bedeutungsloses 'high'
// (siehe habitToForm), deshalb bei ihnen nie aus good.
export function goalFromPayload(kind, payload) {
  const g = payload.numberGoal;
  if (g && ['high', 'low', 'range'].includes(g.dir) && Number.isFinite(g.target)) {
    if (g.dir === 'range' && !(Number.isFinite(g.max) && g.max >= g.target)) return null;
    return { dir: g.dir, target: g.target, max: g.dir === 'range' ? g.max : null, scope: g.scope === 'week' && g.dir !== 'range' ? 'week' : 'day' };
  }
  if ((kind === 'number' || kind === 'counter') && (payload.good === 'high' || payload.good === 'low') && Number.isFinite(payload.target)) {
    return { dir: payload.good, target: payload.target, max: null, scope: 'day' };
  }
  return null;
}
// Einheit hinter Zielzahlen: Dauern in Stunden, berechnete Felder die ihrer Mitglieder.
function goalUnit(h) { return isDurationComputed(h) ? 'h' : isNumberComputed(h) ? computedUnit(h) : h.unit; }
function goalValueText(h) {
  const g = h.goal;
  return (g.dir === 'range' ? `${formatNumber(g.target)}–${formatNumber(g.max)}` : formatNumber(g.target)) + (goalUnit(h) ? ` ${goalUnit(h)}` : '');
}
export function numberGoalText(h) {
  const key = h.goal.dir === 'high' ? 'numberGoal.min' : h.goal.dir === 'low' ? 'numberGoal.max' : 'numberGoal.range';
  return tPlain(key + (h.goal.scope === 'week' ? 'Week' : ''), { value: goalValueText(h) });
}
// Ziele gibt es für Zahlen, Zähler und berechnete Zahlen-Felder (nicht "Tage seit" - dort ist
// das Hochzählen selbst das Ziel). Ein Wochenziel bewertet nie den einzelnen Tag (siehe
// weekGoalWeeks), das Feld bleibt in der Auswertung ein Verlauf wie eine Zahl ohne Ziel.
export function hasNumberGoal(h) { return !!h.goal && (isNumberKind(h) || isCounterKind(h) || (isNumberComputed(h) && !isSinceComputed(h))); }
export function hasDayGoal(h) { return hasNumberGoal(h) && h.goal.scope !== 'week'; }
export function hasWeekGoal(h) { return hasNumberGoal(h) && h.goal.scope === 'week'; }
export function isScoredKind(h) { return h.kind === 'scale' || (h.kind === 'computed' && !h.aggregate) || hasDayGoal(h); }
// Wie gut ein Zahlenwert das Ziel trifft (0-1): "mindestens 8" -> 4 ist 0,5; "höchstens 3" ->
// bis 3 voll, darüber linear abnehmend, ab dem Doppelten (mind. Ziel + 1) 0. Bereich: darin
// voll, darunter wie "mindestens Untergrenze", darüber wie "höchstens Obergrenze".
export function goalScore(goal, v) {
  if (v === null || v === undefined) return null;
  const atLeast = (lo) => (lo > 0 ? Math.max(0, Math.min(1, v / lo)) : 1);
  const atMost = (hi) => (v <= hi ? 1 : Math.max(0, 1 - (v - hi) / Math.max(hi, 1)));
  if (goal.dir === 'high') return atLeast(goal.target);
  if (goal.dir === 'low') return atMost(goal.target);
  return v < goal.target ? atLeast(goal.target) : atMost(goal.max);
}
export function numberGoalScore(h, v) { return goalScore(h.goal, v); }
// Wochensumme eines Felds mit Wochenziel (Woche ab dem eingestellten Wochenbeginn, siehe
// startOfWeek): count = Tage mit Wert. Ein Zähler zählt leere vergangene Tage als 0.
function weekGoalSum(h, weekStart) {
  let sum = 0, count = 0;
  for (let i = 0; i < 7; i++) {
    const v = habitNumericValue(h, formatKey(addDays(weekStart, i)));
    if (v !== null && v !== undefined) { sum += v; count++; }
  }
  return { sum, count };
}
// Die Wochen, deren letzter Tag in dateKeys liegt (eine Woche über den Monatswechsel gehört zu
// dem Monat, in dem sie endet - sonst zählte sie in beiden oder in keinem). Bewertet wird eine
// Woche erst, wenn sie vorbei ist (Nutzer-Entscheidung 2026-11-10: die laufende zeigt nur den
// Stand), und nur mit mindestens einem Wert (vor dem Anlegen bzw. ohne Einträge gibt es nichts
// zu bewerten).
export function weekGoalWeeks(h, dateKeys) {
  const inRange = new Set(dateKeys);
  const todayKey = formatKey(new Date());
  const starts = [...new Set(dateKeys.map((k) => formatKey(startOfWeek(parseDateKey(k)))))];
  return starts.map((sk) => {
    const start = parseDateKey(sk);
    const lastKey = formatKey(addDays(start, 6));
    const { sum, count } = weekGoalSum(h, start);
    const complete = lastKey < todayKey;
    return { start: sk, lastKey, sum, count, complete, judged: complete && count > 0 && inRange.has(lastKey), score: goalScore(h.goal, sum) };
  });
}
// Zeile unter dem Verlauf: eine einzelne Woche mit ihrer Summe, längere Zeiträume mit
// "in n von m Wochen erreicht".
export function weekGoalChartNote(h, dateKeys) {
  const weeks = weekGoalWeeks(h, dateKeys);
  if (weeks.length === 1) {
    const w = weeks[0];
    if (!w.count) return '';
    const text = tPlain(w.complete ? 'weekGoal.sum' : 'weekGoal.sumRunning', { sum: formatNumber(round1(w.sum)) + (goalUnit(h) ? ` ${goalUnit(h)}` : '') });
    const color = w.complete ? scoreTextColor(scoreColor(w.score)) : 'var(--sand)';
    return `<p class="number-chart-goal" style="color:${color}">${esc(text)}</p>`;
  }
  const judged = weeks.filter((w) => w.judged);
  if (!judged.length) return '';
  const hits = judged.filter((w) => w.score >= 0.999).length;
  return `<p class="number-chart-goal">${esc(tPlain('stats.goalHits.week', { n: hits, total: judged.length }))}</p>`;
}
// "Heute" bei einem Wochenziel: der Stand der Woche des angezeigten Tags, ohne Farbe (die
// laufende Woche wird nicht bewertet).
export function weekGoalTodayHtml(h, dateKey) {
  const { sum } = weekGoalSum(h, startOfWeek(parseDateKey(dateKey)));
  const unit = goalUnit(h) ? ` ${goalUnit(h)}` : '';
  return `<span class="week-goal-progress">${t(h.goal.dir === 'high' ? 'today.weekGoal.high' : 'today.weekGoal.low', { sum: formatNumber(round1(sum)) + unit, target: formatNumber(h.goal.target) + unit })}</span>`;
}
// Felder mit Zahlen-Verlauf (Graph statt Farbe).
export function hasNumericSeries(h) { return isNumberKind(h) || isCounterKind(h) || isNumberComputed(h) || isTimeKind(h); }
// Nur Mitglieder vom passenden Typ: der Typ eines Mitglieds lässt sich ändern, solange es
// noch keine Daten hat - ein Skala-Mittelwert über ein inzwischen zum Zahlenwert gewordenes
// Feld ergäbe sonst NaN (und umgekehrt).
export function computedMemberHabits(h) {
  const members = (h.members || []).map((key) => state.habits.find((x) => x.id === key));
  if (h.aggregate === 'since') return members.filter((m) => m && sinceSourceCandidate(m)).slice(0, 1);
  const kind = h.aggregate === 'duration' ? 'time' : h.aggregate ? 'number' : 'scale';
  return members.filter((m) => m && m.kind === kind);
}
// Einheit eines berechneten Zahlen-Felds = die (gemeinsame, im Formular erzwungene) Einheit seiner Mitglieder.
export function computedUnit(h) { return isDurationComputed(h) ? 'h' : isSinceComputed(h) ? null : computedMemberHabits(h)[0]?.unit || null; }
// Tageswert eines berechneten Zahlen-Felds aus den an dem Tag eingetragenen Mitgliedern (bei der
// Summe zählt ein nicht eingetragenes Mitglied also als 0). Ist gar keins eingetragen,
// gibt es keinen Wert (null) statt 0 - sonst sähe ein vergessener Tag aus wie ein Tag
// mit echtem Wert 0.
export function numberComputedDay(h, dateKey) {
  if (isDurationComputed(h)) return durationComputedDay(h, dateKey);
  if (isSinceComputed(h)) return sinceComputedDay(h, dateKey);
  const members = computedMemberHabits(h);
  const day = state.entries[dateKey] || {};
  const values = members.map((m) => day[m.id]).filter((v) => typeof v === 'number');
  let value = null;
  if (values.length) {
    if (h.aggregate === 'sum') value = values.reduce((a, b) => a + b, 0);
    else if (h.aggregate === 'avg') value = values.reduce((a, b) => a + b, 0) / values.length;
    else if (h.aggregate === 'min') value = Math.min(...values);
    else if (h.aggregate === 'max') value = Math.max(...values);
    // Rundung gegen Gleitkomma-Reste (0.1 + 0.2 = 0.30000000000000004)
    if (value !== null) value = Math.round(value * 100) / 100;
  }
  return { value, filled: values.length, total: members.length };
}
// Dauer an einem Tag = "bis" an diesem Tag minus das letzte "von" davor (bis zu
// DURATION_LOOKBACK_DAYS zurück) - so geht es über Mitternacht und über mehr als 24 Stunden,
// und ein "von" später am selben Tag (abends wieder ins Bett) zählt erst für den nächsten.
const DURATION_LOOKBACK_DAYS = 7;
export function durationComputedDay(h, dateKey) {
  const [fromKey, toKey] = h.members || [];
  const from = state.habits.find((x) => x.id === fromKey && isTimeKind(x));
  const to = state.habits.find((x) => x.id === toKey && isTimeKind(x));
  const end = to ? state.entries[dateKey]?.[to.id] : undefined;
  let start = null;
  let endAt = null;
  if (from && typeof end === 'number') {
    endAt = dayIndex(dateKey) * MINUTES_PER_DAY + end;
    const base = parseDateKey(dateKey);
    for (let i = 0; i <= DURATION_LOOKBACK_DAYS; i++) {
      const key = formatKey(addDays(base, -i));
      const v = state.entries[key]?.[from.id];
      if (typeof v !== 'number') continue;
      const at = dayIndex(key) * MINUTES_PER_DAY + v;
      if (at < endAt && (start === null || at > start)) start = at;
    }
  }
  const value = start === null ? null : Math.round(((endAt - start) / 60) * 100) / 100;
  return { value, filled: (typeof end === 'number' ? 1 : 0) + (start !== null ? 1 : 0), total: 2 };
}
// Zahlenwert eines Felds an einem Tag - Zahlenwert-Feld direkt, berechnetes Zahlen-Feld berechnet.
export function habitNumericValue(h, dateKey) {
  if (isNumberComputed(h)) return numberComputedDay(h, dateKey).value;
  const v = state.entries[dateKey]?.[h.id];
  if (v === undefined && isCounterKind(h)) return counterZeroApplies(h, dateKey) ? 0 : null;
  return v === undefined ? null : v;
}
// Leerer Tag (bzw. Zeitraum) eines Zählers = 0 - aber nur zwischen Anlegen und gestern: der
// laufende Tag zählt erst, wenn getippt wurde (sonst wäre "mindestens 8" schon morgens rot und
// der Schnitt gedrückt), davor und in der Zukunft stünden sonst Nullen außerhalb seiner Zeit.
function counterZeroApplies(h, dateKey) {
  const period = h.period || 'day';
  const since = h.counterSince ? parseDateKey(h.counterSince) : h.createdAt ? new Date(h.createdAt) : null;
  const created = since ? formatKey(periodStart(period, since)) : null;
  const now = formatKey(periodStart(period, new Date()));
  return (!created || dateKey >= created) && dateKey < now;
}
export function isTextKind(h) { return h.kind === 'text'; }

// Uhrzeit-Felder (kind 'time', Nutzer-Entscheidung 2026-10-29): ein Zeitpunkt pro Tag, z.B.
// "ins Bett" oder "aufgestanden". Eingetragen wird immer auf dem Tag, den man gerade ansieht
// (nie eigenmächtig auf einem anderen). Wert = Minuten ab Mitternacht dieses Tages; ab 1440
// liegt der Zeitpunkt auf dem nächsten Kalendertag ("ins Bett" Dienstag um 0:30 Mittwoch früh =
// 1470) - in "Heute" sichtbar und umschaltbar am Tag neben der Uhrzeit. Gerechnet wird mit
// Wanduhr-Zeit über Tagesnummern: eine Dauer über die Nacht der Zeitumstellung liegt eine
// Stunde daneben (bewusst hingenommen).
export function isTimeKind(h) { return h.kind === 'time'; }
// Mehrfachauswahl (kind 'multi'): mehrere Optionen pro Tag ankreuzen, z.B. was heute war. Wert =
// Array der Options-Ids (stabil, damit Umbenennen nichts verschiebt), [] = "nichts davon" (zählt
// als eingetragen). h.options = [{ id, label, hidden }]: schon gewählte Optionen lassen sich nicht
// entfernen, nur ausblenden - dann nicht mehr in "Heute" (außer am Tag, an dem sie gewählt ist),
// in der Auswertung weiter, solange sie im Zeitraum vorkommt. Keine Bewertung, nur Tagesfelder.
export function isMultiKind(h) { return h.kind === 'multi'; }
export const MULTI_MAX_OPTIONS = 20;
export function multiValue(h, dateKey) {
  const v = state.entries[dateKey]?.[h.id];
  return Array.isArray(v) ? v : null;
}
export function multiOptionUsed(habitId, optionId) {
  return Object.values(state.entries).some((day) => Array.isArray(day?.[habitId]) && day[habitId].includes(optionId));
}
export function newMultiOptionId() { return crypto.randomUUID().slice(0, 8); }
export function emptyMultiOptions() { return [{ id: newMultiOptionId(), label: '' }, { id: newMultiOptionId(), label: '' }]; }
export const MINUTES_PER_DAY = 1440;
function dayIndex(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
// Wie viele Kalendertage nach dem Tag des Eintrags der Zeitpunkt liegt (0 = derselbe).
export function timeDayOffset(v) { return Math.floor(v / MINUTES_PER_DAY); }
// Ein Zeitpunkt als Wert auf dem Tag dateKey ("Jetzt", "+20 min" - auch auf der Seite von gestern).
export function timeValueOn(dateKey, moment) {
  return (dayIndex(formatKey(moment)) - dayIndex(dateKey)) * MINUTES_PER_DAY + moment.getHours() * 60 + moment.getMinutes();
}
// Uhrzeit zum Anzeigen: 12 oder 24 Stunden nach der Region des Geräts (clockUses12h).
export function formatClock(v) {
  const m = ((Math.round(v) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (!clockUses12h()) return minutesToTimeStr(m);
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
// Dauer in Stunden als "7:30" (Stunden:Minuten statt 7,5 - so liest man Schlaf).
export function formatDuration(hours) {
  const total = Math.round(Math.abs(hours) * 60);
  return `${hours < 0 ? '-' : ''}${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
