import { MULTI_MAX_OPTIONS, habitFromParts, newMultiOptionId } from './fields.js?v=8aaa0e5b67';
import { formatKey, isPeriodField } from './dates.js?v=8aaa0e5b67';
import { state } from './state.js?v=8aaa0e5b67';
import { activeHabits, esc, openHabitForm } from './navigation.js?v=8aaa0e5b67';
import { t, tPlain } from './i18n.js?v=8aaa0e5b67';
import { convertToCounterRow, defaultHabitForm, habitFormDefinition, habitPayloadFromDefinition, habitToForm, persistHabitForm, resizeLabels } from './field-form.js?v=8aaa0e5b67';
import { applyStepEditPreset, handleHabitArchive, rewriteDays, typeChangeBlocker, typeChangeTargets, typeEditKindChanged, typeEditStepsChanged } from './type-change.js?v=8aaa0e5b67';
import { handleHabitDelete, insertSection } from './section-form.js?v=8aaa0e5b67';
import { updateHabitPayload } from './save.js?v=8aaa0e5b67';
import { renderTodayHabitRow } from './row-view.js?v=8aaa0e5b67';
import { icon } from './main-view.js?v=8aaa0e5b67';

// --- Vorlagen (Nutzer-Entscheidung 2026-10-30) -------------------------------------------
// "Neues Feld" beginnt mit "Was willst du festhalten?": fertige Felder zum Antippen, das volle
// Formular nur noch für "Eigenes Feld" bzw. "Anpassen" - das Formular war für Neulinge die
// größte Hürde. Eine Vorlage besteht aus Teilen (slots) und optional einer Gruppe; jeder Teil
// ist ein Formular-Zustand (Überschreibungen von defaultHabitForm), angelegt über dieselben
// Bausteine wie das Formular (habitFormDefinition/persistHabitForm). '@slot' in einem Teil
// verweist auf den Schlüssel eines anderen Teils derselben Vorlage (berechnete Felder) - die
// Teile stehen deshalb in der Reihenfolge, in der sie angelegt werden. Namen und Bezeichnungen
// in der Sprache beim Anlegen (tpl.*), danach normale Felder.
// placeLast: der Teil wird abends eingetragen ("Ins Bett") und kommt deshalb nach ganz unten statt in
// die Gruppe der Vorlage (Nutzer-Entscheidung 2026-10-30: in "Heute" nach Tageszeit sortiert).
const YES_NO = () => [t('tpl.no'), t('tpl.yes')];
const STRENGTH_LABELS = () => ['none', 'light', 'medium', 'strong'].map((k) => t('tpl.strength.' + k));
// Bausteine (blank: ohne Namen, Beispiele als Platzhalter - Nutzer-Entscheidung 2026-10-30: viele
// Vorlagen passen zu vielem, "Ja oder Nein" eben auch für Kreatin) und fertige Felder, deren
// Einstellungen wirklich zur Sache gehören. ask: was der Bestätigen-Schritt zusätzlich fragt
// ('good' = was ist gut, 'unit'). direct: gleich ins Formular (die Optionen einer Mehrfachauswahl
// gibt man dort ein).
export const FIELD_TEMPLATES = [
  { id: 'yesno', topic: 'blocks', blank: true, ask: ['good'], slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 2, good: 'high', labelsEnabled: true, labels: YES_NO() }) }] },
  { id: 'strength', topic: 'blocks', blank: true, ask: ['good'], slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 4, good: 'low', labelsEnabled: true, labels: STRENGTH_LABELS() }) }] },
  { id: 'scale5', topic: 'blocks', blank: true, slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 5, good: 'high' }) }] },
  { id: 'count', topic: 'blocks', blank: true, slots: [{ slot: 'main', form: () => ({ kind: 'counter' }) }] },
  { id: 'number', topic: 'blocks', blank: true, ask: ['unit'], slots: [{ slot: 'main', form: () => ({ kind: 'number' }) }] },
  { id: 'time', topic: 'blocks', blank: true, slots: [{ slot: 'main', form: () => ({ kind: 'time' }) }] },
  { id: 'text', topic: 'blocks', blank: true, slots: [{ slot: 'main', form: () => ({ kind: 'text' }) }] },
  { id: 'multi', topic: 'blocks', blank: true, direct: true, slots: [{ slot: 'main', form: () => ({ kind: 'multi' }) }] },
  { id: 'mood', topic: 'ready', slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 5, good: 'high' }) }] },
  { id: 'stress', topic: 'ready', slots: [{ slot: 'main', form: () => ({ kind: 'scale', min: 0, max: 10, good: 'low', displayStyle: 'slider' }) }] },
  { id: 'water', topic: 'ready', slots: [{ slot: 'main', form: () => ({ kind: 'counter', numberGoalDir: 'high', numberGoalValue: '8' }) }] },
  { id: 'meds', topic: 'ready', slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 2, good: 'high', labelsEnabled: true, labels: YES_NO(), reminderEnabled: true }) }] },
  { id: 'weight', topic: 'ready', slots: [{ slot: 'main', form: () => ({ kind: 'number', unit: 'kg' }) }] },
  { id: 'sleep', topic: 'ready', group: true, extras: ['quality', 'nap'], slots: [
    { slot: 'bed', placeLast: true, form: () => ({ kind: 'time' }) },
    { slot: 'up', form: () => ({ kind: 'time' }) },
    { slot: 'duration', form: () => ({ kind: 'computed', computedType: 'duration', durationFrom: '@bed', durationTo: '@up' }) },
    { slot: 'quality', extra: 'quality', form: () => ({ kind: 'scale', max: 5, good: 'high' }) },
    { slot: 'napDown', extra: 'nap', form: () => ({ kind: 'time', optional: true }) },
    { slot: 'napUp', extra: 'nap', form: () => ({ kind: 'time', optional: true }) },
    { slot: 'napDuration', extra: 'nap', form: () => ({ kind: 'computed', computedType: 'duration', durationFrom: '@napDown', durationTo: '@napUp' }) },
  ] },
  { id: 'cycle', topic: 'ready', slots: [
    { slot: 'period', form: () => ({ kind: 'scale', max: 4, good: null, labelsEnabled: true, labels: STRENGTH_LABELS() }) },
    { slot: 'day', form: () => ({ kind: 'computed', computedType: 'since', sinceSource: '@period', sinceValues: [2, 3, 4], sinceMode: 'start' }) },
  ] },
  { id: 'events', topic: 'ready', slots: [{ slot: 'main', form: () => ({ kind: 'multi', multiOptions: ['sport', 'outside', 'friends', 'argument', 'alcohol', 'screen'].map((k) => ({ id: newMultiOptionId(), label: t('tpl.events.' + k) })) }) }] },
];
const TEMPLATE_TOPICS = ['blocks', 'ready'];
// Startpaket (Nutzer-Entscheidung 2026-10-30): im Tutorial zuerst ein ausgereifter Satz Felder zum
// An-/Abwählen, statt dass Neulinge selbst verantworten, alles anzulegen - Logbuch lebt davon, dass
// vieles zusammenkommt (CLAUDE.md "Kern"). Nur eine Vorauswahl: die Texte ermutigen ausdrücklich,
// anzupassen und Eigenes anzulegen. Ein Eintrag verweist auf eine Vorlage (tpl) oder hat eigene
// Teile (Namen dann unter tpl.<id>.*). Gruppen außer 'other' werden als Gruppe angelegt; Teile mit
// placeLast ("Ins Bett") kommen in eine eigene Gruppe "Abends" ganz unten.
export const PACKAGE_GROUPS = [
  { id: 'morning', items: [
    { id: 'sleep', tpl: 'sleep', on: true },
    { id: 'sleepQuality', on: true, slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 5, good: 'high' }) }] },
  ] },
  { id: 'feeling', items: [
    { id: 'mood', tpl: 'mood', on: true },
    { id: 'energy', on: true, slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 5, good: 'high' }) }] },
    { id: 'stress', tpl: 'stress', on: true },
    { id: 'body', on: true, slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 4, good: 'low', labelsEnabled: true, labels: STRENGTH_LABELS() }) }] },
    { id: 'headache', on: false, slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 4, good: 'low', labelsEnabled: true, labels: STRENGTH_LABELS() }) }] },
  ] },
  { id: 'influences', items: [
    { id: 'sport', on: true, slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 2, good: 'high', labelsEnabled: true, labels: YES_NO() }) }] },
    // Nur Kontext ohne Wertung (Nutzer-Entscheidung 2026-10-30): was man bewerten oder mit Ziel
    // verfolgen will (Sport, Alkohol), ist ein eigenes Ja/Nein-Feld.
    { id: 'dayEvents', on: true, slots: [{ slot: 'main', form: () => ({ kind: 'multi', multiOptions: ['outside', 'friends', 'argument', 'screen'].map((k) => ({ id: newMultiOptionId(), label: t('tpl.events.' + k) })) }) }] },
    { id: 'water', tpl: 'water', on: true },
    { id: 'caffeine', on: false, slots: [{ slot: 'main', form: () => ({ kind: 'counter' }) }] },
    { id: 'cigarettes', on: false, slots: [{ slot: 'main', form: () => ({ kind: 'counter' }) }] },
    { id: 'alcohol', on: false, slots: [{ slot: 'main', form: () => ({ kind: 'scale', max: 2, good: 'low', labelsEnabled: true, labels: YES_NO() }) }] },
    { id: 'meds', tpl: 'meds', on: false },
  ] },
  { id: 'other', items: [
    { id: 'cycle', tpl: 'cycle', on: false },
    { id: 'weight', tpl: 'weight', on: false },
    { id: 'grateful', on: false, slots: [{ slot: 'main', form: () => ({ kind: 'text' }) }] },
    // Nur die Zusätze einer Vorlage (extras): dieselben Felder wie beim Bestätigen der Vorlage.
    { id: 'nap', tpl: 'sleep', extras: ['nap'], nameKey: 'tpl.sleep.napDuration', on: false },
  ] },
];
// Ein Eintrag mit extras besteht nur aus diesen Zusätzen seiner Vorlage, ohne die Grundfelder.
function packageItemTemplate(item) {
  if (!item.tpl) return { id: item.id, slots: item.slots };
  const tpl = templateById(item.tpl);
  return item.extras ? { ...tpl, slots: tpl.slots.filter((s) => item.extras.includes(s.extra)) } : templateWithExtras(tpl);
}
function packageItemNameKey(item) { return item.nameKey || `tpl.${item.tpl || item.id}.name`; }
export function packageDefaultChoice() {
  return Object.fromEntries(PACKAGE_GROUPS.flatMap((g) => g.items.map((it) => [it.id, it.on])));
}
const sameName = (a, b) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
// Einträge des Startpakets, die es schon gibt: ein aktives Feld heißt wie einer ihrer Teile.
// Nur über den Namen - mehr verrät ein Feld nicht darüber, wofür es gedacht ist.
function packageExistingItems() {
  const names = activeHabits().map((h) => h.name);
  return PACKAGE_GROUPS.flatMap((g) => g.items).filter((it) => {
    const tpl = packageItemTemplate(it);
    return tpl.slots.some((sl) => names.some((n) => sameName(n, templateSlotName(tpl, sl.slot))));
  }).map((it) => it.id);
}
// Startpaket außerhalb des Tutorials (K3, Nutzer-Entscheidung 2026-11-10): jederzeit über
// "Neues Feld"; was es schon gibt, ist abgewählt und markiert, damit nichts doppelt entsteht.
export function packageFormState() {
  const existing = packageExistingItems();
  const chosen = packageDefaultChoice();
  for (const id of existing) chosen[id] = false;
  return { packageChosen: chosen, packageExisting: existing, template: { stage: 'package' } };
}
export function packageFieldCount(chosen) {
  return PACKAGE_GROUPS.flatMap((g) => g.items).filter((it) => chosen[it.id]).reduce((n, it) => n + packageItemTemplate(it).slots.length, 0);
}
// Legt die gewählten Einträge an, je Gruppe erst die Gruppe. Scheitert etwas, bleibt das schon
// Angelegte stehen (normale Felder, wie bei Vorlagen).
export async function createStarterPackage(chosen) {
  const habits = [];
  // Erst alle Gruppen in Anzeige-Reihenfolge ("Abends" zuletzt), dann die Felder - "Ins Bett" wird
  // als Verweis für die Schlafdauer zuerst angelegt, gehört aber in die letzte Gruppe.
  const chosenItems = (g) => g.items.filter((it) => chosen[it.id]);
  const sectionKeys = PACKAGE_GROUPS.filter((g) => g.id !== 'other' && chosenItems(g).length).map((g) => g.id);
  if (PACKAGE_GROUPS.some((g) => chosenItems(g).some((it) => packageItemTemplate(it).slots.some((sl) => sl.placeLast)))) sectionKeys.push('evening');
  const sections = {};
  for (const key of sectionKeys) {
    // Eine Gruppe gleichen Namens gibt es schon (Startpaket ein zweites Mal): dorthinein.
    const name = tPlain('pkg.group.' + key);
    const existing = state.sections.find((sec) => sameName(sec.name, name));
    if (existing) { sections[key] = existing.id; continue; }
    const sec = await insertSection(name, 'done');
    if (sec.notice) return sec;
    sections[key] = sec.id;
  }
  for (const g of PACKAGE_GROUPS) {
    for (const it of chosenItems(g)) {
      const tpl = packageItemTemplate(it);
      const refs = {};
      for (const slot of tpl.slots) {
        const sectionId = sections[slot.placeLast ? 'evening' : g.id] ?? null;
        const form = { ...templateSlotForm(tpl, slot, templateSlotName(tpl, slot.slot), refs), sectionId };
        const def = habitFormDefinition(form);
        if (def.notice) return def;
        const result = await persistHabitForm(form, def);
        if (result.notice) return result;
        refs[slot.slot] = result.habit.id;
        habits.push(result.habit);
      }
    }
  }
  return { habits };
}
export function renderStarterPackage(f) {
  const chosen = f.packageChosen;
  const count = packageFieldCount(chosen);
  return `
    <div class="habit-form" id="habit-form">
      <p class="pkg-intro">${t(activeHabits().length ? 'pkg.introMore' : 'pkg.intro')}</p>
      ${PACKAGE_GROUPS.map((g) => `
        <fieldset class="pkg-group">
          <legend class="form-part-title">${t('pkg.group.' + g.id)}</legend>
          ${g.items.map((it) => `
            <label class="checkbox-field pkg-item">
              <input type="checkbox" id="pkg-item-${it.id}" ${chosen[it.id] ? 'checked' : ''} ${state.habitFormSaving ? 'disabled' : ''} />
              <span><span class="pkg-item-name">${t(packageItemNameKey(it))}</span>
              <span class="pkg-item-note">${t('pkg.item.' + it.id)}</span>
              ${f.packageExisting?.includes(it.id) ? `<span class="pkg-item-note pkg-item-have">${t('pkg.have')}</span>` : ''}</span>
            </label>
          `).join('')}
        </fieldset>
      `).join('')}
      <div class="form-tip">${icon('tip')}<div><p><strong>${t('pkg.ideasTitle')}</strong> ${t('pkg.ideas')}</p></div></div>
      <button type="button" class="auth-submit" data-action="pkg-create" ${state.habitFormSaving || !count ? 'disabled' : ''}>${state.habitFormSaving ? t('common.saving') : t(count === 1 ? 'pkg.createOne' : 'pkg.create', { count })}</button>
      <button type="button" class="auth-toggle" data-action="pkg-single" ${state.habitFormSaving ? 'disabled' : ''}>${t('pkg.single')}</button>
    </div>
  `;
}
export function templateById(id) { return FIELD_TEMPLATES.find((x) => x.id === id); }
// Zusätze einer Vorlage (extras, K6 Nutzer-Entscheidung 2026-11-10: Schlaf + Schlafqualität /
// Mittagsschlaf) kommen nur mit, wenn man sie beim Bestätigen ankreuzt; ohne Auswahl (Startpaket)
// nie. Die Vorlage mit nur den gewählten Teilen:
export function templateWithExtras(tpl, extras = {}) {
  return tpl.extras ? { ...tpl, slots: tpl.slots.filter((s) => !s.extra || extras[s.extra]) } : tpl;
}
function templateDisplaySlots(tpl) { return [...tpl.slots.filter((s) => !s.placeLast), ...tpl.slots.filter((s) => s.placeLast)]; }
function templateSlotName(tpl, slot) { return tPlain(tpl.slots.length > 1 ? `tpl.${tpl.id}.${slot}` : `tpl.${tpl.id}.name`); }
// Formular-Zustand eines Teils; refs = { slot: Schlüssel } der schon angelegten Teile.
export function templateSlotForm(tpl, s, name, refs = {}, answers = {}) {
  const ref = (v) => (typeof v === 'string' && v.startsWith('@') ? refs[v.slice(1)] ?? null : v);
  const own = Object.fromEntries(Object.entries(s.form()).map(([k, v]) => [k, ref(v)]));
  if ('good' in answers) own.good = answers.good;
  if ('unit' in answers) own.unit = answers.unit;
  const form = { ...defaultHabitForm(), ...own, name };
  Object.defineProperty(form, '__keys', { value: Object.fromEntries(Object.keys(own).map((k) => [k, true])), enumerable: false });
  if (form.labelsEnabled) form.labels = resizeLabels(form.labels, form.max - form.min + 1);
  return form;
}
export function startTemplateConfirm(f, id) {
  const tpl = templateById(id);
  const sameName = tpl.group ? state.sections.find((sec) => sec.name.trim().toLocaleLowerCase() === tPlain(`tpl.${id}.name`).toLocaleLowerCase()) : null;
  const first = tpl.slots[0].form();
  f.template = {
    stage: 'confirm', id,
    names: Object.fromEntries(tpl.slots.map((s) => [s.slot, tpl.blank ? '' : templateSlotName(tpl, s.slot)])),
    answers: { ...(tpl.ask?.includes('good') ? { good: first.good } : {}), ...(tpl.ask?.includes('unit') ? { unit: '' } : {}) },
    groupName: tPlain(`tpl.${id}.name`),
    group: sameName ? sameName.id : tpl.group ? 'new' : (f.sectionId || 'none'),
    extras: {},
  };
}
export function readTemplateFromDom(f) {
  const tp = f.template;
  if (tp?.stage !== 'confirm') return;
  for (const slot of Object.keys(tp.names)) {
    const el = document.getElementById(`tpl-name-${slot}`);
    if (el) tp.names[slot] = el.value;
  }
  const groupEl = document.getElementById('tpl-group');
  if (groupEl) tp.group = groupEl.value;
  const groupNameEl = document.getElementById('tpl-group-name');
  if (groupNameEl) tp.groupName = groupNameEl.value;
  const unitEl = document.getElementById('tpl-unit');
  if (unitEl) tp.answers.unit = unitEl.value;
  for (const el of document.querySelectorAll('[id^="tpl-extra-"]')) tp.extras = { ...tp.extras, [el.id.slice('tpl-extra-'.length)]: el.checked };
  const mergeEls = [...document.querySelectorAll('[id^="tpl-merge-"][data-def]')];
  if (mergeEls.length) tp.merge = mergeEls.filter((el) => el.checked).map((el) => el.dataset.def);
  tp.sources ??= {};
  for (const slot of Object.keys(tp.names)) {
    const el = document.getElementById(`tpl-source-${slot}`);
    if (!el) continue;
    const before = tp.sources[slot];
    tp.sources[slot] = el.value;
    // Baustein ohne Namen: das übernommene Feld behält seinen.
    const { habit } = templateSourceOf(tp, slot);
    if (habit && before !== el.value && !tp.names[slot].trim()) tp.names[slot] = habit.name;
  }
}
// "Anpassen" (nur Vorlagen mit einem Teil): weiter im vollen Formular, schon ausgefüllt.
export function adjustTemplate(f) {
  readTemplateFromDom(f);
  const tpl = templateById(f.template.id);
  const form = templateSlotForm(tpl, tpl.slots[0], f.template.names[tpl.slots[0].slot], {}, f.template.answers);
  const sectionId = f.template.group !== 'none' && f.template.group !== 'new' ? f.template.group : f.sectionId;
  delete f.template;
  Object.assign(f, form, { sectionId, returnToTab: f.returnToTab, revealStage: f.revealStage });
  if (f.revealStage !== undefined) f.revealStage = 3;
}
// Aus vorhandenem Feld (Nutzer-Entscheidung 2026-10-30): pro Teil "neu", "take:<defId>" (das Feld
// wird an Ort und Stelle umgebaut, behält Schlüssel und Einträge) oder "replace:<defId>" (neues
// Feld, das alte wird archiviert und bleibt in der Auswertung sichtbar). Wie umgebaut wird:
// 'same' = Typ und Stufen passen, nur Einstellungen; 'steps'/'type' = danach öffnet "Stufen
// ändern" bzw. "Typ ändern", schon auf die Vorlage eingestellt - die Zuordnung der alten Werte
// entscheidet man dort (eine Stelle für Wert-Umwandlungen); 'counter' = Zahl wird Zähler (Werte
// bleiben, leer = 0 erst ab heute, wie convertHabitToCounter).
export function templateTakeMode(slotForm, h) {
  if (isPeriodField(h) || h.archivedAt) return null;
  const k = slotForm.kind;
  const steps = (x) => x.max - x.min + 1;
  if (k === 'computed') return h.kind === 'computed' && h.aggregate === slotForm.computedType ? 'same' : null;
  if (h.kind === 'computed') return null;
  const canType = (to) => typeChangeTargets(h).includes(to) && !typeChangeBlocker(h);
  // Schieberegler ohne Bezeichnungen (Stress 0-10): der Bereich des vorhandenen Felds bleibt - ob
  // 0-10 oder 1-10 macht für die Vorlage keinen Unterschied, eine Umstellung wäre nur Aufwand.
  const freeSlider = slotForm.displayStyle === 'slider' && !slotForm.labelsEnabled && h.kind === 'scale' && !h.labels;
  if (k === 'scale') return h.kind === 'scale' ? (steps(h) === steps(slotForm) || freeSlider ? 'same' : 'steps') : canType('scale') ? 'type' : null;
  if (k === 'counter') return h.kind === 'counter' ? 'same' : h.kind === 'number' ? 'counter' : null;
  if (k === 'number') return h.kind === 'number' ? 'same' : canType('number') ? 'type' : null;
  if (k === 'text') return h.kind === 'text' ? 'same' : canType('text') ? 'type' : null;
  return h.kind === k ? 'same' : null; // Uhrzeit, Mehrfachauswahl
}
function templateSourceOf(tp, slot) {
  const [how, defId] = (tp.sources?.[slot] || 'new').split(':');
  return { how, habit: defId ? state.habits.find((h) => h.defId === defId) ?? null : null };
}
// Einstellungen der Vorlage, die ein übernommenes Feld bekommt. Nie die Optionen einer
// Mehrfachauswahl (gewählte Ids in den Einträgen verlören ihre Bedeutung) und bei 'steps'/'type'
// nur, was nicht an den Werten hängt - den Rest stellt "Stufen/Typ ändern" um.
function templateTakeOverlay(slotForm, mode) {
  const skip = new Set(['kind', 'min', 'max', 'multiOptions']);
  if (mode !== 'same' && mode !== 'counter') ['labelsEnabled', 'labels', 'displayStyle', 'unit', 'numberGoalDir', 'numberGoalValue', 'numberGoalMax', 'numberGoalScope'].forEach((k) => skip.add(k));
  return Object.fromEntries(Object.entries(slotForm).filter(([k]) => !skip.has(k) && k in templateSlotOverrideKeys(slotForm)));
}
// Nur die Schlüssel, die der Teil selbst setzt (nicht die Vorgaben von defaultHabitForm).
function templateSlotOverrideKeys(slotForm) { return slotForm.__keys || {}; }
async function takeIntoTemplate(h, slotForm, mode, sectionId) {
  // Zahl -> Zähler über denselben Umbau wie "In Zähler umwandeln", danach wie ein passendes Feld.
  if (mode === 'counter') {
    const converted = await convertToCounterRow(h);
    if (converted.notice) return converted;
    h = converted.habit;
  }
  const f = { ...habitToForm(h), ...templateTakeOverlay(slotForm, mode), name: slotForm.name, sectionId };
  const def = habitFormDefinition(f);
  if (def.notice) return def;
  const result = await persistHabitForm(f, def);
  if (result.notice) return result;
  return { habit: result.habit, followUp: mode === 'steps' || mode === 'type' ? { defId: result.habit.defId, mode, target: slotForm } : null };
}
// Nach dem Anlegen: "Stufen ändern" bzw. "Typ ändern" des übernommenen Felds öffnen, schon auf
// die Vorlage eingestellt (Stufenzahl, Bezeichnungen bzw. Ziel-Typ).
export function openTemplateFollowUp(fu) {
  const h = state.habits.find((x) => x.defId === fu.defId);
  if (!h) return;
  const form = habitToForm(h);
  const steps = fu.target.max - fu.target.min + 1;
  if (fu.mode === 'steps') {
    form.stepEdit = { steps, labels: fu.target.labelsEnabled ? [...fu.target.labels] : null, preset: 'spread', map: {}, confirm: false };
    applyStepEditPreset(h, form.stepEdit);
    form.stepEdit.initial = '';
  } else {
    form.typeEdit = { kind: null, steps: 5, preset: 'round', unit: fu.target.unit || '', map: {}, confirm: false };
    typeEditKindChanged(h, form.typeEdit, fu.target.kind);
    if (fu.target.kind === 'scale') typeEditStepsChanged(h, form.typeEdit, steps);
    form.typeEdit.initial = '';
  }
  openHabitForm(form);
  state.notice = { type: 'ok', text: tPlain(fu.mode === 'steps' ? 'tpl.followUp.steps' : 'tpl.followUp.type', { name: h.name }) };
}

