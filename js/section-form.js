import { supabase } from './config.js?v=90bbeaa075';
import { encryptData } from './crypto.js?v=90bbeaa075';
import { SECTION_COLLAPSE_MODES, containerMaxSortOrder, formatClock, invalidateTodayAutoCollapse, layoutBlocks, saveFieldNamesForPush } from './fields.js?v=90bbeaa075';
import { readTimeInput, reminderTimeInputHtml } from './dates.js?v=90bbeaa075';
import { currentDek, runtime, state } from './state.js?v=90bbeaa075';
import { esc, markFormBaseline } from './navigation.js?v=90bbeaa075';
import { t } from './i18n.js?v=90bbeaa075';
import { errorNotice } from './format.js?v=90bbeaa075';
import { commitLayoutOrder } from './type-change.js?v=90bbeaa075';
import { NOTES_KEY, PREV_KEY, SECTION_NOTE_PREFIX, saveDay, withNote, withPrev } from './save.js?v=90bbeaa075';
import { render } from './main-view.js?v=90bbeaa075';

// --- Gruppen (intern: sections) - Formular -------------------------------------
// Eigene Ebene der Verwaltung wie das Feld-Formular (openHabitForm): Name + Liste aller
// aktiven Felder zum Ankreuzen, beliebig gemischt. Ein Feld kann nur in EINER Gruppe
// sein - Felder aus einer anderen Gruppe erscheinen ausgegraut mit deren Namen. Scroll-
// Position und Rückweg teilen sich den Mechanismus des Feld-Formulars.
// returnToTab: aus dem Zeilen-Menü in "Heute" geöffnet - danach dorthin zurück (wie beim
// Feld-Formular, siehe closeHabitForm).
export function openSectionForm(id, { returnToTab = false } = {}) {
  runtime.habitFormReturnScrollY = window.scrollY;
  const sec = id ? state.sections.find((x) => x.id === id) : null;
  state.sectionForm = {
    id: sec ? sec.id : null,
    name: sec ? sec.name : '',
    collapse: sec ? sec.collapse : 'done',
    members: sec ? state.habits.filter((h) => !h.archivedAt && h.sectionId === sec.id).map((h) => h.defId) : [],
    reminderEnabled: sec ? sec.reminderMinute !== null : false,
    reminderMinute: sec && sec.reminderMinute !== null ? sec.reminderMinute : state.userSettings.defaultReminderMinute,
    returnToTab,
  };
  state.sectionDeleteConfirm = null;
  render();
  markFormBaseline();
  window.scrollTo(0, 0);
  if (!sec) requestAnimationFrame(() => document.getElementById('section-form-name')?.focus());
}
export function closeSectionForm() {
  const returnToTab = state.sectionForm?.returnToTab;
  state.sectionForm = null;
  if (returnToTab && state.view === 'manage') state.view = state.previousTabView || 'today';
  runtime.pendingScrollRestore = runtime.habitFormReturnScrollY;
  runtime.habitFormReturnScrollY = null;
}
export function readSectionFormFromDom() {
  const sf = state.sectionForm;
  const nameEl = document.getElementById('section-form-name');
  if (nameEl) sf.name = nameEl.value;
  const collapseEl = document.getElementById('section-form-collapse');
  if (collapseEl && SECTION_COLLAPSE_MODES.includes(collapseEl.value)) sf.collapse = collapseEl.value;
  const boxes = [...document.querySelectorAll('[data-section-member]')];
  if (boxes.length) sf.members = boxes.filter((b) => b.checked && !b.disabled).map((b) => b.dataset.sectionMember);
  const reminderEnabledEl = document.getElementById('section-form-reminder-enabled');
  if (reminderEnabledEl) sf.reminderEnabled = reminderEnabledEl.checked;
  const reminderTime = readTimeInput('section-form-reminder-time');
  if (reminderTime !== null) sf.reminderMinute = reminderTime;
}
// Neue Gruppe ans Ende der obersten Ebene -> { id } oder { notice }.
export async function insertSection(name, collapse, reminderMinute = null) {
  const enc = await encryptData(currentDek, { name, collapse });
  const sortOrder = containerMaxSortOrder(null) + 1;
  const { data, error } = await supabase.from('habit_sections')
    .insert({ user_id: state.session.user.id, enc, sort_order: sortOrder, reminder_minute: reminderMinute })
    .select().single();
  if (error) return { notice: errorNotice('notice.createFailed', error.message) };
  state.sections = [...state.sections, { id: data.id, name, collapse, sortOrder, reminderMinute }];
  return { id: data.id };
}
export async function saveSectionForm() {
  const sf = state.sectionForm;
  if (!sf) return;
  readSectionFormFromDom();
  const name = sf.name.trim();
  if (!name) {
    state.notice = { type: 'error', text: t('manage.error.sectionNameRequired') };
    render();
    return;
  }
  const collapse = sf.collapse;
  const enc = await encryptData(currentDek, { name, collapse });
  const reminderMinute = sf.reminderEnabled ? sf.reminderMinute : null;
  let id = sf.id;
  if (id) {
    const { error } = await supabase.from('habit_sections').update({ enc, reminder_minute: reminderMinute }).eq('id', id);
    if (error) {
      state.notice = errorNotice('notice.saveFailed', error.message);
      render();
      return;
    }
    state.sections = state.sections.map((sec) => (sec.id === id ? { ...sec, name, collapse, reminderMinute } : sec));
  } else {
    const created = await insertSection(name, collapse, reminderMinute);
    if (created.notice) {
      state.notice = created.notice;
      render();
      return;
    }
    id = created.id;
  }
  saveFieldNamesForPush();
  // Mitgliedschaft abgleichen: neu angekreuzte Felder ans Ende der Gruppe (in der
  // Reihenfolge, in der sie in der Verwaltung stehen), abgewählte ans Ende der obersten
  // Ebene. Bestehende Mitglieder behalten ihren Platz.
  const active = state.habits.filter((h) => !h.archivedAt);
  const layoutOrder = layoutBlocks(active).flatMap((b) => (b.type === 'habit' ? [b.habit.defId] : b.habits.map((h) => h.defId)));
  const current = active.filter((h) => h.sectionId === id).map((h) => h.defId);
  const added = sf.members.filter((d) => !current.includes(d)).sort((a, b) => layoutOrder.indexOf(a) - layoutOrder.indexOf(b));
  const removed = current.filter((d) => !sf.members.includes(d));
  let nextInGroup = containerMaxSortOrder(id);
  let nextTop = containerMaxSortOrder(null);
  const updates = [
    ...added.map((defId) => ({ defId, section_id: id, sort_order: ++nextInGroup })),
    ...removed.map((defId) => ({ defId, section_id: null, sort_order: ++nextTop })),
  ];
  const results = await Promise.all(updates.map((u) =>
    supabase.from('habit_definitions').update({ section_id: u.section_id, sort_order: u.sort_order }).eq('id', u.defId)));
  const failed = results.find((r) => r.error);
  const applied = new Map(updates.filter((u, i) => !results[i].error).map((u) => [u.defId, u]));
  state.habits = state.habits
    .map((h) => (applied.has(h.defId) ? { ...h, sectionId: applied.get(h.defId).section_id, sortOrder: applied.get(h.defId).sort_order } : h))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  if (failed) {
    state.notice = errorNotice('notice.saveFailed', failed.error.message);
  }
  invalidateTodayAutoCollapse(); // neue Einstellung gleich beim Zurück nach "Heute" anwenden
  closeSectionForm();
  render();
}
export function renderSectionForm() {
  const sf = state.sectionForm;
  const active = state.habits.filter((h) => !h.archivedAt);
  const candidates = layoutBlocks(active).flatMap((b) => (b.type === 'habit' ? [b.habit] : b.habits));
  return `
    <div class="habit-form" id="section-form">
      <p class="habit-form-lock-note">${t('sectionForm.explain')}</p>
      <div class="auth-field">
        <label for="section-form-name">${t('manage.sectionName')}</label>
        <input type="text" id="section-form-name" maxlength="40" value="${esc(sf.name)}" placeholder="${esc(t('manage.sectionNamePlaceholder'))}" />
      </div>
      <div class="auth-field">
        <label>${t('sectionForm.members')}</label>
        ${candidates.length ? `
          <div class="member-list">
            ${candidates.map((h) => {
              const other = h.sectionId && h.sectionId !== sf.id ? state.sections.find((sec) => sec.id === h.sectionId) : null;
              return `
                <label class="checkbox-field member-check${other ? ' member-check--blocked' : ''}">
                  <input type="checkbox" data-section-member="${h.defId}" ${sf.members.includes(h.defId) ? 'checked' : ''} ${other ? 'disabled' : ''} />
                  ${esc(h.name)}${other ? ` <span class="manage-meta">${t('sectionForm.inOtherGroup', { name: other.name })}</span>` : ''}
                </label>
              `;
            }).join('')}
          </div>
        ` : `<p class="habit-form-lock-note">${t('sectionForm.noFields')}</p>`}
      </div>
      <div class="auth-field">
        <label for="section-form-collapse">${t('sectionForm.collapse')}</label>
        <select id="section-form-collapse" aria-describedby="section-form-collapse-note">
          ${SECTION_COLLAPSE_MODES.map((m) => `<option value="${m}" ${sf.collapse === m ? 'selected' : ''}>${t('sectionForm.collapse.' + m)}</option>`).join('')}
        </select>
        <p class="habit-form-lock-note" id="section-form-collapse-note">${t('sectionForm.collapseNote')}</p>
      </div>
      <div class="auth-field section-form-reminder">
        <label class="checkbox-field">
          <input type="checkbox" id="section-form-reminder-enabled" data-action="section-reminder-toggle" aria-describedby="section-form-reminder-note" ${sf.reminderEnabled ? 'checked' : ''} />
          ${t('sectionForm.ownReminderTime')}
        </label>
        ${sf.reminderEnabled ? reminderTimeInputHtml('section-form-reminder-time', sf.reminderMinute, null, false, 'section-form-reminder-note') : ''}
        <p class="habit-form-lock-note" id="section-form-reminder-note">${sf.reminderEnabled
          ? t('sectionForm.reminderExplain')
          : t('sectionForm.defaultReminderNote', { time: formatClock(state.userSettings.defaultReminderMinute) })}</p>
      </div>
      <div class="habit-form-actions">
        <button type="button" class="habit-form-cancel" data-action="section-form-cancel">${t('common.cancel')}</button>
        <button type="button" class="auth-submit" data-action="section-form-save">${t('common.save')}</button>
      </div>
    </div>
  `;
}
// Löschen einer Gruppe löscht keine Felder: ihre (aktiven) Felder rücken auf der
// obersten Ebene genau an die Stelle, an der die Gruppe stand. Archivierte Felder
// darin verlieren ihre Zuordnung per ON DELETE SET NULL.
export async function deleteSection(id) {
  const items = [];
  for (const b of layoutBlocks(state.habits.filter((h) => !h.archivedAt))) {
    if (b.type === 'habit') items.push({ type: 'habit', id: b.habit.defId });
    else if (b.section.id === id) b.habits.forEach((h) => items.push({ type: 'habit', id: h.defId, moveOut: true }));
    else items.push({ type: 'section', id: b.section.id });
  }
  state.sectionDeleteConfirm = null;
  await commitLayoutOrder(items);
  const { error } = await supabase.from('habit_sections').delete().eq('id', id);
  if (error) {
    state.notice = errorNotice('notice.deleteFailed', error.message);
    render();
    return;
  }
  state.sections = state.sections.filter((sec) => sec.id !== id);
  state.habits = state.habits.map((h) => (h.sectionId === id ? { ...h, sectionId: null } : h));
  saveFieldNamesForPush();
  render();
  purgeKeyFromEntries(SECTION_NOTE_PREFIX + id);
}

