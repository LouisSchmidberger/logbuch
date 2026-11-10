import { supabase } from './config.js?v=90bbeaa075';
import { ENCRYPT_PAD_BLOCK, base64ToBuf, decryptData, encryptData } from './crypto.js?v=90bbeaa075';
import { SECTION_COLLAPSE_MODES, defPayloadFromPlainRow, habitFromParts, migrateHabitDefinitions, saveFieldNamesForPush } from './fields.js?v=90bbeaa075';
import { WEEK_STARTS, addDays, formatKey, parseDateKey, startOfDay, startOfWeek, startOfWeekWith } from './dates.js?v=90bbeaa075';
import { currentDek, runtime, state } from './state.js?v=90bbeaa075';
import { applyLocale, detectInitialLocale, t, tPlain } from './i18n.js?v=90bbeaa075';
import { errorNotice } from './format.js?v=90bbeaa075';
import { rewriteDays } from './type-change.js?v=90bbeaa075';
import { NOTES_KEY, PREV_KEY, renderUnlessTyping, syncedEntries } from './save.js?v=90bbeaa075';
import { pushOffStatus } from './device.js?v=90bbeaa075';
import { unseenChangelog } from './about-view.js?v=90bbeaa075';
import { render } from './main-view.js?v=90bbeaa075';

// --- Datenzugriff --------------------------------------------------------
// PostgREST liefert höchstens api.max_rows (1000) Zeilen pro Anfrage und kappt still -
// bei den Tages-Einträgen wären das nach ~2,7 Jahren täglicher Nutzung nicht mehr alle
// (ohne Sortierung sogar eine zufällige Auswahl). Deshalb seitenweise; buildQuery muss
// eine eindeutige Sortierung setzen, sonst sind die Seiten nicht stabil.
const FETCH_PAGE_SIZE = 1000;
export async function fetchAllRows(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += FETCH_PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) return { data: null, error };
    rows.push(...data);
    if (data.length < FETCH_PAGE_SIZE) return { data: rows, error: null };
  }
}

// { keepLocalChanges: true } (Neuladen nach der Rückkehr in die App): hat sich
// state.entries während des Ladens geändert (jemand hat schon etwas angetippt), wird das
// Ergebnis verworfen statt diese Änderung zu überschreiben - die Speicherung führt sie
// ohnehin mit dem Server-Stand zusammen (saveDay).
export async function loadEntries({ keepLocalChanges = false } = {}) {
  const before = state.entries;
  const dek = currentDek;
  const { data, error } = await fetchAllRows(() =>
    supabase.from('habit_entries').select('entry_date, data').order('entry_date'));
  if (error) {
    state.notice = errorNotice('notice.loadEntriesError', error.message);
    return;
  }
  const map = {};
  const unpadded = [];
  const undecryptable = new Set();
  const synced = new Map();
  for (const row of data) {
    try {
      map[row.entry_date] = row.data ? await decryptData(dek, row.data) : {};
      synced.set(row.entry_date, { day: map[row.entry_date], iv: row.data?.iv ?? null });
      if (row.data && !isPaddedCiphertext(row.data)) unpadded.push(row.entry_date);
    } catch {
      map[row.entry_date] = {};
      undecryptable.add(row.entry_date);
    }
  }
  // Schlüssel inzwischen verworfen (abgemeldet, veraltet) - nichts mehr übernehmen.
  if (currentDek !== dek) return;
  if (keepLocalChanges && state.entries !== before) return;
  state.entries = map;
  unpaddedEntryDates = unpadded;
  runtime.undecryptableEntryDates = undecryptable;
  syncedEntries.clear();
  synced.forEach((v, k) => syncedEntries.set(k, v));
  if (runtime.undecryptableEntryDates.size) {
    state.notice = { type: 'error', text: tPlain('notice.entriesUndecryptable', { count: runtime.undecryptableEntryDates.size }) };
  }
}