// Ja/Nein-Felder in einer Mehrfachauswahl aufgehen lassen (Nutzer-Entscheidung 2026-10-30): jedes
// Feld wird eine Option (eine gleichnamige vorhandene Option wird mitbenutzt), pro Tag "Ja" =
// angekreuzt, "Nein" = eingetragen, aber nicht angekreuzt; Tage ohne Antwort bleiben leer. Die
// alten Felder werden unverändert archiviert (in der Auswertung sichtbar) - sie sind zugleich die
// Sicherung. Rückgängig nur direkt danach über die Meldung.
export function isYesNoField(h) { return h.kind === 'scale' && h.max - h.min === 1 && !h.archivedAt && !isPeriodField(h); }
// Welcher Wert "Ja" ist: steht "Ja" vorn (Bezeichnungen andersherum), die untere Stufe, sonst die obere.
export function yesValueOf(h) { return /^(ja|yes)$/i.test((h.labels?.[0] || '').trim()) ? h.min : h.max; }
function templateMergeCandidates(tp) {
  const taken = new Set(Object.values(tp.sources || {}).map((v) => v.split(':')[1]).filter(Boolean));
  return state.habits.filter((h) => isYesNoField(h) && !taken.has(h.defId));
}
function templateMergeFields(tp) {
  const candidates = templateMergeCandidates(tp);
  return (tp.merge || []).map((id) => candidates.find((h) => h.defId === id)).filter(Boolean);
}
// Optionen nach dem Zusammenführen und welches Feld zu welcher Option wird.
export function mergedMultiOptions(base, fields) {
  const options = base.map((o) => ({ ...o }));
  const idOf = new Map();
  for (const h of fields) {
    const label = h.name.trim().replace(/\s*\?+$/, '') || h.name.trim();
    let option = options.find((o) => o.label.trim().toLocaleLowerCase() === label.toLocaleLowerCase());
    if (!option) options.push(option = { id: newMultiOptionId(), label });
    else delete option.hidden;
    idOf.set(h.defId, option.id);
  }
  return { options, idOf };
}
// Schreibt die Antworten der Felder als Optionen in die Mehrfachauswahl. before: alter Wert pro Tag.
async function mergeIntoMulti(multi, fields, idOf, onProgress) {
  const answered = (day) => fields.filter((h) => typeof day?.[h.id] === 'number');
  const todo = Object.keys(state.entries).filter((k) => answered(state.entries[k]).length);
  const before = Object.fromEntries(todo.map((k) => [k, state.entries[k][multi.id]]));
  const { failed } = await rewriteDays(todo, (day) => {
    const prev = Array.isArray(day[multi.id]) ? day[multi.id] : [];
    const yes = answered(day).filter((h) => day[h.id] === yesValueOf(h)).map((h) => idOf.get(h.defId));
    return { ...day, [multi.id]: [...new Set([...prev, ...yes])] };
  }, onProgress);
  return { before, failed };
}
// m = { defId, created, before, oldOptions, archived: [{ defId, inStats }] }
export async function undoTemplateMerge(m) {
  const multi = state.habits.find((h) => h.defId === m.defId);
  if (multi && m.created) await handleHabitDelete(m.defId);
  else if (multi) {
    await rewriteDays(Object.keys(m.before), (day, dateKey) => {
      const next = { ...day };
      if (m.before[dateKey] === undefined) delete next[multi.id];
      else next[multi.id] = m.before[dateKey];
      return next;
    });
    await updateHabitPayload(multi, { options: m.oldOptions });
  }
  for (const a of m.archived) {
    if (!(await handleHabitArchive(a.defId, false))) continue;
    const h = state.habits.find((x) => x.defId === a.defId);
    if (h && !!h.archivedInStats !== a.inStats) await updateHabitPayload(h, { archivedInStats: a.inStats });
  }
}
async function archiveIntoStats(defId) {
  const h = state.habits.find((x) => x.defId === defId);
  const entry = { defId, inStats: !!h?.archivedInStats };
  if (!(await handleHabitArchive(defId, true))) return null;
  const archived = state.habits.find((x) => x.defId === defId);
  if (archived && !archived.archivedInStats) await updateHabitPayload(archived, { archivedInStats: true });
  return entry;
}