export async function handleHabitDelete(defId) {
  const habit = state.habits.find((h) => h.defId === defId);
  const { error } = await supabase.from('habit_definitions').delete().eq('id', defId);
  if (error) {
    state.notice = errorNotice('notice.deleteFailed', error.message);
    render();
    return;
  }
  state.habits = state.habits.filter((h) => h.defId !== defId);
  render();
  // Die Feld-Definition ist gelöscht (das war der eigentliche "Löschen"-Schritt) –
  // zusätzlich räumen wir best effort die Werte dieses Feldes aus allen Tages-
  // Einträgen weg, statt sie als verwaisten Schlüssel im verschlüsselten data-JSON
  // liegen zu lassen. Passt zur Zero-Access-/Löschrecht-Ausrichtung der App: "Löschen"
  // soll möglichst wenig übrig lassen, nicht nur die Definition unbrauchbar machen.
  if (habit) purgeKeyFromEntries(habit.id);
}

// Entfernt Wert, Notiz und Sicherung (Stufen ändern) eines Schlüssels (Feld, bzw. nur
// Notiz bei 'section:<id>') aus allen Tages-Einträgen - beim endgültigen Löschen eines
// Feldes bzw. einer Gruppe.
async function purgeKeyFromEntries(key) {
  const affectedDates = Object.keys(state.entries).filter(
    (k) => state.entries[k]?.[key] !== undefined || state.entries[k]?.[NOTES_KEY]?.[key] !== undefined
      || state.entries[k]?.[PREV_KEY]?.[key] !== undefined
  );
  await Promise.all(affectedDates.map(async (dateKey) => {
    const day = withPrev(withNote({ ...state.entries[dateKey] }, key, ''), key, undefined);
    delete day[key];
    state.entries = { ...state.entries, [dateKey]: day };
    await saveDay(dateKey);
  }));
  render();
}