// Einträge von vor dem Auffüllen (siehe encryptData) verrieten über ihre Länge weiter,
// an welchen Tagen viel eingetragen/geschrieben wurde - deshalb einmalig neu
// verschlüsselt speichern (von completeAuthFlow bzw. dem Session-Start nach dem Laden
// aufgerufen, im Hintergrund). Nur Tage, die mindestens 2 Tage zurückliegen: an denen
// arbeitet man praktisch nie gerade parallel, ein gleichzeitiges normales Speichern
// könnte sonst von dieser (älteren) Fassung überschrieben werden; neuere Tage werden
// beim nächsten normalen Speichern ohnehin aufgefüllt. Überspringt zusätzlich jeden
// Tag, dessen Inhalt sich seit dem Laden geändert hat (state.entries wird bei jeder
// Änderung durch ein neues Objekt ersetzt). Nicht entschlüsselbare Zeilen stehen gar
// nicht erst in der Liste - die werden nie überschrieben. Upsert nur mit data:
// filled_slugs bleibt unangetastet.
let unpaddedEntryDates = [];
function isPaddedCiphertext(enc) {
  try {
    return (base64ToBuf(enc.ciphertext).byteLength - 16) % ENCRYPT_PAD_BLOCK === 0; // 16 = GCM-Tag
  } catch {
    return true; // unlesbar - nicht anfassen
  }
}
const REPAD_BATCH_SIZE = 50;
export async function repadOldEntries() {
  const cutoff = formatKey(addDays(startOfDay(new Date()), -2));
  const todo = unpaddedEntryDates.filter((k) => k <= cutoff).map((k) => [k, state.entries[k]]);
  unpaddedEntryDates = [];
  for (let i = 0; i < todo.length; i += REPAD_BATCH_SIZE) {
    const batch = todo.slice(i, i + REPAD_BATCH_SIZE).filter(([k, day]) => day && state.entries[k] === day);
    if (!batch.length || !currentDek || !state.session) continue;
    try {
      const rows = await Promise.all(batch.map(async ([k, day]) => ({
        user_id: state.session.user.id, entry_date: k, data: await encryptData(currentDek, day),
      })));
      // Kurz vor dem Absenden nochmal prüfen - dazwischen lag die (asynchrone) Verschlüsselung.
      const stillUnchanged = rows.filter((r) => state.entries[r.entry_date] === batch.find(([k]) => k === r.entry_date)[1]);
      if (!stillUnchanged.length) continue;
      const { error } = await supabase.from('habit_entries').upsert(stillUnchanged, { onConflict: 'user_id,entry_date' });
      if (error) console.error('[Logbuch] Nachträgliches Auffüllen fehlgeschlagen, nächster Versuch beim nächsten Laden', error.message);
      // Neuer Chiffretext = neuer IV - sonst hielte saveDay den eigenen Stand für eine
      // Änderung von einem anderen Gerät (harmlos, aber ein unnötiges Zusammenführen).
      else stillUnchanged.forEach((r) => syncedEntries.set(r.entry_date, { day: state.entries[r.entry_date], iv: r.data.iv }));
    } catch (err) {
      console.error('[Logbuch] Nachträgliches Auffüllen fehlgeschlagen', err);
    }
  }
}