// Anlegen: erst die Gruppe, dann die Teile in ihrer Reihenfolge. Scheitert ein Teil, bleibt das
// schon Angelegte stehen (normale Felder, einzeln zu bearbeiten oder zu archivieren).
export async function createFromTemplate(f) {
  readTemplateFromDom(f);
  const tp = f.template;
  const tpl = templateWithExtras(templateById(tp.id), tp.extras);
  const names = tpl.slots.map((s) => (tp.names[s.slot] || '').trim());
  if (names.some((n) => !n)) return { notice: { type: 'error', text: t('habitForm.error.nameRequired') } };
  let sectionId = null;
  if (tp.group === 'new') {
    if (!tp.groupName.trim()) return { notice: { type: 'error', text: t('manage.error.sectionNameRequired') } };
    const created = await insertSection(tp.groupName.trim(), 'done');
    if (created.notice) return created;
    sectionId = created.id;
  } else if (tp.group !== 'none' && state.sections.some((sec) => sec.id === tp.group)) sectionId = tp.group;
  const sources = tpl.slots.map((s) => templateSourceOf(tp, s.slot));
  const chosen = sources.filter((x) => x.habit).map((x) => x.habit.defId);
  if (new Set(chosen).size !== chosen.length) return { notice: { type: 'error', text: t('tpl.error.sameField') } };
  const mergeFields = templateMergeFields(tp);
  const refs = {};
  const habits = [];
  let followUp = null;
  let merged = null;
  for (const [i, s] of tpl.slots.entries()) {
    const { how, habit: old } = sources[i];
    const slotForm = templateSlotForm(tpl, s, names[i], refs, tp.answers);
    const merging = slotForm.kind === 'multi' && mergeFields.length;
    const mergedOptions = merging ? mergedMultiOptions(how === 'take' && old ? old.options || [] : slotForm.multiOptions, mergeFields) : null;
    if (mergedOptions && mergedOptions.options.length > MULTI_MAX_OPTIONS) return { notice: { type: 'error', text: t('tpl.error.mergeTooMany', { max: MULTI_MAX_OPTIONS }) } };
    let result;
    if (how === 'take' && old) {
      const mode = templateTakeMode(slotForm, old);
      if (!mode) return { notice: { type: 'error', text: t('tpl.error.sameField') } };
      // Ohne Gruppe in der Vorlage (bzw. bei placeLast) bleibt ein übernommenes Feld, wo es ist.
      result = await takeIntoTemplate(old, slotForm, mode, !s.placeLast && (tpl.group || tp.group !== 'none') ? sectionId : old.sectionId);
      if (result.followUp) followUp = result.followUp;
      if (!result.notice && merging) {
        if (!(await updateHabitPayload(result.habit, { options: mergedOptions.options }))) return { notice: { type: 'error', text: t('tpl.error.merge') } };
        result.habit = state.habits.find((x) => x.defId === result.habit.defId);
      }
    } else {
      const form = { ...slotForm, sectionId: s.placeLast ? null : sectionId, ...(merging ? { multiOptions: mergedOptions.options } : {}) };
      const def = habitFormDefinition(form);
      if (def.notice) return def;
      result = await persistHabitForm(form, def);
    }
    if (result.notice) return result;
    if (merging) {
      merged = { defId: result.habit.defId, created: how !== 'take', before: {}, oldOptions: old?.options, archived: [], names: mergeFields.map((h) => h.name) };
      const { before, failed } = await mergeIntoMulti(result.habit, mergeFields, mergedOptions.idOf, (done, total) => {
        const el = document.getElementById('tpl-merge-progress');
        if (el) el.textContent = tPlain('tpl.mergeProgress', { done, total });
      });
      merged.before = before;
      if (failed) {
        // Halb übernommen hilft niemandem: alles zurück, die alten Felder bleiben, wie sie sind.
        await undoTemplateMerge(merged);
        return { notice: { type: 'error', text: t('tpl.error.merge') } };
      }
      for (const h of mergeFields) {
        const entry = await archiveIntoStats(h.defId);
        if (entry) merged.archived.push(entry);
        else merged.notArchived = [...(merged.notArchived || []), h.name];
      }
    }
    if (how === 'replace' && old) {
      const entry = await archiveIntoStats(old.defId);
      if (entry && merged) merged.archived.push(entry);
    }
    refs[s.slot] = result.habit.id;
    habits.push(result.habit);
  }
  return { habits, followUp, merged };
}
// Vorschau: die Zeilen wie in "Heute", aber inert (nicht antippbar, nichts wird gespeichert).
// Berechnete Teile nur als Text - ihr Wert hängt an den noch nicht angelegten Feldern.
function templatePreviewHtml(tpl, names, answers = {}, mergeFields = []) {
  const rows = [];
  const computed = [];
  for (const s of templateDisplaySlots(tpl)) {
    const form = templateSlotForm(tpl, s, names[s.slot] || templateSlotName(tpl, s.slot), {}, answers);
    if (form.kind === 'computed') { computed.push(form.name); continue; }
    if (form.kind === 'multi' && mergeFields.length) form.multiOptions = mergedMultiOptions(form.multiOptions, mergeFields).options;
    const def = habitFormDefinition({ ...form, sinceSource: null });
    if (def.notice) continue;
    const h = habitFromParts({ id: `tpl-${s.slot}`, kind: def.fields.kind, schedule: null, reminder_minute: null, period: 'day', created_at: new Date().toISOString() },
      habitPayloadFromDefinition(form, def, `tpl-preview-${s.slot}`));
    rows.push(renderTodayHabitRow(h, formatKey(new Date()), {}));
  }
  return `
    <div class="field-preview tpl-preview" inert aria-hidden="true">${rows.join('')}</div>
    ${computed.length ? `<p class="habit-form-lock-note">${t('tpl.computedNote', { names: computed.join(', ') })}</p>` : ''}
  `;
}
export function renderTemplatePicker(f) {
  const card = (action, attrs, title, note) => `<button type="button" class="kind-card tpl-card" data-action="${action}"${attrs}><span class="kind-card-title">${title}</span><span class="kind-card-note">${note}</span></button>`;
  return `
    <div class="habit-form" id="habit-form">
      ${f.revealStage !== undefined ? '' : `<h3 class="form-part-title tpl-question">${t('tpl.question')}</h3>`}
      <div class="kind-cards tpl-cards">${card('tpl-package', '', t('pkg.backTitle'), t(f.packageChosen ? 'pkg.backNote' : 'pkg.cardNote'))}${card('tpl-custom', '', t('tpl.custom'), t('tpl.customNote'))}</div>
      ${TEMPLATE_TOPICS.map((topic) => `
        <section class="form-part" aria-labelledby="tpl-topic-${topic}">
          <h3 class="form-part-title" id="tpl-topic-${topic}">${t('tpl.topic.' + topic)}</h3>
          <div class="kind-cards tpl-cards">
            ${FIELD_TEMPLATES.filter((x) => x.topic === topic).map((x) => card('tpl-pick', ` data-template="${x.id}"`, t(`tpl.${x.id}.name`), t(`tpl.${x.id}.note`))).join('')}
          </div>
        </section>
      `).join('')}
    </div>
  `;
}
// "Hast du so ein Feld schon?": übernehmbare Felder (Einträge bleiben) und alle übrigen zum
// Ersetzen. Nur, wenn es überhaupt aktive Tagesfelder gibt.
function templateSourceHtml(tpl, s, tp) {
  if (state.habitForm?.revealStage !== undefined) return '';
  const slotForm = templateSlotForm(tpl, s, '', {}, tp.answers);
  const active = state.habits.filter((h) => !h.archivedAt && !isPeriodField(h) && (slotForm.kind === 'computed') === (h.kind === 'computed'));
  if (!active.length) return '';
  const take = active.filter((h) => templateTakeMode(slotForm, h));
  const replace = active; // auch passende Felder: bewusst neu beginnen soll gehen
  const value = tp.sources?.[s.slot] || 'new';
  const opt = (v, h) => `<option value="${v}" ${value === v ? 'selected' : ''}>${esc(h.name)}</option>`;
  const { how, habit } = templateSourceOf(tp, s.slot);
  const mode = habit && how === 'take' ? templateTakeMode(slotForm, habit) : null;
  const note = !habit ? ''
    : how === 'replace' ? tPlain('tpl.replaceNote', { name: habit.name })
    : mode === 'steps' ? tPlain('tpl.takeNote.steps', { name: habit.name, from: habit.max - habit.min + 1, to: slotForm.max - slotForm.min + 1 })
    : tPlain('tpl.takeNote.' + mode, { name: habit.name });
  return `
    <label class="tpl-source-label" for="tpl-source-${s.slot}">${t('tpl.source')}</label>
    <select id="tpl-source-${s.slot}" class="tpl-source">
      <option value="new" ${value === 'new' ? 'selected' : ''}>${t('tpl.sourceNew')}</option>
      ${take.length ? `<optgroup label="${esc(tPlain('tpl.sourceTake'))}">${take.map((h) => opt(`take:${h.defId}`, h)).join('')}</optgroup>` : ''}
      ${replace.length && slotForm.kind !== 'computed' ? `<optgroup label="${esc(tPlain('tpl.sourceReplace'))}">${replace.map((h) => opt(`replace:${h.defId}`, h)).join('')}</optgroup>` : ''}
    </select>
    ${note ? `<p class="habit-form-lock-note">${esc(note)}</p>` : ''}
    ${slotForm.kind === 'multi' ? templateMergeHtml(tp) : ''}
  `;
}
function templateMergeHtml(tp) {
  const candidates = templateMergeCandidates(tp);
  if (!candidates.length) return '';
  const chosen = templateMergeFields(tp).map((h) => h.defId);
  return `
    <fieldset class="tpl-merge">
      <legend class="tpl-source-label">${t('tpl.merge')}</legend>
      ${candidates.map((h) => `
        <label class="checkbox-field">
          <input type="checkbox" id="tpl-merge-${h.defId}" data-def="${h.defId}" ${chosen.includes(h.defId) ? 'checked' : ''} />
          ${esc(h.name)}
        </label>
      `).join('')}
      <p class="habit-form-lock-note">${t(chosen.length ? 'tpl.mergeNote' : 'tpl.mergeHint')}</p>
    </fieldset>
  `;
}
// "Anpassen" baut ein neues Feld im Formular - mit vorhandenen Feldern (übernehmen, ersetzen,
// hineinnehmen) gibt es das deshalb nicht, sonst gingen diese Angaben still verloren.
function templateUsesExisting(tp) {
  return Object.values(tp.sources || {}).some((v) => v !== 'new') || templateMergeFields(tp).length > 0;
}
export function renderTemplateConfirm(f) {
  const tp = f.template;
  const full = templateById(tp.id);
  const tpl = templateWithExtras(full, tp.extras);
  const multi = tpl.slots.length > 1;
  const groupOptions = [
    ...(tpl.group ? [['new', tPlain('tpl.groupNew')]] : []),
    ['none', tPlain('habitForm.sectionNone')],
    ...[...state.sections].sort((a, b) => a.sortOrder - b.sortOrder).map((sec) => [sec.id, sec.name]),
  ];
  return `
    <div class="habit-form" id="habit-form">
      <h3 class="form-part-title">${t(`tpl.${tpl.id}.name`)}</h3>
      <p class="habit-form-lock-note">${t(`tpl.${tpl.id}.explain`)}</p>
      ${full.extras ? `
        <fieldset class="auth-field tpl-extras">
          <legend class="settings-label">${t('tpl.extras')}</legend>
          ${full.extras.map((x) => `
            <label class="checkbox-field">
              <input type="checkbox" id="tpl-extra-${x}" ${tp.extras?.[x] ? 'checked' : ''} />
              <span>${t(`tpl.${full.id}.extra.${x}`)}</span>
            </label>
          `).join('')}
        </fieldset>
      ` : ''}
      ${templateDisplaySlots(tpl).map((s) => `
        <div class="auth-field">
          <label for="tpl-name-${s.slot}">${multi ? t('tpl.nameOf', { what: templateSlotName(tpl, s.slot) }) : t('habitForm.name')}</label>
          <input type="text" id="tpl-name-${s.slot}" value="${esc(tp.names[s.slot])}" maxlength="40"${tpl.blank ? ` placeholder="${esc(tPlain(`tpl.${tpl.id}.placeholder`))}"` : ''} />
          ${s.placeLast ? `<p class="habit-form-lock-note">${t('tpl.placeLastNote')}</p>` : ''}
          ${s.form().optional ? `<p class="habit-form-lock-note">${t('tpl.optionalNote')}</p>` : ''}
          ${templateSourceHtml(tpl, s, tp)}
        </div>
      `).join('')}
      ${'good' in tp.answers ? `
        <div class="auth-field">
          <label id="tpl-good-label">${t('tpl.goodQuestion')}</label>
          <div class="pill-group seg seg--stack" role="group" aria-labelledby="tpl-good-label">
            ${[['high', `tpl.${tpl.id}.goodHigh`], ['low', `tpl.${tpl.id}.goodLow`], ['', 'habitForm.noValuation']].map(([g, key]) => `<button type="button" class="pill-toggle${(tp.answers.good || '') === g ? ' pill-toggle--active' : ''}" data-action="tpl-good" data-good="${g}" aria-pressed="${(tp.answers.good || '') === g}">${t(key)}</button>`).join('')}
          </div>
        </div>
      ` : ''}
      ${'unit' in tp.answers ? `
        <div class="auth-field">
          <label for="tpl-unit">${t('habitForm.unit')}</label>
          <input type="text" id="tpl-unit" value="${esc(tp.answers.unit)}" maxlength="10" placeholder="${esc(t('habitForm.unitPlaceholder'))}" />
        </div>
      ` : ''}
      ${groupOptions.length > 1 ? `
        <div class="auth-field">
          <label for="tpl-group">${t('habitForm.part.group')}</label>
          <select id="tpl-group" data-action="tpl-group">
            ${groupOptions.map(([v, label]) => `<option value="${esc(v)}" ${tp.group === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select>
          ${tp.group === 'new' ? `<input type="text" id="tpl-group-name" class="tpl-group-name" value="${esc(tp.groupName)}" maxlength="40" aria-label="${esc(tPlain('tpl.groupName'))}" />` : ''}
        </div>
      ` : ''}
      <div class="auth-field">
        <span class="settings-label">${t('tpl.preview')}</span>
        ${templatePreviewHtml(tpl, tp.names, tp.answers, templateMergeFields(tp))}
      </div>
      ${state.habitFormSaving && templateMergeFields(tp).length ? '<p class="habit-form-lock-note" id="tpl-merge-progress" role="status"></p>' : ''}
      <div class="habit-form-actions">
        <button type="button" class="habit-form-cancel" data-action="tpl-back">${t('tpl.back')}</button>
        <button type="button" class="auth-submit" data-action="tpl-create" ${state.habitFormSaving ? 'disabled' : ''}>${state.habitFormSaving ? t('common.saving') : t('tpl.create')}</button>
      </div>
      ${multi || templateUsesExisting(tp) ? '' : `<button type="button" class="manage-btn tpl-adjust" data-action="tpl-adjust">${t('tpl.adjust')}</button>`}
    </div>
  `;
}