export const SUPPORTED_KINDS = ['scale', 'number', 'counter', 'computed', 'text', 'time', 'multi'];
const SUPPORTED_AGGREGATES = [null, 'sum', 'avg', 'min', 'max', 'duration', 'since'];
function isSupportedHabit(h) {
  return SUPPORTED_KINDS.includes(h.kind) && (h.kind !== 'computed' || SUPPORTED_AGGREGATES.includes(h.aggregate));
}
export async function loadHabits() {
  const { data, error } = await supabase.from('habit_definitions').select('*').order('sort_order');
  if (error) {
    state.notice = errorNotice('notice.loadHabitsError', error.message);
    return;
  }
  const habits = [];
  const unencrypted = [];
  let undecryptable = 0;
  for (const row of data) {
    if (row.enc) {
      try {
        habits.push(habitFromParts(row, await decryptData(currentDek, row.enc)));
      } catch {
        undecryptable++;
      }
    } else {
      habits.push(habitFromParts(row, defPayloadFromPlainRow(row)));
      unencrypted.push(row);
    }
  }
  // Felder eines Typs (bzw. einer Berechnung), den diese App-Version noch nicht kennt - angelegt
  // mit einer neueren Version (z.B. auf der Beta, gleiche Datenbank). Sie bleiben draußen statt
  // halb kaputt angezeigt oder über ein unpassendes Formular überschrieben zu werden; nur
  // filledFieldIds kennt sie noch, damit ihre Werte für die Erinnerungen als eingetragen zählen.
  state.habits = habits.filter(isSupportedHabit);
  state.unsupportedHabits = habits.filter((h) => !isSupportedHabit(h));
  if (undecryptable) state.notice = { type: 'error', text: tPlain('notice.habitsUndecryptable', { count: undecryptable }) };
  if (unencrypted.length) migrateHabitDefinitions(unencrypted);
}

// Gruppen (habit_sections): nur der Name ist verschlüsselt ({name} in enc, gleicher
// DEK). Die Zuordnung Feld -> Gruppe steht als Klartext-Spalte habit_definitions.
// section_id (nur zwei zufällige IDs) - so löst die DB sie beim Löschen einer Gruppe
// selbst (ON DELETE SET NULL) und Umhängen braucht kein Neu-Verschlüsseln des Felds.
export async function loadSections() {
  const { data, error } = await supabase.from('habit_sections').select('*').order('sort_order');
  if (error) {
    state.notice = errorNotice('notice.loadHabitsError', error.message);
    return;
  }
  const sections = [];
  for (const row of data) {
    let name = '?';
    let collapse = 'done';
    try {
      const payload = await decryptData(currentDek, row.enc);
      name = payload.name;
      if (SECTION_COLLAPSE_MODES.includes(payload.collapse)) collapse = payload.collapse;
    } catch { /* unlesbar - Platzhalter statt Absturz */ }
    sections.push({ id: row.id, name, collapse, sortOrder: row.sort_order, reminderMinute: row.reminder_minute ?? null });
  }
  state.sections = sections;
}

// --- Schalter pro Funktion (feature_flags/user_access, siehe docs/freigabe.md) ---
// Eine neue Funktion geht mit dem normalen Live-Gang raus, sichtbar ist sie erst ab ihrer
// Stufe. Schalter sperren nur den Einstieg (z.B. eine Feld-Art im Formular), nie
// vorhandene Daten: wer ein Feld schon hat, sieht es weiter, auch wenn die Stufe sinkt.
// Unbekannte Schalter und ein Ladefehler gelten als aus.
let featureStages = {}; // key -> 'off' | 'owner' | 'testers' | 'all'
export let accessGroup = null; // 'owner' | 'tester' | null (eigene Zeile in user_access)
export function featureVisible(stage, group) {
  return stage === 'all' || (stage === 'testers' && (group === 'tester' || group === 'owner')) || (stage === 'owner' && group === 'owner');
}
// Gerade ohne Aufrufer (keine Funktion hinter einem Schalter), bleibt als Schnittstelle für neue
// Schalter (docs/freigabe.md).
// eslint-disable-next-line no-unused-vars
function featureOn(key) { return featureVisible(featureStages[key], accessGroup); }
export async function loadFeatureAccess() {
  const [flags, access] = await Promise.all([
    supabase.from('feature_flags').select('key, stage'),
    supabase.from('user_access').select('access_group').maybeSingle(),
  ]);
  if (flags.error || access.error) console.error('[Logbuch] Schalter nicht geladen', flags.error || access.error);
  featureStages = Object.fromEntries((flags.data || []).map((f) => [f.key, f.stage]));
  accessGroup = access.data?.access_group ?? null;
}
export function clearFeatureAccess() { featureStages = {}; accessGroup = null; }

export async function loadUserSettings() {
  const { data, error } = await supabase.from('user_settings')
    .select('default_reminder_minute, onboarding_completed, locale, summary_notifications, timezone, last_seen_changelog, week_start, week_start_pending').maybeSingle();
  if (error) {
    state.notice = errorNotice('notice.loadSettingsError', error.message);
    return;
  }
  state.userSettings = {
    defaultReminderMinute: data ? data.default_reminder_minute : 1320,
    onboardingCompleted: data ? data.onboarding_completed : true,
    locale: data && data.locale ? data.locale : detectInitialLocale(),
    summaryNotifications: data ? data.summary_notifications : true,
    timezone: data ? data.timezone : 'Europe/Berlin',
    lastSeenChangelog: data ? data.last_seen_changelog : null,
    weekStart: WEEK_STARTS.includes(data?.week_start) ? data.week_start : 1,
    weekStartPending: WEEK_STARTS.includes(data?.week_start_pending) ? data.week_start_pending : null,
  };
  applyWeekStart(state.userSettings.weekStart);
  // Nach einem Update einmal "Was ist neu" - nicht für neue Konten (die setzen beim Abschluss
  // des Tutorials den neuesten Eintrag als gesehen, saveOnboardingCompleted).
  state.whatsNew = !!data && data.onboarding_completed && unseenChangelog().length > 0;
  applyLocale(state.userSettings.locale);
  syncTimezone();
}

// Erinnerungen richten sich nach user_settings.timezone (siehe send-notifications) -
// die folgt still der Zeitzone des Geräts, damit Erinnerung und App immer denselben
// "heute"-Tag meinen (Einträge speichert die App unter dem lokalen Gerätedatum).
// Abgleich bei jedem Laden der Einstellungen und beim Zurückkehren in die App
// (visibilitychange unten - eine installierte PWA bleibt auf Reisen oft tagelang im
// Hintergrund offen, ohne neu zu laden). Fehler bewusst still: z.B. eine Zeitzone,
// die Postgres (noch) nicht kennt, wird serverseitig abgelehnt - dann bleibt es
// einfach bei der bisherigen, kein Grund für eine Fehlermeldung.
function deviceTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}
async function syncTimezone() {
  const tz = deviceTimezone();
  if (!tz || !state.session || tz === state.userSettings.timezone) return;
  const { error } = await supabase.from('user_settings')
    .upsert({ user_id: state.session.user.id, timezone: tz }, { onConflict: 'user_id' });
  if (error) { console.warn('Zeitzone nicht übernommen:', tz, error.message); return; }
  state.userSettings = { ...state.userSettings, timezone: tz };
  // Nur neu rendern, wenn die Anzeige gerade sichtbar ist - ein Hintergrund-Render
  // könnte sonst z.B. ungespeicherte Eingaben im Feld-Formular überschreiben.
  if (state.menuOpen) render();
}

export async function saveDefaultReminderMinute(minutes) {
  state.userSettings = { ...state.userSettings, defaultReminderMinute: minutes };
  render();
  const { error } = await supabase.from('user_settings')
    .upsert({ user_id: state.session.user.id, default_reminder_minute: minutes }, { onConflict: 'user_id' });
  if (error) {
    state.notice = errorNotice('notice.saveFailed', error.message);
    render();
  }
}

function applyWeekStart(iso) {
  const anchorWasCurrent = formatKey(startOfWeek(state.weekAnchor)) === formatKey(startOfWeek(new Date()));
  runtime.weekStartIso = iso;
  // Die Woche, auf der man stand, in der neuen Einteilung: die mit ihrem mittleren Tag.
  state.weekAnchor = anchorWasCurrent ? startOfWeek(new Date()) : startOfWeek(addDays(state.weekAnchor, 3));
}
// Wochenbeginn der Region (beim Registrieren vorausgewählt): Intl kennt ihn nicht überall
// (getWeekInfo fehlt z. B. in Firefox) - dann Montag. Nur die angebotenen Tage.
function regionWeekStart() {
  try {
    const loc = new Intl.Locale(navigator.language).maximize();
    const first = (loc.getWeekInfo?.() || loc.weekInfo)?.firstDay;
    return WEEK_STARTS.includes(first) ? first : 1;
  } catch { return 1; }
}
// Neues Konto, noch nichts eingetragen: Wochenbeginn der Region übernehmen (kein Umzug nötig).
export async function presetWeekStartForNewAccount() {
  if (state.userSettings.onboardingCompleted || Object.keys(state.entries).length) return;
  const iso = regionWeekStart();
  if (iso === state.userSettings.weekStart) return;
  const { error } = await supabase.from('user_settings').upsert({ user_id: state.session.user.id, week_start: iso }, { onConflict: 'user_id' });
  if (error) return; // dann eben Montag, in den Einstellungen änderbar
  state.userSettings = { ...state.userSettings, weekStart: iso };
  applyWeekStart(iso);
  render();
}

// Wochen-Einträge umziehen: Werte, Notizen und Sicherungen (_prev) von Wochenfeldern stehen
// unter dem ersten Tag ihrer Woche. Jede Woche der alten Einteilung geht in die neue Woche,
// die ihren mittleren Tag enthält (die mit den meisten gemeinsamen Tagen). Erst alle Ziele
// schreiben, dann die alten Stellen leeren - bricht es ab, holt ein neuer Lauf das nach (die
// alten Stellen gewinnen, week_start_pending bleibt bis zum Ende gesetzt).
export function weekMoveTarget(dateKey, newIso) { return formatKey(startOfWeekWith(addDays(parseDateKey(dateKey), 3), newIso)); }
function weekStartMoves(oldIso, newIso) {
  const fields = state.habits.filter((h) => h.period === 'week').map((h) => h.id);
  const has = (day, id) => day[id] !== undefined || day[NOTES_KEY]?.[id] !== undefined || day[PREV_KEY]?.[id] !== undefined;
  const moves = []; // { from, to, ids }
  for (const [key, day] of Object.entries(state.entries)) {
    if (parseDateKey(key).getDay() !== oldIso % 7) continue;
    const ids = fields.filter((id) => has(day || {}, id));
    if (ids.length) moves.push({ from: key, to: weekMoveTarget(key, newIso), ids });
  }
  return moves;
}
export const weekStartChange = { running: false, done: 0, total: 0 };
export async function runWeekStartChange(newIso) {
  if (weekStartChange.running) return;
  const oldIso = state.userSettings.weekStart;
  const uid = state.session.user.id;
  weekStartChange.running = true;
  render();
  try {
    if (newIso !== oldIso) {
      const mark = await supabase.from('user_settings').upsert({ user_id: uid, week_start_pending: newIso }, { onConflict: 'user_id' });
      if (mark.error) { state.notice = errorNotice('notice.saveFailed', mark.error.message); return; }
      state.userSettings = { ...state.userSettings, weekStartPending: newIso };
      const moves = weekStartMoves(oldIso, newIso);
      const byTarget = new Map();
      for (const m of moves) byTarget.set(m.to, [...(byTarget.get(m.to) || []), m]);
      weekStartChange.total = moves.length * 2;
      weekStartChange.done = 0;
      const progress = (done) => {
        const el = document.getElementById('week-start-progress');
        if (el) el.textContent = tPlain('settings.weekStartProgress', { done: Math.min(done, weekStartChange.total), total: weekStartChange.total });
      };
      const put = await rewriteDays([...byTarget.keys()], (day, key) => {
        const next = { ...day, [NOTES_KEY]: { ...(day[NOTES_KEY] || {}) }, [PREV_KEY]: { ...(day[PREV_KEY] || {}) } };
        for (const m of byTarget.get(key)) {
          const src = state.entries[m.from] || {};
          for (const id of m.ids) {
            if (src[id] !== undefined) next[id] = src[id];
            if (src[NOTES_KEY]?.[id] !== undefined) next[NOTES_KEY][id] = src[NOTES_KEY][id];
            if (src[PREV_KEY]?.[id] !== undefined) next[PREV_KEY][id] = src[PREV_KEY][id];
          }
        }
        if (!Object.keys(next[NOTES_KEY]).length) delete next[NOTES_KEY];
        if (!Object.keys(next[PREV_KEY]).length) delete next[PREV_KEY];
        return next;
      }, (done) => progress(done));
      if (put.failed) { state.notice = { type: 'error', text: t('settings.weekStartFailed') }; return; }
      const fromIds = new Map(moves.map((m) => [m.from, m.ids]));
      const clear = await rewriteDays([...fromIds.keys()], (day, key) => {
        const next = { ...day, [NOTES_KEY]: { ...(day[NOTES_KEY] || {}) }, [PREV_KEY]: { ...(day[PREV_KEY] || {}) } };
        for (const id of fromIds.get(key)) { delete next[id]; delete next[NOTES_KEY][id]; delete next[PREV_KEY][id]; }
        if (!Object.keys(next[NOTES_KEY]).length) delete next[NOTES_KEY];
        if (!Object.keys(next[PREV_KEY]).length) delete next[PREV_KEY];
        return next;
      }, (done) => progress(byTarget.size + done));
      if (clear.failed) { state.notice = { type: 'error', text: t('settings.weekStartFailed') }; return; }
    }
    // Die Marke erst am Ende: ab hier gilt der neue Wochenbeginn.
    const fin = await supabase.from('user_settings').upsert({ user_id: uid, week_start: newIso, week_start_pending: null }, { onConflict: 'user_id' });
    if (fin.error) { state.notice = errorNotice('notice.saveFailed', fin.error.message); return; }
    state.userSettings = { ...state.userSettings, weekStart: newIso, weekStartPending: null };
    applyWeekStart(newIso);
    if (newIso !== oldIso) state.notice = { type: 'ok', text: t('settings.weekStartDone') };
  } finally {
    weekStartChange.running = false;
    render();
  }
}
// Beim Laden: ein abgebrochener Umzug läuft weiter.
export function resumeWeekStartChange() {
  const pending = state.userSettings.weekStartPending;
  if (pending !== null) runWeekStartChange(pending);
}

export async function saveSummaryNotifications(enabled) {
  state.userSettings = { ...state.userSettings, summaryNotifications: enabled };
  render();
  const { error } = await supabase.from('user_settings')
    .upsert({ user_id: state.session.user.id, summary_notifications: enabled }, { onConflict: 'user_id' });
  if (error) {
    state.notice = errorNotice('notice.saveFailed', error.message);
    render();
  }
}

export async function saveLocale(locale) {
  applyLocale(locale);
  state.userSettings = { ...state.userSettings, locale };
  render();
  saveFieldNamesForPush(); // Textvorlage der Erinnerungen in der neuen Sprache
  const { error } = await supabase.from('user_settings')
    .upsert({ user_id: state.session.user.id, locale }, { onConflict: 'user_id' });
  if (error) {
    state.notice = errorNotice('notice.saveFailed', error.message);
    render();
  }
}

// Was beim Start einmal laufen muss (Event-Listener u.ä.). Nicht beim Laden des Moduls, sondern
// vom Einstieg (logbuch.js) aufgerufen, in fester Reihenfolge, wenn alle Module geladen sind.
export function initData() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentDek) syncTimezone();
    // Zurück aus den Handy-Einstellungen, wo Mitteilungen wieder erlaubt wurden: Anleitung
    // durch "Einschalten" ersetzen, ohne dass man neu laden muss.
    if (document.visibilityState === 'visible' && state.pushStatus === 'blocked' && pushOffStatus() !== 'blocked') {
      state.pushStatus = 'off';
      renderUnlessTyping();
    }
  });
}
