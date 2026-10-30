import { createClient } from './vendor/supabase-js-2.117.2.js';

// --- Konfiguration -----------------------------------------------------
const SUPABASE_URL = 'https://qdadoqcnqmrauhshvcts.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_c8VJ-dqy-WD_y01aQy1Dzw_LJE-Ornr';
const VAPID_PUBLIC_KEY = 'BDsrR2NV5vEE4Ati-Dda7tNom6GTtWmKvzytspTc7x1LP6ur1np90oAPphhIAoCtnaw3nGELgBXxYNyiSkLVEEY';
// Supabase-seitiger Fehler (nicht unserer): PostgREST lehnt ein gerade frisch
// ausgestelltes Token gelegentlich als "JWT issued at future" (PGRST303) ab - Uhren-
// Abweichung zwischen Auth und PostgREST bzw. ein bekannter Zeit-Cache-Bug, behoben
// erst in PostgREST 14.18/16.3 (Projekt lief am 2026-09-27 auf v14.5). Trifft v.a. das
// erste Laden nach dem Öffnen (Token wird dann erneuert) - und hätte genauso gut ein
// Speichern treffen können, dann wäre der Wert verloren gewesen. Deshalb zentral hier
// statt an jeder Abfrage: bei genau diesem Fehler bis zu zweimal nach kurzer Pause neu
// versuchen. Sicher auch für Schreibzugriffe, da PostgREST die Anfrage dann vor der
// Ausführung abgewiesen hat. Nur REST-Aufrufe (Edge Functions laufen nicht über
// PostgREST). supabase-js übergibt den Body als String, der sich erneut senden lässt.
const JWT_FUTURE_RETRY_DELAYS_MS = [1000, 2000];
async function fetchWithJwtFutureRetry(input, init) {
  let res = await fetch(input, init);
  const isRest = String(input instanceof Request ? input.url : input).includes('/rest/v1/');
  for (const delay of isRest ? JWT_FUTURE_RETRY_DELAYS_MS : []) {
    if (res.status !== 401) break;
    const body = await res.clone().json().catch(() => null);
    if (body?.code !== 'PGRST303') break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    res = await fetch(input, init);
  }
  return res;
}
// Kam die Seite über den Bestätigungslink aus der Registrierungs-Mail? supabase-js liest
// den Teil nach '#' gleich beim Start aus und entfernt ihn - deshalb vorher merken
// (siehe renderConfirmLanding).
const ARRIVED_VIA_SIGNUP_CONFIRM = /(^#|&)type=signup(&|$)/.test(location.hash);
// Rückkehr über den Link aus der Mail von "E-Mail ändern" (Anmeldung mit type=email_change).
const ARRIVED_VIA_EMAIL_CHANGE = /(^#|&)type=email_change(&|$)/.test(location.hash);
// Link aus einer Mail (Registrierung, Passwort vergessen, E-Mail ändern) abgelaufen oder schon
// benutzt: Supabase leitet dann mit error_code statt einer Anmeldung zurück (otp_expired -
// auch, wenn ein Virenscanner des Mail-Anbieters den Link vorab geöffnet hat). Ohne Meldung
// sähe es aus, als hätte der Knopf in der Mail nichts getan. Welche Mail es war, steht nicht
// darin, deshalb eine Meldung, die für alle passt.
const MAIL_LINK_ERROR = (() => {
  const hash = new URLSearchParams(location.hash.slice(1));
  return hash.get('error_code') || hash.get('error');
})();
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: fetchWithJwtFutureRetry } });

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// --- Verschlüsselung (Zero-Access: der Server sieht nur Chiffretext) --------
// Zweistufiger Schlüssel: ein zufälliger DEK (Data Encryption Key) verschlüsselt die
// eigentlichen Werte in habit_entries.data. Der DEK selbst wird zweifach "verpackt"
// (wrapped) serverseitig abgelegt — einmal mit einem aus dem Passwort abgeleiteten KEK
// (Key Encryption Key), einmal mit einem zufälligen Recovery-Key, den nur der Nutzer
// kennt (einmalig angezeigt, siehe renderRecoveryKeyDisplay). Der DEK selbst ändert
// sich dadurch nie — ein Passwort-Reset mit Recovery-Key "vererbt" ihn einfach ins neu
// verpackte Feld weiter, ohne dass irgendwelche Bestandsdaten neu verschlüsselt werden
// müssten. Alles über die native Web Crypto API, keine externe Library nötig.

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBuf(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes.buffer;
}
// Recovery-Key fürs Anzeigen in Fünferblöcken gruppieren, z.B. "a1b2c-d3e4f-...".
function formatRecoveryKey(hex) {
  return hex.match(/.{1,5}/g).join('-');
}

// OWASP-Empfehlung für PBKDF2-SHA256 (Stand 2023). Konten mit weniger Runden (bis
// 2026-09-29: 250.000) werden beim nächsten Entsperren mit Passwort still hochgestuft
// (upgradePasswordWrap).
const PBKDF2_ITERATIONS = 600000;

async function deriveKek(password, saltBuf, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

async function generateDek() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

function generateRecoveryKeyBytes() {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function importRecoveryKeyAsCryptoKey(bytesBuf) {
  return crypto.subtle.importKey('raw', bytesBuf, 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
}

async function wrapDek(dek, wrappingKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey('raw', dek, wrappingKey, { name: 'AES-GCM', iv });
  return { iv: bufToBase64(iv), wrapped: bufToBase64(wrapped) };
}

async function unwrapDek(wrappedB64, ivB64, wrappingKey) {
  return crypto.subtle.unwrapKey(
    'raw',
    base64ToBuf(wrappedB64),
    wrappingKey,
    { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(ivB64)) },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// Klartext vor dem Verschlüsseln mit Leerzeichen auf ein Vielfaches von 256 Byte
// auffüllen: die Länge des Chiffretexts verriet sonst grob, wie viel jemand an einem Tag
// eingetragen/geschrieben hat (z.B. lange Notizen). JSON.parse ignoriert Leerzeichen am
// Ende, decryptData braucht deshalb keine Änderung und liest alte, ungepolsterte Daten
// genauso.
const ENCRYPT_PAD_BLOCK = 256;
async function encryptData(dek, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / ENCRYPT_PAD_BLOCK) * ENCRYPT_PAD_BLOCK).fill(0x20);
  padded.set(bytes);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, padded);
  return { iv: bufToBase64(iv), ciphertext: bufToBase64(ciphertext) };
}

async function decryptData(dek, enc) {
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(enc.iv)) }, dek, base64ToBuf(enc.ciphertext));
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// --- Lokaler DEK-Cache (IndexedDB) -------------------------------------------
// Rohbytes des entpackten DEK, ausschließlich auf diesem Gerät — geht nie an den
// Server. Erspart bei jedem App-Start auf demselben Gerät die erneute Passworteingabe
// (und die PBKDF2-Ableitung). Vergleichbares Sicherheitsniveau wie die ohnehin schon
// lokal gespeicherte Supabase-Session. Neben dem Schlüssel liegt seine Kennung
// (user_encryption.dek_id), damit sich ein veralteter Cache erkennen lässt (siehe
// usableCachedDek). Einträge von vor dieser Kennung sind ein reiner base64-String.
function openKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('logbuch-keys', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('deks');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function cacheDek(userId, dek, dekId) {
  const raw = await crypto.subtle.exportKey('raw', dek);
  const db = await openKeyDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('deks', 'readwrite');
    tx.objectStore('deks').put({ key: bufToBase64(raw), dekId }, userId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function loadCachedDek(userId) {
  const db = await openKeyDb();
  const stored = await new Promise((resolve, reject) => {
    const tx = db.transaction('deks', 'readonly');
    const req = tx.objectStore('deks').get(userId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (!stored) return null;
  const legacy = typeof stored === 'string';
  const dek = await crypto.subtle.importKey('raw', base64ToBuf(legacy ? stored : stored.key), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  return { dek, dekId: legacy ? null : stored.dekId };
}
async function clearCachedDek(userId) {
  try {
    const db = await openKeyDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('deks', 'readwrite');
      tx.objectStore('deks').delete(userId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* IndexedDB evtl. nicht verfügbar (privater Modus etc.) - egal, nur Cache */ }
}

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
function habitFromParts(row, payload) {
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
    createdAt: row.created_at,            // Zähler: ab wann ein leerer Tag als 0 zählt
    counterSince: payload.counterSince ?? null, // umgewandelter Zähler: 0 erst ab diesem Tag (siehe convertHabitToCounter)
    periodReminderDay: row.period_reminder_day ?? null, // Tag der Erinnerung im Zeitraum, null = Standard
    stepChange: payload.stepChange ?? null, // Stufen ändern: laufende bzw. letzte Umstellung (siehe runStepChange)
  };
}
// Eigene Erinnerungszeiten einer Zeile: bis zu MAX_REMINDER_TIMES (reminder_minutes, nur
// Tagesfelder), sonst die eine reminder_minute. Die DB hält reminder_minute immer auf der
// ersten Zeit (Trigger, für ältere App-Versionen).
const MAX_REMINDER_TIMES = 4;
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
function counterReminderThresholds(h) {
  const n = h.reminderTimes.length;
  if (Array.isArray(h.reminderBelow)) return h.reminderTimes.map((_, i) => (Number.isFinite(h.reminderBelow[i]) ? h.reminderBelow[i] : null));
  if (h.good === 'high' && Number.isFinite(h.target)) return h.reminderTimes.map((_, i) => Math.ceil((h.target * (i + 1)) / n - 1e-9));
  return h.reminderTimes.map(() => null);
}
// Noch nicht umgestellte Zeile (Klartext-Spalten) -> dieselbe payload-Form.
function defPayloadFromPlainRow(row) {
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
const DEF_PLAINTEXT_CLEARED = {
  slug: null, name: null, min: null, max: null, labels: null, good: null, unit: null,
  goal_threshold: null, group_members: null, display_style: 'buttons', slider_show_value: true,
};
// Neue Felder bekommen einen zufälligen Schlüssel statt eines aus dem Namen abgeleiteten
// (der frühere slug "gekifft" verriet den Namen). Bestehende Felder behalten ihren alten
// Schlüssel - der steht nur noch verschlüsselt (in enc und in habit_entries.data).
function newHabitKey() {
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
async function migrateHabitDefinitions(rows) {
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
async function saveFieldNamesForPush() {
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
async function clearFieldNamesForPush() {
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

function isNumberKind(h) { return h.kind === 'number'; }
// Zähler (kind 'counter', Nutzer-Entscheidung 2026-10-11): eine Zahl, die man im Lauf des
// Zeitraums per "+" hochzählt. Ohne Antippen gilt 0 - auch in der Auswertung (ab dem Anlegen,
// bis heute) und für Erinnerungen (nie "fehlend", siehe Migration add_counter_kind).
function isCounterKind(h) { return h.kind === 'counter'; }

// --- Gruppen (intern: sections): Anordnung -------------------------------------
// "Gruppe" in der App = "section" im Code/in der DB (habit_sections) - NICHT zu
// verwechseln mit berechneten Feldern (kind='computed'), die bis 2026-09-27 "Gruppen"
// hießen. Oberste Ebene: Felder ohne Gruppe und Gruppen gemeinsam nach sort_order (frei
// untereinander anordenbar), die Felder einer Gruppe darin nach ihrem eigenen
// sort_order (gilt nur innerhalb ihres Behälters). Ein Feld mit unbekannter Gruppe
// (sollte nicht vorkommen) gilt als "ohne Gruppe". Leere Gruppen werden mitgeliefert,
// die Aufrufer entscheiden, ob sie sie zeigen.
function layoutBlocks(habits) {
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
function containerMaxSortOrder(sectionId) {
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
function isSectionCollapsed(scope, id) {
  try { return localStorage.getItem(`sectionCollapsed:${scope}:${id}`) === '1'; } catch { return false; }
}
function setSectionCollapsed(scope, id, collapsed) {
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
const SECTION_COLLAPSE_MODES = ['done', 'manual', 'start', 'never'];
// Für den aktuellen Besuch eines Tages automatisch eingeklappte Gruppen. null = beim
// nächsten Zeichnen von "Heute" neu bestimmen (siehe invalidateTodayAutoCollapse).
let todayAutoCollapse = null; // { dateKey, ids: Set }
function invalidateTodayAutoCollapse() { todayAutoCollapse = null; }
function sectionDoneOn(habits, dayEntry) {
  const tracked = habits.filter((h) => h.kind !== 'computed');
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
function expandSection(scope, id) {
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
function renderBySection(habits, scope, renderList) {
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
function inStats(h) { return !isPeriodField(h) && (h.archivedAt ? h.archivedInStats : !h.hideInStats); }
// Berechnete Felder (kind='computed', bis 2026-09-27 "Gruppen" genannt) gibt es in zwei
// Arten: aus Skalen (Durchschnitt der normalisierten Bewertungen, mit Farbe/Ziel-Quote -
// der ursprüngliche Fall) und aus Zahlen (fassen Zahlenwert-Felder derselben Einheit per
// Summe/Durchschnitt/Minimum/Maximum zusammen, ohne Bewertung - verhalten sich in der
// Auswertung wie ein Zahlenwert-Feld). Unterschieden über aggregate: gesetzt = aus Zahlen.
function isNumberComputed(h) { return h.kind === 'computed' && !!h.aggregate; }
// Dauer zwischen zwei Uhrzeit-Feldern (aggregate 'duration', Mitglieder [von, bis]): verhält
// sich wie ein berechnetes Zahlen-Feld in Stunden.
function isDurationComputed(h) { return h.kind === 'computed' && h.aggregate === 'duration'; }
// "Tage seit …" (aggregate 'since', genau ein Mitglied = das Quellfeld): zählt die Tage seit
// einem passenden Eintrag im Quellfeld. h.since = { values, atLeast, mode }: values = die
// zählenden Stufen einer Skala mit Knöpfen (bis CHOICE_STEP_CAP Stufen), sonst atLeast =
// zählt ab diesem Wert (Zahl, Zähler, Skala mit Regler). mode 'last' = seit dem letzten
// passenden Tag (am Tag selbst 0), 'start' = seit dem ersten Tag einer Reihe (Tag 1), wobei
// Lücken bis SINCE_RUN_GAP_DAYS noch zur Reihe gehören - so wird aus "Periode" der Zyklustag,
// ohne dass ein vergessener Tag mitten in der Periode neu zu zählen beginnt.
function isSinceComputed(h) { return h.kind === 'computed' && h.aggregate === 'since'; }
const SINCE_SOURCE_KINDS = ['scale', 'number', 'counter'];
const SINCE_RUN_GAP_DAYS = 7;
function sinceUsesStages(src) { return src.kind === 'scale' && src.max - src.min + 1 <= CHOICE_STEP_CAP; }
function sinceSourceCandidate(h) { return SINCE_SOURCE_KINDS.includes(h.kind) && !isPeriodField(h); }
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
function sinceComputedDay(h, dateKey) {
  if (isFutureKey(dateKey)) return { value: null, filled: 0, total: 1 }; // weiter gezählt wird erst, wenn der Tag da ist
  const { days, runStart } = sinceDays(h);
  const d = dayIndex(dateKey);
  let lo = 0, hi = days.length - 1, i = -1; // letzter passender Tag <= d
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] <= d) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  const value = i < 0 ? null : h.since?.mode === 'start' ? d - runStart[i] + 1 : d - days[i];
  return { value, filled: value === null ? 0 : 1, total: 1 };
}
// Welche Einträge zählen, als Text ("leicht, mittel, stark" bzw. "ab 2").
function sinceWhichText(h) {
  const src = computedMemberHabits(h)[0];
  if (!src) return '–';
  if (sinceUsesStages(src)) return (h.since?.values || []).map((v) => valueAsText(src, v)).join(', ') || '–';
  return tPlain('since.atLeast', { n: formatNumber(h.since?.atLeast ?? 0) });
}
// Felder mit Gut/Schlecht-Score (Farben, Heatmap, Prozent-Statistik).
// Zahlen und Zähler mit Ziel ("mindestens/höchstens X", Nutzer-Entscheidung 2026-10-11) sind
// ebenfalls bewertet - ohne Ziel bleiben sie ein neutraler Verlauf.
function numberGoalText(h) {
  return tPlain(h.good === 'high' ? 'numberGoal.min' : 'numberGoal.max', { value: formatNumber(h.target) + (h.unit ? ` ${h.unit}` : '') });
}
function hasNumberGoal(h) { return (isNumberKind(h) || isCounterKind(h)) && !!h.good && Number.isFinite(h.target); }
function isScoredKind(h) { return h.kind === 'scale' || (h.kind === 'computed' && !h.aggregate) || hasNumberGoal(h); }
// Wie gut ein Zahlenwert das Ziel trifft (0-1): "mindestens 8" -> 4 ist 0,5; "höchstens 3" ->
// bis 3 voll, darüber linear abnehmend, ab dem Doppelten (mind. Ziel + 1) 0.
function numberGoalScore(h, v) {
  if (v === null || v === undefined) return null;
  if (h.good === 'high') return h.target > 0 ? Math.max(0, Math.min(1, v / h.target)) : 1;
  if (v <= h.target) return 1;
  return Math.max(0, 1 - (v - h.target) / Math.max(h.target, 1));
}
// Felder mit Zahlen-Verlauf (Graph statt Farbe).
function hasNumericSeries(h) { return isNumberKind(h) || isCounterKind(h) || isNumberComputed(h) || isTimeKind(h); }
// Nur Mitglieder vom passenden Typ: der Typ eines Mitglieds lässt sich ändern, solange es
// noch keine Daten hat - ein Skala-Mittelwert über ein inzwischen zum Zahlenwert gewordenes
// Feld ergäbe sonst NaN (und umgekehrt).
function computedMemberHabits(h) {
  const members = (h.members || []).map((key) => state.habits.find((x) => x.id === key));
  if (h.aggregate === 'since') return members.filter((m) => m && sinceSourceCandidate(m)).slice(0, 1);
  const kind = h.aggregate === 'duration' ? 'time' : h.aggregate ? 'number' : 'scale';
  return members.filter((m) => m && m.kind === kind);
}
// Einheit eines berechneten Zahlen-Felds = die (gemeinsame, im Formular erzwungene) Einheit seiner Mitglieder.
function computedUnit(h) { return isDurationComputed(h) ? 'h' : isSinceComputed(h) ? null : computedMemberHabits(h)[0]?.unit || null; }
// Tageswert eines berechneten Zahlen-Felds aus den an dem Tag eingetragenen Mitgliedern (bei der
// Summe zählt ein nicht eingetragenes Mitglied also als 0). Ist gar keins eingetragen,
// gibt es keinen Wert (null) statt 0 - sonst sähe ein vergessener Tag aus wie ein Tag
// mit echtem Wert 0.
function numberComputedDay(h, dateKey) {
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
function durationComputedDay(h, dateKey) {
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
function habitNumericValue(h, dateKey) {
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
function isTextKind(h) { return h.kind === 'text'; }

// Uhrzeit-Felder (kind 'time', Nutzer-Entscheidung 2026-10-29): ein Zeitpunkt pro Tag, z.B.
// "ins Bett" oder "aufgestanden". Eingetragen wird immer auf dem Tag, den man gerade ansieht
// (nie eigenmächtig auf einem anderen). Wert = Minuten ab Mitternacht dieses Tages; ab 1440
// liegt der Zeitpunkt auf dem nächsten Kalendertag ("ins Bett" Dienstag um 0:30 Mittwoch früh =
// 1470) - in "Heute" sichtbar und umschaltbar am Tag neben der Uhrzeit. Gerechnet wird mit
// Wanduhr-Zeit über Tagesnummern: eine Dauer über die Nacht der Zeitumstellung liegt eine
// Stunde daneben (bewusst hingenommen).
function isTimeKind(h) { return h.kind === 'time'; }
// Mehrfachauswahl (kind 'multi'): mehrere Optionen pro Tag ankreuzen, z.B. was heute war. Wert =
// Array der Options-Ids (stabil, damit Umbenennen nichts verschiebt), [] = "nichts davon" (zählt
// als eingetragen). h.options = [{ id, label, hidden }]: schon gewählte Optionen lassen sich nicht
// entfernen, nur ausblenden - dann nicht mehr in "Heute" (außer am Tag, an dem sie gewählt ist),
// in der Auswertung weiter, solange sie im Zeitraum vorkommt. Keine Bewertung, nur Tagesfelder.
function isMultiKind(h) { return h.kind === 'multi'; }
const MULTI_MAX_OPTIONS = 20;
function multiValue(h, dateKey) {
  const v = state.entries[dateKey]?.[h.id];
  return Array.isArray(v) ? v : null;
}
function multiOptionUsed(habitId, optionId) {
  return Object.values(state.entries).some((day) => Array.isArray(day?.[habitId]) && day[habitId].includes(optionId));
}
function newMultiOptionId() { return crypto.randomUUID().slice(0, 8); }
function emptyMultiOptions() { return [{ id: newMultiOptionId(), label: '' }, { id: newMultiOptionId(), label: '' }]; }
const MINUTES_PER_DAY = 1440;
function dayIndex(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
// Wie viele Kalendertage nach dem Tag des Eintrags der Zeitpunkt liegt (0 = derselbe).
function timeDayOffset(v) { return Math.floor(v / MINUTES_PER_DAY); }
// Ein Zeitpunkt als Wert auf dem Tag dateKey ("Jetzt", "+20 min" - auch auf der Seite von gestern).
function timeValueOn(dateKey, moment) {
  return (dayIndex(formatKey(moment)) - dayIndex(dateKey)) * MINUTES_PER_DAY + moment.getHours() * 60 + moment.getMinutes();
}
// Uhrzeit zum Anzeigen: 12 oder 24 Stunden nach der Region des Geräts (clockUses12h).
function formatClock(v) {
  const m = ((Math.round(v) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (!clockUses12h()) return minutesToTimeStr(m);
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
// Dauer in Stunden als "7:30" (Stunden:Minuten statt 7,5 - so liest man Schlaf).
function formatDuration(hours) {
  const total = Math.round(Math.abs(hours) * 60);
  return `${hours < 0 ? '-' : ''}${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// --- Feste Tage (habit_definitions.schedule) -------------------------------
// null = täglich, {type:'weekly', days:[0..6]} (0 = Montag) oder "Alle N Tage"
// {type:'interval', every:2..365, unit:'day', start:'YYYY-MM-DD'} - dran ab dem Starttag in
// festem Abstand, davor nicht (monatlich/jährlich decken Zeitraum-Felder ab). Gegenstück zur
// SQL-Funktion public.habit_scheduled_on (Erinnerungen) - beide müssen dieselbe Regel
// umsetzen; unbekannte Pläne gelten als "dran".
function isScheduledOn(schedule, date) {
  if (schedule?.type === 'interval' && Number.isInteger(schedule.every) && schedule.every >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(schedule.start || '')) {
    const diff = Math.round((startOfDay(date) - parseDateKey(schedule.start)) / 86400000);
    return diff >= 0 && diff % schedule.every === 0;
  }
  if (schedule?.type !== 'weekly' || !Array.isArray(schedule.days)) return true;
  return schedule.days.includes((date.getDay() + 6) % 7);
}
// Ob ein Feld an einem Tag "dran" ist. Berechnete Felder haben keinen eigenen Plan: dran, sobald
// eines ihrer aktiven Mitglieder dran ist.
function isPlannedOn(h, date) {
  if (h.kind !== 'computed') return isScheduledOn(h.schedule, date);
  return (h.members || []).some((slug) => {
    const m = state.habits.find((x) => x.id === slug);
    return m && !m.archivedAt && isScheduledOn(m.schedule, date);
  });
}
// Kurzbeschreibung für die Verwaltungsliste ('' bei täglich): die Wochentage bzw. "alle N Tage".
function scheduleSummary(schedule) {
  if (schedule?.type === 'interval') return t('schedule.summary.everyDays', { n: schedule.every });
  if (schedule?.type !== 'weekly') return '';
  const names = mondayFirstWeekdayShortNames();
  return schedule.days.map((d) => names[d]).join(', ');
}

// --- Datum-Helfer ----------------------------------------------------------
function formatKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
// Parst einen 'YYYY-MM-DD'-Key als lokales Datum (nicht new Date(string), das UTC
// interpretiert und je nach Zeitzone einen Tag daneben liegen kann).
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
// Tage nach heute lassen sich nicht öffnen und nichts eintragen (Nutzer-Entscheidung
// 2026-10-30, Grenze Mitternacht ohne Einstellung): Pfeil, Wischen, Kalender und die Zellen
// der Übersicht enden bei heute. Uhrzeiten nach Mitternacht auf der heutigen Seite bleiben.
function isFutureKey(dateKey) { return dateKey > formatKey(new Date()); }
function isPastKey(dateKey) { return dateKey < formatKey(new Date()); }
// Steht die Ansicht schon beim laufenden Tag/Woche/Monat/Jahr? Dann geht es nicht weiter.
function atCurrentPeriod(view = state.view) {
  const now = new Date();
  if (view === 'today') return !isPastKey(formatKey(state.currentDate));
  if (view === 'week') return formatKey(startOfWeek(state.weekAnchor)) >= formatKey(startOfWeek(now));
  if (view === 'month') return state.monthAnchor.getFullYear() * 12 + state.monthAnchor.getMonth() >= now.getFullYear() * 12 + now.getMonth();
  if (view === 'year') return state.yearAnchor >= now.getFullYear();
  return false;
}
const nextPeriodDisabled = (view) => (atCurrentPeriod(view) ? ' aria-disabled="true"' : '');
// Zellen der Übersicht, die einen Tag öffnen - zukünftige sind keine Knöpfe.
function openDayAttrs(d) {
  const key = formatKey(d);
  return isFutureKey(key) ? 'role="img"' : `data-action="open-day" data-date="${key}" tabindex="0" role="button"`;
}
function startOfWeek(date) { const d = startOfDay(date); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); return d; }
// Zeitraum-Felder (period 'week'/'month'/'year', siehe docs/datenmodell.md): ein Wert pro
// Zeitraum, gespeichert im Eintrag des ersten Tags des Zeitraums. Gegenstück zu
// public.habit_period_start (SQL) - synchron halten.
const PERIODS = ['week', 'month', 'year'];
function isPeriodField(h) { return !!h && !!h.period && h.period !== 'day'; }
function periodStart(period, date) {
  const d = startOfDay(date);
  if (period === 'week') return startOfWeek(d);
  if (period === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  if (period === 'year') return new Date(d.getFullYear(), 0, 1);
  return d;
}
function periodEnd(period, date) {
  const start = periodStart(period, date);
  if (period === 'week') return addDays(start, 6);
  if (period === 'month') return new Date(start.getFullYear(), start.getMonth() + 1, 0);
  if (period === 'year') return new Date(start.getFullYear(), 11, 31);
  return start;
}
// Unter welchem Tag der Wert eines Felds steht: Tagesfelder am Tag selbst, Zeitraum-Felder am
// ersten Tag ihres Zeitraums. Alle Speicher-Wege (handleSelect & Co., Notizen) laufen hier
// durch - so bleibt der Rest (saveDay, mergeDay, Verschlüsselung) unverändert.
function entryKeyFor(habitId, dateKey) {
  const h = state.habits.find((x) => x.id === habitId);
  return isPeriodField(h) ? formatKey(periodStart(h.period, parseDateKey(dateKey))) : dateKey;
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }

// --- Erinnerungszeit-Helfer (Minuten seit Mitternacht <-> "HH:MM") ---------
// Erinnerungszeiten werden seit dem Onboarding-Tutorial in 15-Minuten-Schritten
// statt nur zur vollen Stunde gespeichert (siehe CLAUDE.md), als Minuten seit
// Mitternacht (0-1439) statt Stunde (0-23).
function minutesToTimeStr(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
const REMINDER_TIME_STEP = 15; // Minuten — muss zum Cron-Intervall in send-notifications passen
// Uhrzeit als Knopf, der die eigene Uhrzeit-Auswahl öffnet (openTimePicker), Minuten nur
// 00/15/30/45 - so oft läuft der Versand. dataAction sagt, was nach der Auswahl passiert
// (reminderTimePicked). Wert lesen über readTimeInput(id).
function reminderTimeInputHtml(id, minutes, dataAction, disabled, describedBy, labelledBy) {
  const label = labelledBy ? `aria-labelledby="${labelledBy} ${id}"` : `aria-label="${esc(t('time.label'))}: ${esc(formatClock(minutes))}"`;
  return `<button type="button" class="time-pick" id="${id}" data-time-input data-action="reminder-time-pick" data-then="${dataAction || ''}" data-value="${minutes}" ${disabled ? 'disabled' : ''} ${describedBy ? `aria-describedby="${describedBy}"` : ''} ${label}>${esc(formatClock(minutes))}</button>`;
}
// Minuten seit Mitternacht aus reminderTimeInputHtml (id oder das Element), null wenn es
// nicht im DOM steht.
function readTimeInput(idOrEl) {
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl?.closest('[data-time-input]');
  return el ? Number(el.dataset.value) : null;
}
// Nach der Auswahl: Knopf nachziehen, dann je nach Stelle speichern bzw. ins Formular übernehmen.
function reminderTimePicked(id, v) {
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
function normalize(habit, value) {
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
// jedem Aufruf live neu gerechnet wird — beabsichtigt, siehe CLAUDE.md.
function habitScore(h, dateKey) {
  if (hasNumberGoal(h)) return numberGoalScore(h, habitNumericValue(h, dateKey));
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
function habitVisibleInRange(h, dateKeys) {
  if (isNumberComputed(h)) return dateKeys.some((k) => numberComputedDay(h, k).value !== null);
  if (h.kind === 'computed') return dateKeys.some((k) => habitScore(h, k) !== null);
  return dateKeys.some((k) => state.entries[k]?.[h.id] !== undefined);
}

function scoreColor(score) {
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
function isNeutralScale(h) { return h.kind === 'scale' && !h.good; }
const NEUTRAL_FILL = 'var(--sand)';
const NEUTRAL_SELECTED = 'var(--ink)';
const NEUTRAL_SELECTED_TEXT = 'var(--paper)';
// Zentrale Weiche für jede farbliche Score-Darstellung eines konkreten Feldes -
// scoreColor() für bewertete (auch berechnete) Felder, NEUTRAL_FILL für unbewertete.
function habitColor(habit, score) {
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
function textOnScore(rgb) {
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
function scoreTextColor(color) {
  return `color-mix(in srgb, ${color} 60%, var(--ink))`;
}
// Zahlen/Zähler mit Ziel in "Heute": der Wert gefärbt nach Zielnähe (auch 0 - Nutzer-
// Entscheidung 2026-10-14: neutral bis zum ersten Eintrag hilft nicht, nach einem von acht
// Gläsern wäre es trotzdem rot), dahinter "/ Ziel". Bewusst ohne "max"/Haken: ob mindestens
// oder höchstens, weiß man bei den eigenen Feldern selbst (Nutzer-Entscheidung, störte optisch).
function goalValueStyle(h, value) {
  if (!hasNumberGoal(h)) return '';
  const v = Number(value);
  return Number.isFinite(v) ? ` style="color:${scoreTextColor(scoreColor(numberGoalScore(h, v)))}"` : '';
}
function goalSuffixHtml(h) {
  return `<span class="goal-suffix"><span aria-hidden="true">/ ${esc(formatNumber(h.target))}</span><span class="visually-hidden">${esc(tPlain('today.goalOf', { target: formatNumber(h.target) }))}</span></span>`;
}

// Zusätzlich zur Farbe (scoreColor) ein Streifenmuster, dessen Dichte/Deckkraft mit
// dem Score steigt — macht die Bewertung auch für Rot-Grün-Farbenblinde ohne Farbe
// erkennbar, nicht als Ersatz für die Farbe, sondern als Ergänzung. Bewusst diskrete
// Stufen statt stufenloser Variation: bei 8-22px Zellgröße wäre ein kontinuierlicher
// Verlauf visuelles Rauschen, diskrete Stufen sind als "Sprosse auf einer Leiter"
// erkennbar unabhängig vom Farbton. coarse=true (Jahres-Ansicht, ~8px Zellen) nutzt
// nur 3 statt 5 Stufen mit weiter auseinanderliegenden Streifen.
function scorePatternStyle(score, coarse) {
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
function dayCellAriaLabel(date, score) {
  const scoreText = score === null || score === undefined ? t('common.noData') : `${Math.round(score * 100)}%`;
  return tPlain('ariaLabel.dayCell', { date: formatDMY(date), score: scoreText });
}

// Verschiebt einen normalisierten Score (0-1) anhand der pro Feld einstellbaren
// Ziel-Quote (goalThreshold, Standard 1 = 100%) für die FARBGEBUNG — z.B. bei
// "Kraftsport gemacht" kann eine 50%-Quote schon als voll erreicht (Score 1) gelten.
// Ändert NIE angezeigte Prozentzahlen, nur die Farbe, und wird bewusst NICHT in der
// "Heute"-Ansicht verwendet (siehe renderHabitOptions). Bei Standard-Ziel (1) exakter
// Durchreicher, keine Änderung ggü. vorher.
function applyGoal(habit, score) {
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
function dayOverallScore(date) {
  const dateKey = formatKey(date);
  const day = state.entries[dateKey];
  if (!day) return null;
  const scores = state.habits.filter((h) => ((h.kind === 'scale' && !isNeutralScale(h)) || hasNumberGoal(h)) && !isPeriodField(h))
    .map((h) => applyGoal(h, habitScore(h, dateKey)))
    .filter((s) => s !== null);
  if (!scores.length) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// Durchschnitt + Anzahl je Skala-/berechnetem Feld über eine Menge von Datums-Keys
// ('YYYY-MM-DD').
function computeHabitStats(habits, dateKeys) {
  return habits.map((h) => {
    let sum = 0, count = 0, hits = 0, numSum = 0;
    for (const k of dateKeys) {
      const s = habitScore(h, k);
      if (s !== null) {
        sum += s; count++; if (s >= 0.999) hits++;
        if (hasNumberGoal(h)) numSum += habitNumericValue(h, k);
      }
    }
    return { habit: h, avg: count ? sum / count : null, count, hits, numAvg: count ? numSum / count : null };
  });
}

// Werte-Reihe + Kennzahlen eines Zahlenwert-Felds bzw. berechneten Zahlen-Felds über eine
// Menge von Datums-Keys.
function numberFieldStats(habit, dateKeys) {
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
function formatSeriesValue(h, v) {
  if (isTimeKind(h)) return formatClock(v);
  if (isDurationComputed(h)) return `${formatDuration(v)} h`;
  if (isSinceComputed(h)) {
    if (h.since?.mode === 'start') return tPlain('since.dayN', { n: formatNumber(v) });
    return v === 0 ? tPlain('since.today') : tPlain(v === 1 ? 'since.oneDay' : 'since.days', { n: formatNumber(v) });
  }
  const unit = isNumberComputed(h) ? computedUnit(h) : h.unit;
  return formatNumber(v) + (unit ? ` ${unit}` : '');
}

// --- App-State ---------------------------------------------------------
const state = {
  onbDisplayOpen: false, // Einführung: Auswahl "Aa Anzeige" aufgeklappt (addOnbDisplayBar)
  session: null,
  entries: {},       // { 'YYYY-MM-DD': { habitId: value, ... } }
  loading: true,
  notice: null,       // { type: 'error'|'ok', text }
  view: 'today',
  previousTabView: 'today', // Tab, zu dem "Verwalten"/"Über Logbuch" zurückspringen (siehe enterSubpage/closeTopLayer)
  currentDate: startOfDay(new Date()),
  weekAnchor: startOfWeek(new Date()),
  monthAnchor: (() => { const d = startOfDay(new Date()); d.setDate(1); return d; })(),
  yearAnchor: new Date().getFullYear(),
  // 'welcome' | 'mode' (Einstiegsfrage) | 'overview' ("So läuft's ab") | 'installed' (frisch
  // installierte App) | 'signup' | 'checkMail' | 'signin' | 'forgot'
  authMode: signedInHereBefore() ? 'signin' : isStandaloneDisplay() ? 'installed' : 'welcome',
  authError: null,
  authEmail: '', // bleibt über einen Re-Render (z.B. nach Fehler) hinweg erhalten,
  authPassword: '', // damit ein Tippfehler nicht das ganze Formular leert (siehe input-Listener).
  authPasswordVisible: false,
  // Adresse, an die gerade eine Bestätigungsmail ging (nach der Registrierung bzw. beim
  // Anmelden mit noch unbestätigter Adresse) - blendet die Hilfe "Keine Mail da?" ein.
  confirmEmailFor: null,
  confirmResend: null, // null | 'sending' | 'sent' | { error: text }
  passwordRecovery: false, // true zwischen Klick auf den Passwort-Reset-Link und neuem Passwort
  todayIntroStep: 0, // aktuelle Karte der einmaligen Erklärung in "Heute" (renderTodayIntro)
  pushStatus: 'unknown', // 'unsupported' | 'unknown' | 'off' | 'on' | 'busy' | 'blocked' (Mitteilungen im Browser/Handy verboten)
  habits: [],         // alle Felder des Nutzers (aktiv + archiviert), sort_order-sortiert
  unsupportedHabits: [], // Felder eines Typs, den diese Version nicht kennt (siehe isSupportedHabit)
  sections: [],       // Gruppen (intern "sections"): { id, name, sortOrder } (siehe layoutBlocks)
  sectionForm: null,  // { id: null (neu) | Gruppen-ID, name, members: [defId] } - offenes Gruppen-Formular
  sectionDeleteConfirm: null, // Gruppen-ID, deren Löschen gerade bestätigt wird
  habitForm: null,    // { defId, locked, name, mode: 'numeric'|'labels', min, max, steps, labels, good }
  habitFormSaving: false, // true während handleHabitSave() läuft, verhindert Doppel-Submits
  menuOpen: false,
  rowMenu: null,      // offenes Zeilen-Menü in "Heute": Feld-id, 'section:<id>' oder DAY_MENU_KEY
  noteEditor: null,   // { dateKey, key, draft } - offener Notiz-Editor (key = slug oder DAY_NOTE_KEY)
  resetConfirm: null, // dateKey, während die Rückfrage "Tag zurücksetzen?" offen ist
  unplannedOpenFor: null, // dateKey, an dem "Heute nicht geplant" aufgeklappt wurde
  // Standard-Erinnerungszeit (Minuten seit Mitternacht) für Felder ohne eigene reminder_minute.
  // onboardingCompleted default true, bis loadUserSettings() den echten Wert lädt – verhindert,
  // dass das Tutorial kurz aufblitzt, bevor die tatsächlichen Einstellungen geladen sind.
  userSettings: { defaultReminderMinute: 1320, onboardingCompleted: true, locale: 'de', summaryNotifications: true, timezone: 'Europe/Berlin' },
  deleteConfirm: null, // { busy: boolean } während der Konto-Löschen-Bestätigung offen ist
  passwordChange: null, // { current, next, visible, busy, error } während "Passwort ändern" offen ist
  spareKeyCheck: null, // { value, busy, result: 'ok'|'wrong'|'error'|null, errorText } während "Ersatzschlüssel prüfen" offen ist
  emailChange: null, // { value, password, busy, error, sentTo } während "E-Mail-Adresse ändern" offen ist
  regenKeyConfirm: false, // Rückfrage vor "Ersatzschlüssel neu erzeugen" offen
  logoutConfirm: false,   // Rückfrage vor "Abmelden" (aus dem Menü) offen
  leaveFormConfirm: false, // Rückfrage "Änderungen verwerfen?" beim Verlassen eines geänderten Formulars (siehe leaveFormGuarded)
  habitDeleteConfirm: null, // defId eines archivierten Feldes mit Daten, dessen Löschen gerade bestätigt wird
  tutorialStep: null, // TUTORIAL_STEP_* während Tutorial bzw. Erinnerungs-Schritt für neue Accounts laufen, sonst null
  tutorialSkipConfirm: false, // Bestätigungsdialog "Tutorial überspringen?" offen
  confirmLanding: false, // "E-Mail bestätigt - zurück zur App" statt Anmelden im Browser (renderConfirmLanding)
  encryptionSetupInProgress: false, // true während setupEncryption()/Migration läuft
  recoveryKeyToShow: null, // { hex } - einmalige Anzeige des Ersatzschlüssels nach Erzeugung
  unlockError: null, // Fehlertext im renderUnlockPrompt-Screen
  unlockBusy: false,
  recoveryFallbackConfirm: false, // "Recovery-Key auch verloren?" im Passwort-Reset aufgeklappt
  recoveryBusy: false,
  feedback: { message: '', anonymous: false, busy: false }, // Unterseite "Feedback geben"
};

// currentDek (Modul-Variable statt state): der lebende Entschlüsselungs-Schlüssel darf
// nie über render()/innerHTML laufen und soll auch nicht versehentlich durch
// generische State-Handhabung angefasst werden. currentDekId ist seine Kennung
// (user_encryption.dek_id), gegen die checkDekStillCurrent prüft.
let currentDek = null;
let currentDekId = null;
// Konto, dem der geladene Schlüssel gehört - damit sich erkennen lässt, wenn die Session
// plötzlich einem anderen Konto gehört (z.B. in einem anderen Tab umgemeldet).
let currentDekUserId = null;
function setCurrentDek(dek, dekId, userId) {
  currentDek = dek;
  currentDekId = dekId;
  currentDekUserId = userId;
}
function clearCurrentDek() {
  clearFeatureAccess(); // gehört zum angemeldeten Konto wie der Schlüssel
  currentDek = null;
  currentDekId = null;
  currentDekUserId = null;
}
// Ersatzschlüssel (Recovery-Key) noch unbestätigt (user_encryption.recovery_key_confirmed
// = false): neues Konto, Reset ohne Ersatzschlüssel, oder im Menü neu erzeugt und vor dem
// Bestätigen geschlossen. maybeShowSpareKey zeigt dann einen frisch erzeugten an.
let spareKeyPending = false;

// Merkt sich einen CSS-Selektor für das Element, das ein Modal (Konto löschen/
// Tutorial überspringen) geöffnet hat, damit der Fokus beim Schließen
// (Abbrechen/Escape) dorthin zurückspringt. Bewusst ein Selektor statt einer
// direkten Element-Referenz: render() ersetzt bei jedem Aufruf das komplette
// innerHTML, jede zuvor gemerkte Node wäre beim Schließen längst verwaist —
// der Selektor wird erst beim tatsächlichen Zurückspringen neu aufgelöst.
let modalTriggerSelector = null;
function restoreModalFocus() {
  if (!modalTriggerSelector) return;
  document.querySelector(modalTriggerSelector)?.focus();
  modalTriggerSelector = null;
}
// Gemeinsamer Schließ-Weg aller Bestätigungs-Modals (Abbrechen-Button, Escape,
// Android-Zurück) - rendert NICHT selbst, der Aufrufer muss danach render() und
// restoreModalFocus() aufrufen (closeTopLayer läuft z.B. vor einem eigenen render()).
function closeModals() {
  if (state.whatsNew) closeWhatsNew(); // Schließen = gesehen (speichert)
  state.deleteConfirm = null;
  if (!state.passwordChange?.busy) state.passwordChange = null;
  state.spareKeyCheck = null;
  if (!state.emailChange?.busy) state.emailChange = null;
  state.tutorialSkipConfirm = false;
  state.resetConfirm = null;
  state.regenKeyConfirm = false;
  state.logoutConfirm = false;
  state.leaveFormConfirm = false;
  pendingFormLeave = null;
}

// --- Android-Zurück-Taste schließt offene Overlays/Unterseiten statt die App zu
// verlassen -------------------------------------------------------------------
// Ohne eigene History-Einträge hat die native/Gesten-Zurück-Taste nichts, wohin sie
// "zurückgehen" könnte, und beendet stattdessen sofort die App (bzw. den Tab) -
// unabhängig davon, was gerade offen ist. Bewusst nur für Overlays (Menü,
// Feld-Formular, Lösch-Bestätigungen) und Unterseiten (Verwalten/Über Logbuch), NICHT
// für reine Tab-Wechsel (Heute/Woche/...) - das entspricht dem üblichen Verhalten von
// Android-Apps mit Tab-Leiste. state.recoveryKeyToShow bleibt bewusst ausgenommen: das
// ist schon jetzt absichtlich nur über die Bestätigungs-Checkbox schließbar (auch
// Escape greift dort nicht), das soll die Zurück-Taste nicht aushebeln.
//
// Overlay und Unterseite können gleichzeitig offen sein (z.B. "Neues Feld" innerhalb
// von "Verwalten") - deshalb ein Layer-Zähler statt einer reinen Boolean-Prüfung, mit
// je einem History-Eintrag pro Layer, damit zwei Zurück-Drücke auch zwei Ebenen
// nacheinander schließen.
function isSubpageView(view) { return ['manage', 'about', 'feedback', 'settings', 'install'].includes(view); }
// Merkt sich den Tab, von dem aus eine Unterseite betreten wurde (nicht überschreiben,
// wenn man z.B. innerhalb von "Verwalten" übers Menü direkt zu "Über Logbuch"
// wechselt - sonst würde "Zurück" dann fälschlich zu "Verwalten" statt zum
// ursprünglichen Tab führen).
function enterSubpage(view) {
  if (!isSubpageView(state.view)) state.previousTabView = state.view;
  if (view === 'about' || view === 'settings') openAboutSections = new Set(); // bei jedem Öffnen alles zugeklappt
  if (view !== 'manage') closeManageOverlays();
  state.view = view;
  state.menuOpen = false;
}
// Feld-Formular und Feld-Lösch-Bestätigung gehören zur Verwaltungsseite - wer sie
// verlässt (←-Button, Wischen, Menü-Wechsel zu einer anderen Unterseite), schließt
// sie mit. Sonst blieben sie unsichtbar im State offen und zählten weiter als
// History-Ebene (ein wirkungsloser Android-Zurück-Druck auf der nächsten Seite).
function closeManageOverlays() {
  state.habitForm = null;
  habitFormReturnScrollY = null;
  state.habitDeleteConfirm = null;
  state.sectionForm = null;
  state.sectionDeleteConfirm = null;
}
function leaveSubpage() {
  closeManageOverlays();
  state.view = state.previousTabView || 'today';
}
function isOverlayOpen() {
  return state.menuOpen || !!state.rowMenu || isNoteEditorOpen() || !!state.sectionForm || !!state.resetConfirm || !!state.regenKeyConfirm || !!state.logoutConfirm || state.leaveFormConfirm || !!state.deleteConfirm || !!state.passwordChange || !!state.spareKeyCheck || !!state.emailChange || state.tutorialSkipConfirm || !!state.habitForm || !!state.habitDeleteConfirm || !!state.whatsNew;
}
// Der Notiz-Editor gehört zu einem bestimmten Tag in "Heute" und ist nur offen, solange
// er dort auch sichtbar ist - wechselt man Tag/Tab, speichert render() den Entwurf und
// schließt ihn (siehe commitPendingNoteDraft).
// Zusätzlich muss das Feld selbst noch in "Heute" stehen - wird es z.B. über das
// Zeilen-Menü archiviert, während seine Notiz offen ist, wäre der Editor sonst
// unsichtbar, zählte aber weiter als offene Ebene.
function isNoteEditorOpen() {
  const ed = state.noteEditor;
  if (!ed || state.view !== 'today' || ed.dateKey !== entryKeyFor(ed.key, formatKey(state.currentDate))) return false;
  if (ed.key === DAY_NOTE_KEY) return true;
  if (ed.key.startsWith(SECTION_NOTE_PREFIX)) return sectionShownToday(ed.key.slice(SECTION_NOTE_PREFIX.length));
  return activeHabits().some((h) => h.id === ed.key && !isTextKind(h));
}
function currentLayerCount() {
  return (isSubpageView(state.view) ? 1 : 0) + (isOverlayOpen() ? 1 : 0) + (timePicker ? 1 : 0);
}
// Das Feld-Formular ist eine eigene Ebene innerhalb der Verwaltung: solange es offen
// ist, zeigt die Verwaltung NUR das Formular (kein Weiterscrollen zu den anderen
// Feldern, Titel im Seitenkopf, siehe renderManage/renderApp). Geöffnet wird es immer
// über openHabitForm, das sich die Scroll-Position merkt - closeHabitForm (einziger
// Schließ-Weg: Speichern, Abbrechen, ←-Button, Wischen, Android-Zurück) bringt einen
// genau dorthin zurück (per pendingScrollRestore, eingelöst am Ende von render()).
// Wurde es über einen Shortcut aus "Heute" geöffnet (returnToTab, lebt bewusst im
// Formular-Zustand und verschwindet so automatisch mit ihm), geht es danach direkt
// zurück zum Tab statt in der Verwaltung zu bleiben - die Absicht war dort "jetzt
// tracken", nicht "verwalten".
let habitFormReturnScrollY = null;
let pendingScrollRestore = null;
function openHabitForm(form) {
  habitFormReturnScrollY = window.scrollY;
  state.habitForm = form;
  render();
  markFormBaseline();
  window.scrollTo(0, 0);
  // Nur beim Neuanlegen direkt den Namen fokussieren (öffnet auf dem Handy gleich die
  // Tastatur, funktioniert nur zuverlässig synchron aus einem Klick-Handler) - ohne
  // Namen geht es dort nicht weiter. Beim Bearbeiten will man meist etwas anderes
  // ändern; dort bleibt der Fokus auf der Seitenüberschrift (siehe renderApp).
  if (!form.defId) requestAnimationFrame(() => document.getElementById('habit-form-name')?.focus());
}
function closeHabitForm() {
  const returnToTab = state.habitForm?.returnToTab;
  state.habitForm = null;
  if (returnToTab && state.view === 'manage') state.view = state.previousTabView || 'today';
  pendingScrollRestore = habitFormReturnScrollY;
  habitFormReturnScrollY = null;
}
// ←-Button und Wischen auf einer Unterseite: bei offenem Feld-Formular zurück zur
// Liste (bzw. zum Tab, siehe returnToTab), sonst die Unterseite verlassen.
function subpageBack() {
  if (state.view === 'manage' && state.habitForm) leaveFormGuarded(closeHabitForm);
  else if (state.view === 'manage' && state.sectionForm) leaveFormGuarded(closeSectionForm);
  else leaveSubpage();
}

// --- Rückfrage beim Verlassen eines geänderten Formulars ----------------------
// Feld- und Gruppen-Formular: wer sie mit Änderungen anders als über "Abbrechen" verlässt
// (←, Wischen, Android-Zurück, Menü), wird gefragt, statt still alles zu verlieren.
// "Abbrechen" verwirft bewusst ohne Rückfrage. Verglichen wird mit dem Stand direkt nach
// dem Öffnen (form.baseline, gesetzt von markFormBaseline) - nur die gespeicherten
// Werte, keine reinen Anzeige-Zustände (Fehler, aufgeklappte Teile). Formulare ohne
// baseline (Tutorial) fragen nie: dort gibt es eigene Wege (Überspringen-Rückfrage).
function habitFormSnapshot(f) {
  const snap = {};
  for (const k of Object.keys(defaultHabitForm())) snap[k] = f[k];
  snap.labels = f.labelsEnabled ? f.labels.slice(0, f.max - f.min + 1) : null;
  snap.members = [...f.members].sort();
  snap.schedule = f.schedule.mode === 'interval'
    ? { every: f.schedule.every, start: f.schedule.start }
    : [...f.schedule.days].sort();
  if (!f.reminderEnabled) { snap.reminderTimes = null; snap.reminderBelow = null; }
  // "Stufen ändern" offen und schon etwas eingestellt (nur Öffnen zählt nicht).
  snap.stepEdit = f.stepEdit && stepEditKey(f.stepEdit) !== f.stepEdit.initial ? 'changed' : null;
  snap.typeEdit = f.typeEdit && typeEditKey(f.typeEdit) !== f.typeEdit.initial ? 'changed' : null;
  return JSON.stringify(snap);
}
function sectionFormSnapshot(sf) {
  return JSON.stringify({
    name: sf.name, collapse: sf.collapse, members: [...sf.members].sort(),
    reminderMinute: sf.reminderEnabled ? sf.reminderMinute : null,
  });
}
// Nach dem ersten render() des Formulars aufrufen: liest es einmal aus dem DOM zurück,
// damit Normalisierungen beim Einlesen (Uhrzeit, Bezeichnungen) nicht als Änderung zählen.
function markFormBaseline() {
  if (state.habitForm) { syncHabitFormFromDom(); state.habitForm.baseline = habitFormSnapshot(state.habitForm); }
  else if (state.sectionForm) { readSectionFormFromDom(); state.sectionForm.baseline = sectionFormSnapshot(state.sectionForm); }
}
function openFormHasChanges() {
  const f = state.habitForm;
  if (f?.baseline) { syncHabitFormFromDom(); return habitFormSnapshot(f) !== f.baseline; }
  const sf = state.sectionForm;
  if (sf?.baseline) { readSectionFormFromDom(); return sectionFormSnapshot(sf) !== sf.baseline; }
  return false;
}
// Führt proceed (rendert NICHT selbst, wie closeHabitForm) sofort aus - oder öffnet bei
// Änderungen die Rückfrage und führt es erst bei "Verwerfen" aus. Der Aufrufer rendert
// in beiden Fällen wie gewohnt danach.
let pendingFormLeave = null;
function leaveFormGuarded(proceed) {
  if (state.leaveFormConfirm) return; // Rückfrage schon offen (z.B. zweiter Wisch)
  if (!openFormHasChanges()) { proceed(); return; }
  pendingFormLeave = proceed;
  state.leaveFormConfirm = true;
  state.menuOpen = false;
  modalTriggerSelector = '.subpage-header .back-btn';
}
// Schließt jeweils nur die "oberste" Ebene (analog zur bestehenden Escape-Logik) -
// Overlays vor der Unterseite, da sie darüber liegen. In der Praxis nie mehrere
// Overlays gleichzeitig offen, da z.B. die Menü-Aktionen state.menuOpen beim Öffnen
// eines anderen Overlays bereits selbst auf false setzen.
function closeTopLayer() {
  if (state.whatsNew) {
    closeWhatsNew();
  } else if (state.deleteConfirm || state.passwordChange || state.spareKeyCheck || state.emailChange || state.tutorialSkipConfirm || state.resetConfirm || state.regenKeyConfirm || state.logoutConfirm || state.leaveFormConfirm) {
    closeModals(); // bei "Änderungen verwerfen?" = Weiter bearbeiten
    restoreModalFocus();
  } else if (stepDialogOpen()) {
    closeStepDialog();
  } else if (state.menuOpen) {
    state.menuOpen = false;
  } else if (state.rowMenu) {
    state.rowMenu = null;
  } else if (isNoteEditorOpen()) {
    commitPendingNoteDraft(); // wie Tag-/Tab-Wechsel: Zurück speichert, nur "Abbrechen" verwirft
  } else if (state.sectionForm || state.habitForm) {
    // Bleibt das Formular wegen der Rückfrage offen, legt das folgende render() den eben
    // verbrauchten History-Eintrag wieder an (syncLayerHistory).
    leaveFormGuarded(state.sectionForm ? closeSectionForm : closeHabitForm);
  } else if (state.habitDeleteConfirm) {
    state.habitDeleteConfirm = null;
  } else if (isSubpageView(state.view)) {
    leaveSubpage();
  }
}
let openLayerCount = 0;
// true zwischen einem SELBST ausgelösten history.go() (siehe syncLayerHistory) und
// dem dadurch erst asynchron ausgelösten popstate - unterscheidet "wir korrigieren nur
// die History-Position, der State stimmt schon" von einem echten Zurück-Druck. Ohne das
// hätte z.B. ein direkter Wechsel zwischen zwei Unterseiten übers Menü (schließt dabei
// nebenbei das Menü-Overlay, die Layer-Zahl sinkt also auch ohne echten Zurück-Druck)
// fälschlich die Unterseite selbst mit geschlossen, weil das eigene Korrektur-go()
// ebenfalls ein popstate auslöst.
let closingLayerViaPopstate = false;
window.addEventListener('popstate', () => {
  if (closingLayerViaPopstate) { closingLayerViaPopstate = false; return; }
  if (currentLayerCount() === 0) return; // nichts (mehr) zu schließen - Browser navigiert normal weiter
  openLayerCount = Math.max(0, openLayerCount - 1); // History-Position ist durch den Pop bereits korrekt
  // Die Uhrzeit-Auswahl liegt über allem und außerhalb von #app: ohne render() schließen.
  if (timePicker) { closeTimePicker({ viaPopstate: true }); return; }
  closeTopLayer();
  // Schließt closeTopLayer dabei mehr als eine Ebene (z.B. Feld-Formular aus dem
  // "Heute"-Shortcut: Formular UND Verwaltung), räumt syncLayerHistory in render() den
  // übrigen History-Eintrag selbst weg.
  render();
});
// Von render() aufgerufen: hält die History mit der Layer-Anzahl synchron, damit pro
// geöffneter Ebene genau ein Zurück-Druck sie wieder schließt - auch wenn sie
// stattdessen ganz normal über die App (Abbrechen-Button, ←-Button o.ä.) geschlossen
// wird (sonst blieben "tote" History-Einträge stehen, die zusätzliche, wirkungslose
// Zurück-Drücke vor dem eigentlichen Verlassen der App erfordert hätten).
function syncLayerHistory() {
  if (closingLayerViaPopstate) return;
  const n = currentLayerCount();
  if (n > openLayerCount) {
    // Ein Eintrag PRO neuer Ebene - öffnen sich zwei auf einmal (z.B. "+ Neues Feld" in
    // "Heute": Verwaltung + Formular), muss es auch zwei geben, sonst ginge das
    // go(-2) beim gemeinsamen Schließen unten einen Schritt zu weit (App verlassen).
    for (let i = openLayerCount; i < n; i++) history.pushState({ logbuchLayer: true }, '');
    openLayerCount = n;
  } else if (n < openLayerCount) {
    // go(-Differenz) statt back(): schließt eine Aktion zwei Ebenen auf einmal (z.B.
    // Deep-Link aus einer Benachrichtigung, oder Speichern im "Heute"-Shortcut-
    // Formular), bliebe mit back() ein toter Eintrag stehen, der einen wirkungslosen
    // Zurück-Druck kosten würde. Eine Traversierung = genau ein popstate, egal wie weit.
    const steps = openLayerCount - n;
    openLayerCount = n;
    closingLayerViaPopstate = true; // siehe Kommentar an der Deklaration oben
    history.go(-steps);
  }
}
// Scrollen NEBEN dem Menü (Hintergrund/Fenster) soll das Menü schließen, Scrollen AUF
// dem Menü selbst (falls dessen Inhalt bei Zoom o.ä. nicht mehr auf den Bildschirm
// passt) dagegen nicht - und darf dabei auch nicht den Hintergrund mitscrollen. Löst
// sich rein über 'scroll' am WINDOW statt einer Body-Scroll-Sperre: 'scroll'-Events
// bubbeln nicht, ein Scroll innerhalb von .menu-panel (eigenes overflow-y: auto, siehe
// CSS) feuert nur dort, nie am window - dieser Listener sieht deshalb nur echte
// Hintergrund-Scrolls. .menu-panel hat zusätzlich overscroll-behavior: contain, damit
// ein Scroll, der dort an sein Ende kommt (z.B. durchgescrollt bis ganz unten), nicht
// ins darunterliegende Fenster "durchreicht" und dort doch noch scrollt.
// Das Zeilen-Menü in "Heute" schließt beim Scrollen ebenso - es hängt zwar an seiner
// Zeile (scrollt mit), bleibt aber sonst beim Weiterscrollen unbemerkt offen und würde
// den nächsten Tipp als Light-Dismiss verschlucken.
window.addEventListener('scroll', () => {
  if (state.menuOpen) { state.menuOpen = false; render(); }
  if (state.rowMenu) closeRowMenu();
}, { passive: true });

function activeHabits() {
  return state.habits.filter((h) => !h.archivedAt);
}

function habitHasData(habitId) {
  return Object.values(state.entries).some((day) => day[habitId] !== undefined);
}

const app = document.getElementById('app');

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- i18n --------------------------------------------------------------
// Flache Keys ("namespace.element"), DE und EN in schlüsselgleicher Reihenfolge
// zum leichten Diffen. t(key, params) interpoliert {platzhalter} aus params (wird
// dabei automatisch esc()'t) — das Template selbst bleibt unescaped, darf also
// bewusst gesetztes HTML wie <strong> enthalten.
const STRINGS = {
  de: {
    'error.db.duplicateSlug': 'Ein Feld mit einem sehr ähnlichen Namen existiert schon – bitte einen anderen Namen wählen.',
    'error.db.duplicateGeneric': 'Das gibt es in dieser Form schon.',
    'error.db.notNull': 'Ein Pflichtfeld fehlt oder enthält gerade keinen gültigen Wert – bitte alle Felder prüfen und nochmal versuchen.',
    'error.db.check': 'Einer der eingegebenen Werte liegt außerhalb des erlaubten Bereichs.',
    'error.db.pushLimit': 'Erinnerungen sind schon auf 10 Geräten eingeschaltet – schalte sie auf einem davon aus, um sie hier einzuschalten.',
    'error.db.accountGone': 'Dieses Konto existiert nicht mehr (z.B. von einem anderen Gerät aus gelöscht). Du wurdest ausgeloggt.',
    'error.db.foreignKey': 'Ein verknüpfter Eintrag existiert nicht mehr – bitte die Seite neu laden und nochmal versuchen.',
    'error.db.network': 'Keine Verbindung zum Server – prüfe deine Internetverbindung und versuch es nochmal.',
    'error.db.sessionExpired': 'Deine Sitzung ist abgelaufen – bitte lade die Seite neu und melde dich erneut an.',
    'ariaLabel.clearInput': 'Eingabe löschen',
    'ariaLabel.explain': 'Erklärung anzeigen',
    'ariaLabel.decrease': 'Verringern',
    'ariaLabel.increase': 'Erhöhen',
    'notice.loadEntriesError': 'Einträge konnten nicht geladen werden.',
    'notice.loadHabitsError': 'Felder konnten nicht geladen werden.',
    'notice.habitsUndecryptable': '{count} Feld(er) konnten nicht entschlüsselt werden und werden nicht angezeigt.',
    'push.customReminder': 'Erinnerung: {names} noch nicht eingetragen.',
    'push.counterReminder': 'Erinnerung: {names}',
    'push.sectionReminder': 'Erinnerung: In „{name}“ fehlt noch etwas.',
    'notice.loadSettingsError': 'Einstellungen konnten nicht geladen werden.',
    'notice.saveFailed': 'Speichern hat nicht geklappt.',
    'notice.createFailed': 'Anlegen hat nicht geklappt.',
    'notice.actionFailed': 'Das hat nicht geklappt.',
    'notice.reorderFailed': 'Die Reihenfolge konnte nicht gespeichert werden.',
    'notice.deleteFailed': 'Löschen hat nicht geklappt.',
    'notice.invalidNumber': 'Das ist keine gültige Zahl.',
    'notice.recoveryKeySaveError': 'Der neue Ersatzschlüssel konnte nicht gespeichert werden.',
    'habitForm.error.minComputedMembers': 'Bitte mindestens 2 Felder auswählen.',
    'habitForm.error.stepsRange': 'Anzahl Stufen muss zwischen 2 und {max} liegen.',
    'habitForm.lockedStepCap': 'Dieses Feld hat {steps} Stufen – Buttons und eigene Bezeichnungen gehen nur bis {cap} Stufen, damit jede Stufe gut sichtbar und gezielt wählbar bleibt.',
    'habitForm.stepCapHint': 'Mehr als {cap} Stufen gehen nur als Schieberegler ohne eigene Bezeichnungen – bei so vielen lässt sich eine einzelne Stufe kaum noch gezielt wählen.',
    'habitForm.stepCapToSlider': 'Zum Schieberegler wechseln',
    'habitForm.stepCapLabelsOff': 'Eigene Bezeichnungen abschalten',
    'habitForm.error.fillAllLabels': 'Bitte alle Bezeichnungen ausfüllen.',
    'habitForm.error.nameRequired': 'Bitte einen Namen eingeben.',
    'ariaLabel.dismissHint': 'Hinweis schließen',
    'installHint.ios': 'Leg Logbuch auf deinen Home-Bildschirm – auf dem iPhone kommen Erinnerungen sonst gar nicht an.',
    'installHint.other': 'Leg Logbuch auf deinen Startbildschirm – dann öffnet es sich wie eine App, und Erinnerungen kommen zuverlässiger an.',
    'installHint.show': 'Zeig mir, wie',
    'notice.pushPermissionDenied': 'Ohne deine Erlaubnis kann Logbuch keine Erinnerungen schicken. Du kannst es jederzeit nochmal versuchen.',
    'notice.pushEnabled': 'Erinnerungen sind aktiv.',
    'notice.enableFailed': 'Erinnerungen ließen sich nicht einschalten.',
    'notice.entriesUndecryptable': '{count} Tag(e) konnten nicht entschlüsselt werden und erscheinen leer. Damit nichts verloren geht, speichert Logbuch dort nichts. Schreib mir gern über „Feedback geben“.',
    'notice.dayUndecryptable': 'Dieser Tag konnte nicht entschlüsselt werden. Damit sein Inhalt nicht überschrieben wird, speichert Logbuch hier nichts.',
    'notice.disableFailed': 'Erinnerungen ließen sich nicht ausschalten.',
    'notice.exportFailed': 'Der Export hat nicht geklappt.',
    'notice.exportDownloaded': 'Export heruntergeladen.',
    'notice.tryAgain': 'Bitte versuch es gleich nochmal.',
    'notice.valueRemoved': '{name}: Eintrag entfernt',
    'notice.undo': 'Rückgängig',
    'notice.details': 'Technische Details',
    'ariaLabel.closeNotice': 'Meldung schließen',
    'deleteAccount.confirmWord': 'LÖSCHEN',
    'deleteAccount.confirmMismatch': 'Bitte tippe genau „{word}“ zur Bestätigung.',
    'auth.title.forgot': 'Passwort zurücksetzen',
    'auth.title.signup': 'Neues Konto anlegen',
    'auth.title.login': 'Anmelden',
    'auth.forgotRecoveryNote': 'Zum eigentlichen Zurücksetzen brauchst du im nächsten Schritt deinen Ersatzschlüssel (den du nach der Einrichtung bekommen bzw. zuletzt in den Einstellungen neu erzeugt hast) – nur damit bleiben deine bisherigen Daten erhalten.',
    'auth.email': 'E-Mail',
    'auth.password': 'Passwort',
    'auth.passwordHint': '<strong>Merk es dir gut oder schreib es auf</strong> und leg den Zettel an einen sicheren Ort – ohne dein Passwort kommst du nicht mehr an deine Einträge.',
    'auth.passwordRule': 'Mindestens {min} Zeichen',
    'auth.emailWhy': 'Damit hast du ein eigenes Konto: Wechselst du mal das Handy oder willst du Logbuch auf einem anderen Gerät nutzen, meldest du dich dort einfach an.',
    'auth.passwordWhyTitle': 'Warum so wichtig?',
    'auth.passwordWhy': 'Deine Einträge werden auf deinem Gerät verschlüsselt, bevor sie gespeichert werden – dein Passwort ist der Schlüssel dazu. Deshalb kann niemand sonst sie lesen, nicht mal ich. Wähle eines, das du sonst nirgends verwendest.',
    'auth.hide': 'Verbergen',
    'auth.show': 'Anzeigen',
    'auth.sendResetLink': 'Link zum Zurücksetzen senden',
    'auth.createAccount': 'Konto erstellen',
    'auth.login': 'Anmelden',
    'auth.busy.signup': 'Konto wird erstellt …',
    'auth.busy.login': 'Wird angemeldet …',
    'auth.busy.forgot': 'Wird gesendet …',
    'auth.welcome.lead': 'Schön, dass du da bist!',
    'auth.welcome.new': 'Ich bin neu hier',
    'auth.welcome.newNote': 'Konto erstellen und Logbuch einrichten – dauert etwa 5 bis 10 Minuten.',
    'auth.welcome.existing': 'Ich habe schon ein Konto',
    'auth.welcome.existingNote': 'Mit deiner E-Mail-Adresse und deinem Passwort anmelden.',
    'onb.mode.title': 'Wie möchtest du starten?',
    'onb.mode.guided': 'Schritt für Schritt',
    'onb.mode.guidedNote': 'Mit genauen Erklärungen und Bildern.',
    'onb.mode.short': 'Kurz und knapp',
    'onb.mode.shortNote': 'Wenn du dich mit Apps gut auskennst. Erklärungen kannst du trotzdem jederzeit aufklappen.',
    'onb.intro.title': 'Kurz vorweg',
    'onb.intro.body': 'Hi, ich bin Louis und hab Logbuch gebaut, weil ich Menschen im Alltag unterstützen will – so, wie ich es mir selbst von einer App wünschen würde. Logbuch funktioniert in ein paar Punkten anders, als du es vielleicht von anderen Apps kennst – und damit es für dich richtig funktioniert, solltest du die kennen.',
    'onb.intro.help': 'Ich erklär dir bei jedem Schritt, was zu tun ist. <strong>Lies es dir bitte in Ruhe durch</strong> – dann klappt alles beim ersten Mal.',
    'onb.intro.ok': 'Alles klar',
    'onb.overview.title': 'So läuft’s ab',
    'onb.overview.install': 'Logbuch aufs Handy holen',
    'onb.overview.account': 'Konto erstellen und E-Mail bestätigen',
    'onb.overview.setup': 'Logbuch kennenlernen und dein erstes Feld anlegen',
    'onb.overview.reminders': 'Erinnerungen einstellen, wenn du magst',
    'onb.overview.key': 'Ersatzschlüssel sichern',
    'onb.overview.duration': 'Dauert etwa 5 bis 10 Minuten – du kannst dir aber auch gern mehr Zeit lassen.',
    'onb.overview.helper': 'Wenn du magst, hol dir jemanden dazu, der sich mit Handys auskennt – zu zweit geht’s oft leichter.',
    'onb.overview.start': 'Los geht’s',
    'onb.installed.title': 'Geschafft!',
    'onb.installed.body': 'Logbuch ist jetzt auf deinem Handy. Weiter geht’s mit deinem Konto.',
    'onb.installed.continue': 'Konto erstellen',
    'onb.progress.label': 'Schritt {n} von {total}: {name}',
    'onb.progress.part': 'Teil {part} von {parts}',
    'onb.stage.install': 'Logbuch aufs Handy holen',
    'onb.stage.account': 'Konto erstellen',
    'onb.stage.setup': 'Logbuch kennenlernen',
    'onb.stage.reminders': 'Erinnerungen',
    'onb.stage.key': 'Ersatzschlüssel sichern',
    'auth.backToLogin': 'Zurück zur Anmeldung',
    'auth.forgotPassword': 'Passwort vergessen?',
    'auth.resetLinkSent': 'Falls diese E-Mail bei uns registriert ist, haben wir einen Link zum Zurücksetzen geschickt.',
    'auth.signupFailedGeneric': 'Registrierung fehlgeschlagen. Bitte versuche es erneut.',
    'auth.confirmHelp.spam': 'Keine Mail da? Schau auch im <strong>Spam-Ordner</strong> nach – je nach Anbieter heißt er auch „Werbung“ oder „Junk“. Manchmal dauert es ein paar Minuten.',
    'auth.confirmHelp.sentTo': 'Die Mail ging an: <strong>{email}</strong>. Stimmt die Adresse nicht? Dann registriere dich einfach nochmal mit der richtigen.',
    'auth.confirmHelp.resend': 'Mail nochmal senden',
    'auth.confirmHelp.resending': 'Wird gesendet …',
    'auth.confirmHelp.resent': 'Eine neue Mail ist unterwegs.',
    'auth.confirmHelp.wait': 'Bitte warte noch {seconds} Sekunden, dann kannst du es nochmal versuchen.',
    'auth.confirmHelp.failed': 'Das Senden hat nicht geklappt. Bitte versuch es gleich nochmal.',
    'auth.checkMail.title': 'Schau in dein Postfach',
    'auth.checkMail.body': 'Ich hab dir eine Mail geschickt. Damit ist sicher, dass die Adresse dir gehört – wichtig, falls du einmal dein Passwort zurücksetzen musst.',
    'auth.checkMail.howTitle': 'So geht’s',
    'auth.checkMail.after': 'Danach meldest du dich an – hier über „Weiter zum Anmelden“ oder auf der Seite, die sich nach dem Bestätigen öffnet. Hast du Logbuch aufs Handy geholt, mach am besten in der App weiter.',
    'auth.checkMail.step1': 'Öffne deine E-Mail-App (z. B. Gmail, GMX oder Outlook).',
    'auth.checkMail.step2': 'Öffne die Mail von Logbuch („Bestätige deine Adresse für Logbuch“). Findest du sie nicht, schau auch im Spam-Ordner.',
    'auth.checkMail.step3': 'Tipp darin auf den Knopf zum Bestätigen.',
    'auth.checkMail.continue': 'Weiter zum Anmelden',
    'auth.error.passwordTooShort': 'Das Passwort muss mindestens {min} Zeichen lang sein.',
    'recovery.title': 'Neues Passwort setzen',
    'recovery.newPassword': 'Neues Passwort',
    'recovery.key': 'Ersatzschlüssel',
    'recovery.keyPlaceholder': 'von der Einrichtung bzw. zuletzt in den Einstellungen neu erzeugt',
    'recovery.saving': 'Wird gespeichert …',
    'recovery.savePassword': 'Passwort speichern',
    'recovery.keyAlsoLost': 'Ersatzschlüssel auch verloren?',
    'recovery.fallbackWarning': 'Ohne Ersatzschlüssel lassen sich deine bisherigen Daten nicht mehr entschlüsseln: alle Einträge und Notizen sowie deine Felder und Gruppen. Sie sind dann unwiederbringlich verloren und werden gelöscht, du startest mit einem leeren Logbuch. Dein Konto selbst bleibt bestehen.',
    'recovery.setAnyway': 'Verstanden, Passwort trotzdem setzen (alte Daten verloren)',
    'recovery.cancelHaveKey': 'Doch abbrechen, ich habe den Ersatzschlüssel noch',
    'recovery.error.noConfig': 'Keine Verschlüsselungs-Konfiguration gefunden.',
    'recovery.error.wrongKey': 'Der Ersatzschlüssel ist falsch oder unvollständig. Nichts wurde verändert.',
    'recovery.passwordSaved': 'Passwort gespeichert.',
    'recovery.cleanupFailed': 'Passwort gespeichert. Deine alten, nicht mehr lesbaren Daten konnten aber nicht vollständig gelöscht werden – falls dir Felder als „nicht entschlüsselbar“ gemeldet werden, schreib mir bitte über „Feedback geben“.',
    'recoveryDisplay.title': 'Dein Ersatzschlüssel',
    'recoveryDisplay.lead': 'Falls du dein Passwort einmal vergisst, kommst du <strong>nur mit diesem Schlüssel</strong> wieder an deine Einträge. Heb ihn deshalb gut auf.',
    'recoveryDisplay.whyTitle': 'Warum gibt es den?',
    'recoveryDisplay.codeLabel': 'Dein Ersatzschlüssel',
    'recoveryDisplay.secret': 'Gib ihn niemandem – er öffnet dein Logbuch genauso wie dein Passwort.',
    'recoveryDisplay.how': 'Wie möchtest du ihn aufbewahren?',
    'recoveryDisplay.method.write': 'Aufschreiben',
    'recoveryDisplay.method.photo': 'Foto vom Bildschirm',
    'recoveryDisplay.method.file': 'Als Datei speichern',
    'recoveryDisplay.method.copy': 'Kopieren',
    'recoveryDisplay.help.write': 'Schreib ihn Zeichen für Zeichen auf Papier und leg den Zettel zu deinen wichtigen Unterlagen. Die Abstände zwischen den Blöcken sind nur zum besseren Lesen.',
    'recoveryDisplay.help.photoIos': 'Mach ein Bildschirmfoto – bei den meisten iPhones: kurz gleichzeitig die <strong>Seitentaste</strong> und die <strong>Lauter-Taste</strong> drücken (bei iPhones mit runder Home-Taste: Seitentaste und Home-Taste). Das Bild landet in deinen Fotos.',
    'recoveryDisplay.help.photoAndroid': 'Mach ein Bildschirmfoto – bei den meisten Handys: kurz gleichzeitig die <strong>Ein/Aus-Taste</strong> und die <strong>Leiser-Taste</strong> drücken. Das Bild landet in deiner Galerie bzw. deinen Fotos.',
    'recoveryDisplay.help.photoOther': 'Mach mit deinem Handy ein Foto von diesem Bildschirm.',
    'recoveryDisplay.help.fileIos': 'Die Datei „logbuch-ersatzschluessel.txt“ liegt danach meist in der App <strong>Dateien</strong> unter <strong>Downloads</strong>. Fragt dein iPhone vorher nach, tipp auf „Laden“.',
    'recoveryDisplay.help.fileAndroid': 'Die Datei „logbuch-ersatzschluessel.txt“ liegt danach meist im Ordner <strong>Downloads</strong> – zu finden in der App <strong>Dateien</strong> bzw. „Eigene Dateien“ (je nach Handy).',
    'recoveryDisplay.help.fileOther': 'Die Datei „logbuch-ersatzschluessel.txt“ liegt danach meist in deinem Ordner <strong>Downloads</strong>.',
    'recoveryDisplay.help.copy': 'Kopiert. Füge ihn jetzt dort ein, wo du ihn aufbewahren willst – z. B. in einem Passwort-Manager oder einer Notiz.',
    'recoveryDisplay.help.copyGuided': 'Kopiert – dein Handy hat sich den Schlüssel gemerkt. Öffne jetzt z. B. deine <strong>Notizen-App</strong>, tipp lange auf eine leere Stelle und wähle <strong>Einfügen</strong>. Komm danach hierher zurück.',
    'recoveryDisplay.done': 'Ich habe ihn aufbewahrt',
    'recoveryDisplay.askNone': 'Hast du ihn sicher aufbewahrt? Ohne Ersatzschlüssel kann dir niemand helfen, wenn du dein Passwort vergisst.',
    'recoveryDisplay.askWritten': 'Hast du ihn aufgeschrieben? Ohne Ersatzschlüssel kann dir niemand helfen, wenn du dein Passwort vergisst.',
    'recoveryDisplay.notYet': 'Noch nicht',
    'recoveryDisplay.yesWritten': 'Ja, aufgeschrieben',
    'recoveryDisplay.yesKept': 'Ja, ist aufbewahrt',
    'recoveryDisplay.explain': 'Deine Einträge sind so verschlüsselt, dass <strong>nur du sie lesen kannst – nicht mal ich.</strong> Die Kehrseite: Vergisst du dein Passwort, reicht ein Link zum Zurücksetzen allein nicht, deine Einträge blieben verschlossen. Dafür gibt es diesen Ersatzschlüssel – mit ihm setzt du ein neues Passwort, ohne etwas zu verlieren.',
    'recoveryDisplay.moreLabel': 'Was, wenn ich beides verliere?',
    'recoveryDisplay.more': 'Verlierst du Passwort <strong>und</strong> Ersatzschlüssel, sind deine Einträge weg – das ist der Preis dafür, dass niemand sonst rankommt. Einen neuen Ersatzschlüssel bekommst du jederzeit in den Einstellungen unter „Ersatzschlüssel neu erzeugen“, der alte wird dann ungültig.',
    'recoveryDisplay.fileTitle': 'Logbuch – Ersatzschlüssel',
    'recoveryDisplay.fileName': 'logbuch-ersatzschluessel.txt',
    'common.next': 'Weiter',
    'common.back': 'Zurück',
    'common.logout': 'Abmelden',
    'unlock.title': 'Passwort eingeben',
    'unlock.explain': 'Zur Sicherheit brauchst du hier dein Passwort noch einmal.',
    'unlock.account': 'Konto: <strong>{email}</strong>',
    'unlock.afterConfirm': '✓ Adresse bestätigt! Gib hier dein Passwort ein, um weiterzumachen – oder mach in der Logbuch-App weiter, falls du sie aufs Handy geholt hast. Dann brauchst du diese Seite nicht mehr.',
    'unlock.whyTitle': 'Warum?',
    'unlock.why': 'Deine Einträge sind mit deinem Passwort verschlüsselt. Auf einem neuen Gerät, nach dem Löschen der Browserdaten oder wenn du gerade über den Link aus der Mail gekommen bist, kennt Logbuch den Schlüssel noch nicht – dein Passwort öffnet sie wieder (bzw. richtet bei einem neuen Konto die Verschlüsselung ein).',
    'unlock.unlocking': 'Einen Moment …',
    'unlock.unlock': 'Weiter',
    'unlock.wrongPassword': 'Falsches Passwort.',
    'unlock.failed': 'Das hat nicht geklappt.',
    'unlock.keyChanged': 'Deine Verschlüsselung wurde auf einem anderen Gerät neu eingerichtet (Passwort zurückgesetzt ohne Ersatzschlüssel). Bitte gib dein aktuelles Passwort ein.',
    'ariaLabel.deleteEntry': 'Eintrag löschen',
    'ariaLabel.noValue': 'kein Wert',
    'ariaLabel.prevDay': 'Vorheriger Tag',
    'ariaLabel.nextDay': 'Nächster Tag',
    'ariaLabel.prevWeek': 'Vorherige Woche',
    'ariaLabel.nextWeek': 'Nächste Woche',
    'ariaLabel.prevMonth': 'Vorheriger Monat',
    'ariaLabel.nextMonth': 'Nächster Monat',
    'ariaLabel.prevYear': 'Vorheriges Jahr',
    'ariaLabel.nextYear': 'Nächstes Jahr',
    'ariaLabel.reorder': 'Reihenfolge ändern',
    'ariaLabel.menu': 'Menü',
    'ariaLabel.back': 'Zurück',
    'ariaLabel.dayCell': '{date}, {score}',
    'ariaLabel.moveUp': 'Nach oben verschieben',
    'ariaLabel.moveDown': 'Nach unten verschieben',
    'common.noData': 'keine Daten',
    'computedInfo.avgOf': 'Ø aus {names} ({filled}/{total} heute erfasst)',
    'computedInfo.aggOf': '{agg} aus {names} ({filled}/{total} heute erfasst)',
    'computedInfo.durationOf': 'Dauer von „{from}“ bis „{to}“',
    'computedInfo.sinceLast': 'seit dem letzten „{name}“ ({which})',
    'computedInfo.sinceStart': 'seit Beginn von „{name}“ ({which})',
    'since.today': 'heute',
    'since.oneDay': '1 Tag',
    'since.days': '{n} Tage',
    'since.dayN': 'Tag {n}',
    'since.atLeast': 'ab {n}',
    'aggregate.sum': 'Summe',
    'aggregate.avg': 'Durchschnitt',
    'aggregate.min': 'Minimum',
    'aggregate.max': 'Maximum',
    'manage.computedAggregate': '{agg} aus: {names}',
    'manage.computedDuration': 'Dauer von {from} bis {to}',
    'manage.computedSinceLast': 'Tage seit dem letzten Eintrag in {name}',
    'manage.computedSinceStart': 'Tage seit Beginn von {name}',
    'habitForm.computedType': 'Art der Berechnung',
    'habitForm.computedType.scale': 'Skalen',
    'habitForm.computedType.number': 'Zahlenwerte',
    'habitForm.computedType.duration': 'Dauer',
    'habitForm.computedType.since': 'Tage seit',
    'habitForm.sinceSource': 'Welches Feld?',
    'habitForm.sinceValues': 'Welche Einträge zählen?',
    'habitForm.sinceAtLeast': 'Zählt ab dem Wert',
    'habitForm.sinceMode': 'Wie zählen?',
    'habitForm.sinceMode.last': 'Seit dem letzten Mal',
    'habitForm.sinceMode.start': 'Seit Beginn',
    'habitForm.sinceNote.last': 'Zeigt, wie viele Tage seit dem letzten passenden Eintrag vergangen sind – am Tag selbst „heute“. Z. B. Tage seit dem letzten Sport.',
    'habitForm.sinceNote.start': 'Zählt ab dem ersten Tag einer Reihe passender Einträge, dieser Tag ist Tag 1. Lücken bis zu einer Woche gehören noch zur Reihe (z. B. ein vergessener Tag), erst danach beginnt eine neue. So wird z. B. aus einem Feld „Periode“ der Zyklustag.',
    'habitForm.noSinceCandidates': 'Dafür braucht es ein Feld mit Skala oder Zahl.',
    'habitForm.durationChoose': 'Bitte wählen',
    'habitForm.durationFrom': 'Von (z. B. ins Bett)',
    'habitForm.durationTo': 'Bis (z. B. aufgestanden)',
    'habitForm.durationNote': 'Die Dauer steht an dem Tag mit der Bis-Uhrzeit und reicht zurück bis zur letzten Von-Uhrzeit davor – auch über Mitternacht.',
    'habitForm.noDurationCandidates': 'Dafür braucht es zwei Uhrzeit-Felder, z. B. „ins Bett“ und „aufgestanden“.',
    'habitForm.aggregate': 'Pro Tag berechnen als',
    'habitForm.computedUnitNote': 'Zusammenrechnen lassen sich nur Felder mit derselben Einheit – sonst käme eine falsche Zahl heraus (z. B. km + m).',
    'habitForm.noNumberComputedCandidates': 'Noch keine Zahlenwert-Felder vorhanden, die sich zusammenrechnen lassen.',
    'habitForm.error.computedUnitMismatch': 'Die ausgewählten Felder haben unterschiedliche Einheiten.',
    'habitForm.error.durationMembers': 'Bitte zwei verschiedene Uhrzeit-Felder für „Von“ und „Bis“ wählen.',
    'habitForm.error.sinceSource': 'Bitte ein Feld wählen und festlegen, welche Einträge zählen.',
    'numberBox.last': 'zuletzt: {value} ({date})',
    'timeBox.now': 'Jetzt',
    'timeBox.aria': '{name}: {time} – ändern',
    'timeBox.ariaEmpty': '{name}: noch keine Uhrzeit – eintragen',
    'timeBox.ariaNextDay': '{name}: {time} nach Mitternacht ({day}) – ändern',
    'timePicker.addAria': '{n} Minuten später',
    'timePicker.addLabel': '+{n} min',
    'timePicker.dayLabel': 'Welcher Tag?',
    'timePicker.sameDay': 'am {day}',
    'timePicker.nextDay': 'nach Mitternacht ({day})',
    'timePicker.clear': 'Uhrzeit löschen',
    'timePicker.apply': 'Übernehmen',
    'today.jumpToday': 'Zu heute springen',
    'today.pickDate': 'Datum wählen',
    'today.noFields': 'Noch keine Felder angelegt.',
    'today.resetDay': 'Tag zurücksetzen',
    'today.fieldOptions': 'Optionen für {name}',
    'today.dayOptions': 'Optionen für diesen Tag',
    'today.sectionOptions': 'Optionen für Gruppe {name}',
    'note.add': 'Notiz hinzufügen',
    'note.edit': 'Notiz bearbeiten',
    'note.editPrefix': 'Notiz bearbeiten:',
    'note.labelField': 'Notiz zu {name}',
    'note.labelDay': 'Notiz zum Tag',
    'note.labelSection': 'Notiz zur Gruppe {name}',
    'note.addDay': 'Notiz zum Tag hinzufügen …',
    'ariaLabel.withNote': ', mit Notiz',
    'resetConfirm.title': 'Tag zurücksetzen?',
    'resetConfirm.body': 'Alle Werte und Notizen vom {date} werden gelöscht. Das lässt sich nicht rückgängig machen.',
    'resetConfirm.confirm': 'Zurücksetzen',
    'regenKeyConfirm.title': 'Neuen Ersatzschlüssel erzeugen?',
    'regenKeyConfirm.body': 'Dein bisheriger Ersatzschlüssel funktioniert danach <strong>nicht mehr</strong> – auch nicht der, den du aufgeschrieben oder gespeichert hast. Mach das nur, wenn du ihn verloren hast oder jemand anderes ihn kennen könnte.',
    'regenKeyConfirm.confirm': 'Neuen erzeugen',
    'logoutConfirm.title': 'Abmelden?',
    'logoutConfirm.body': 'Auf diesem Gerät kommen dann keine Erinnerungen mehr. Zum erneuten Anmelden brauchst du dein Passwort. Deine Einträge bleiben erhalten.',
    'leaveForm.title': 'Änderungen verwerfen?',
    'leaveForm.bodyField': 'Deine Änderungen an diesem Feld sind noch nicht gespeichert. Wenn du jetzt gehst, gehen sie verloren.',
    'leaveForm.bodyGroup': 'Deine Änderungen an dieser Gruppe sind noch nicht gespeichert. Wenn du jetzt gehst, gehen sie verloren.',
    'leaveForm.stay': 'Weiter bearbeiten',
    'leaveForm.discard': 'Verwerfen',
    'notice.fieldArchived': 'Feld archiviert. Unter „Felder verwalten“ kannst du es jederzeit wieder aktivieren.',
    'common.archived': 'archiviert',
    'global.rangeNote': 'Seit {since} · {count} Tage mit Eintrag',
    'global.noEntries': 'Noch keine Einträge.',
    'stats.empty': 'Hier siehst du bald, wie deine Tage verlaufen – sobald du ein paar Tage eingetragen hast.',
    'stats.legend.title': 'Was bedeuten Farben und Zahlen?',
    'stats.legend.bad': 'weniger gut',
    'stats.legend.good': 'gut',
    'stats.legend.week': 'Jedes Kästchen zeigt, wie gut der Wert an dem Tag war – gemessen daran, was du beim Feld unter „Bewertung“ eingestellt hast (bei „Niedrige Werte erstrebenswert“ ist wenig grün). Leer: nichts eingetragen. Schraffiert: an dem Tag nicht geplant. Ø: bei Feldern mit zwei Stufen (z. B. Ja/Nein), an wie vielen der eingetragenen Tage es der gute Wert war (2/5), bei Skalen der Durchschnitt als Punkt auf der Skala (links der erste, rechts der letzte Wert); berechnete Felder in Prozent. Antippen zeigt es ausgeschrieben.',
    'stats.legend.stats': 'Im Kalender zeigt jeder Tag die Tagesfarbe: den Durchschnitt aller bewerteten Felder. Darunter pro Feld: bei Feldern mit zwei Stufen (z. B. Ja/Nein), an wie vielen der eingetragenen Tage es der gute Wert war, sonst der Durchschnitt und in Klammern, an wie vielen Tagen du eingetragen hast. Berechnete Felder in Prozent – 100 % wäre jeden Tag der beste Wert.',
    'stats.yesNoDays': 'an {n} von {total} Tagen',
    'stats.scaleOf': 'Ø {value} von {max}',
    'stats.scaleRange': 'Ø {value} ({min} bis {max})',
    'stats.yesNoDaysLabel': 'an {n} von {total} Tagen „{label}“',
    'stats.yesNoDays.week': 'in {n} von {total} Wochen',
    'stats.yesNoDaysLabel.week': 'in {n} von {total} Wochen „{label}“',
    'stats.yesNoDays.month': 'in {n} von {total} Monaten',
    'stats.yesNoDaysLabel.month': 'in {n} von {total} Monaten „{label}“',
    'stats.yesNoDays.year': 'in {n} von {total} Jahren',
    'stats.yesNoDaysLabel.year': 'in {n} von {total} Jahren „{label}“',
    'periodStats.week': 'Wöchentliche Felder',
    'periodStats.month': 'Monatliche Felder',
    'periodStats.year': 'Jährliche Felder',
    'stats.legend.common': 'Felder ohne Bewertung zeigen nur, ob etwas eingetragen ist. Das Streifenmuster (abschaltbar in den Einstellungen) zeigt dasselbe wie die Farbe – für alle, die Rot und Grün schlecht unterscheiden.',
    'global.title': 'Gesamt',
    'numberChart.meta': '{last} zuletzt · Ø {avg} · {count}×',
    'numberChart.metaLast': '{last} zuletzt',
    'numberChart.metaSum': 'Summe {sum} · Ø {avg} pro {per} · {count}×',
    'numberChart.per.day': 'Tag',
    'numberChart.per.week': 'Woche',
    'numberChart.per.month': 'Monat',
    'numberChart.per.year': 'Jahr',
    'numberChart.tooFewValues': 'Noch zu wenige Werte für einen Verlauf.',
    'numberChart.noValues': 'Noch keine Werte.',
    'numberChart.trend.up': 'steigend',
    'numberChart.trend.down': 'fallend',
    'numberChart.trend.flat': 'gleichbleibend',
    'numberChart.summary': '{name}: {count} Einträge, zuletzt {last}, Durchschnitt {avg}, Spanne {min} bis {max}, Trend {trend}.',
    'numberChart.summaryLast': '{name}: zuletzt {last}.',
    'numberChart.withNotes': 'Davon {count} mit Notiz.',
    'habitForm.goalLabel': 'Ziel für die Auswertung: ab wie viel Prozent voll erreicht?',
    'habitForm.goalYesNoLabel': 'Ziel für die Auswertung: an wie vielen von 7 Tagen „{label}“?',
    'habitForm.goalEveryDay': 'jeden Tag',
    'habitForm.goalDays': 'an {n} von 7 Tagen',
    'habitForm.goalYesNoLabel.week': 'Ziel für die Auswertung: in wie vielen von 4 Wochen „{label}“?',
    'habitForm.goalYesNoLabel.month': 'Ziel für die Auswertung: in wie vielen von 12 Monaten „{label}“?',
    'habitForm.goalYesNoLabel.year': 'Ziel für die Auswertung: in wie vielen von 5 Jahren „{label}“?',
    'habitForm.goalEveryDay.week': 'jede Woche',
    'habitForm.goalEveryDay.month': 'jeden Monat',
    'habitForm.goalEveryDay.year': 'jedes Jahr',
    'habitForm.goalDays.week': 'in {n} von 4 Wochen',
    'habitForm.goalDays.month': 'in {n} von 12 Monaten',
    'habitForm.goalDays.year': 'in {n} von 5 Jahren',
    'habitForm.goalValueLabel': 'Ziel für die Auswertung: ab wann voll erreicht?',
    'habitForm.goalFrom': 'ab Ø {value}',
    'habitForm.goalUpTo': 'bis Ø {value}',
    'habitForm.goalLabelAt': '„{label}“ ({value})',
    'habitForm.goalBetween': 'zwischen {a} und {b}',
    'habitForm.goalNote': 'Gilt für Woche, Monat, Jahr und Gesamt – „Heute“ bleibt unverändert.',
    'habitForm.goalExplain': 'Ab deinem Ziel ist das Feld in den Übersichten voll grün – bei Durchschnitten ab diesem Wert, bei Tagen ab dieser Anzahl. Gezählt werden die Tage, an denen du etwas eingetragen hast.',
    'habitForm.ownLabels': 'Eigene Bezeichnungen verwenden',
    'habitForm.labelForStep': 'Bezeichnung für Stufe {step}',
    'habitForm.preview': 'Vorschau',
    'habitForm.previewNote': 'Zum Ausprobieren – hier wird nichts gespeichert.',
    'habitForm.display': 'Darstellung',
    'habitForm.displayLockedExplain': 'Reine Anzeige-Einstellung, ändert nichts an bestehenden Werten – deshalb hier trotz gesperrtem Bereich änderbar.',
    'habitForm.buttons': 'Buttons',
    'habitForm.slider': 'Schieberegler',
    'habitForm.numberOfSteps': 'Anzahl Stufen',
    'habitForm.stepsExplain': 'In Fragebögen haben sich 5 bis 7 Stufen bewährt – mehr Abstufungen machen Antworten selten genauer. Deshalb gehen Buttons und eigene Bezeichnungen bis 7. Für ein feineres „ungefähr wie viel“ gibt es den Schieberegler ohne Bezeichnungen (bis 100).',
    'habitForm.sliderRangeExplain': 'Der Regler zeigt nie eine Min/Max-Beschriftung beim Eintragen (nur hier in der Verwaltung).',
    'habitForm.rangeLocked': '{steps} Stufen ({min} bis {max})',
    'habitForm.period': 'Wie oft trägst du das ein? Einmal pro …',
    'habitForm.period.day': 'Tag',
    'habitForm.period.week': 'Woche',
    'habitForm.period.month': 'Monat',
    'habitForm.period.year': 'Jahr',
    'habitForm.periodHint.week': 'Ein Wert pro Woche, an jedem Tag der Woche eintragbar – in „Heute“ unten unter „Diese Woche“.',
    'habitForm.periodHint.month': 'Ein Wert pro Monat, an jedem Tag des Monats eintragbar – in „Heute“ unten unter „Dieser Monat“.',
    'habitForm.periodHint.year': 'Ein Wert pro Jahr, an jedem Tag des Jahres eintragbar – in „Heute“ unten unter „Dieses Jahr“.',
    'habitForm.periodReminderDay': 'Erinnerung am',
    'habitForm.periodReminderNote': 'Zur Standardzeit oder zu deiner eigenen Erinnerungszeit – nur, wenn bis dahin noch nichts eingetragen ist.',
    'habitForm.numbers': 'Zahlen',
    'habitForm.numbersRange': '{min} bis {max}',
    'habitForm.numbersExplain': 'Manche Skalen beginnen üblicherweise bei 0, z. B. Schmerz oder Stress von 0 („gar nicht“) bis 10.',
    'habitForm.showValueWhileEntering': 'Aktuellen Wert beim Eintragen anzeigen',
    'habitForm.goalDirection': 'Bewertung',
    'habitForm.goalDirectionExplain': 'Legt fest, was als "gut" gilt und entsprechend grün eingefärbt wird. Meist "hohe Werte" (z. B. Sport, gesunde Ernährung). "Niedrige Werte" eignet sich für Dinge, von denen weniger besser ist (z. B. Konsum von etwas, das man reduzieren möchte). "Keine Wertung" trackt den Wert einfach nur, ohne Rot-Grün-Färbung – z. B. für Dinge, die du beobachten, aber nicht bewerten willst.',
    'habitForm.highIsGood': 'Hohe Werte erstrebenswert',
    'habitForm.lowIsGood': 'Niedrige Werte erstrebenswert',
    'habitForm.noValuation': 'Keine Wertung',
    'habitForm.unit': 'Einheit (optional)',
    'habitForm.unitPlaceholder': 'z. B. kg',
    'habitForm.members': 'Mitglieder (mind. 2 Felder)',
    'habitForm.noComputedCandidates': 'Noch keine Skala-Felder vorhanden, die sich zusammenfassen lassen.',
    'habitForm.ownReminderTime': 'Eigene Erinnerungszeit',
    'habitForm.defaultReminderNote': 'Ohne eigene Zeit gilt die Standard-Erinnerungszeit (aktuell {time}, änderbar in den Einstellungen).',
    'habitForm.reminderAdd': '+ Weitere Zeit',
    'habitForm.reminderRemove': 'Entfernen',
    'habitForm.reminderTimesNote': 'Zu jeder Zeit wird nur erinnert, solange das Feld an dem Tag noch leer ist.',
    'habitForm.reminderBelow': 'falls weniger als',
    'habitForm.counterReminderNote': 'Mit einer Zahl erinnert Logbuch nur, wenn der Zähler zu der Zeit darunter liegt, z. B. um 9 Uhr falls weniger als 1, um 21 Uhr falls weniger als 2. Ohne Zahl erinnert es zu jeder Zeit.',
    'habitForm.error.reminderBelowNumber': 'Bitte gib bei „falls weniger als“ eine Zahl größer als 0 ein.',
    'habitForm.error.reminderBelowAll': 'Bitte gib bei „falls weniger als“ für jede Erinnerungszeit eine Zahl ein – oder lass alle leer.',
    'habitForm.error.reminderBelowOrder': 'Bei „falls weniger als“ darf die Zahl zu einer späteren Zeit nicht kleiner sein als zu einer früheren.',
    'habitForm.sectionReminderNote': 'Ohne eigene Zeit über die Gruppe „{name}“ geregelt: gemeinsame Erinnerung um {time}.',
    'habitForm.title.editGroup': 'Gruppe bearbeiten',
    'habitForm.title.newGroup': 'Neue Gruppe',
    'habitForm.title.editField': 'Feld bearbeiten',
    'habitForm.title.newField': 'Neues Feld',
    'habitForm.convertCounter': 'In Zähler umwandeln …',
    'habitForm.convertCounterDo': 'Umwandeln',
    'habitForm.convertHint.number': 'Lieber mit „+“ hochzählen statt die Zahl einzutippen? Als Zähler bleiben alle bisherigen Werte erhalten.',
    'habitForm.convertHint.scale': 'Diese Skala beginnt bei 0 – zählt sie eigentlich etwas? Als Zähler bleiben die Werte als Zahlen erhalten, und du zählst mit „+“ hoch.',
    'habitForm.convertConfirm.number': 'Wirklich umwandeln? Die bisherigen Werte bleiben. Neu ist: Ab heute zählt ein Tag ohne Antippen als 0, frühere leere Tage bleiben leer. Zurückwandeln geht nicht.',
    'habitForm.convertConfirm.scale': 'Wirklich umwandeln? Die bisherigen Werte bleiben als Zahlen, die Bezeichnungen der Stufen und die Bewertung entfallen. Ab heute zählt ein Tag ohne Antippen als 0, frühere leere Tage bleiben leer. Zurückwandeln geht nicht.',
    'habitForm.convertDone': '„{name}“ ist jetzt ein Zähler.',
    'habitForm.labelsLockedWarn': 'Neue Bezeichnungen gelten auch für alle bisherigen Einträge. Sollen alte Einträge auf eine andere Stufe wandern, nimm oben „Stufen ändern“.',
    'habitForm.goodChangedWarn': 'Das gilt auch rückwirkend: Alle bisherigen Einträge werden danach anders gefärbt.',
    'stepEdit.title': 'Stufen ändern',
    'stepEdit.hint': 'Weil es schon Einträge gibt, änderst du die Anzahl hier – und entscheidest dabei selbst, was aus den bisherigen Werten wird.',
    'stepEdit.open': 'Stufen ändern …',
    'stepEdit.intro': 'Du entscheidest selbst, was aus den bisherigen Einträgen wird. Überleg dabei, was ein alter Wert damals bedeutet hat: Eine 3 auf einer Skala bis 3 ist nicht dasselbe wie eine 3 auf einer Skala bis 5.',
    'stepEdit.newSteps': 'Neue Anzahl Stufen',
    'stepEdit.newLabels': 'Bezeichnungen der neuen Stufen',
    'stepEdit.mapTitle': 'Was wird aus den bisherigen Einträgen?',
    'stepEdit.presetExplain': '„Gleichmäßig verteilen“: Die niedrigste Stufe bleibt die niedrigste, die höchste die höchste, alles dazwischen rückt anteilig mit. „Zahlen beibehalten“: Jeder Eintrag behält seine Zahl; was über der neuen höchsten Stufe liegt, landet auf der höchsten. Darunter kannst du jede Stufe einzeln zuordnen oder ihre Einträge entfernen.',
    'stepEdit.preset.spread': 'Gleichmäßig verteilen',
    'stepEdit.preset.same': 'Zahlen beibehalten',
    'stepEdit.valueLabel': '„{label}“ ({value})',
    'stepEdit.count': '{count}×',
    'stepEdit.mapAria': 'Bisher {value} ({count}×) wird zu',
    'stepEdit.remove': 'Entfernen',
    'stepEdit.summary.changedOne': '1 Eintrag bekommt einen anderen Wert.',
    'stepEdit.summary.changedMany': '{count} Einträge bekommen einen anderen Wert.',
    'stepEdit.summary.removedOne': '1 Eintrag wird entfernt.',
    'stepEdit.summary.removedMany': '{count} Einträge werden entfernt.',
    'stepEdit.summary.merged': 'Mehrere alte Stufen landen auf derselben neuen und lassen sich danach nicht mehr unterscheiden.',
    'stepEdit.summary.none': 'Alle bisherigen Einträge behalten ihre Zahl.',
    'stepEdit.safety': 'Die alten Werte bleiben als Sicherung gespeichert. Rückgängig machen kannst du das hier, bis du etwas Neues in dieses Feld einträgst.',
    'stepEdit.apply': 'Umstellen …',
    'stepEdit.fieldNow': '„{name}“ hat bisher {steps} Stufen.',
    'stepEdit.confirmTitle': 'Wirklich umstellen?',
    'stepEdit.confirm': '„{name}“ bekommt {to} statt {from} Stufen, und alle bisherigen Einträge werden so umgerechnet, wie du sie zugeordnet hast.',
    'stepEdit.confirmDo': 'Jetzt umstellen',
    'stepEdit.progress': 'Wird umgestellt … {done} von {total} Tagen. Lass Logbuch so lange offen.',
    'stepEdit.done': '„{name}“ hat jetzt {steps} Stufen.',
    'stepEdit.failed': 'Die Umstellung ist noch nicht fertig, vermutlich fehlte kurz die Verbindung. Sie läuft beim nächsten Öffnen von Logbuch weiter – oder tippe im Feld auf „Weiter umstellen“.',
    'stepEdit.pending': 'Die Umstellung dieses Felds ist noch nicht fertig.',
    'stepEdit.resume': 'Weiter umstellen',
    'stepEdit.resumed': 'Die Umstellung von „{name}“ ist fertig.',
    'stepEdit.last': 'Am {date} von {from} auf {to} Stufen umgestellt.',
    'stepEdit.undo': 'Rückgängig machen …',
    'stepEdit.undoTitle': 'Umstellung rückgängig machen?',
    'stepEdit.undoConfirm': '„{name}“ bekommt wieder {from} Stufen, und alle Einträge bekommen ihren Wert von vor der Umstellung zurück.',
    'stepEdit.undoDo': 'Zurückholen',
    'stepEdit.undoDone': '„{name}“ hat wieder {steps} Stufen.',
    'stepEdit.error.nothing': 'Das ist dieselbe Skala wie bisher – es gibt nichts umzustellen.',
    'typeEdit.title': 'Typ ändern',
    'typeEdit.hint': 'Du kannst den Typ trotz Einträgen ändern – und entscheidest dabei selbst, was aus den bisherigen Werten wird.',
    'typeEdit.open': 'Typ ändern …',
    'typeEdit.blocked': 'Den Typ kannst du gerade nicht ändern: Das Feld wird in „{computed}“ mitberechnet. Nimm es dort zuerst heraus.',
    'typeEdit.fieldNow': '„{name}“ ist bisher vom Typ {kind}.',
    'typeEdit.intro': 'Du entscheidest selbst, was aus den bisherigen Einträgen wird. Die Vorschläge kannst du für jeden Wert ändern.',
    'typeEdit.newKind': 'Neuer Typ',
    'typeEdit.steps': 'Anzahl Stufen',
    'typeEdit.preset.round': 'Runden',
    'typeEdit.preset.spread': 'Gleichmäßig verteilen',
    'typeEdit.presetExplain': '„Runden“: Jeder Wert wird zur nächsten ganzen Zahl; was außerhalb der Skala liegt, landet auf der niedrigsten bzw. höchsten Stufe. „Gleichmäßig verteilen“: Der kleinste eingetragene Wert wird die niedrigste Stufe, der größte die höchste, alles dazwischen rückt anteilig mit.',
    'typeEdit.emptyRemoves': 'Leer lassen = diese Einträge entfernen.',
    'typeEdit.manyValues': 'Es gibt {count} verschiedene Werte (von {lo} bis {hi}) – zu viele, um jeden einzeln zuzuordnen. Sie werden alle nach der gewählten Regel umgewandelt.',
    'typeEdit.manyValuesText': 'Es gibt {count} verschiedene Werte – sie werden alle so zu Text, wie sie bisher angezeigt werden, z. B. „{example}“.',
    'typeEdit.summary.merged': 'Mehrere bisherige Werte landen auf derselben Stufe und lassen sich danach nicht mehr unterscheiden.',
    'typeEdit.loss.text': 'Als Text fließen die Einträge nicht mehr in Tagesfarbe, Durchschnitte und Ziele ein.',
    'typeEdit.loss.scaleToNumber': 'Die Bezeichnungen der Stufen und die Bewertung entfallen; ein Ziel kannst du danach im Feld einstellen.',
    'typeEdit.loss.numberToScale': 'Einheit und Ziel entfallen; ob hohe Werte gut oder schlecht sind, prüfst du danach im Feld.',
    'typeEdit.loss.counter': 'Tage ohne Eintrag zählen dann nicht mehr als 0, und „falls weniger als“ bei den Erinnerungen entfällt.',
    'typeEdit.loss.notes': 'Notizen zu einzelnen Tagen bleiben gespeichert, ein Text-Feld zeigt sie aber nicht an.',
    'typeEdit.apply': 'Umwandeln …',
    'typeEdit.confirm': '„{name}“ wird von {from} zu {to}, und alle bisherigen Einträge werden so umgewandelt, wie du es eingestellt hast.',
    'typeEdit.confirmTitle': 'Wirklich umwandeln?',
    'typeEdit.confirmDo': 'Jetzt umwandeln',
    'typeEdit.done': '„{name}“ ist jetzt vom Typ {kind}.',
    'typeEdit.last': 'Am {date} von {from} zu {to} umgewandelt.',
    'typeEdit.undoTitle': 'Umwandlung rückgängig machen?',
    'typeEdit.undoConfirm': '„{name}“ wird wieder vom Typ {from}, und alle Einträge bekommen ihren Wert von vor der Umwandlung zurück.',
    'typeEdit.undoDone': '„{name}“ ist wieder vom Typ {kind}.',
    'typeEdit.error.number': 'Bitte überall eine Zahl eintragen – oder leer lassen, um die Einträge zu entfernen.',
    'typeEdit.error.dirty': 'Speichere zuerst deine anderen Änderungen an diesem Feld (oder verwirf sie) – danach kannst du den Typ ändern.',
    'habitForm.lockedNote': 'Für dieses Feld gibt es bereits Einträge – wie oft du einträgst, ist deshalb fest. Typ und Stufen änderst du über die eigenen Knöpfe dafür, weil dabei auch die bisherigen Einträge umgewandelt werden.',
    'habitForm.lockedNoteText': 'Für dieses Feld gibt es bereits Einträge – Feld-Typ und wie oft du einträgst sind deshalb fest. Für einen anderen Typ: archivieren und neu anlegen.',
    'habitForm.name': 'Feldname',
    'habitForm.fieldType': 'Feld-Typ',
    'habitForm.kindScale': 'Skala',
    'habitForm.kindNumber': 'Zahl',
    'habitForm.kindText': 'Text',
    'habitForm.kindCounter': 'Zähler',
    'habitForm.kindTime': 'Uhrzeit',
    'habitForm.entryMode': 'Wie trägst du ein?',
    'habitForm.entryMode.type': 'Eintippen',
    'habitForm.entryMode.count': 'Hochzählen (+)',
    'habitForm.numberGoal': 'Ziel für die Auswertung',
    'habitForm.numberGoal.none': 'Keins',
    'habitForm.numberGoal.min': 'Mindestens',
    'habitForm.numberGoal.max': 'Höchstens',
    'habitForm.numberGoalNote': 'Ab dem Ziel ist der Tag in Woche, Monat, Jahr und Gesamt grün, je weiter davon entfernt, desto röter. „Heute“ bleibt unverändert.',
    'habitForm.error.numberGoal': 'Bitte gib als Ziel eine Zahl ein (bei „Mindestens“ größer als 0).',
    'numberGoal.min': 'Ziel: mindestens {value}',
    'numberGoal.max': 'Ziel: höchstens {value}',
    'stats.goalHits': 'Ziel an {n} von {total} Tagen erreicht',
    'stats.goalHits.week': 'Ziel in {n} von {total} Wochen erreicht',
    'stats.goalHits.month': 'Ziel in {n} von {total} Monaten erreicht',
    'stats.goalHits.year': 'Ziel in {n} von {total} Jahren erreicht',
    'habitForm.counterNote': 'Zählt mit „+“ hoch, zum Beispiel Zigaretten oder Gläser Wasser – jeder neue Tag (bzw. Zeitraum) beginnt bei 0. Ohne Antippen zählt 0, deshalb gibt es dafür keine Erinnerung.',
    'habitForm.counterStep': 'Schritt pro Tippen',
    'habitForm.counterStepNote': 'Um so viel ändern „+“ und „−“ den Wert, z. B. 1 oder 0,5.',
    'habitForm.error.counterStep': 'Der Schritt muss eine Zahl größer als 0 sein.',
    'counter.less': 'Um {step} verringern',
    'counter.more': 'Um {step} erhöhen',
    'today.goalOf': 'von {target}',
    'charCount.sr': '{n} von {max} Zeichen',
    'habitForm.kindComputed': 'Berechnet',
    'habitForm.days': 'An welchen Tagen?',
    'habitForm.days.hint': 'Nur für feste Tage, etwa montags wiegen. Was du mal machst und mal nicht (z. B. Sport), lass an allen Tagen – „Nein“ ist auch ein Eintrag.',
    'habitForm.days.explain': 'An den übrigen Tagen erinnert Logbuch nicht an das Feld, und es steht in „Heute“ unten unter „Heute nicht geplant“. Eintragen kannst du dort trotzdem.',
    'schedule.summary.everyDays': 'alle {n} Tage',
    'habitForm.days.modeWeekdays': 'Wochentage',
    'habitForm.days.modeInterval': 'Alle paar Tage',
    'habitForm.days.every': 'Alle',
    'habitForm.days.everyUnit': 'Tage',
    'habitForm.days.everyStart': 'Zum ersten Mal am',
    'habitForm.days.intervalHint': 'Für Dinge mit festem Abstand, z. B. alle 3 Tage die Pflanzen gießen. An den Tagen dazwischen erinnert Logbuch nicht, und das Feld steht in „Heute“ unter „Heute nicht geplant“.',
    'habitForm.error.scheduleEvery': 'Bitte gib bei „Alle … Tage“ eine ganze Zahl von 2 bis 365 ein.',
    'habitForm.error.scheduleStart': 'Bitte wähle, wann es zum ersten Mal dran ist.',
    'habitForm.schedule.lastDay': 'Letzter Tag',
    'habitForm.schedule.dayAria': 'Tag',
    'habitForm.schedule.monthAria': 'Monat',
    'habitForm.error.scheduleNoDays': 'Bitte mindestens einen Wochentag auswählen.',
    'habitForm.part.what': 'Was?',
    'habitForm.part.entry': 'Wie trägst du ein?',
    'habitForm.part.when': 'Wann?',
    'habitForm.part.stats': 'Auswertung',
    'habitForm.part.group': 'Gruppe',
    'habitForm.kindScaleNote': 'Wie sehr – z. B. Stimmung 1–5',
    'habitForm.kindNumberNote': 'Messwert oder Anzahl – z. B. Gewicht, Gläser',
    'habitForm.kindTextNote': 'Ein paar Worte – z. B. Wofür bin ich heute dankbar?',
    'habitForm.kindTimeNote': 'Ein Zeitpunkt – z. B. ins Bett, aufgestanden',
    'habitForm.kindComputedNote': 'Rechnet aus anderen Feldern – z. B. Wohlbefinden aus Stimmung und Energie oder Tage seit dem letzten Sport',
    'habitForm.summary': 'Für Woche, Monat und Jahr zusammenrechnen als',
    'habitForm.summary.avg': 'Durchschnitt',
    'habitForm.summary.sum': 'Summe',
    'habitForm.summary.noteAvg': 'Passt zu Messwerten wie dem Gewicht: „Ø 68,2 kg“.',
    'habitForm.summary.noteSum': 'Passt zu Mengen wie der Arbeitszeit: „Summe 38 h“, dazu der Schnitt pro Tag.',
    'habitForm.entryPreviewNote': 'So sieht es in „Heute“ aus.',
    'habitForm.entryPreviewAria.number': 'Vorschau: ein Eingabefeld, in das du die Zahl tippst',
    'habitForm.entryPreviewAria.counter': 'Vorschau: die Zahl mit den Knöpfen „−“ und „+“',
    'habitForm.entryPreviewAria.time': 'Vorschau: Uhrzeit-Feld, noch leer',
    'today.unplanned': 'Heute nicht geplant ({count})',
    'today.nothingPlanned': 'Für heute ist kein Feld geplant.',
    'day.today': 'Heute',
    'day.yesterday': 'Gestern',
    'today.openField': '(noch offen)',
    'today.sectionHasOpen': '(enthält noch offene Felder)',
    'today.sectionDone': '✓ erledigt',
    'period.week.current': 'Diese Woche',
    'period.week.other': 'Woche',
    'period.month.current': 'Dieser Monat',
    'period.month.other': 'Monat',
    'period.year.current': 'Dieses Jahr',
    'period.year.other': 'Jahr',
    'today.statusDone': 'Alles eingetragen',
    'today.statusProgress': '{done} von {total} eingetragen',
    'todayIntro.label': 'Kurz erklärt',
    'todayIntro.enter': '<strong>So trägst du ein:</strong> Tipp auf einen Wert – nochmal tippen nimmt ihn wieder weg. Der grüne Punkt hinter einem Namen zeigt, was heute noch offen ist.',
    'todayIntro.days': '<strong>Andere Tage:</strong> Wisch nach links oder rechts – oder tipp auf die Pfeile oben –, um einen anderen Tag einzutragen oder nachzutragen.',
    'todayIntro.menu': '⋮ <strong>Mehr:</strong> Über die drei Punkte vor einem Feld schreibst du eine Notiz dazu oder bearbeitest es. Unter <strong>☰ Menü</strong> oben rechts findest du deine Felder, die Einstellungen und Erklärungen zu allem.',
    'todayIntro.done': 'Verstanden',
    'habitForm.textNote': 'Für Fragen wie „Wofür bin ich heute dankbar?“: in „Heute“ steht dafür ein Textfeld, das automatisch speichert. Fließt nicht in die Auswertung ein, erscheint dort aber als Liste zum Nachlesen.',
    'habitForm.timeNote': 'In „Heute“ tippst du auf das Feld und wählst die Uhrzeit. Ist es noch leer, steht dort schon die aktuelle; mit „+5 min“ usw. kommst du etwas später an, z. B. wenn du das Handy schon weglegst. Liegt die Uhrzeit nach Mitternacht, steht der Wochentag dahinter. Zwei Uhrzeiten ergeben mit einem berechneten Feld „Dauer“ z. B. deine Schlafdauer.',
    'habitForm.kindMulti': 'Mehrfachauswahl',
    'habitForm.kindMultiNote': 'Mehrere ankreuzen – z. B. was heute war: Sport, Streit, Kaffee',
    'habitForm.multiNote': 'In „Heute“ tippst du alle Optionen an, die zutreffen – oder „nichts davon“. In der Auswertung bekommt jede Option eine eigene Zeile.',
    'habitForm.multiOptions': 'Optionen',
    'habitForm.multiOptionAria': 'Option {n}',
    'habitForm.multiAdd': '+ Option',
    'habitForm.multiRemove': 'Option {n} entfernen',
    'habitForm.multiHide': 'Ausblenden',
    'habitForm.multiShow': 'Einblenden',
    'habitForm.multiUsedNote': 'Optionen, die du schon gewählt hast, kannst du umbenennen oder ausblenden, aber nicht entfernen – sonst fehlten sie in deinen bisherigen Einträgen. Ausgeblendete stehen nicht mehr in „Heute“, in der Auswertung aber weiter.',
    'habitForm.lockedNoteMulti': 'Für dieses Feld gibt es bereits Einträge – der Typ ist deshalb fest.',
    'habitForm.error.multiEmpty': 'Bitte jede Option ausfüllen oder entfernen.',
    'habitForm.error.multiDuplicate': 'Zwei Optionen heißen gleich.',
    'habitForm.error.multiMin': 'Es braucht mindestens zwei Optionen, die nicht ausgeblendet sind.',
    'today.multiNone': 'nichts davon',
    'textReview.countOne': '1 Eintrag',
    'textReview.countMany': '{count} Einträge',
    'common.saving': 'Wird gespeichert …',
    'common.save': 'Speichern',
    'common.cancel': 'Abbrechen',
    'common.delete': 'Löschen',
    'common.edit': 'Bearbeiten',
    'manage.deleteConfirmFinal': 'Ja, endgültig löschen',
    'manage.deleteWarning': 'Es gibt historische Einträge – nach dem Löschen in der App nicht mehr nutzbar.',
    'manage.reminderAt': 'Erinnerung {time}',
    'manage.computedMembers': 'Ø aus: {names}',
    'manage.archive': 'Archivieren',
    'manage.reactivate': 'Reaktivieren',
    'manage.archivedSectionLabel': 'Archiviert',
    'manage.archiveNote': 'Archivieren blendet ein Feld aus: Seine Werte bleiben erhalten, und du kannst es jederzeit reaktivieren. Endgültig löschen kannst du es danach unten unter „Archiviert“.',
    'manage.computedTag': 'Berechnet',
    'manage.sectionTag': 'Gruppe',
    'sectionForm.explain': 'Eine Gruppe ordnet Felder unter einer Überschrift – in „Heute“ und in der Auswertung. Jedes Feld kann in höchstens einer Gruppe sein.',
    'sectionForm.members': 'Felder in dieser Gruppe',
    'sectionForm.inOtherGroup': '(in „{name}“)',
    'sectionForm.noFields': 'Noch keine Felder vorhanden.',
    'manage.sectionName': 'Name der Gruppe',
    'manage.sectionNamePlaceholder': 'z. B. Gesundheit',
    'manage.sectionEmpty': 'Noch leer – über „Bearbeiten“ Felder hinzufügen.',
    'manage.period.week': 'wöchentlich',
    'manage.period.month': 'monatlich',
    'manage.period.year': 'jährlich',
    'manage.groupTip': 'Viele Felder? Ordne sie in Gruppen nach Tageszeit, z. B. „Morgens“ und „Abends“. Dann trägst du jeden Block in einem Rutsch ein, und jede Gruppe kann zu ihrer eigenen Zeit erinnern.',
    'manage.groupTipHide': 'Ausblenden',
    'sectionForm.collapse': 'In „Heute“',
    'sectionForm.collapse.done': 'Zuklappen, wenn erledigt',
    'sectionForm.collapse.manual': 'Nur von Hand zuklappen',
    'sectionForm.collapse.start': 'Immer eingeklappt starten',
    'sectionForm.collapse.never': 'Nicht einklappbar (nur Überschrift)',
    'sectionForm.collapseNote': 'Erledigt heißt: alles eingetragen. Zu klappt die Gruppe erst beim nächsten Öffnen, nie während du gerade einträgst.',
    'sectionForm.ownReminderTime': 'Eigene Erinnerungszeit für diese Gruppe',
    'sectionForm.reminderExplain': 'Die Felder dieser Gruppe werden dann nicht mehr zur Standardzeit erinnert, sondern gemeinsam zu dieser Zeit – eine Nachricht für die ganze Gruppe, sobald darin noch etwas fehlt. Felder mit eigener Erinnerungszeit behalten ihre.',
    'sectionForm.defaultReminderNote': 'Ohne eigene Zeit werden die Felder zur Standard-Erinnerungszeit erinnert (aktuell {time}).',
    'manage.sectionDeleteWarning': 'Gruppe löschen? Die Felder darin bleiben erhalten.',
    'manage.sectionDeleteNotesWarning': 'Deine Notizen zu dieser Gruppe werden mitgelöscht.',
    'manage.error.sectionNameRequired': 'Bitte einen Namen für die Gruppe eingeben.',
    'habitForm.section': 'Gruppe',
    'habitForm.sectionNone': 'Keine Gruppe',
    'manage.hiddenInStats': 'in der Auswertung ausgeblendet',
    'habitForm.showInStats': 'In der Auswertung anzeigen',
    'habitForm.showInStatsNote': 'Aus: erscheint nur in „Heute“, nicht in Woche, Monat, Jahr und Gesamt – z. B. wenn dir ein berechnetes Feld daraus reicht. Die Tagesfarbe rechnet es trotzdem mit ein.',
    'habitForm.more': 'Mehr Einstellungen',
    'habitForm.moreSub': 'Tage, Erinnerungszeit, Auswertung – kannst du auch später ändern',
    'habitForm.moreSubPeriod': 'Ziel, Erinnerung und mehr – kannst du auch später ändern',
    'habitForm.computedExplain': 'Ein berechnetes Feld fasst mehrere Felder zu einem live berechneten Wert zusammen – Skalen als Durchschnitt, Zahlenwerte z. B. als Summe, zwei Uhrzeiten als Dauer dazwischen – oder es zählt die Tage seit einem Eintrag. Selbst ausfüllen kann man es nicht.',
    'common.finish': 'Fertig',
    'common.close': 'Schließen',
    'menu.defaultReminderTime': 'Standard-Erinnerungszeit',
    'menu.timezoneNote': 'Zeitzone: {tz} (folgt deinem Gerät)',
    'time.label': 'Uhrzeit',
    'time.hour': 'Stunde',
    'time.minute': 'Minute',
    'menu.summaryNotifications': 'Wochen- und Monatsübersicht ankündigen',
    'menu.summaryNotificationsExplain': 'Sonntags bzw. am letzten Tag des Monats kommt zur Standard-Erinnerungszeit eine Benachrichtigung, dass deine Wochen- bzw. Monatsübersicht bereit ist – aber nur, wenn du im jeweiligen Zeitraum mindestens einen Tag eingetragen hast. Ein Tipp darauf öffnet direkt die passende Übersicht.',
    'tutorial.skip': 'Tutorial überspringen',
    'tutorial.navLabel': 'Tutorial-Navigation',
    'tutorial.skipConfirm.title': 'Tutorial überspringen?',
    'tutorial.skipConfirm.body': 'Klar – Felder kannst du jederzeit über Menü → „Felder verwalten“ anlegen.',
    'tutorial.skipConfirm.confirmButton': 'Ja, überspringen',
    'tutorial.hello.title': 'Willkommen bei Logbuch.',
    'tutorial.hello.body': 'Logbuch hilft dir, jeden Tag kurz festzuhalten, wie es dir geht und was du tust – und mit der Zeit zu sehen, was dir guttut.',
    'tutorial.hello.privateTitle': 'Privat.',
    'tutorial.hello.privateBody': 'Deine Einträge werden auf deinem Gerät verschlüsselt. Nicht mal ich kann sie lesen.',
    'tutorial.hello.noPressureTitle': 'Ohne Druck.',
    'tutorial.hello.noPressureBody': 'Keine Punkte, keine Serien, kein schlechtes Gewissen – ein Tag ohne Eintrag ist einfach ein Tag ohne Eintrag.',
    'tutorial.hello.yoursTitle': 'Deins.',
    'tutorial.hello.yoursBody': 'Du entscheidest, was du festhältst – es gibt keine vorgegebenen Felder.',
    'tutorial.hello.start': 'Los geht’s',
    'tutorial.reminders.title': 'Soll ich dich erinnern?',
    'tutorial.reminders.body': '<strong>Ich melde mich nur, wenn an einem Tag noch etwas fehlt</strong> – und, falls du magst, einmal pro Woche und Monat mit deiner Übersicht. Nie Werbung, und die Uhrzeit bestimmst du.',
    'tutorial.reminders.bodyField': '<strong>Ich melde mich nur, wenn an einem Tag noch etwas fehlt</strong>, zum Beispiel „{name}“ – und, falls du magst, einmal pro Woche und Monat mit deiner Übersicht. Nie Werbung, und die Uhrzeit bestimmst du.',
    'tutorial.reminders.whyTitle': 'Warum überhaupt?',
    'tutorial.reminders.whyBody': 'Logbuch wird aussagekräftiger, je regelmäßiger du einträgst. Und wer abends müde ist, vergisst es schnell.',
    'tutorial.reminders.permissionNote': 'Gleich fragt dein Gerät um Erlaubnis – tipp dort auf „Erlauben“ bzw. „Zulassen“.',
    'tutorial.reminders.yes': 'Ja, erinnere mich',
    'tutorial.reminders.no': 'Lieber nicht',
    'tutorial.reminders.laterNote': 'Kein Problem – du kannst Erinnerungen jederzeit in den Einstellungen einschalten.',
    'tutorial.reminders.activeTitle': '✓ Erinnerungen sind an.',
    'tutorial.reminders.timeLabel': 'Um wie viel Uhr?',
    'tutorial.reminders.timeNote': 'Abends passt oft gut – dann ist der Tag rum. Ändern kannst du das jederzeit in den Einstellungen.',
    'tutorial.reminders.iosNeedsInstall': 'Auf dem iPhone kommen Erinnerungen nur an, wenn Logbuch auf dem Home-Bildschirm liegt. Das kannst du jederzeit nachholen – auch gleich jetzt.',
    'tutorial.reminders.howInstall': 'So holst du Logbuch auf den Home-Bildschirm',
    'tutorial.field.title': 'Was möchtest du festhalten?',
    'tutorial.field.intro': 'Ein <strong>Feld</strong> ist eine Sache, die du jeden Tag einträgst – zum Beispiel deine Stimmung oder ob du Sport gemacht hast. Leg jetzt dein erstes an; das Formular hier ist dasselbe, mit dem du später weitere Felder anlegst.',
    'tutorial.examples.title': 'Beispiele ansehen',
    'tutorial.examples.intro': 'So sehen Felder später in „Heute“ aus – nur zum Anschauen:',
    'tutorial.examples.mood': 'Stimmung',
    'tutorial.examples.moodNote': 'Stimmung: Skala von 1 bis 5, hohe Werte sind gut – je besser, desto grüner.',
    'tutorial.examples.sport': 'Sport',
    'tutorial.examples.sportNote': 'Sport: Ja oder Nein – eine Skala mit zwei Stufen.',
    'tutorial.examples.water': 'Wasser',
    'tutorial.examples.waterNote': 'Wasser: eine Zahl, die du hochzählst – bei jedem Glas einmal „+“.',
    'tutorial.examples.grateful': 'Dankbar für',
    'tutorial.examples.gratefulNote': 'Dankbar für: Text, eine freie Antwort in eigenen Worten.',
    'tutorial.examples.gratefulValue': 'Kaffee in der Sonne',
    'tutorial.examples.no': 'Nein',
    'tutorial.examples.yes': 'Ja',
    'tutorial.form.nameIdeas': 'Kurze Namen passen am besten in die Übersicht. Zum Beispiel: <strong>Schlaf</strong> – wie gut habe ich geschlafen? · <strong>Stimmung</strong> – wie geht’s mir heute? · <strong>Sport</strong> – ja oder nein? · <strong>Gewicht</strong> – in kg',
    'tutorial.form.tipKindTitle': 'Tipp zum Feld-Typ',
    'tutorial.form.tipKind': 'Der Feld-Typ bestimmt, wie du einträgst: <strong>Skala</strong> für „wie sehr“ (z. B. Stimmung 1–5), <strong>Zahl</strong> für Messwerte (z. B. Schlafstunden oder Wassergläser), <strong>Text</strong> für ein paar Worte.',
    'tutorial.form.tipKindMoreTitle': 'Und für Ja/Nein-Fragen?',
    'tutorial.form.tipKindMore': 'Nimm eine Skala mit 2 Stufen und schalte „Eigene Bezeichnungen“ ein – dann schreibst du „Nein“ und „Ja“ hinein.',
    'tutorial.form.tip.scale': 'Stell ein, wie viele Stufen es gibt und ob die Werte als Knöpfe oder Schieberegler erscheinen. Mit <strong>„Eigene Bezeichnungen“</strong> gibst du den Stufen Namen statt Zahlen (z. B. schlecht – okay – gut). In der <strong>Vorschau</strong> kannst du gleich ausprobieren, wie das in „Heute“ aussieht.',
    'tutorial.form.tipScaleMoreTitle': 'Was bedeutet „Bewertung“?',
    'tutorial.form.tipScaleMore': '„Bewertung“ legt fest, was gut ist – danach richten sich die Farben in der Auswertung (grün = gut). Bei „Keine Wertung“ wird nur festgehalten, ohne gut oder schlecht.',
    'tutorial.form.tip.number': 'Gib eine Einheit an, wenn du magst (z. B. kg). Eingetragen wird dann einfach eine Zahl.',
    'tutorial.form.tip.text': 'In „Heute“ steht für dieses Feld ein Textfeld, das von selbst speichert.',
    'tutorial.form.tip.computed': '',
    'tutorial.form.create': 'Feld anlegen',
    'tutorial.field.whyTitle': 'Warum erst mal nur eins?',
    'tutorial.field.whyBody': 'Wenige Felder heißt: schnell eingetragen. Das hält länger durch als ein langer Fragebogen – ergänzen kannst du jederzeit.',
    'tutorial.done.title': 'Dein erstes Feld steht.',
    'tutorial.done.titleMore': 'Deine {count} Felder stehen.',
    'tutorial.done.body': 'Du kannst noch ein, zwei weitere anlegen oder es erst mal dabei lassen. <strong>Tipp: lieber klein anfangen und später erweitern.</strong>',
    'tutorial.done.start': 'Weiter',
    'tutorial.done.addMore': 'Noch ein Feld anlegen',
    'installGate.title': 'Erst mal ein Zuhause für Logbuch',
    'installGate.body': 'Logbuch kommt nicht aus dem App-Store, sondern ist eine Webseite, die du <strong>wie eine App auf deinen Startbildschirm legst</strong>. Dann öffnest du es mit einem Tipp – ohne Browser drumherum.',
    'installGate.whyTitle': 'Warum?',
    'installGate.whyIos': 'Auf dem iPhone kommen Erinnerungen nur an, wenn Logbuch auf dem Home-Bildschirm liegt – so hat Apple das geregelt.',
    'installGate.whyAndroid': 'Dann öffnet sich Logbuch wie eine App – ohne Browser-Leisten, mit einem Tipp auf dem Startbildschirm, statt es jedes Mal im Browser suchen zu müssen.',
    'installGate.installButton': 'Logbuch installieren',
    'installGate.manualFallback': 'Klappt das nicht? So geht’s von Hand',
    'installGate.otherBrowser': 'Mit diesem Browser wird Logbuch meist nur eine Verknüpfung statt einer eigenen App. Das funktioniert auch – Erinnerungen laufen dann aber über die Mitteilungs-Einstellungen {browser}. Lieber eine eigene App? Dann installiere Logbuch über Chrome.',
    'installGate.browserOpera': 'von Opera',
    'installGate.browserFirefox': 'von Firefox',
    'installGate.browserOther': 'deines Browsers',
    'installGate.openInChrome': 'In Chrome öffnen',
    'installGate.openInChromeNote': 'Klappt das nicht, öffne Chrome selbst und gib diese Adresse ein: <strong>{address}</strong>',
    'installGate.vary': 'Je nach Handy und Browser sieht das etwas anders aus und die Einträge heißen leicht anders – halte nach etwas Ähnlichem Ausschau.',
    'installGate.installButtonNote': 'Danach fragt dein Handy noch einmal – tipp dort auf „Installieren“.',
    'installGate.showPictures': 'Mit Bildern zeigen',
    'installGate.afterwards': 'Danach schließt sich der Browser oft von selbst, und du siehst das neue Logbuch-Symbol auf deinem Startbildschirm. Tipp darauf – dort geht’s weiter.',
    'installGate.step.iosSafari1': 'Tippe auf das Teilen-Symbol [share]. Meist ist es unten in der Leiste; manchmal steckt es hinter ••• .',
    'installGate.step.iosOther1': 'Tippe auf das Teilen-Symbol [share] – meist oben in der Adressleiste.',
    'installGate.step.ios2': 'Such in der Liste nach „Zum Home-Bildschirm“ – eventuell musst du dafür etwas nach unten scrollen.',
    'installGate.step.ios3': 'Bestätige mit „Hinzufügen“.',
    'installGate.step.chrome1': 'Öffne das Menü des Browsers – meist drei Punkte ⋮ oben rechts.',
    'installGate.step.chrome2': 'Such nach einem Eintrag wie „Zum Startbildschirm hinzufügen“ oder „App installieren“.',
    'installGate.step.samsung1': 'Öffne das Menü – meist ≡ unten rechts.',
    'installGate.step.samsung2': 'Such nach „Seite hinzufügen zu“ und wähle dann „Startbildschirm“ (oder etwas Ähnliches).',
    'installGate.step.firefox1': 'Öffne das Menü – meist drei Punkte ⋮, oben oder unten rechts.',
    'installGate.step.firefox2': 'Such nach einem Eintrag wie „Installieren“ oder „Zum Startbildschirm hinzufügen“.',
    'installGate.step.other1': 'Öffne das Menü deines Browsers – oft drei Punkte ⋮ oben rechts oder ≡ unten rechts.',
    'installGate.step.other2': 'Such nach einem Eintrag wie „Zum Startbildschirm hinzufügen“, „App installieren“ oder „Hinzufügen zu …“ – manchmal steckt er in einem Unterpunkt.',
    'installGate.step.opera1': 'Öffne das Menü – meist drei Punkte ⋮ oben rechts.',
    'installGate.step.opera2': 'Tippe auf „Hinzufügen zu …“ und wähle dort „Startbildschirm“ (oder etwas Ähnliches).',
    'installGate.step.confirm': 'Bestätige, falls dein Handy nachfragt (z. B. mit „Installieren“ oder „Hinzufügen“).',
    'installSketch.copy': 'Kopieren',
    'installSketch.readingList': 'Zur Leseliste',
    'installSketch.addHome': 'Zum Home-Bildschirm',
    'installSketch.bookmark': 'Lesezeichen',
    'installSketch.cancel': 'Abbrechen',
    'installSketch.add': 'Hinzufügen',
    'installSketch.newTab': 'Neuer Tab',
    'installSketch.history': 'Verlauf',
    'installSketch.bookmarks': 'Lesezeichen',
    'installSketch.addHomeAndroid1': 'Zum Startbildschirm',
    'installSketch.addHomeAndroid2': 'hinzufügen',
    'installSketch.addPageTo1': 'Seite',
    'installSketch.addPageTo2': 'hinzufügen zu',
    'installSketch.downloads': 'Downloads',
    'installSketch.ariaIosShare': 'Skizze: Teilen-Symbol unten in der Leiste von Safari',
    'installSketch.ariaIosShareTop': 'Skizze: Teilen-Symbol oben rechts in der Adressleiste',
    'installSketch.ariaIosSheet': 'Skizze: Liste mit „Zum Home-Bildschirm“ hervorgehoben',
    'installSketch.ariaIosAdd': 'Skizze: „Hinzufügen“ oben rechts hervorgehoben',
    'installSketch.ariaChromeMenu': 'Skizze: drei Punkte oben rechts neben der Adressleiste',
    'installSketch.ariaChromeList': 'Skizze: Menü mit „Zum Startbildschirm hinzufügen“ hervorgehoben',
    'installSketch.ariaSamsungMenu': 'Skizze: Menü ≡ unten rechts',
    'installSketch.ariaSamsungList': 'Skizze: Menü mit „Seite hinzufügen zu“ hervorgehoben',
    'installSketch.or': 'oder',
    'installSketch.settings': 'Einstellungen',
    'installSketch.addHomeGeneric1': 'Zum Startbildschirm',
    'installSketch.addHomeGeneric2': '/ Hinzufügen zu …',
    'installSketch.reload': 'Neu laden',
    'installSketch.share': 'Teilen',
    'installSketch.addTo': 'Hinzufügen zu …',
    'installSketch.zoom': 'Zoomstufe',
    'installSketch.ariaGenericMenu': 'Skizze: das Menü sitzt meist oben rechts oder unten rechts',
    'installSketch.ariaGenericList': 'Skizze: Menü mit einem Eintrag zum Startbildschirm hervorgehoben',
    'installSketch.ariaOperaList': 'Skizze: Menü mit „Hinzufügen zu …“ hervorgehoben',
    'installSketch.permIosLine1': '„Logbuch“ möchte dir',
    'installSketch.permIosLine2': 'Mitteilungen senden',
    'installSketch.permDeny': 'Nicht erlauben',
    'installSketch.permAllow': 'Erlauben',
    'installSketch.permAndroidLine1': 'Logbuch erlauben, dir',
    'installSketch.permAndroidLine2': 'Benachrichtigungen',
    'installSketch.permAndroidLine3': 'zu senden?',
    'installSketch.permAllowAndroid': 'Zulassen',
    'installSketch.permDenyAndroid': 'Nicht zulassen',
    'installSketch.ariaPerm': 'Skizze: die Frage deines Handys, mit „Erlauben“ hervorgehoben',
    'installGate.installed': '✓ Installiert! Öffne Logbuch jetzt über das neue Symbol auf deinem Startbildschirm und registriere dich dort (oder melde dich an).',
    'installGate.skip': 'Ich bleib erst mal im Browser',
    'installGate.skipNoteIos': 'Geht auch – nur kommen dann keine Erinnerungen. Du kannst Logbuch jederzeit später noch hinzufügen.',
    'installGate.skipNote': 'Geht auch – du kannst Logbuch jederzeit später noch hinzufügen.',
    'confirmLanding.title': 'Adresse bestätigt!',
    'spamFeedback.question': 'Kurze Frage: Lag die Mail von Logbuch im Spam-Ordner?',
    'spamFeedback.yes': 'Ja, im Spam',
    'spamFeedback.no': 'Nein',
    'spamFeedback.why': 'Damit ich weiß, ob ich da etwas verbessern muss. Gespeichert wird nur deine Antwort mit deinem Mail-Anbieter (z. B. gmail.com), nicht deine Adresse oder dein Konto.',
    'spamFeedback.thanks': 'Danke für die Rückmeldung!',
    'confirmLanding.body': 'Diese Seite brauchst du nicht mehr. <strong>Öffne Logbuch jetzt wieder über das Symbol auf deinem Startbildschirm</strong> und melde dich dort an.',
    'confirmLanding.continueHere': 'Oder hier im Browser weitermachen',
    'push.unsupported': 'Erinnerungen werden von diesem Browser nicht unterstützt.',
    'push.checking': 'Erinnerungsstatus wird geprüft …',
    'push.active': 'Erinnerungen aktiv',
    'push.disable': 'Ausschalten',
    'push.none': 'Keine Erinnerungen',
    'push.enable': 'Einschalten',
    'push.blocked.status': 'Mitteilungen sind für Logbuch blockiert',
    'push.blocked.intro': 'Dein Handy fragt nicht noch einmal, wenn Mitteilungen einmal blockiert wurden. So erlaubst du sie wieder:',
    'push.blocked.ios': 'Öffne die <strong>Einstellungen</strong> deines iPhones, such dort <strong>Mitteilungen</strong> und dann <strong>Logbuch</strong>, und erlaube Mitteilungen. Komm dann hierher zurück.',
    'push.blocked.androidApp': 'Halte das <strong>Logbuch-Symbol</strong> auf dem Startbildschirm gedrückt, öffne die <strong>App-Info</strong> (oft ⓘ) und erlaube dort <strong>Benachrichtigungen</strong>. Je nach Handy heißen die Punkte etwas anders. Komm dann hierher zurück.',
    'push.blocked.androidBrowser': 'Tippe in der Adressleiste auf das Symbol links neben der Adresse und such dort nach <strong>Berechtigungen</strong> bzw. <strong>Benachrichtigungen</strong>, um sie zu erlauben. Je nach Browser sieht das etwas anders aus. Komm dann hierher zurück.',
    'push.blocked.other': 'Erlaube in den Website-Einstellungen deines Browsers für diese Seite <strong>Benachrichtigungen</strong>. Komm dann hierher zurück.',
    'push.blocked.retry': 'Nochmal versuchen',
    'push.blocked.retryHint': 'Hast du sie dort erlaubt? Dann tipp hier, um die Erinnerungen einzuschalten:',
    'push.blocked.still': 'Mitteilungen sind noch blockiert. Erlaube sie zuerst wie beschrieben und versuch es dann nochmal.',
    'tutorial.reminders.blocked': 'Kein Problem – du kannst auch ohne Erinnerungen weitermachen. Falls du es dir anders überlegst:',
    'menu.language': 'Sprache',
    'theme.label': 'Darstellung',
    'theme.system': 'System',
    'theme.light': 'Hell',
    'theme.dark': 'Dunkel',
    'textSize.label': 'Textgröße',
    'onbDisplay.welcomeTitle': 'Schrift zu klein? Lieber hell oder dunkel?',
    'onbDisplay.button': 'Anzeige',
    'textSize.small': 'Klein',
    'textSize.normal': 'Normal',
    'textSize.large': 'Groß',
    'textSize.xlarge': 'Sehr groß',
    'pattern.enableLabel': 'Muster zusätzlich zur Farbe anzeigen',
    'haptics.enableLabel': 'Beim Eintragen vibrieren',
    'pattern.explain': 'Etwa 1 von 12 Männern und 1 von 200 Frauen hat eine Rot-Grün-Sehschwäche – oft unbemerkt, da sie selten diagnostiziert wird. Damit Bewertungen (rot bis grün) nicht ausschließlich über die Farbe erkennbar sind, zeigt Logbuch standardmäßig zusätzlich ein feines Streifenmuster: je dichter, desto besser der Wert. Rein optisch abschaltbar, falls du es nicht brauchst und nicht magst.',
    'dayProgress.label': 'Stand des Tages zeigen (z. B. 3 von 7)',
    'dayProgress.explain': 'Standardmäßig aus: Eine Zahl, die noch nicht voll ist, kann sich wie eine Pflicht anfühlen – Logbuch soll ohne Druck funktionieren. Zähler wie „Zigaretten“ zählen nicht mit, dort ist kein Eintrag ja auch ein Ergebnis.',
    'menu.groupAccount': 'Konto',
    'menu.manageFields': 'Felder verwalten',
    'menu.about': 'Über Logbuch',
    'about.title': 'Über Logbuch',
    'menu.feedback': 'Feedback geben',
    'menu.install': 'Aufs Handy holen',
    'menu.settings': 'Einstellungen',
    'settings.reminders': 'Erinnerungen',
    'settings.display': 'Anzeige',
    'settings.defaultReminderNote': 'Gilt für alle Felder ohne eigene Erinnerungszeit.',
    'settings.exportNote': 'Lädt alles, was zu deinem Konto gehört, als eine Datei herunter.',
    'settings.recoveryKeyNote': 'Nur nötig, wenn du deinen Ersatzschlüssel verloren hast – der alte gilt danach nicht mehr.',
    'feedback.title': 'Feedback',
    'feedback.intro': 'Ideen, Fehler, Lob oder Kritik – alles ist willkommen.',
    'feedback.messageLabel': 'Deine Nachricht',
    'feedback.anonymousLabel': 'Ohne Absender senden',
    'feedback.anonymousNote': 'Ich sehe dann nicht, von wem die Nachricht kommt, und kann dir nicht antworten.',
    'feedback.replyNote': 'Ich kann dir an {email} antworten.',
    'feedback.submit': 'Absenden',
    'feedback.sending': 'Wird gesendet …',
    'feedback.sent': 'Danke! Dein Feedback ist angekommen.',
    'feedback.error.empty': 'Bitte schreib zuerst eine Nachricht.',
    'feedback.error.rateLimited': 'Du hast in den letzten 24 Stunden schon mehrere Nachrichten geschickt – bitte versuch es später noch einmal.',
    'feedback.error.failed': 'Senden fehlgeschlagen – bitte versuch es später noch einmal.',
    'about.intro': 'Ein paar Dinge, die sich nicht von selbst erklären — zum Nachlesen, falls du magst.',
    'about.link.menu': 'In den Einstellungen zeigen',
    'about.link.manage': 'Zu „Felder verwalten“',
    'about.status': 'Beta – Stand {date}. Ich baue laufend weiter, melde dich gern, falls dir etwas auffällt.',
    'about.monetizationNote': 'Logbuch ist aktuell in vollem Umfang kostenlos. Es ist möglich, dass ich künftig bestimmte Funktionen kostenpflichtig mache, zum Beispiel über ein Abonnement.',
    'about.group.usage': 'Bedienung',
    'about.group.fields': 'Felder & Auswertung',
    'about.group.appearance': 'Darstellung',
    'about.a11y.title': 'Barrierefreiheit bei Logbuch',
    'about.a11y.intro': 'Menschen mit Einschränkungen — ob durch eine Behinderung, Farbenblindheit, eingeschränkte Beweglichkeit oder wenig Erfahrung mit Handys — gehören zu den in der Gesellschaft am wenigsten berücksichtigten Gruppen. Gerade eine App, die dabei helfen soll, gut für sich selbst zu sorgen, sollte hier besonders genau hinschauen — nicht weil es irgendwann Pflicht wird, sondern weil es mir wichtig ist. Ein paar konkrete Dinge, die ich deshalb bewusst eingebaut habe, und warum:',
    'about.a11y.pattern.title': 'Warum ein Muster zusätzlich zur Farbe?',
    'about.a11y.pattern.body': 'Rund 1 von 12 Männern und 1 von 200 Frauen hat eine Rot-Grün-Sehschwäche — oft unbemerkt, weil sie selten diagnostiziert wird. Bewertungen in Logbuch (rot bis grün) sind deshalb standardmäßig zusätzlich mit einem feinen Streifenmuster versehen, dessen Dichte sich nach dem Wert richtet. Bewusst nicht als Extra-Einstellung, die man erst suchen muss (Opt-in), sondern als Standard, den man bei Bedarf abschalten kann (in den Einstellungen) — wer es braucht, weiß oft selbst nicht, dass er danach suchen müsste.',
    'about.a11y.textSize.title': 'Größere Schrift',
    'about.a11y.textSize.body': 'Logbuch nutzt eine gut lesbare Schriftgröße und kräftigen Kontrast. Unter „Textgröße“ in den Einstellungen kannst du alles größer oder kleiner stellen – anders als beim Zoomen mit zwei Fingern passt sich dabei die ganze Seite an.',
    'about.a11y.buttons.title': 'Klare Knöpfe',
    'about.a11y.buttons.body': 'Alles, was man antippen kann, sieht wie ein Knopf aus – nicht wie unterstrichener Text, den viele übersehen. Und jeder Knopf hat eine ausreichend große Tippfläche, auch wenn er klein aussieht.',
    'about.a11y.keyboard.title': 'Tastatur statt Maus oder Finger',
    'about.a11y.keyboard.body': 'Alles in Logbuch lässt sich vollständig ohne Maus oder Touch bedienen — wichtig für Menschen, die aus motorischen Gründen keine Maus präzise führen oder einen Touchscreen nicht zuverlässig treffen können. Kalenderzellen, Dialoge und selbst das Umsortieren von Feldern (sonst nur per Ziehen möglich) haben eine vollwertige Tastatur-Alternative. In Dialogen wie „Konto löschen“ bleibt der Tastatur-Fokus zuverlässig innerhalb des Dialogs, statt unbemerkt in den Hintergrund abzurutschen, und Escape schließt sie, wie man es von anderer Software gewohnt ist.',
    'about.a11y.screenreader.title': 'Screenreader (Vorlese-Software für blinde Menschen)',
    'about.a11y.screenreader.body': 'Neue Fehler- oder Erfolgsmeldungen werden automatisch vorgelesen, ohne dass man erst danach suchen muss. Der Verlaufs-Graph bei Zahlenwert-Feldern hat zusätzlich zur Grafik eine vollständige Textzusammenfassung (Anzahl der Einträge, letzter Wert, Durchschnitt, Trend) — eine reine Grafik wäre für einen Screenreader sonst stumm. Das ist kein abgeschlossenes Kapitel, ich baue daran laufend weiter.',
    'about.a11y.feedback': 'Fehlt dir etwas, oder hast du eine Idee, was ich noch verbessern könnte? Ich freue mich über jedes Feedback.',
    'about.mentalHealth.title': 'Psychische Gesundheit',
    'about.mentalHealth.intro': 'An sich selbst arbeiten zu wollen ist ein guter Impuls — aber nur, wenn er nicht in Druck oder Selbstkritik umschlägt. Mir ist wichtig, dass Logbuch dabei hilft, ohne selbst zur Belastung zu werden. Ein paar Dinge, die mir dabei am Herzen liegen:',
    'about.mentalHealth.observation.title': 'Ein Eintrag ist eine Beobachtung, keine Bewertung',
    'about.mentalHealth.observation.body': 'Ein roter Tag heißt nicht, dass du versagt hast — nur, dass an diesem Tag etwas anders war als sonst. Wenn Zahlen oder Farben anfangen, sich wie eine Note für dich als Person anzufühlen, ist das ein guter Moment für eine Pause vom Tracken.',
    'about.mentalHealth.noSubstitute.title': 'Logbuch ersetzt keine professionelle Hilfe',
    'about.mentalHealth.noSubstitute.body': 'Diese App kann helfen, Muster über die Zeit zu erkennen — sie kann aber kein Gespräch mit einem Therapeuten, einer Ärztin oder einer Vertrauensperson ersetzen, gerade bei Themen wie Stimmung, Schlaf oder Konsum. Wenn es dir über längere Zeit schlecht geht, sprich bitte mit jemandem.',
    'about.mentalHealth.crisis.title': 'Falls es dir gerade richtig schlecht geht',
    'about.mentalHealth.crisis.germany': 'In Deutschland ist die Telefonseelsorge kostenlos und anonym erreichbar – per Telefon rund um die Uhr (zwei unabhängige Nummern, falls eine besetzt ist), außerdem per Chat.',
    'about.mentalHealth.crisis.websiteButton': 'Chat auf telefonseelsorge.de',
    'about.mentalHealth.crisis.callButton1': '0800 111 0 111 anrufen',
    'about.mentalHealth.crisis.callButton2': '0800 111 0 222 anrufen',
    'about.mentalHealth.crisis.international': 'Außerhalb Deutschlands (oder wenn dir das lieber ist) findest du auf <a href="https://findahelpline.com" target="_blank" rel="noopener">findahelpline.com</a> kostenlose Anlaufstellen nach Land.',
    'about.mentalHealth.crisis.emergency': 'Bist du oder jemand anderes in akuter Gefahr, ruf den Notruf <strong>112</strong> an – in der EU überall kostenlos, anderswo die örtliche Notrufnummer.',
    'about.mentalHealth.crisis.closing': 'Du brauchst dafür keinen Notfall, ein Gespräch reicht.',
    'about.mentalHealth.feedback': 'Fehlt dir hier etwas, oder siehst du das anders? Ich freue mich über dein Feedback.',
    'about.privacy.title': 'Deine Daten und deine Privatsphäre',
    'about.privacy.intro': 'In Logbuch landen oft sehr persönliche Dinge: Stimmung, Schlaf, Konsum, Sexualität, Gedanken, die man sonst niemandem erzählt. Genau deshalb soll niemand außer dir sie lesen können – auch ich nicht. Nicht, weil du mir misstrauen müsstest, sondern weil Vertrauen am besten dort funktioniert, wo man es gar nicht erst braucht: Was ich nicht sehen kann, kann ich auch nicht verlieren, weitergeben oder missbrauchen. Hier ganz ehrlich, was ich sehen kann und was nicht:',
    'about.privacy.cannotSee.title': 'Was ich nicht sehen kann',
    'about.privacy.cannotSee.body': 'Alles, was du einträgst, und worum es dabei geht: deine Werte, Notizen und Text-Antworten, die Namen deiner Felder und Gruppen und die Bezeichnungen ihrer Stufen. Das alles wird auf deinem Gerät verschlüsselt, bevor es überhaupt verschickt wird. Der Schlüssel dafür hängt an deinem Passwort und deinem Ersatzschlüssel, und beide kennst nur du. Selbst mit vollem Zugriff auf die Datenbank sehe ich davon nur unlesbaren Zeichensalat.',
    'about.privacy.canSee.title': 'Was ich sehen kann',
    'about.privacy.canSee.body': 'Was technisch nötig ist, damit die App funktioniert:<ul><li>deine E-Mail-Adresse und wann du dich registriert und zuletzt angemeldet hast</li><li>wie viele Felder und Gruppen du hast, von welcher Art die Felder sind (z. B. Skala oder Zahl), wie oft sie dran sind (z. B. täglich, an bestimmten Wochentagen oder einmal pro Woche) und welches Feld in welcher Gruppe steht – aber nicht, worum es geht oder wie Felder und Gruppen heißen</li><li>an welchen Tagen du welches dieser Felder ausgefüllt hast (für die Erinnerungen), ohne den Wert – bei Zählern mit Erinnerungen und „falls weniger als“ nur, wie viele der Erinnerungen an dem Tag schon erledigt sind (z. B. „1 von 2“), nicht die Zahl selbst</li><li>deine Einstellungen wie Erinnerungszeit, Sprache und Zeitzone</li></ul>Dazu protokollieren die Anbieter, bei denen Logbuch läuft, für kurze Zeit technische Zugriffsdaten wie IP-Adressen. Und ein Mail-Dienst bekommt deine E-Mail-Adresse, um dir die Mails zum Bestätigen deines Kontos und zum Zurücksetzen des Passworts zu schicken.',
    'about.privacy.recoveryKey.title': 'Die Kehrseite: dein Ersatzschlüssel',
    'about.privacy.recoveryKey.body': 'Weil ich keinen Zugriff habe, kann ich dir auch nicht helfen, wenn du Passwort <strong>und</strong> Ersatzschlüssel verlierst – dann sind deine Einträge unwiederbringlich weg. Bewahre ihn deshalb gut auf. Hast du ihn verlegt, kannst du dir in den Einstellungen jederzeit einen neuen erzeugen – der alte wird dabei ungültig, und du brauchst ihn dafür nicht.',
    'about.privacy.yourData.title': 'Deine Daten gehören dir',
    'about.privacy.yourData.body': 'Du kannst jederzeit alles als Datei exportieren – dein Recht auf Auskunft über deine Daten – oder dein Konto löschen (in den Einstellungen unter „Konto“). Dein Konto und alle Einträge werden dabei endgültig gelöscht.',
    'about.privacy.feedback': 'Hast du Fragen dazu, oder fehlt dir etwas? Schreib mir gern.',
    'about.tip.keys.title': 'Tastatur am Computer',
    'about.tip.keys.body': '← und → blättern zum vorigen bzw. nächsten Tag oder Zeitraum, solange kein Eingabefeld ausgewählt ist. Strg+Enter (Mac: ⌘+Enter) speichert ein Feld, eine Gruppe, eine Notiz oder dein Feedback. Escape schließt Fenster und Menüs.',
    'about.tip.swipe.title': 'Wischen',
    'about.tip.swipe.body': 'In Tag-, Wochen-, Monats- und Jahresansicht kannst du nach links/rechts wischen, um zum vorherigen/nächsten Zeitraum zu springen — schneller als die Pfeil-Buttons. In "Felder verwalten" und "Über Logbuch" bringt dich ein Wisch nach rechts zurück.',
    'about.tip.jumpDay.title': 'Direkt zu einem Tag springen',
    'about.tip.jumpDay.body': 'Tippe in der Wochen-, Monats- oder Jahresansicht auf eine beliebige Zelle, um direkt zu diesem Tag zu springen.',
    'about.tip.toggleOff.title': 'Eine Antwort wieder löschen',
    'about.tip.toggleOff.body': 'Tippe eine bereits ausgewählte Option nochmal an, um sie zu entfernen — praktisch, falls du dich vertippt hast.',
    'about.tip.openDot.title': 'Punkt = noch offen',
    'about.tip.openDot.body': 'In „Heute“ markiert ein kleiner Punkt hinter dem Namen die Felder, die an diesem Tag geplant, aber noch nicht eingetragen sind – bei eingeklappten Gruppen an der Überschrift. Ist alles eingetragen, steht unter der Liste „Alles eingetragen“. Bewusst ohne Zähler oder Quote: Es soll zeigen, was noch fehlt, keinen Druck machen.',
    'about.tip.textFields.title': 'Freie Text-Felder',
    'about.tip.textFields.body': 'Für Fragen wie „Wofür bin ich heute dankbar?“ gibt es den Feld-Typ „Text“. In „Heute“ steht dafür ein Textfeld, das automatisch speichert. Die Antworten fließen nicht in die Auswertung ein, lassen sich aber in Woche, Monat, Jahr und Gesamt aufklappen und nachlesen — ein Tipp auf einen Eintrag führt zu seinem Tag.',
    'about.tip.fieldMenu.title': 'Notizen & Felder direkt bearbeiten',
    'about.tip.fieldMenu.body': 'Über die drei Punkte ⋮ vor jedem Feld in „Heute“ kannst du eine Notiz dazu schreiben — etwa „heute wegen Erkältung kein Sport“ — oder das Feld direkt dort bearbeiten bzw. archivieren; vor einer Gruppe entsprechend die Gruppe bearbeiten, vor dem Wochentag oben den ganzen Tag zurücksetzen. Schneller geht es, wenn du auf den Feldnamen tippst oder die Zeile kurz gedrückt hältst. Notizen fließen nicht in die Auswertung ein, in Woche und Monat zeigt ein kleiner Punkt, wo es eine gibt.',
    'about.tip.reorder.title': 'Felder umsortieren',
    'about.tip.reorder.body': 'In „Felder verwalten“ kannst du Felder per Ziehen am Griff-Symbol oder mit den ↑/↓-Buttons neu anordnen.',
    'about.tip.noValuation.title': 'Felder ohne Wertung',
    'about.tip.noValuation.body': 'Nicht alles muss gut oder schlecht sein. Bei „Keine Wertung“ (statt „Hohe/Niedrige Werte erstrebenswert“) wird ein Feld einfach nur getrackt – ganz ohne Färbung nach Wert, denn schon eine Abstufung von hell nach dunkel würde ein „mehr“ oder „weniger“ behaupten. In der Auswertung siehst du, an welchen Tagen und wie oft du etwas eingetragen hast, aber keine Prozentwerte.',
    'about.tip.computed.title': 'Berechnete Felder',
    'about.tip.computed.body': 'Ein Feld vom Typ „Berechnet“ fasst mehrere Felder zu einem Wert zusammen: Skala-Felder zu einem Durchschnitt, z. B. „Sport gemacht“ aus „Ausdauersport“ + „Kraftsport“ – oder Zahlenwert-Felder mit derselben Einheit als Summe, Durchschnitt, Minimum oder Maximum, z. B. „Bewegung gesamt (km)“ aus „Laufen“ + „Radfahren“. Selbst ausfüllen kann man es nicht – der Wert berechnet sich immer live aus den anderen Feldern.',
    'about.tip.goalThreshold.title': 'Ziel-Quote statt 100 %',
    'about.tip.goalThreshold.body': 'Nicht alles muss jeden Tag klappen. Unter „Mehr Einstellungen“ im Feld-Formular stellst du ein Ziel ein, z. B. Sport an 3 von 7 Tagen – ab dann ist das Feld in der Auswertung voll grün.',
    'about.tip.slider.title': 'Schieberegler statt Buttons',
    'about.tip.slider.body': 'Stufen lassen sich auch als Schieberegler statt als Auswahl-Buttons darstellen. Buttons gehen bis 7 Stufen, damit jede gut sichtbar und gezielt wählbar bleibt – für feinere Skalen mit bis zu 100 Stufen (z. B. 1 bis 100) nimm den Schieberegler.',
    'about.tip.customReminder.title': 'Eigene Erinnerungszeiten pro Feld oder Gruppe',
    'about.tip.customReminder.body': 'Jedes Feld kann eigene Erinnerungszeiten bekommen, statt sich an die Standardzeit zu halten — sinnvoll z. B. für etwas, das du morgens einträgst, statt abends. Bis zu vier Zeiten gehen, etwa morgens und abends fürs Zähneputzen; erinnert wird jeweils nur, solange noch etwas fehlt. Auch eine Gruppe kann eine eigene Zeit haben: Ihre Felder werden dann gemeinsam zu dieser Zeit erinnert, mit einer Nachricht für die ganze Gruppe. Hat ein Feld darin selbst eine eigene Zeit, gilt seine.',
    'about.tip.sections.title': 'Gruppen',
    'about.tip.sections.body': 'Felder lassen sich in Gruppen ordnen – am besten nach Tageszeit, z. B. „Morgens“ und „Abends“: Dann trägst du jeden Block in einem Rutsch ein, und jede Gruppe kann zu ihrer eigenen Zeit erinnern. Ist in einer Gruppe alles eingetragen, ist sie beim nächsten Öffnen zugeklappt; das stellst du pro Gruppe ein. Gruppen ordnen nur; einen gemeinsamen Wert berechnet ein Feld vom Typ „Berechnet“.',
    'about.tip.schedule.title': 'Feste Tage? Wochentage wählen',
    'about.tip.schedule.body': 'Für Dinge an festen Tagen, etwa montags wiegen: Im Feld-Formular wählst du unter „An welchen Tagen?“ die Wochentage – oder „Alle paar Tage“ für einen festen Abstand, etwa alle 3 Tage. An anderen Tagen steht das Feld in „Heute“ eingeklappt unter „Heute nicht geplant“ – eintragen kannst du dort trotzdem –, und es löst keine Erinnerung aus. In der Woche sind solche Tage schraffiert, damit „nicht dran“ nicht wie „vergessen“ aussieht.',
    'about.tip.archiveVsDelete.title': 'Archivieren statt löschen',
    'about.tip.archiveVsDelete.body': 'Archivierte Felder verschwinden aus der Tageseingabe und standardmäßig auch aus der Auswertung – ihre bisherigen Werte bleiben aber erhalten. Willst du sie weiter sehen (z. B. die Vorgeschichte eines Feldes, das du durch ein neues ersetzt hast), setz in „Felder verwalten“ beim archivierten Feld den Haken „In der Auswertung anzeigen“. Archivierte Felder lassen sich jederzeit reaktivieren; endgültiges Löschen entfernt dagegen auch die bisherigen Werte.',
    'about.tip.theme.title': 'Dark Mode',
    'about.tip.theme.body': 'Folgt automatisch deiner Systemeinstellung, lässt sich in den Einstellungen aber auch fest auf Hell oder Dunkel stellen.',
    'about.tip.textSize.title': 'Schriftgröße',
    'about.tip.textSize.body': 'In den Einstellungen unter „Textgröße“ lässt sich die Schrift in der ganzen App vergrößern oder verkleinern – gilt für dieses Gerät.',
    'about.tip.language.title': 'Sprache',
    'about.tip.language.body': 'Logbuch gibt\'s auf Deutsch und Englisch, umstellbar in den Einstellungen.',
    'menu.exportData': 'Meine Daten exportieren',
    'menu.regenerateRecoveryKey': 'Ersatzschlüssel neu erzeugen',
    'menu.deleteAccount': 'Konto löschen',
    'menu.changePassword': 'Passwort ändern',
    'passwordChange.title': 'Passwort ändern',
    'passwordChange.current': 'Aktuelles Passwort',
    'passwordChange.new': 'Neues Passwort',
    'passwordChange.note': 'Auf deinen anderen Geräten wirst du danach abgemeldet und meldest dich dort mit dem neuen Passwort an. Dein Ersatzschlüssel bleibt gültig.',
    'passwordChange.submit': 'Passwort ändern',
    'passwordChange.saving': 'Wird geändert …',
    'passwordChange.saved': 'Passwort geändert.',
    'passwordChange.error.wrongCurrent': 'Das aktuelle Passwort stimmt nicht.',
    'passwordChange.error.same': 'Das neue Passwort ist dasselbe wie das aktuelle.',
    'passwordChange.error.failed': 'Passwort nicht geändert.',
    'passwordChange.error.incomplete': 'Die Änderung ist nicht ganz durchgelaufen, vermutlich war die Verbindung kurz weg. Tippe bitte gleich noch einmal auf „Passwort ändern“ – erst dann ist sie abgeschlossen.',
    'menu.changeEmail': 'E-Mail-Adresse ändern',
    'settings.emailCurrent': 'Angemeldet mit {email}',
    'settings.emailPending': 'Wechsel zu {email} wartet noch auf deine Bestätigung in der Mail dorthin.',
    'emailChange.title': 'E-Mail-Adresse ändern',
    'emailChange.current': 'Bisher: <strong>{email}</strong>',
    'emailChange.new': 'Neue E-Mail-Adresse',
    'emailChange.password': 'Dein Passwort',
    'emailChange.note': 'Du bekommst eine Mail an die neue Adresse. Erst wenn du dort bestätigt hast, gilt sie – bis dahin meldest du dich mit der bisherigen an. An die bisherige geht danach ein Hinweis, dass die Adresse geändert wurde.',
    'emailChange.submit': 'Mail senden',
    'emailChange.sending': 'Wird gesendet …',
    'emailChange.sentTitle': 'Schau in dein Postfach',
    'emailChange.sentBody': 'Ich habe dir eine Mail an <strong>{email}</strong> geschickt. Tippe dort auf den Knopf – danach gilt die neue Adresse.',
    'emailChange.sentSpam': 'Keine Mail da? Schau auch im Spam-Ordner nach.',
    'emailChange.landedDone': 'Deine neue E-Mail-Adresse gilt jetzt.',
    'emailChange.error.same': 'Das ist schon deine aktuelle Adresse.',
    'emailChange.error.wrongPassword': 'Das Passwort stimmt nicht.',
    'emailChange.error.taken': 'Für diese Adresse gibt es schon ein Konto.',
    'emailChange.error.invalid': 'Das sieht nicht nach einer gültigen E-Mail-Adresse aus.',
    'emailChange.error.rateLimit': 'Gerade wurden zu viele Mails verschickt. Versuch es in ein paar Minuten noch einmal.',
    'emailChange.error.failed': 'Mail nicht gesendet.',
    'mailLink.expired': 'Dieser Link aus der Mail ist abgelaufen oder wurde schon benutzt. Hast du schon bestätigt, ist alles erledigt. Sonst fordere einfach eine neue Mail an.',
    'mailLink.failed': 'Der Link aus der Mail hat nicht funktioniert. Fordere einfach eine neue Mail an.',
    'menu.checkSpareKey': 'Ersatzschlüssel prüfen',
    'settings.checkSpareKeyNote': 'Prüft, ob dein aufgeschriebener oder gespeicherter Ersatzschlüssel noch passt. Dabei wird nichts verändert.',
    'spareKeyCheck.title': 'Ersatzschlüssel prüfen',
    'spareKeyCheck.body': 'Gib deinen Ersatzschlüssel ein, so wie du ihn aufgeschrieben oder gespeichert hast. Geprüft wird nur hier auf deinem Gerät, er wird nirgends gespeichert.',
    'spareKeyCheck.submit': 'Prüfen',
    'spareKeyCheck.checking': 'Wird geprüft …',
    'spareKeyCheck.ok': 'Passt. Mit diesem Ersatzschlüssel kommst du an deine Daten, falls du dein Passwort vergisst.',
    'spareKeyCheck.wrong': 'Dieser Ersatzschlüssel passt nicht. Sieh nach, ob du ihn vollständig und ohne Tippfehler eingegeben hast. Hast du keinen passenden mehr, erzeuge einen neuen.',
    'spareKeyCheck.failed': 'Prüfen hat nicht geklappt.',
    'deleteAccount.title': 'Konto endgültig löschen',
    'deleteAccount.warning': 'Alle deine Einträge, Felder und Einstellungen werden unwiderruflich gelöscht. Das kann nicht rückgängig gemacht werden.',
    'deleteAccount.whichAccount': 'Konto: <strong>{email}</strong>',
    'deleteAccount.protected': 'Dieses Konto ist gegen Löschen geschützt.',
    'deleteAccount.typeToConfirm': 'Tippe {word} zur Bestätigung',
    'deleteAccount.deleting': 'Wird gelöscht …',
    'deleteAccount.deletePermanently': 'Endgültig löschen',
    'common.loading': 'Lädt …',
    'whatsNew.title': 'Neu in Logbuch',
    'whatsNew.close': 'Alles klar',
    'whatsNew.all': 'Alle Neuigkeiten',
    'about.news.title': 'Neuigkeiten',
    'startup.opening': 'Dein Logbuch wird geöffnet …',
    'startup.slow': 'Das dauert gerade länger als sonst – meist ist die Internetverbindung langsam. Es geht gleich von selbst weiter.',
    'tabs.today': 'Heute',
    'tabs.week': 'Woche',
    'tabs.month': 'Monat',
    'tabs.year': 'Jahr',
    'tabs.global': 'Gesamt',
    'common.encryptingData': 'Deine Daten werden verschlüsselt …',
    'recoveryDisplay.replacedElsewhere': 'Dein Ersatzschlüssel wurde inzwischen auf einem anderen Gerät neu erzeugt – der eben gezeigte gilt deshalb nicht mehr. Hier ist ein neuer, bewahre bitte diesen auf.',
    'recoveryDisplay.copyFailed': 'Kopieren nicht möglich - bitte den Ersatzschlüssel von Hand abschreiben.',
    'recoveryDisplay.fileBody': 'Sicher aufbewahren – ohne diesen Ersatzschlüssel UND dein Passwort sind deine Daten unwiederbringlich verloren. Gib ihn niemandem: Er öffnet dein Logbuch genauso wie dein Passwort.',
  },
  en: {
    'error.db.duplicateSlug': 'A field with a very similar name already exists – please choose a different name.',
    'error.db.duplicateGeneric': 'This already exists in this form.',
    'error.db.notNull': 'A required field is missing or currently has no valid value – please check all fields and try again.',
    'error.db.check': 'One of the entered values is outside the allowed range.',
    'error.db.pushLimit': 'Reminders are already on for 10 devices – turn them off on one of them to turn them on here.',
    'error.db.accountGone': 'This account no longer exists (e.g. deleted from another device). You have been signed out.',
    'error.db.foreignKey': 'A linked entry no longer exists – please reload the page and try again.',
    'error.db.network': 'No connection to the server – check your internet connection and try again.',
    'error.db.sessionExpired': 'Your session has expired – please reload the page and sign in again.',
    'ariaLabel.clearInput': 'Clear input',
    'ariaLabel.explain': 'Show explanation',
    'ariaLabel.decrease': 'Decrease',
    'ariaLabel.increase': 'Increase',
    'notice.loadEntriesError': 'Entries could not be loaded.',
    'notice.loadHabitsError': 'Fields could not be loaded.',
    'notice.habitsUndecryptable': '{count} field(s) could not be decrypted and are not shown.',
    'push.customReminder': 'Reminder: {names} not entered yet.',
    'push.counterReminder': 'Reminder: {names}',
    'push.sectionReminder': 'Reminder: something in “{name}” is still missing.',
    'notice.loadSettingsError': 'Settings could not be loaded.',
    'notice.saveFailed': 'Saving did not work.',
    'notice.createFailed': 'Creating did not work.',
    'notice.actionFailed': 'That did not work.',
    'notice.reorderFailed': 'The order could not be saved.',
    'notice.deleteFailed': 'Deleting did not work.',
    'notice.invalidNumber': 'That is not a valid number.',
    'notice.recoveryKeySaveError': 'The new spare key could not be saved.',
    'habitForm.error.minComputedMembers': 'Please select at least 2 fields.',
    'habitForm.error.stepsRange': 'Number of steps must be between 2 and {max}.',
    'habitForm.lockedStepCap': 'This field has {steps} steps – buttons and custom labels only go up to {cap} steps, so that every step stays clearly visible and easy to pick.',
    'habitForm.stepCapHint': 'More than {cap} steps only work as a slider without custom labels – with that many, a single step can hardly be picked deliberately.',
    'habitForm.stepCapToSlider': 'Switch to slider',
    'habitForm.stepCapLabelsOff': 'Turn off custom labels',
    'habitForm.error.fillAllLabels': 'Please fill in all labels.',
    'habitForm.error.nameRequired': 'Please enter a name.',
    'ariaLabel.dismissHint': 'Dismiss hint',
    'installHint.ios': 'Put Logbuch on your Home Screen – on iPhone, reminders cannot reach you otherwise.',
    'installHint.other': 'Put Logbuch on your home screen – it then opens like an app, and reminders arrive more reliably.',
    'installHint.show': 'Show me how',
    'notice.pushPermissionDenied': 'Without your permission Logbuch cannot send reminders. You can try again anytime.',
    'notice.pushEnabled': 'Reminders are active.',
    'notice.enableFailed': 'Reminders could not be turned on.',
    'notice.entriesUndecryptable': '{count} day(s) could not be decrypted and appear empty. So that nothing gets lost, Logbuch does not save anything there. Feel free to write to me via “Send feedback”.',
    'notice.dayUndecryptable': 'This day could not be decrypted. So that its content is not overwritten, Logbuch does not save anything here.',
    'notice.disableFailed': 'Reminders could not be turned off.',
    'notice.exportFailed': 'The export did not work.',
    'notice.exportDownloaded': 'Export downloaded.',
    'notice.tryAgain': 'Please try again in a moment.',
    'notice.valueRemoved': '{name}: entry removed',
    'notice.undo': 'Undo',
    'notice.details': 'Technical details',
    'ariaLabel.closeNotice': 'Close message',
    'deleteAccount.confirmWord': 'DELETE',
    'deleteAccount.confirmMismatch': 'Please type exactly "{word}" to confirm.',
    'auth.title.forgot': 'Reset password',
    'auth.title.signup': 'Create new account',
    'auth.title.login': 'Sign in',
    'auth.forgotRecoveryNote': 'To actually reset your password, you will need your spare key in the next step (the one you got after setup, or last regenerated in the settings) – only with it is your existing data kept.',
    'auth.email': 'Email',
    'auth.password': 'Password',
    'auth.passwordHint': '<strong>Remember it well or write it down</strong> and keep the note in a safe place – without your password you cannot get to your entries anymore.',
    'auth.passwordRule': 'At least {min} characters',
    'auth.emailWhy': 'This gives you your own account: if you switch phones or want to use Logbuch on another device, you simply sign in there.',
    'auth.passwordWhyTitle': 'Why does it matter so much?',
    'auth.passwordWhy': 'Your entries are encrypted on your device before they are stored – your password is the key. That is why nobody else can read them, not even me. Choose one you do not use anywhere else.',
    'auth.hide': 'Hide',
    'auth.show': 'Show',
    'auth.sendResetLink': 'Send reset link',
    'auth.createAccount': 'Create account',
    'auth.login': 'Sign in',
    'auth.busy.signup': 'Creating account …',
    'auth.busy.login': 'Signing in …',
    'auth.busy.forgot': 'Sending …',
    'auth.welcome.lead': 'Great to have you here!',
    'auth.welcome.new': 'I’m new here',
    'auth.welcome.newNote': 'Create an account and set up Logbuch – takes about 5 to 10 minutes.',
    'auth.welcome.existing': 'I already have an account',
    'auth.welcome.existingNote': 'Sign in with your email address and password.',
    'onb.mode.title': 'How would you like to start?',
    'onb.mode.guided': 'Step by step',
    'onb.mode.guidedNote': 'With detailed explanations and pictures.',
    'onb.mode.short': 'Short and sweet',
    'onb.mode.shortNote': 'If you know your way around apps. You can still open the explanations anytime.',
    'onb.intro.title': 'A quick note first',
    'onb.intro.body': 'Hi, I’m Louis and I built Logbuch because I want to support people in their everyday lives – the way I’d wish an app would support me. Logbuch works differently in a few ways than you might be used to from other apps – and for it to work properly for you, you should know about them.',
    'onb.intro.help': 'I’ll explain what to do at every step. <strong>Please read it calmly</strong> – then everything works the first time.',
    'onb.intro.ok': 'Got it',
    'onb.overview.title': 'Here’s how it goes',
    'onb.overview.install': 'Get Logbuch onto your phone',
    'onb.overview.account': 'Create an account and confirm your email',
    'onb.overview.setup': 'Get to know Logbuch and create your first field',
    'onb.overview.reminders': 'Set up reminders, if you like',
    'onb.overview.key': 'Save your spare key',
    'onb.overview.duration': 'Takes about 5 to 10 minutes – but feel free to take more time.',
    'onb.overview.helper': 'If you like, ask someone who knows their way around phones to join you – it’s often easier together.',
    'onb.overview.start': 'Let’s go',
    'onb.installed.title': 'Done!',
    'onb.installed.body': 'Logbuch is now on your phone. Next up: your account.',
    'onb.installed.continue': 'Create account',
    'onb.progress.label': 'Step {n} of {total}: {name}',
    'onb.progress.part': 'part {part} of {parts}',
    'onb.stage.install': 'Get Logbuch onto your phone',
    'onb.stage.account': 'Create account',
    'onb.stage.setup': 'Get to know Logbuch',
    'onb.stage.reminders': 'Reminders',
    'onb.stage.key': 'Save your spare key',
    'auth.backToLogin': 'Back to sign in',
    'auth.forgotPassword': 'Forgot password?',
    'auth.resetLinkSent': 'If this email is registered with us, we have sent a link to reset your password.',
    'auth.signupFailedGeneric': 'Sign-up failed. Please try again.',
    'auth.confirmHelp.spam': 'No email? Also check your <strong>spam folder</strong> – depending on your provider it may be called “Junk” or “Promotions”. Sometimes it takes a few minutes.',
    'auth.confirmHelp.sentTo': 'The email went to: <strong>{email}</strong>. Wrong address? Just sign up again with the right one.',
    'auth.confirmHelp.resend': 'Send the email again',
    'auth.confirmHelp.resending': 'Sending …',
    'auth.confirmHelp.resent': 'A new email is on its way.',
    'auth.confirmHelp.wait': 'Please wait another {seconds} seconds, then you can try again.',
    'auth.confirmHelp.failed': 'Sending did not work. Please try again in a moment.',
    'auth.checkMail.title': 'Check your inbox',
    'auth.checkMail.body': 'I have sent you an email. That way we know the address is yours – important in case you ever need to reset your password.',
    'auth.checkMail.howTitle': 'How it works',
    'auth.checkMail.after': 'Then sign in – here via “Continue to sign in” or on the page that opens after confirming. If you put Logbuch on your phone, it is best to continue in the app.',
    'auth.checkMail.step1': 'Open your email app (e.g. Gmail, Outlook or Yahoo Mail).',
    'auth.checkMail.step2': 'Open the email from Logbuch (“Confirm your email for Logbuch”). If you cannot find it, also check your spam folder.',
    'auth.checkMail.step3': 'Tap the confirm button in it.',
    'auth.checkMail.continue': 'Continue to sign in',
    'auth.error.passwordTooShort': 'The password must be at least {min} characters long.',
    'recovery.title': 'Set new password',
    'recovery.newPassword': 'New password',
    'recovery.key': 'Spare key',
    'recovery.keyPlaceholder': 'from setup, or last regenerated in the settings',
    'recovery.saving': 'Saving…',
    'recovery.savePassword': 'Save password',
    'recovery.keyAlsoLost': 'Also lost your spare key?',
    'recovery.fallbackWarning': 'Without the spare key, your existing data can no longer be decrypted: all entries and notes as well as your fields and groups. They are then irrecoverably lost and will be deleted, and you start with an empty logbook. Your account itself remains.',
    'recovery.setAnyway': 'Understood, set password anyway (old data lost)',
    'recovery.cancelHaveKey': 'Cancel after all, I still have the spare key',
    'recovery.error.noConfig': 'No encryption configuration found.',
    'recovery.error.wrongKey': 'The spare key is incorrect or incomplete. Nothing was changed.',
    'recovery.passwordSaved': 'Password saved.',
    'recovery.cleanupFailed': 'Password saved. However, your old, no longer readable data could not be fully deleted – if fields are reported as “could not be decrypted”, please let me know via “Send feedback”.',
    'recoveryDisplay.title': 'Your spare key',
    'recoveryDisplay.lead': 'If you ever forget your password, <strong>only this key</strong> gets you back to your entries. So keep it safe.',
    'recoveryDisplay.whyTitle': 'Why does it exist?',
    'recoveryDisplay.codeLabel': 'Your spare key',
    'recoveryDisplay.secret': 'Do not give it to anyone – it unlocks your Logbuch just like your password.',
    'recoveryDisplay.how': 'How would you like to keep it?',
    'recoveryDisplay.method.write': 'Write it down',
    'recoveryDisplay.method.photo': 'Screenshot',
    'recoveryDisplay.method.file': 'Save as file',
    'recoveryDisplay.method.copy': 'Copy',
    'recoveryDisplay.help.write': 'Write it down character by character on paper and keep the note with your important documents. The gaps between the blocks are just for easier reading.',
    'recoveryDisplay.help.photoIos': 'Take a screenshot – on most iPhones: briefly press the <strong>side button</strong> and the <strong>volume up button</strong> at the same time (on iPhones with a round Home button: side button and Home button). The picture ends up in your Photos.',
    'recoveryDisplay.help.photoAndroid': 'Take a screenshot – on most phones: briefly press the <strong>power button</strong> and the <strong>volume down button</strong> at the same time. The picture ends up in your gallery or photos.',
    'recoveryDisplay.help.photoOther': 'Take a photo of this screen with your phone.',
    'recoveryDisplay.help.fileIos': 'The file “logbuch-ersatzschluessel.txt” is then usually in the <strong>Files</strong> app under <strong>Downloads</strong>. If your iPhone asks first, tap “Download”.',
    'recoveryDisplay.help.fileAndroid': 'The file “logbuch-ersatzschluessel.txt” is then usually in the <strong>Downloads</strong> folder – find it in the <strong>Files</strong> app or “My Files” (depending on your phone).',
    'recoveryDisplay.help.fileOther': 'The file “logbuch-ersatzschluessel.txt” is then usually in your <strong>Downloads</strong> folder.',
    'recoveryDisplay.help.copy': 'Copied. Now paste it where you want to keep it – e.g. in a password manager or a note.',
    'recoveryDisplay.help.copyGuided': 'Copied – your phone has remembered the key. Now open e.g. your <strong>notes app</strong>, press and hold an empty spot and choose <strong>Paste</strong>. Then come back here.',
    'recoveryDisplay.done': 'I have kept it safe',
    'recoveryDisplay.askNone': 'Have you kept it safe? Without a spare key nobody can help you if you forget your password.',
    'recoveryDisplay.askWritten': 'Did you write it down? Without a spare key nobody can help you if you forget your password.',
    'recoveryDisplay.notYet': 'Not yet',
    'recoveryDisplay.yesWritten': 'Yes, written down',
    'recoveryDisplay.yesKept': 'Yes, it is safe',
    'recoveryDisplay.explain': 'Your entries are encrypted so that <strong>only you can read them – not even I can.</strong> The flip side: if you forget your password, a reset link alone is not enough, your entries would stay locked. That is what this spare key is for – with it, you set a new password without losing anything.',
    'recoveryDisplay.moreLabel': 'What if I lose both?',
    'recoveryDisplay.more': 'If you lose your password <strong>and</strong> your spare key, your entries are gone – that is the price of nobody else being able to get in. You can get a new spare key anytime in the settings under “Regenerate spare key”; the old one then becomes invalid.',
    'recoveryDisplay.fileTitle': 'Logbuch – spare key',
    'recoveryDisplay.fileName': 'logbuch-spare-key.txt',
    'common.next': 'Next',
    'common.back': 'Back',
    'common.logout': 'Sign out',
    'unlock.title': 'Enter your password',
    'unlock.explain': 'For security, please enter your password once more.',
    'unlock.account': 'Account: <strong>{email}</strong>',
    'unlock.afterConfirm': '✓ Address confirmed! Enter your password here to continue – or continue in the Logbuch app if you put it on your phone. Then you do not need this page anymore.',
    'unlock.whyTitle': 'Why?',
    'unlock.why': 'Your entries are encrypted with your password. On a new device, after clearing browser data, or if you just came from the link in the email, Logbuch does not know the key yet – your password opens them again (or, for a new account, sets up the encryption).',
    'unlock.unlocking': 'One moment …',
    'unlock.unlock': 'Continue',
    'unlock.wrongPassword': 'Incorrect password.',
    'unlock.failed': 'That did not work.',
    'unlock.keyChanged': 'Your encryption was set up again on another device (password reset without a spare key). Please enter your current password.',
    'ariaLabel.deleteEntry': 'Delete entry',
    'ariaLabel.noValue': 'no value',
    'ariaLabel.prevDay': 'Previous day',
    'ariaLabel.nextDay': 'Next day',
    'ariaLabel.prevWeek': 'Previous week',
    'ariaLabel.nextWeek': 'Next week',
    'ariaLabel.prevMonth': 'Previous month',
    'ariaLabel.nextMonth': 'Next month',
    'ariaLabel.prevYear': 'Previous year',
    'ariaLabel.nextYear': 'Next year',
    'ariaLabel.reorder': 'Change order',
    'ariaLabel.menu': 'Menu',
    'ariaLabel.back': 'Back',
    'ariaLabel.dayCell': '{date}, {score}',
    'ariaLabel.moveUp': 'Move up',
    'ariaLabel.moveDown': 'Move down',
    'common.noData': 'no data',
    'computedInfo.avgOf': 'avg. of {names} ({filled}/{total} entered today)',
    'computedInfo.aggOf': '{agg} of {names} ({filled}/{total} entered today)',
    'computedInfo.durationOf': 'Duration from “{from}” to “{to}”',
    'computedInfo.sinceLast': 'since the last “{name}” ({which})',
    'computedInfo.sinceStart': 'since the start of “{name}” ({which})',
    'since.today': 'today',
    'since.oneDay': '1 day',
    'since.days': '{n} days',
    'since.dayN': 'Day {n}',
    'since.atLeast': 'from {n}',
    'aggregate.sum': 'Sum',
    'aggregate.avg': 'Average',
    'aggregate.min': 'Minimum',
    'aggregate.max': 'Maximum',
    'manage.computedAggregate': '{agg} of: {names}',
    'manage.computedDuration': 'Duration from {from} to {to}',
    'manage.computedSinceLast': 'Days since the last entry in {name}',
    'manage.computedSinceStart': 'Days since the start of {name}',
    'habitForm.computedType': 'Kind of calculation',
    'habitForm.computedType.scale': 'Scales',
    'habitForm.computedType.number': 'Number values',
    'habitForm.computedType.duration': 'Duration',
    'habitForm.computedType.since': 'Days since',
    'habitForm.sinceSource': 'Which field?',
    'habitForm.sinceValues': 'Which entries count?',
    'habitForm.sinceAtLeast': 'Counts from the value',
    'habitForm.sinceMode': 'How to count?',
    'habitForm.sinceMode.last': 'Since the last time',
    'habitForm.sinceMode.start': 'Since the start',
    'habitForm.sinceNote.last': 'Shows how many days have passed since the last matching entry – “today” on the day itself. E.g. days since your last workout.',
    'habitForm.sinceNote.start': 'Counts from the first day of a run of matching entries; that day is day 1. Gaps of up to a week still belong to the run (e.g. a forgotten day); only after that does a new one start. This is how e.g. a “Period” field gives you the cycle day.',
    'habitForm.noSinceCandidates': 'This needs a field with a scale or a number.',
    'habitForm.durationChoose': 'Please choose',
    'habitForm.durationFrom': 'From (e.g. went to bed)',
    'habitForm.durationTo': 'To (e.g. got up)',
    'habitForm.durationNote': 'The duration appears on the day of the “to” time and reaches back to the last “from” time before it – across midnight, too.',
    'habitForm.noDurationCandidates': 'This needs two time fields, e.g. “went to bed” and “got up”.',
    'habitForm.aggregate': 'Per day, calculate as',
    'habitForm.computedUnitNote': 'Only fields with the same unit can be combined – otherwise the result would be wrong (e.g. km + m).',
    'habitForm.noNumberComputedCandidates': 'No number fields available yet that can be combined.',
    'habitForm.error.computedUnitMismatch': 'The selected fields have different units.',
    'habitForm.error.durationMembers': 'Please choose two different time fields for “From” and “To”.',
    'habitForm.error.sinceSource': 'Please choose a field and which entries count.',
    'numberBox.last': 'last: {value} ({date})',
    'timeBox.now': 'Now',
    'timeBox.aria': '{name}: {time} – change',
    'timeBox.ariaEmpty': '{name}: no time yet – enter one',
    'timeBox.ariaNextDay': '{name}: {time} after midnight ({day}) – change',
    'timePicker.addAria': '{n} minutes later',
    'timePicker.addLabel': '+{n} min',
    'timePicker.dayLabel': 'Which day?',
    'timePicker.sameDay': 'on {day}',
    'timePicker.nextDay': 'after midnight ({day})',
    'timePicker.clear': 'Delete time',
    'timePicker.apply': 'Set',
    'today.jumpToday': 'Jump to today',
    'today.pickDate': 'Choose date',
    'today.noFields': 'No fields created yet.',
    'today.resetDay': 'Reset day',
    'today.fieldOptions': 'Options for {name}',
    'today.dayOptions': 'Options for this day',
    'today.sectionOptions': 'Options for group {name}',
    'note.add': 'Add note',
    'note.edit': 'Edit note',
    'note.editPrefix': 'Edit note:',
    'note.labelField': 'Note on {name}',
    'note.labelDay': 'Note for the day',
    'note.labelSection': 'Note on the group {name}',
    'note.addDay': 'Add a note for the day …',
    'ariaLabel.withNote': ', with note',
    'resetConfirm.title': 'Reset day?',
    'resetConfirm.body': 'All values and notes from {date} will be deleted. This cannot be undone.',
    'resetConfirm.confirm': 'Reset',
    'regenKeyConfirm.title': 'Create a new spare key?',
    'regenKeyConfirm.body': 'Your current spare key will <strong>stop working</strong> – including the one you wrote down or saved. Only do this if you lost it or someone else might know it.',
    'regenKeyConfirm.confirm': 'Create new key',
    'logoutConfirm.title': 'Sign out?',
    'logoutConfirm.body': 'This device will then stop receiving reminders. To sign in again you’ll need your password. Your entries are kept.',
    'leaveForm.title': 'Discard changes?',
    'leaveForm.bodyField': 'Your changes to this field aren’t saved yet. If you leave now, they’ll be lost.',
    'leaveForm.bodyGroup': 'Your changes to this group aren’t saved yet. If you leave now, they’ll be lost.',
    'leaveForm.stay': 'Keep editing',
    'leaveForm.discard': 'Discard',
    'notice.fieldArchived': 'Field archived. You can reactivate it anytime under “Manage fields”.',
    'common.archived': 'archived',
    'global.rangeNote': 'Since {since} · {count} days with entry',
    'global.noEntries': 'No entries yet.',
    'stats.empty': 'Soon you will see here how your days are going – once you have entered a few days.',
    'stats.legend.title': 'What do the colors and numbers mean?',
    'stats.legend.bad': 'less good',
    'stats.legend.good': 'good',
    'stats.legend.week': 'Each box shows how good the value was that day – measured by what you set under “Valuation” for the field (with “Low values desirable”, little is green). Empty: nothing entered. Hatched: not planned that day. Ø: for fields with two steps (e.g. yes/no), on how many of the days you entered it was the good value (2/5), for scales the average as a dot on the scale (left the first, right the last value); calculated fields in percent. Tap it to see it spelled out.',
    'stats.legend.stats': 'In the calendar, each day shows the day color: the average of all rated fields. Below, for each field: for fields with two steps (e.g. yes/no), on how many of the days you entered it was the good value, otherwise the average and in parentheses on how many days you entered something. Calculated fields in percent – 100 % would be the best value every day.',
    'stats.yesNoDays': 'on {n} of {total} days',
    'stats.scaleOf': 'Ø {value} of {max}',
    'stats.scaleRange': 'Ø {value} ({min} to {max})',
    'stats.yesNoDaysLabel': 'on {n} of {total} days “{label}”',
    'stats.yesNoDays.week': 'in {n} of {total} weeks',
    'stats.yesNoDaysLabel.week': 'in {n} of {total} weeks “{label}”',
    'stats.yesNoDays.month': 'in {n} of {total} months',
    'stats.yesNoDaysLabel.month': 'in {n} of {total} months “{label}”',
    'stats.yesNoDays.year': 'in {n} of {total} years',
    'stats.yesNoDaysLabel.year': 'in {n} of {total} years “{label}”',
    'periodStats.week': 'Weekly fields',
    'periodStats.month': 'Monthly fields',
    'periodStats.year': 'Yearly fields',
    'stats.legend.common': 'Fields without a rating only show whether something was entered. The stripe pattern (can be turned off in the settings) shows the same as the color – for everyone who has trouble telling red and green apart.',
    'global.title': 'Overall',
    'numberChart.meta': 'last: {last} · avg. {avg} · {count}×',
    'numberChart.metaLast': 'last: {last}',
    'numberChart.metaSum': 'total {sum} · avg. {avg} per {per} · {count}×',
    'numberChart.per.day': 'day',
    'numberChart.per.week': 'week',
    'numberChart.per.month': 'month',
    'numberChart.per.year': 'year',
    'numberChart.tooFewValues': 'Not enough values yet for a chart.',
    'numberChart.noValues': 'No values yet.',
    'numberChart.trend.up': 'rising',
    'numberChart.trend.down': 'falling',
    'numberChart.trend.flat': 'steady',
    'numberChart.summary': '{name}: {count} entries, last {last}, average {avg}, range {min} to {max}, trend {trend}.',
    'numberChart.summaryLast': '{name}: last {last}.',
    'numberChart.withNotes': '{count} of them with a note.',
    'habitForm.goalLabel': 'Goal for the statistics: fully reached from what percentage?',
    'habitForm.goalYesNoLabel': 'Goal for the statistics: on how many of 7 days “{label}”?',
    'habitForm.goalEveryDay': 'every day',
    'habitForm.goalDays': 'on {n} of 7 days',
    'habitForm.goalYesNoLabel.week': 'Goal for the statistics: in how many of 4 weeks “{label}”?',
    'habitForm.goalYesNoLabel.month': 'Goal for the statistics: in how many of 12 months “{label}”?',
    'habitForm.goalYesNoLabel.year': 'Goal for the statistics: in how many of 5 years “{label}”?',
    'habitForm.goalEveryDay.week': 'every week',
    'habitForm.goalEveryDay.month': 'every month',
    'habitForm.goalEveryDay.year': 'every year',
    'habitForm.goalDays.week': 'in {n} of 4 weeks',
    'habitForm.goalDays.month': 'in {n} of 12 months',
    'habitForm.goalDays.year': 'in {n} of 5 years',
    'habitForm.goalValueLabel': 'Goal for the statistics: when is it fully reached?',
    'habitForm.goalFrom': 'from avg. {value}',
    'habitForm.goalUpTo': 'up to avg. {value}',
    'habitForm.goalLabelAt': '“{label}” ({value})',
    'habitForm.goalBetween': 'between {a} and {b}',
    'habitForm.goalNote': 'Applies to Week, Month, Year and Overall – “Today” stays unchanged.',
    'habitForm.goalExplain': 'From your goal on, the field is fully green in the overviews – for averages from this value, for days from this number. Days on which you entered something count.',
    'habitForm.ownLabels': 'Use custom labels',
    'habitForm.labelForStep': 'Label for step {step}',
    'habitForm.preview': 'Preview',
    'habitForm.previewNote': 'Try it out – nothing is saved here.',
    'habitForm.display': 'Display',
    'habitForm.displayLockedExplain': 'Pure display setting, does not change existing values – that is why it stays editable here despite the locked range.',
    'habitForm.buttons': 'Buttons',
    'habitForm.slider': 'Slider',
    'habitForm.numberOfSteps': 'Number of steps',
    'habitForm.stepsExplain': 'In questionnaires, 5 to 7 steps have proven themselves – more gradations rarely make answers more accurate. That is why buttons and custom labels go up to 7. For a finer “roughly how much”, there is the slider without custom labels (up to 100).',
    'habitForm.sliderRangeExplain': 'The slider never shows a min/max label while entering a value (only here in management).',
    'habitForm.rangeLocked': '{steps} steps ({min} to {max})',
    'habitForm.period': 'How often do you fill this in? Once a …',
    'habitForm.period.day': 'Day',
    'habitForm.period.week': 'Week',
    'habitForm.period.month': 'Month',
    'habitForm.period.year': 'Year',
    'habitForm.periodHint.week': 'One value per week, can be filled in on any day of the week – at the bottom of “Today” under “This week”.',
    'habitForm.periodHint.month': 'One value per month, can be filled in on any day of the month – at the bottom of “Today” under “This month”.',
    'habitForm.periodHint.year': 'One value per year, can be filled in on any day of the year – at the bottom of “Today” under “This year”.',
    'habitForm.periodReminderDay': 'Reminder on',
    'habitForm.periodReminderNote': 'At the default time or your own reminder time – only if nothing has been entered by then.',
    'habitForm.numbers': 'Numbers',
    'habitForm.numbersRange': '{min} to {max}',
    'habitForm.numbersExplain': 'Some scales usually start at 0, e.g. pain or stress from 0 (“not at all”) to 10.',
    'habitForm.showValueWhileEntering': 'Show current value while entering',
    'habitForm.goalDirection': 'Valuation',
    'habitForm.goalDirectionExplain': 'Determines what counts as "good" and is colored green accordingly. Usually "high values" (e.g. exercise, healthy eating). "Low values" suits things you want less of (e.g. consumption of something you want to reduce). "No valuation" simply tracks the value without red/green coloring - e.g. for things you want to observe but not judge.',
    'habitForm.highIsGood': 'High values desirable',
    'habitForm.lowIsGood': 'Low values desirable',
    'habitForm.noValuation': 'No valuation',
    'habitForm.unit': 'Unit (optional)',
    'habitForm.unitPlaceholder': 'e.g. kg',
    'habitForm.members': 'Members (at least 2 fields)',
    'habitForm.noComputedCandidates': 'No scale fields available yet that can be combined.',
    'habitForm.ownReminderTime': 'Custom reminder time',
    'habitForm.defaultReminderNote': 'Without a custom time, the default reminder time applies (currently {time}, changeable in the settings).',
    'habitForm.reminderAdd': '+ Another time',
    'habitForm.reminderRemove': 'Remove',
    'habitForm.reminderTimesNote': 'At each time you’re only reminded while the field is still empty that day.',
    'habitForm.reminderBelow': 'if less than',
    'habitForm.counterReminderNote': 'With a number, Logbuch only reminds you if the counter is below it at that time, e.g. at 9 am if less than 1, at 9 pm if less than 2. Without a number it reminds you at every time.',
    'habitForm.error.reminderBelowNumber': 'Please enter a number greater than 0 for “if less than”.',
    'habitForm.error.reminderBelowAll': 'Please enter a number for “if less than” at every reminder time – or leave all of them empty.',
    'habitForm.error.reminderBelowOrder': 'For “if less than”, a later time can’t have a smaller number than an earlier one.',
    'habitForm.sectionReminderNote': 'Without a custom time, handled by the group “{name}”: shared reminder at {time}.',
    'habitForm.title.editGroup': 'Edit group',
    'habitForm.title.newGroup': 'New group',
    'habitForm.title.editField': 'Edit field',
    'habitForm.title.newField': 'New field',
    'habitForm.convertCounter': 'Convert to counter …',
    'habitForm.convertCounterDo': 'Convert',
    'habitForm.convertHint.number': 'Rather count up with “+” than type the number? As a counter, all previous values are kept.',
    'habitForm.convertHint.scale': 'This scale starts at 0 – does it actually count something? As a counter, the values are kept as numbers and you count up with “+”.',
    'habitForm.convertConfirm.number': 'Really convert? Previous values are kept. New: from today on, a day without tapping counts as 0; earlier empty days stay empty. You cannot convert back.',
    'habitForm.convertConfirm.scale': 'Really convert? Previous values are kept as numbers; the step labels and the valuation are dropped. From today on, a day without tapping counts as 0; earlier empty days stay empty. You cannot convert back.',
    'habitForm.convertDone': '“{name}” is now a counter.',
    'habitForm.labelsLockedWarn': 'New labels also apply to all previous entries. If old entries should move to a different step, use “Change steps” above.',
    'habitForm.goodChangedWarn': 'This also applies retroactively: all previous entries will be colored differently.',
    'stepEdit.title': 'Change steps',
    'stepEdit.hint': 'Since there are entries already, you change the number of steps here – and decide yourself what happens to the previous values.',
    'stepEdit.open': 'Change steps …',
    'stepEdit.intro': 'You decide yourself what happens to the previous entries. Think about what an old value meant back then: a 3 on a scale up to 3 is not the same as a 3 on a scale up to 5.',
    'stepEdit.newSteps': 'New number of steps',
    'stepEdit.newLabels': 'Labels of the new steps',
    'stepEdit.mapTitle': 'What happens to the previous entries?',
    'stepEdit.presetExplain': '“Spread evenly”: the lowest step stays the lowest, the highest stays the highest, everything in between moves proportionally. “Keep numbers”: every entry keeps its number; anything above the new highest step lands on the highest. Below, you can assign each step individually or remove its entries.',
    'stepEdit.preset.spread': 'Spread evenly',
    'stepEdit.preset.same': 'Keep numbers',
    'stepEdit.valueLabel': '“{label}” ({value})',
    'stepEdit.count': '{count}×',
    'stepEdit.mapAria': 'Previously {value} ({count}×) becomes',
    'stepEdit.remove': 'Remove',
    'stepEdit.summary.changedOne': '1 entry gets a different value.',
    'stepEdit.summary.changedMany': '{count} entries get a different value.',
    'stepEdit.summary.removedOne': '1 entry will be removed.',
    'stepEdit.summary.removedMany': '{count} entries will be removed.',
    'stepEdit.summary.merged': 'Several old steps land on the same new one and can no longer be told apart afterwards.',
    'stepEdit.summary.none': 'All previous entries keep their number.',
    'stepEdit.safety': 'The old values are kept as a backup. You can undo this here until you enter something new in this field.',
    'stepEdit.apply': 'Change …',
    'stepEdit.fieldNow': '“{name}” currently has {steps} steps.',
    'stepEdit.confirmTitle': 'Really change?',
    'stepEdit.confirm': '“{name}” gets {to} instead of {from} steps, and all previous entries are converted the way you assigned them.',
    'stepEdit.confirmDo': 'Change now',
    'stepEdit.progress': 'Changing … {done} of {total} days. Keep Logbuch open until it is done.',
    'stepEdit.done': '“{name}” now has {steps} steps.',
    'stepEdit.failed': 'The change is not finished yet, probably the connection dropped briefly. It continues the next time you open Logbuch – or tap “Continue change” in the field.',
    'stepEdit.pending': 'The change of this field is not finished yet.',
    'stepEdit.resume': 'Continue change',
    'stepEdit.resumed': 'The change of “{name}” is finished.',
    'stepEdit.last': 'Changed from {from} to {to} steps on {date}.',
    'stepEdit.undo': 'Undo …',
    'stepEdit.undoTitle': 'Undo the change?',
    'stepEdit.undoConfirm': '“{name}” gets {from} steps again, and all entries get back their value from before the change.',
    'stepEdit.undoDo': 'Restore',
    'stepEdit.undoDone': '“{name}” has {steps} steps again.',
    'stepEdit.error.nothing': 'This is the same scale as before – there is nothing to change.',
    'typeEdit.title': 'Change type',
    'typeEdit.hint': 'You can change the type despite existing entries – and decide yourself what happens to the previous values.',
    'typeEdit.open': 'Change type …',
    'typeEdit.blocked': 'You can’t change the type right now: the field is part of “{computed}”. Remove it there first.',
    'typeEdit.fieldNow': '“{name}” is currently of type {kind}.',
    'typeEdit.intro': 'You decide what happens to the previous entries. You can change the suggestion for every value.',
    'typeEdit.newKind': 'New type',
    'typeEdit.steps': 'Number of steps',
    'typeEdit.preset.round': 'Round',
    'typeEdit.preset.spread': 'Spread evenly',
    'typeEdit.presetExplain': '“Round”: every value becomes the nearest whole number; anything outside the scale lands on the lowest or highest step. “Spread evenly”: the smallest entered value becomes the lowest step, the largest the highest, everything in between moves proportionally.',
    'typeEdit.emptyRemoves': 'Leave empty = remove these entries.',
    'typeEdit.manyValues': 'There are {count} different values (from {lo} to {hi}) – too many to assign each one. They are all converted by the chosen rule.',
    'typeEdit.manyValuesText': 'There are {count} different values – they all become text the way they are shown now, e.g. “{example}”.',
    'typeEdit.summary.merged': 'Several previous values land on the same step and can’t be told apart afterwards.',
    'typeEdit.loss.text': 'As text, the entries no longer count towards the day color, averages and goals.',
    'typeEdit.loss.scaleToNumber': 'The step labels and the rating are dropped; you can set a goal in the field afterwards.',
    'typeEdit.loss.numberToScale': 'Unit and goal are dropped; check in the field afterwards whether high values are good or bad.',
    'typeEdit.loss.counter': 'Days without an entry then no longer count as 0, and “if less than” for the reminders is dropped.',
    'typeEdit.loss.notes': 'Notes on individual days stay saved, but a text field doesn’t show them.',
    'typeEdit.apply': 'Convert …',
    'typeEdit.confirm': '“{name}” changes from {from} to {to}, and all previous entries are converted the way you set it up.',
    'typeEdit.confirmTitle': 'Really convert?',
    'typeEdit.confirmDo': 'Convert now',
    'typeEdit.done': '“{name}” is now of type {kind}.',
    'typeEdit.last': 'Changed from {from} to {to} on {date}.',
    'typeEdit.undoTitle': 'Undo the conversion?',
    'typeEdit.undoConfirm': '“{name}” becomes type {from} again, and all entries get back their value from before the conversion.',
    'typeEdit.undoDone': '“{name}” is of type {kind} again.',
    'typeEdit.error.number': 'Please enter a number everywhere – or leave it empty to remove the entries.',
    'typeEdit.error.dirty': 'Save your other changes to this field first (or discard them) – then you can change the type.',
    'habitForm.lockedNote': 'This field already has entries – so how often you enter it is fixed. Change type and steps with their own buttons, because the previous entries are converted along with them.',
    'habitForm.lockedNoteText': 'This field already has entries – so the field type and how often you enter it are fixed. For a different type: archive and create a new one.',
    'habitForm.name': 'Field name',
    'habitForm.fieldType': 'Field type',
    'habitForm.kindScale': 'Scale',
    'habitForm.kindNumber': 'Number',
    'habitForm.kindText': 'Text',
    'habitForm.kindCounter': 'Counter',
    'habitForm.kindTime': 'Time',
    'habitForm.entryMode': 'How do you enter it?',
    'habitForm.entryMode.type': 'Type it in',
    'habitForm.entryMode.count': 'Count up (+)',
    'habitForm.numberGoal': 'Goal for the statistics',
    'habitForm.numberGoal.none': 'None',
    'habitForm.numberGoal.min': 'At least',
    'habitForm.numberGoal.max': 'At most',
    'habitForm.numberGoalNote': 'From the goal on, the day is green in Week, Month, Year and Overall, the further away, the redder. “Today” stays unchanged.',
    'habitForm.error.numberGoal': 'Please enter a number as the goal (greater than 0 for “At least”).',
    'numberGoal.min': 'Goal: at least {value}',
    'numberGoal.max': 'Goal: at most {value}',
    'stats.goalHits': 'Goal reached on {n} of {total} days',
    'stats.goalHits.week': 'Goal reached in {n} of {total} weeks',
    'stats.goalHits.month': 'Goal reached in {n} of {total} months',
    'stats.goalHits.year': 'Goal reached in {n} of {total} years',
    'habitForm.counterNote': 'Counts up with “+”, for example cigarettes or glasses of water – every new day (or period) starts at 0. Not tapping counts as 0, so there is no reminder for it.',
    'habitForm.counterStep': 'Step per tap',
    'habitForm.counterStepNote': '“+” and “−” change the value by this much, e.g. 1 or 0.5.',
    'habitForm.error.counterStep': 'The step must be a number greater than 0.',
    'counter.less': 'Decrease by {step}',
    'counter.more': 'Increase by {step}',
    'today.goalOf': 'of {target}',
    'charCount.sr': '{n} of {max} characters',
    'habitForm.kindComputed': 'Calculated',
    'habitForm.days': 'On which days?',
    'habitForm.days.hint': 'Only for fixed days, like weighing yourself on Mondays. For things you do on some days and not on others (e.g. sport), keep all days – “No” is an entry too.',
    'habitForm.days.explain': 'On the other days Logbuch won’t remind you of it, and it sits at the bottom of “Today” under “Not planned today”. You can still fill it in there.',
    'schedule.summary.everyDays': 'every {n} days',
    'habitForm.days.modeWeekdays': 'Weekdays',
    'habitForm.days.modeInterval': 'Every few days',
    'habitForm.days.every': 'Every',
    'habitForm.days.everyUnit': 'days',
    'habitForm.days.everyStart': 'First time on',
    'habitForm.days.intervalHint': 'For things at a fixed interval, e.g. watering the plants every 3 days. On the days in between Logbuch won’t remind you, and the field sits in “Today” under “Not planned today”.',
    'habitForm.error.scheduleEvery': 'Please enter a whole number from 2 to 365 for “Every … days”.',
    'habitForm.error.scheduleStart': 'Please choose when it’s due for the first time.',
    'habitForm.schedule.lastDay': 'Last day',
    'habitForm.schedule.dayAria': 'Day',
    'habitForm.schedule.monthAria': 'Month',
    'habitForm.error.scheduleNoDays': 'Please select at least one weekday.',
    'habitForm.part.what': 'What?',
    'habitForm.part.entry': 'How do you enter it?',
    'habitForm.part.when': 'When?',
    'habitForm.part.stats': 'Statistics',
    'habitForm.part.group': 'Group',
    'habitForm.kindScaleNote': 'How much – e.g. mood 1–5',
    'habitForm.kindNumberNote': 'Measurement or amount – e.g. weight, glasses',
    'habitForm.kindTextNote': 'A few words – e.g. What am I grateful for today?',
    'habitForm.kindTimeNote': 'A point in time – e.g. went to bed, got up',
    'habitForm.kindComputedNote': 'Calculates from other fields – e.g. wellbeing from mood and energy, or days since your last workout',
    'habitForm.summary': 'For week, month and year, add up as',
    'habitForm.summary.avg': 'Average',
    'habitForm.summary.sum': 'Total',
    'habitForm.summary.noteAvg': 'Suits measurements like weight: “avg. 68.2 kg”.',
    'habitForm.summary.noteSum': 'Suits amounts like working hours: “total 38 h”, plus the average per day.',
    'habitForm.entryPreviewNote': 'This is how it looks in “Today”.',
    'habitForm.entryPreviewAria.number': 'Preview: a box where you type the number',
    'habitForm.entryPreviewAria.counter': 'Preview: the number with “−” and “+” buttons',
    'habitForm.entryPreviewAria.time': 'Preview: time field, still empty',
    'today.unplanned': 'Not planned today ({count})',
    'today.nothingPlanned': 'No fields are planned for today.',
    'day.today': 'Today',
    'day.yesterday': 'Yesterday',
    'today.openField': '(not filled in yet)',
    'today.sectionHasOpen': '(has fields not filled in yet)',
    'today.sectionDone': '✓ done',
    'period.week.current': 'This week',
    'period.week.other': 'Week',
    'period.month.current': 'This month',
    'period.month.other': 'Month',
    'period.year.current': 'This year',
    'period.year.other': 'Year',
    'today.statusDone': 'All filled in',
    'today.statusProgress': '{done} of {total} filled in',
    'todayIntro.label': 'Quick explanation',
    'todayIntro.enter': '<strong>How to enter things:</strong> tap a value – tap it again to remove it. The green dot after a name shows what is still open today.',
    'todayIntro.days': '<strong>Other days:</strong> swipe left or right – or tap the arrows at the top – to fill in another day.',
    'todayIntro.menu': '⋮ <strong>More:</strong> the three dots in front of a field let you add a note or edit it. Under <strong>☰ Menu</strong> at the top right you find your fields, the settings and explanations for everything.',
    'todayIntro.done': 'Got it',
    'habitForm.textNote': 'For questions like “What am I grateful for today?”: “Today” shows a text box for it that saves automatically. Not part of the statistics, but shown there as a list to read back.',
    'habitForm.timeNote': 'In “Today” you tap the field and pick the time. If it’s still empty, the current time is already set; “+5 min” etc. move it a bit later, e.g. when you’re putting your phone away already. If the time is after midnight, the weekday shows next to it. Two times plus a calculated “Duration” field give you e.g. how long you slept.',
    'habitForm.kindMulti': 'Multiple choice',
    'habitForm.kindMultiNote': 'Tick several – e.g. what happened today: workout, argument, coffee',
    'habitForm.multiNote': 'In “Today” you tap every option that applies – or “none of these”. In the evaluation, each option gets its own row.',
    'habitForm.multiOptions': 'Options',
    'habitForm.multiOptionAria': 'Option {n}',
    'habitForm.multiAdd': '+ Option',
    'habitForm.multiRemove': 'Remove option {n}',
    'habitForm.multiHide': 'Hide',
    'habitForm.multiShow': 'Show',
    'habitForm.multiUsedNote': 'Options you have already chosen can be renamed or hidden, but not removed – otherwise they would be missing from your previous entries. Hidden ones no longer appear in “Today”, but still do in the evaluation.',
    'habitForm.lockedNoteMulti': 'This field already has entries – so its type is fixed.',
    'habitForm.error.multiEmpty': 'Please fill in or remove every option.',
    'habitForm.error.multiDuplicate': 'Two options have the same name.',
    'habitForm.error.multiMin': 'You need at least two options that are not hidden.',
    'today.multiNone': 'none of these',
    'textReview.countOne': '1 entry',
    'textReview.countMany': '{count} entries',
    'common.saving': 'Saving…',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'manage.deleteConfirmFinal': 'Yes, delete permanently',
    'manage.deleteWarning': 'There are historical entries – no longer usable in the app after deletion.',
    'manage.reminderAt': 'Reminder {time}',
    'manage.computedMembers': 'avg. of: {names}',
    'manage.archive': 'Archive',
    'manage.reactivate': 'Reactivate',
    'manage.archivedSectionLabel': 'Archived',
    'manage.archiveNote': 'Archiving hides a field: its values are kept and you can reactivate it anytime. To delete it for good, find it afterwards under “Archived” below.',
    'manage.computedTag': 'Calculated',
    'manage.sectionTag': 'Group',
    'sectionForm.explain': 'A group arranges fields under a heading – in “Today” and in the statistics. Each field can be in at most one group.',
    'sectionForm.members': 'Fields in this group',
    'sectionForm.inOtherGroup': '(in “{name}”)',
    'sectionForm.noFields': 'No fields yet.',
    'manage.sectionName': 'Group name',
    'manage.sectionNamePlaceholder': 'e.g. Health',
    'manage.sectionEmpty': 'Still empty – add fields via “Edit”.',
    'manage.period.week': 'weekly',
    'manage.period.month': 'monthly',
    'manage.period.year': 'yearly',
    'manage.groupTip': 'Lots of fields? Sort them into groups by time of day, e.g. “Morning” and “Evening”. Then you fill in each block in one go, and each group can remind you at its own time.',
    'manage.groupTipHide': 'Hide',
    'sectionForm.collapse': 'In “Today”',
    'sectionForm.collapse.done': 'Collapse when done',
    'sectionForm.collapse.manual': 'Collapse by hand only',
    'sectionForm.collapse.start': 'Always start collapsed',
    'sectionForm.collapse.never': 'Not collapsible (heading only)',
    'sectionForm.collapseNote': 'Done means: everything filled in. The group only collapses the next time you open it, never while you’re entering values.',
    'sectionForm.ownReminderTime': 'Custom reminder time for this group',
    'sectionForm.reminderExplain': 'The fields in this group are then no longer reminded at the default time, but together at this time – one notification for the whole group as soon as something in it is missing. Fields with their own reminder time keep it.',
    'sectionForm.defaultReminderNote': 'Without a custom time, the fields are reminded at the default reminder time (currently {time}).',
    'manage.sectionDeleteWarning': 'Delete group? The fields in it are kept.',
    'manage.sectionDeleteNotesWarning': 'Your notes on this group will be deleted too.',
    'manage.error.sectionNameRequired': 'Please enter a name for the group.',
    'habitForm.section': 'Group',
    'habitForm.sectionNone': 'No group',
    'manage.hiddenInStats': 'hidden in statistics',
    'habitForm.showInStats': 'Show in statistics',
    'habitForm.showInStatsNote': 'Off: only appears in “Today”, not in the week, month, year, and overall views – e.g. if a calculated field made from it is enough for you. It still counts towards the day’s color.',
    'habitForm.more': 'More settings',
    'habitForm.moreSub': 'Days, reminder time, statistics – you can also change these later',
    'habitForm.moreSubPeriod': 'Goal, reminder and more – you can change these later',
    'habitForm.computedExplain': 'A calculated field combines multiple fields into one live-calculated value – scales as an average, number fields e.g. as a sum, two times as the duration between them – or it counts the days since an entry. You cannot fill it in yourself.',
    'common.finish': 'Done',
    'common.close': 'Close',
    'menu.defaultReminderTime': 'Default reminder time',
    'menu.timezoneNote': 'Time zone: {tz} (follows your device)',
    'time.label': 'Time',
    'time.hour': 'Hour',
    'time.minute': 'Minute',
    'menu.summaryNotifications': 'Announce weekly and monthly summary',
    'menu.summaryNotificationsExplain': 'On Sundays and on the last day of the month, you get a notification at your default reminder time that your weekly or monthly summary is ready – but only if you have entered at least one day in that period. Tapping it opens the matching summary directly.',
    'tutorial.skip': 'Skip tutorial',
    'tutorial.navLabel': 'Tutorial navigation',
    'tutorial.skipConfirm.title': 'Skip tutorial?',
    'tutorial.skipConfirm.body': 'Sure – you can create fields anytime via menu → “Manage fields”.',
    'tutorial.skipConfirm.confirmButton': 'Yes, skip',
    'tutorial.hello.title': 'Welcome to Logbuch.',
    'tutorial.hello.body': 'Logbuch helps you jot down every day how you are doing and what you do – and over time see what does you good.',
    'tutorial.hello.privateTitle': 'Private.',
    'tutorial.hello.privateBody': 'Your entries are encrypted on your device. Not even I can read them.',
    'tutorial.hello.noPressureTitle': 'No pressure.',
    'tutorial.hello.noPressureBody': 'No points, no streaks, no guilt – a day without an entry is simply a day without an entry.',
    'tutorial.hello.yoursTitle': 'Yours.',
    'tutorial.hello.yoursBody': 'You decide what you track – there are no predefined fields.',
    'tutorial.hello.start': 'Let’s go',
    'tutorial.reminders.title': 'Should I remind you?',
    'tutorial.reminders.body': '<strong>I only get in touch when something is still missing for a day</strong> – and, if you like, once a week and month with your overview. Never ads, and you pick the time.',
    'tutorial.reminders.bodyField': '<strong>I only get in touch when something is still missing for a day</strong>, for example “{name}” – and, if you like, once a week and month with your overview. Never ads, and you pick the time.',
    'tutorial.reminders.whyTitle': 'Why at all?',
    'tutorial.reminders.whyBody': 'Logbuch becomes more meaningful the more regularly you enter things. And when you are tired in the evening, it is easy to forget.',
    'tutorial.reminders.permissionNote': 'Your device will ask for permission in a moment – tap “Allow” there.',
    'tutorial.reminders.yes': 'Yes, remind me',
    'tutorial.reminders.no': 'Rather not',
    'tutorial.reminders.laterNote': 'No problem – you can turn reminders on in the settings anytime.',
    'tutorial.reminders.activeTitle': '✓ Reminders are on.',
    'tutorial.reminders.timeLabel': 'At what time?',
    'tutorial.reminders.timeNote': 'Evenings often work well – the day is done by then. You can change this in the settings anytime.',
    'tutorial.reminders.iosNeedsInstall': 'On iPhone, reminders only arrive when Logbuch is on your home screen. You can do that anytime – even right now.',
    'tutorial.reminders.howInstall': 'How to put Logbuch on your home screen',
    'tutorial.field.title': 'What would you like to track?',
    'tutorial.field.intro': 'A <strong>field</strong> is one thing you enter every day – for example your mood or whether you exercised. Create your first one now; this form is the same one you will use later for more fields.',
    'tutorial.examples.title': 'See examples',
    'tutorial.examples.intro': 'This is how fields will look in “Today” later – just to look at:',
    'tutorial.examples.mood': 'Mood',
    'tutorial.examples.moodNote': 'Mood: a scale from 1 to 5, high values are good – the better, the greener.',
    'tutorial.examples.sport': 'Exercise',
    'tutorial.examples.sportNote': 'Exercise: yes or no – a scale with two steps.',
    'tutorial.examples.water': 'Water',
    'tutorial.examples.waterNote': 'Water: a number you count up – tap “+” once for every glass.',
    'tutorial.examples.grateful': 'Grateful for',
    'tutorial.examples.gratefulNote': 'Grateful for: text, a free answer in your own words.',
    'tutorial.examples.gratefulValue': 'Coffee in the sun',
    'tutorial.examples.no': 'No',
    'tutorial.examples.yes': 'Yes',
    'tutorial.form.nameIdeas': 'Short names fit best in the overview. For example: <strong>Sleep</strong> – how well did I sleep? · <strong>Mood</strong> – how am I today? · <strong>Exercise</strong> – yes or no? · <strong>Weight</strong> – in kg',
    'tutorial.form.tipKindTitle': 'Tip on the field type',
    'tutorial.form.tipKind': 'The field type decides how you enter things: <strong>Scale</strong> for “how much” (e.g. mood 1–5), <strong>Number</strong> for measurements (e.g. hours of sleep or glasses of water), <strong>Text</strong> for a few words.',
    'tutorial.form.tipKindMoreTitle': 'And for yes/no questions?',
    'tutorial.form.tipKindMore': 'Choose a scale with 2 steps and turn on “Custom labels” – then type “No” and “Yes”.',
    'tutorial.form.tip.scale': 'Set how many steps there are and whether values appear as buttons or a slider. With <strong>“Custom labels”</strong> you give the steps names instead of numbers (e.g. bad – okay – good). In the <strong>preview</strong> you can try out right away how it looks in “Today”.',
    'tutorial.form.tipScaleMoreTitle': 'What does “Valuation” mean?',
    'tutorial.form.tipScaleMore': '“Valuation” decides what is good – the colors in the statistics follow it (green = good). With “No valuation” things are just recorded, without good or bad.',
    'tutorial.form.tip.number': 'Add a unit if you like (e.g. kg). Then you simply enter a number.',
    'tutorial.form.tip.text': 'In “Today” this field gets a text box that saves by itself.',
    'tutorial.form.tip.computed': '',
    'tutorial.form.create': 'Create field',
    'tutorial.field.whyTitle': 'Why just one for now?',
    'tutorial.field.whyBody': 'Few fields means: quickly filled in. That lasts longer than a long questionnaire – you can add more anytime.',
    'tutorial.done.title': 'Your first field is set.',
    'tutorial.done.titleMore': 'Your {count} fields are set.',
    'tutorial.done.body': 'You can add one or two more or leave it at that for now. <strong>Tip: better start small and expand later.</strong>',
    'tutorial.done.start': 'Continue',
    'tutorial.done.addMore': 'Add another field',
    'installGate.title': 'First, a home for Logbuch',
    'installGate.body': 'Logbuch does not come from an app store – it is a web page that you <strong>put on your home screen like an app</strong>. Then you open it with one tap – without a browser around it.',
    'installGate.whyTitle': 'Why?',
    'installGate.whyIos': 'On iPhone, reminders only arrive when Logbuch is on your home screen – that is how Apple set it up.',
    'installGate.whyAndroid': 'Then Logbuch opens like an app – without browser bars, with one tap on your home screen instead of looking for it in the browser every time.',
    'installGate.installButton': 'Install Logbuch',
    'installGate.manualFallback': 'Doesn’t work? Here’s how to do it by hand',
    'installGate.otherBrowser': 'With this browser, Logbuch usually becomes just a shortcut instead of an app of its own. That works too – but reminders then depend on the notification settings {browser}. Prefer an app of its own? Then install Logbuch via Chrome.',
    'installGate.browserOpera': 'of Opera',
    'installGate.browserFirefox': 'of Firefox',
    'installGate.browserOther': 'of your browser',
    'installGate.openInChrome': 'Open in Chrome',
    'installGate.openInChromeNote': 'If that doesn’t work, open Chrome yourself and enter this address: <strong>{address}</strong>',
    'installGate.vary': 'Depending on your phone and browser this looks a little different and the entries are named slightly differently – look for something similar.',
    'installGate.installButtonNote': 'Your phone then asks once more – tap “Install” there.',
    'installGate.showPictures': 'Show with pictures',
    'installGate.afterwards': 'Afterwards the browser often closes by itself and you see the new Logbuch icon on your home screen. Tap it – that is where it continues.',
    'installGate.step.iosSafari1': 'Tap the share icon [share]. It is usually in the bar at the bottom; sometimes it is behind ••• .',
    'installGate.step.iosOther1': 'Tap the share icon [share] – usually at the top in the address bar.',
    'installGate.step.ios2': 'Look for “Add to Home Screen” in the list – you may need to scroll down a little.',
    'installGate.step.ios3': 'Confirm with “Add”.',
    'installGate.step.chrome1': 'Open the browser menu – usually three dots ⋮ at the top right.',
    'installGate.step.chrome2': 'Look for an entry like “Add to Home screen” or “Install app”.',
    'installGate.step.samsung1': 'Open the menu – usually ≡ at the bottom right.',
    'installGate.step.samsung2': 'Look for “Add page to” and then choose “Home screen” (or something similar).',
    'installGate.step.firefox1': 'Open the menu – usually three dots ⋮, at the top or bottom right.',
    'installGate.step.firefox2': 'Look for an entry like “Install” or “Add to Home screen”.',
    'installGate.step.other1': 'Open your browser menu – often three dots ⋮ at the top right or ≡ at the bottom right.',
    'installGate.step.other2': 'Look for an entry like “Add to Home screen”, “Install app” or “Add to …” – sometimes it is inside a sub-menu.',
    'installGate.step.opera1': 'Open the menu – usually three dots ⋮ at the top right.',
    'installGate.step.opera2': 'Tap “Add to …” and choose “Home screen” there (or something similar).',
    'installGate.step.confirm': 'Confirm if your phone asks (e.g. with “Install” or “Add”).',
    'installSketch.copy': 'Copy',
    'installSketch.readingList': 'Reading List',
    'installSketch.addHome': 'Add to Home Screen',
    'installSketch.bookmark': 'Bookmark',
    'installSketch.cancel': 'Cancel',
    'installSketch.add': 'Add',
    'installSketch.newTab': 'New tab',
    'installSketch.history': 'History',
    'installSketch.bookmarks': 'Bookmarks',
    'installSketch.addHomeAndroid1': 'Add to',
    'installSketch.addHomeAndroid2': 'Home screen',
    'installSketch.addPageTo1': 'Add page',
    'installSketch.addPageTo2': 'to',
    'installSketch.downloads': 'Downloads',
    'installSketch.ariaIosShare': 'Sketch: share icon in the bottom bar of Safari',
    'installSketch.ariaIosShareTop': 'Sketch: share icon at the top right of the address bar',
    'installSketch.ariaIosSheet': 'Sketch: list with “Add to Home Screen” highlighted',
    'installSketch.ariaIosAdd': 'Sketch: “Add” at the top right highlighted',
    'installSketch.ariaChromeMenu': 'Sketch: three dots at the top right next to the address bar',
    'installSketch.ariaChromeList': 'Sketch: menu with “Add to Home screen” highlighted',
    'installSketch.ariaSamsungMenu': 'Sketch: menu ≡ at the bottom right',
    'installSketch.ariaSamsungList': 'Sketch: menu with “Add page to” highlighted',
    'installSketch.or': 'or',
    'installSketch.settings': 'Settings',
    'installSketch.addHomeGeneric1': 'Add to Home screen',
    'installSketch.addHomeGeneric2': '/ Add to …',
    'installSketch.reload': 'Reload',
    'installSketch.share': 'Share',
    'installSketch.addTo': 'Add to …',
    'installSketch.zoom': 'Zoom',
    'installSketch.ariaGenericMenu': 'Sketch: the menu is usually at the top right or bottom right',
    'installSketch.ariaGenericList': 'Sketch: menu with an entry for the home screen highlighted',
    'installSketch.ariaOperaList': 'Sketch: menu with “Add to …” highlighted',
    'installSketch.permIosLine1': '“Logbuch” would like',
    'installSketch.permIosLine2': 'to send you notifications',
    'installSketch.permDeny': 'Don’t Allow',
    'installSketch.permAllow': 'Allow',
    'installSketch.permAndroidLine1': 'Allow Logbuch',
    'installSketch.permAndroidLine2': 'to send you',
    'installSketch.permAndroidLine3': 'notifications?',
    'installSketch.permAllowAndroid': 'Allow',
    'installSketch.permDenyAndroid': 'Don’t allow',
    'installSketch.ariaPerm': 'Sketch: your phone’s question, with “Allow” highlighted',
    'installGate.installed': '✓ Installed! Now open Logbuch via the new icon on your home screen and sign up there (or sign in).',
    'installGate.skip': 'I will stay in the browser for now',
    'installGate.skipNoteIos': 'That works too – you just will not get reminders. You can add Logbuch to your home screen anytime later.',
    'installGate.skipNote': 'That works too – you can add Logbuch anytime later.',
    'confirmLanding.title': 'Address confirmed!',
    'spamFeedback.question': 'Quick question: was the email from Logbuch in your spam folder?',
    'spamFeedback.yes': 'Yes, in spam',
    'spamFeedback.no': 'No',
    'spamFeedback.why': 'So I know whether I need to improve something. Only your answer is stored, with your email provider (e.g. gmail.com) – not your address or your account.',
    'spamFeedback.thanks': 'Thanks for letting me know!',
    'confirmLanding.body': 'You do not need this page anymore. <strong>Now open Logbuch again from its icon on your home screen</strong> and sign in there.',
    'confirmLanding.continueHere': 'Or continue here in the browser',
    'push.unsupported': 'Reminders are not supported by this browser.',
    'push.checking': 'Checking reminder status …',
    'push.active': 'Reminders active',
    'push.disable': 'Turn off',
    'push.none': 'No reminders',
    'push.enable': 'Turn on',
    'push.blocked.status': 'Notifications are blocked for Logbuch',
    'push.blocked.intro': 'Once notifications are blocked, your phone does not ask again. Here is how to allow them:',
    'push.blocked.ios': 'Open your iPhone <strong>Settings</strong>, find <strong>Notifications</strong> and then <strong>Logbuch</strong>, and allow notifications. Then come back here.',
    'push.blocked.androidApp': 'Press and hold the <strong>Logbuch icon</strong> on your home screen, open the <strong>App info</strong> (often ⓘ) and allow <strong>notifications</strong> there. Depending on your phone the entries are named a little differently. Then come back here.',
    'push.blocked.androidBrowser': 'Tap the icon to the left of the address in the address bar and look for <strong>Permissions</strong> or <strong>Notifications</strong> to allow them. Depending on your browser this looks a little different. Then come back here.',
    'push.blocked.other': 'Allow <strong>notifications</strong> for this site in your browser’s site settings. Then come back here.',
    'push.blocked.retry': 'Try again',
    'push.blocked.retryHint': 'Allowed them there? Then tap here to turn reminders on:',
    'push.blocked.still': 'Notifications are still blocked. Allow them first as described, then try again.',
    'tutorial.reminders.blocked': 'No problem – you can continue without reminders. In case you change your mind:',
    'menu.language': 'Language',
    'theme.label': 'Appearance',
    'theme.system': 'System',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'textSize.label': 'Text size',
    'onbDisplay.welcomeTitle': 'Text too small? Prefer light or dark?',
    'onbDisplay.button': 'Display',
    'textSize.small': 'Small',
    'textSize.normal': 'Normal',
    'textSize.large': 'Large',
    'textSize.xlarge': 'Extra large',
    'pattern.enableLabel': 'Show pattern in addition to color',
    'haptics.enableLabel': 'Vibrate when entering values',
    'pattern.explain': 'About 1 in 12 men and 1 in 200 women has red-green color vision deficiency – often unnoticed, since it is rarely diagnosed. So that ratings (red to green) are not recognizable through color alone, Logbuch shows a subtle stripe pattern in addition by default: the denser it is, the better the value. Purely a visual choice, switch it off if you do not need or want it.',
    'dayProgress.label': 'Show progress for the day (e.g. 3 of 7)',
    'dayProgress.explain': 'Off by default: a number that is not yet full can feel like an obligation – Logbuch is meant to work without pressure. Counters like “cigarettes” are not included, since no entry is a result there too.',
    'menu.groupAccount': 'Account',
    'menu.manageFields': 'Manage fields',
    'menu.about': 'About Logbuch',
    'about.title': 'About Logbuch',
    'menu.feedback': 'Send feedback',
    'menu.install': 'Get it on your phone',
    'menu.settings': 'Settings',
    'settings.reminders': 'Reminders',
    'settings.display': 'Display',
    'settings.defaultReminderNote': 'Applies to all fields without their own reminder time.',
    'settings.exportNote': 'Downloads everything that belongs to your account as one file.',
    'settings.recoveryKeyNote': 'Only needed if you lost your spare key – the old one stops working afterwards.',
    'feedback.title': 'Feedback',
    'feedback.intro': 'Ideas, bugs, praise or criticism – everything is welcome.',
    'feedback.messageLabel': 'Your message',
    'feedback.anonymousLabel': 'Send without sender',
    'feedback.anonymousNote': 'I will not see who the message is from and cannot reply to you.',
    'feedback.replyNote': 'I can reply to you at {email}.',
    'feedback.submit': 'Send',
    'feedback.sending': 'Sending …',
    'feedback.sent': 'Thank you! Your feedback has arrived.',
    'feedback.error.empty': 'Please write a message first.',
    'feedback.error.rateLimited': 'You have already sent several messages in the last 24 hours – please try again later.',
    'feedback.error.failed': 'Sending failed – please try again later.',
    'about.intro': 'A few things that are not obvious at first glance — here to read up on if you are curious.',
    'about.link.menu': 'Show in settings',
    'about.link.manage': 'Go to “Manage fields”',
    'about.status': 'Beta – as of {date}. I am actively continuing to build this out, feel free to reach out if you notice anything.',
    'about.monetizationNote': 'Logbuch is currently completely free. I may make certain features paid in the future, for example via a subscription.',
    'about.group.usage': 'Using the app',
    'about.group.fields': 'Fields & evaluation',
    'about.group.appearance': 'Appearance',
    'about.a11y.title': 'Accessibility at Logbuch',
    'about.a11y.intro': 'People with disabilities — whether through a physical condition, color blindness, limited mobility, or little experience with phones — are among the least considered groups in society. An app meant to help you take good care of yourself should pay particular attention here — not because it will eventually be required, but because it matters to me. Here are a few concrete things I built in on purpose, and why:',
    'about.a11y.pattern.title': 'Why a pattern in addition to color?',
    'about.a11y.pattern.body': 'About 1 in 12 men and 1 in 200 women has red-green color vision deficiency — often unnoticed, since it is rarely diagnosed. Ratings in Logbuch (red to green) therefore get a subtle stripe pattern by default, whose density follows the value. Deliberately not an extra setting you would have to go looking for (opt-in), but a default you can switch off if you do not need it (in the settings) — the people who need it often would not know to look for it.',
    'about.a11y.textSize.title': 'Larger text',
    'about.a11y.textSize.body': 'Logbuch uses an easily readable text size and strong contrast. Under “Text size” in the settings you can make everything larger or smaller – unlike pinch-zooming, the whole page adapts.',
    'about.a11y.buttons.title': 'Clear buttons',
    'about.a11y.buttons.body': 'Everything you can tap looks like a button – not like underlined text that many people overlook. And every button has a large enough tap area, even if it looks small.',
    'about.a11y.keyboard.title': 'Keyboard instead of mouse or touch',
    'about.a11y.keyboard.body': 'Everything in Logbuch can be operated fully without a mouse or touch — important for people who, for motor reasons, cannot precisely control a mouse or reliably hit targets on a touchscreen. Calendar cells, dialogs, and even reordering fields (otherwise only possible by dragging) have a full keyboard alternative. In dialogs like "Delete account", keyboard focus reliably stays within the dialog instead of unnoticeably slipping into the background, and Escape closes them, as is standard in other software.',
    'about.a11y.screenreader.title': 'Screen readers (software that reads the screen aloud for blind users)',
    'about.a11y.screenreader.body': 'New error or success messages are announced automatically, without having to go looking for them. The history chart for number fields has a full text summary in addition to the graphic (number of entries, last value, average, trend) — a plain graphic would otherwise be silent to a screen reader. This is not a finished chapter, I keep expanding it.',
    'about.a11y.feedback': 'Is something missing, or do you have an idea for what I could improve? I would love to hear your feedback.',
    'about.mentalHealth.title': 'Mental health',
    'about.mentalHealth.intro': 'Wanting to work on yourself is a good impulse — but only if it does not turn into pressure or self-criticism. It matters to me that Logbuch helps with that instead of becoming a burden itself. A few things I care about here:',
    'about.mentalHealth.observation.title': 'An entry is an observation, not a verdict',
    'about.mentalHealth.observation.body': 'A red day does not mean you failed — just that something was different that day. If numbers or colors start to feel like a grade on you as a person, that is a good moment to take a break from tracking.',
    'about.mentalHealth.noSubstitute.title': 'Logbuch is not a substitute for professional help',
    'about.mentalHealth.noSubstitute.body': 'This app can help you notice patterns over time — but it cannot replace a conversation with a therapist, doctor, or someone you trust, especially around topics like mood, sleep, or substance use. If you are struggling for an extended period, please talk to someone.',
    'about.mentalHealth.crisis.title': 'If things feel really bad right now',
    'about.mentalHealth.crisis.germany': 'In Germany, Telefonseelsorge is free and anonymous – by phone around the clock (two independent numbers, in case one is busy), and also via chat.',
    'about.mentalHealth.crisis.websiteButton': 'Chat at telefonseelsorge.de',
    'about.mentalHealth.crisis.callButton1': 'Call 0800 111 0 111',
    'about.mentalHealth.crisis.callButton2': 'Call 0800 111 0 222',
    'about.mentalHealth.crisis.international': 'Outside Germany (or if you prefer), <a href="https://findahelpline.com" target="_blank" rel="noopener">findahelpline.com</a> lists free helplines by country.',
    'about.mentalHealth.crisis.emergency': 'If you or someone else is in acute danger, call the emergency number <strong>112</strong> – free anywhere in the EU; elsewhere, your local emergency number.',
    'about.mentalHealth.crisis.closing': 'You do not need to be in an emergency for this — a conversation is enough.',
    'about.mentalHealth.feedback': 'Is something missing here, or do you see it differently? I would love to hear your feedback.',
    'about.privacy.title': 'Your data and your privacy',
    'about.privacy.intro': 'Logbuch often holds very personal things: mood, sleep, substance use, sexuality, thoughts you would not tell anyone else. That is exactly why nobody but you should be able to read them – not even me. Not because you would have to distrust me, but because trust works best where you do not need it in the first place: what I cannot see, I cannot lose, pass on, or misuse. Here, honestly, is what I can see and what I cannot:',
    'about.privacy.cannotSee.title': 'What I cannot see',
    'about.privacy.cannotSee.body': 'Everything you enter, and what it is about: your values, notes, and text answers, the names of your fields and groups and the labels of their steps. All of this is encrypted on your device before it is even sent. The key for it is tied to your password and your spare key, and only you know them. Even with full access to the database, all I see is unreadable gibberish.',
    'about.privacy.canSee.title': 'What I can see',
    'about.privacy.canSee.body': 'What is technically necessary for the app to work:<ul><li>your email address and when you signed up and last signed in</li><li>how many fields and groups you have, what kind the fields are (e.g. scale or number), how often they are due (e.g. daily, on certain weekdays, or once a week), and which field is in which group – but not what they are about or what your fields and groups are called</li><li>on which days you filled in which of these fields (for reminders), without the value – for counters with reminders and “if less than” only how many of that day’s reminders are already taken care of (e.g. “1 of 2”), not the number itself</li><li>your settings such as reminder time, language, and time zone</li></ul>On top of that, the providers Logbuch runs on briefly log technical access data such as IP addresses. And an email service gets your email address to send you the emails for confirming your account and resetting your password.',
    'about.privacy.recoveryKey.title': 'The flip side: your spare key',
    'about.privacy.recoveryKey.body': 'Because I have no access, I also cannot help you if you lose your password <strong>and</strong> your spare key – your entries are then gone for good. So keep it somewhere safe. If you have misplaced it, you can create a new one in the settings anytime – the old one becomes invalid, and you do not need it to do this.',
    'about.privacy.yourData.title': 'Your data belongs to you',
    'about.privacy.yourData.body': 'You can export everything as a file at any time – your right to access your data – or delete your account (in the settings under “Account”). Your account and all entries are then permanently deleted.',
    'about.privacy.feedback': 'Do you have questions about this, or is something missing? Feel free to write to me.',
    'about.tip.keys.title': 'Keyboard on a computer',
    'about.tip.keys.body': '← and → go to the previous or next day or period, as long as no input field is selected. Ctrl+Enter (Mac: ⌘+Enter) saves a field, a group, a note or your feedback. Escape closes windows and menus.',
    'about.tip.swipe.title': 'Swiping',
    'about.tip.swipe.body': 'In the day, week, month, and year views, you can swipe left/right to jump to the previous/next period — faster than the arrow buttons. On "Manage fields" and "About Logbuch", swiping right takes you back.',
    'about.tip.jumpDay.title': 'Jump straight to a day',
    'about.tip.jumpDay.body': 'Tap any cell in the week, month, or year view to jump directly to that day.',
    'about.tip.toggleOff.title': 'Clearing an answer',
    'about.tip.toggleOff.body': 'Tap an already-selected option again to remove it — handy if you tapped the wrong one.',
    'about.tip.openDot.title': 'Dot = not filled in yet',
    'about.tip.openDot.body': 'In “Today”, a small dot after the name marks the fields that are planned for that day but not filled in yet – for collapsed groups, on the group heading. Once everything is filled in, “Everything filled in” appears below the list. Deliberately without a counter or rate: it is meant to show what is still missing, not to put pressure on you.',
    'about.tip.textFields.title': 'Free text fields',
    'about.tip.textFields.body': 'For questions like "What am I grateful for today?" there is the "Text" field type. "Today" shows a text box for it that saves automatically. The answers are not part of the statistics, but you can expand and read them back in the week, month, year, and overall views — tapping an entry takes you to its day.',
    'about.tip.fieldMenu.title': 'Notes & editing fields directly',
    'about.tip.fieldMenu.body': 'In "Today", the three dots ⋮ in front of each field let you write a note about it — say, "no exercise today, had a cold" — or edit or archive the field right there; in front of a group, they let you edit the group, and in front of the weekday at the top, reset the whole day. For a shortcut, tap the field name or briefly press and hold its row. Notes are not part of the statistics; in the week and month views a small dot shows where there is one.',
    'about.tip.reorder.title': 'Reordering fields',
    'about.tip.reorder.body': 'In "Manage fields" you can reorder fields by dragging the handle or using the ↑/↓ buttons.',
    'about.tip.noValuation.title': 'Fields without valuation',
    'about.tip.noValuation.body': 'Not everything has to be good or bad. With “No valuation” (instead of “High/Low values desirable”), a field is simply tracked – without any coloring by value, since even shading from light to dark would imply “more” or “less”. The evaluation views show on which days and how often you entered something, but no percentages.',
    'about.tip.computed.title': 'Calculated fields',
    'about.tip.computed.body': 'A field of type “Calculated” combines multiple fields into one value: scale fields into an average, e.g. “exercised” from “cardio” + “strength training” – or number fields with the same unit as a sum, average, minimum, or maximum, e.g. “total movement (km)” from “running” + “cycling”. You cannot fill it in yourself – the value is always calculated live from the other fields.',
    'about.tip.goalThreshold.title': 'Goal threshold instead of 100%',
    'about.tip.goalThreshold.body': 'Not everything has to work out every day. Under “More settings” in the field form you set a goal, e.g. sport on 3 of 7 days – from then on the field is fully green in the statistics.',
    'about.tip.slider.title': 'Slider instead of buttons',
    'about.tip.slider.body': 'Steps can also be shown as a slider instead of buttons. Buttons go up to 7 steps, so that each one stays clearly visible and easy to pick – for finer scales with up to 100 steps (e.g. 1 to 100), use the slider.',
    'about.tip.customReminder.title': 'Custom reminder times per field or group',
    'about.tip.customReminder.body': 'Each field can get its own reminder times instead of using the default — useful e.g. for something you enter in the morning instead of the evening. Up to four times work, say morning and evening for brushing your teeth; you’re only reminded while something is still missing. A group can have its own time too: its fields are then reminded together at that time, with one notification for the whole group. If a field in it has its own time, that one applies.',
    'about.tip.sections.title': 'Groups',
    'about.tip.sections.body': 'You can arrange fields in groups – ideally by time of day, e.g. "Morning" and "Evening": then you fill in each block in one go, and each group can remind you at its own time. Once everything in a group is filled in, it is collapsed the next time you open it; you can set this per group. Groups only arrange; a combined value comes from a field of type "Calculated".',
    'about.tip.schedule.title': 'Fixed days? Pick weekdays',
    'about.tip.schedule.body': 'For things on fixed days, like weighing yourself on Mondays: in the field form, under "On which days?", you pick the weekdays – or "Every few days" for a fixed interval, such as every 3 days. On other days the field sits collapsed under "Not planned today" in "Today" – you can still enter something there – and it triggers no reminder. In the week view such days are hatched, so that "not due" does not look like "forgotten".',
    'about.tip.archiveVsDelete.title': 'Archiving instead of deleting',
    'about.tip.archiveVsDelete.body': 'Archived fields disappear from daily entry and, by default, from the statistics too – but their existing values are kept. If you still want to see them (e.g. the history of a field you replaced with a new one), tick “Show in statistics” for the archived field under “Manage fields”. Archived fields can be reactivated anytime; permanent deletion, on the other hand, also removes the existing values.',
    'about.tip.theme.title': 'Dark mode',
    'about.tip.theme.body': 'Follows your system setting automatically, but can also be fixed to light or dark in the settings.',
    'about.tip.textSize.title': 'Text size',
    'about.tip.textSize.body': 'Under “Text size” in the settings you can make the text larger or smaller throughout the app – applies to this device.',
    'about.tip.language.title': 'Language',
    'about.tip.language.body': 'Logbuch is available in German and English, switchable in the settings.',
    'menu.exportData': 'Export my data',
    'menu.regenerateRecoveryKey': 'Regenerate spare key',
    'menu.deleteAccount': 'Delete account',
    'menu.changePassword': 'Change password',
    'passwordChange.title': 'Change password',
    'passwordChange.current': 'Current password',
    'passwordChange.new': 'New password',
    'passwordChange.note': 'You’ll then be signed out on your other devices and sign in there with the new password. Your spare key stays valid.',
    'passwordChange.submit': 'Change password',
    'passwordChange.saving': 'Changing …',
    'passwordChange.saved': 'Password changed.',
    'passwordChange.error.wrongCurrent': 'The current password is incorrect.',
    'passwordChange.error.same': 'The new password is the same as the current one.',
    'passwordChange.error.failed': 'Password not changed.',
    'passwordChange.error.incomplete': 'The change didn’t fully go through, probably because the connection dropped for a moment. Please tap “Change password” again right away – only then is it complete.',
    'menu.changeEmail': 'Change email address',
    'settings.emailCurrent': 'Signed in as {email}',
    'settings.emailPending': 'Switch to {email} is still waiting for your confirmation in the email sent there.',
    'emailChange.title': 'Change email address',
    'emailChange.current': 'Current: <strong>{email}</strong>',
    'emailChange.new': 'New email address',
    'emailChange.password': 'Your password',
    'emailChange.note': 'You’ll get an email at the new address. It only applies once you’ve confirmed there – until then, sign in with your current address. Your current address then gets a notice that the address was changed.',
    'emailChange.submit': 'Send email',
    'emailChange.sending': 'Sending …',
    'emailChange.sentTitle': 'Check your inbox',
    'emailChange.sentBody': 'I sent an email to <strong>{email}</strong>. Tap the button there – then the new address applies.',
    'emailChange.sentSpam': 'No email? Check your spam folder too.',
    'emailChange.landedDone': 'Your new email address now applies.',
    'emailChange.error.same': 'That’s already your current address.',
    'emailChange.error.wrongPassword': 'The password is incorrect.',
    'emailChange.error.taken': 'An account already exists for this address.',
    'emailChange.error.invalid': 'That doesn’t look like a valid email address.',
    'emailChange.error.rateLimit': 'Too many emails were sent just now. Please try again in a few minutes.',
    'emailChange.error.failed': 'Email not sent.',
    'mailLink.expired': 'This link from the email has expired or was already used. If you already confirmed, you’re all set. Otherwise, just request a new email.',
    'mailLink.failed': 'The link from the email didn’t work. Just request a new email.',
    'menu.checkSpareKey': 'Check spare key',
    'settings.checkSpareKeyNote': 'Checks whether the spare key you wrote down or saved still works. Nothing is changed.',
    'spareKeyCheck.title': 'Check spare key',
    'spareKeyCheck.body': 'Enter your spare key the way you wrote it down or saved it. It’s only checked here on your device and isn’t stored anywhere.',
    'spareKeyCheck.submit': 'Check',
    'spareKeyCheck.checking': 'Checking …',
    'spareKeyCheck.ok': 'It works. With this spare key you can get to your data if you forget your password.',
    'spareKeyCheck.wrong': 'This spare key doesn’t work. Check that you entered all of it without typos. If you no longer have one that works, create a new one.',
    'spareKeyCheck.failed': 'The check didn’t work.',
    'deleteAccount.title': 'Permanently delete account',
    'deleteAccount.warning': 'All your entries, fields and settings will be permanently deleted. This cannot be undone.',
    'deleteAccount.whichAccount': 'Account: <strong>{email}</strong>',
    'deleteAccount.protected': 'This account is protected against deletion.',
    'deleteAccount.typeToConfirm': 'Type {word} to confirm',
    'deleteAccount.deleting': 'Deleting …',
    'deleteAccount.deletePermanently': 'Delete permanently',
    'common.loading': 'Loading …',
    'whatsNew.title': 'New in Logbuch',
    'whatsNew.close': 'Got it',
    'whatsNew.all': 'All updates',
    'about.news.title': 'Updates',
    'startup.opening': 'Opening your Logbuch …',
    'startup.slow': 'This is taking longer than usual – usually the internet connection is slow. It will continue on its own.',
    'tabs.today': 'Today',
    'tabs.week': 'Week',
    'tabs.month': 'Month',
    'tabs.year': 'Year',
    'tabs.global': 'Overall',
    'common.encryptingData': 'Your data is being encrypted …',
    'recoveryDisplay.replacedElsewhere': 'Your spare key was created anew on another device in the meantime – so the one just shown is no longer valid. Here is a new one, please keep this one.',
    'recoveryDisplay.copyFailed': 'Copying not possible - please write down the spare key by hand.',
    'recoveryDisplay.fileBody': 'Keep this safe – without this spare key AND your password, your data is irrecoverably lost. Do not give it to anyone: it unlocks your Logbuch just like your password.',
  },
};

let currentLocale = 'de';

function t(key, params, escapeParams = true) {
  const table = STRINGS[currentLocale] || STRINGS.de;
  let str = table[key];
  if (str === undefined) {
    console.warn(`[i18n] fehlender Key "${key}" für Locale "${currentLocale}"`);
    str = STRINGS.de[key] ?? key;
  }
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (_, name) => {
    const v = params[name];
    return v === undefined ? `{${name}}` : escapeParams ? esc(String(v)) : String(v);
  });
}

// Für REINEN TEXT, der später selbst noch escaped wird: Meldungen (state.notice,
// authError, unlockError - renderNotice & Co. escapen den ganzen Text) und Werte, die
// per esc() in ein Attribut kommen. Mit t() würden die Parameter dort doppelt escaped
// ("&" erschiene als "&amp;"). Nur für Templates ohne HTML.
function tPlain(key, params) {
  return t(key, params, false);
}

function applyLocale(locale) {
  currentLocale = locale;
  document.documentElement.lang = locale;
}
// Zahlen im Text in der Schreibweise der Sprache ("6,5" statt "6.5"); Eingabefelder
// (type="number") machen das selbst.
function formatNumber(n) {
  return new Intl.NumberFormat(currentLocale, { maximumFractionDigits: 2 }).format(n);
}

function detectInitialLocale() {
  try {
    return (navigator.language || '').toLowerCase().startsWith('de') ? 'de' : 'en';
  } catch {
    return 'en';
  }
}

// Grobe, rein clientseitige Vermutung des Aufenthaltslands aus der Region-Angabe der
// Browser-/Systemsprache (z.B. "de-DE" -> "DE") - bewusst KEINE IP-Geolocation oder
// navigator.geolocation, das würde einen Drittanbieter-Roundtrip bzw. einen
// Berechtigungsdialog für eine reine Textanzeige bedeuten und widerspräche der
// Zero-Access-Ausrichtung der App (siehe CLAUDE.md "Datenschutz & Sicherheit").
// Unabhängig von currentLocale (der von Nutzern selbst gewählten App-Sprache) - beide
// können auseinanderlaufen (z.B. App auf Englisch gestellt, System auf de-DE), siehe
// Verwendung in renderMentalHealthSection. Liefert null, wenn der Browser keine
// Region angibt (z.B. nur "de" ohne Länder-Suffix) - dann bleibt es beim
// länderunabhängigen Verweis, kein hartes Scheitern.
function detectLikelyCountry() {
  try {
    const lang = navigator.language || (navigator.languages && navigator.languages[0]) || '';
    const match = /-([A-Za-z]{2})$/.exec(lang);
    return match ? match[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

// Prüft beim Laden, ob DE und EN exakt dieselben Keys haben — deckt vergessene
// Übersetzungen sofort im Dev-Verlauf auf, statt sie erst live auffallen zu lassen.
(function assertStringsSymmetry() {
  const deKeys = new Set(Object.keys(STRINGS.de));
  const enKeys = new Set(Object.keys(STRINGS.en));
  const missingInEn = [...deKeys].filter((k) => !enKeys.has(k));
  const missingInDe = [...enKeys].filter((k) => !deKeys.has(k));
  if (missingInEn.length) console.error('[i18n] Keys fehlen in en:', missingInEn);
  if (missingInDe.length) console.error('[i18n] Keys fehlen in de:', missingInDe);
})();

// --- Dark Mode ---------------------------------------------------------
// Folgt standardmäßig prefers-color-scheme (siehe @media-Regeln im <style>-Block).
// Ein manueller Override (System/Hell/Dunkel) im Burger-Menü setzt zusätzlich
// data-theme auf <html> und wird NICHT über user_settings synchronisiert
// (anders als die Sprache) — bewusst geräte-lokal in localStorage, analog zum
// bestehenden installHintDismissed-Flag, kein DB-Roundtrip nötig.
// = --surface (Farbe des angehefteten Kopfs): Statusleiste und Kopf wirken wie eine Fläche.
const THEME_COLOR_BY_MODE = { light: '#eae7df', dark: '#29261f' };

function getThemeOverride() {
  try { return localStorage.getItem('themeOverride'); } catch { return null; } // 'light' | 'dark' | null (= System)
}

function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

function syncThemeColorMeta(mode) {
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR_BY_MODE[mode]);
}

function applyTheme(override) {
  if (override) document.documentElement.setAttribute('data-theme', override);
  else document.documentElement.removeAttribute('data-theme');
  syncThemeColorMeta(override || (systemPrefersDark() ? 'dark' : 'light'));
}

function setThemeOverride(value) {
  try {
    if (value) localStorage.setItem('themeOverride', value);
    else localStorage.removeItem('themeOverride');
  } catch { /* z.B. privater Modus — Override wirkt dann nur für die laufende Sitzung */ }
  applyTheme(value);
}

// Textgröße, pro Gerät wie das Theme (localStorage 'textSize': 'small' | 'large' | 'xlarge'
// | nicht gesetzt = Normal; "Klein" für alle, die lieber mehr auf einmal sehen). Setzt nur die Grundgröße auf <html> - alle Schriftgrößen im CSS
// stehen in rem und wachsen mit. Zwei-Finger-Zoom ist kein Ersatz (vergrößert wie eine
// Lupe, man muss seitlich schieben), und in der installierten App fehlt die
// Browser-Leiste mit ihrer eigenen Schriftgrößen-Einstellung.
const TEXT_SIZES = ['small', '', 'large', 'xlarge'];
function getTextSize() {
  try { const v = localStorage.getItem('textSize'); return TEXT_SIZES.includes(v) ? v : ''; } catch { return ''; }
}
function applyTextSize(size) {
  if (size) document.documentElement.setAttribute('data-text-size', size);
  else document.documentElement.removeAttribute('data-text-size');
}
function setTextSize(size) {
  try {
    if (size) localStorage.setItem('textSize', size);
    else localStorage.removeItem('textSize');
  } catch { /* dann eben nur für diese Sitzung */ }
  applyTextSize(size);
}

// Streifenmuster (siehe scorePatternStyle) ist bewusst Standard, nicht opt-in — die
// meisten Menschen mit Rot-Grün-Farbschwäche wissen selbst nicht genau, dass/wie stark
// sie betroffen sind, würden ein verstecktes "Barrierefreiheit"-Menü also gar nicht
// erst aufsuchen. Wer das Muster rein optisch nicht möchte, kann es hier abschalten —
// geräte-lokal wie der Theme-Override, keine inhaltliche Account-Einstellung.
// "Stand des Tages zeigen" (3 von 7 eingetragen): standardmäßig aus - eine Zahl, die noch
// nicht voll ist, kann sich wie eine Pflicht anfühlen. Geräte-lokal wie Muster und Theme.
function isDayProgressShown() {
  try { return localStorage.getItem('dayProgressShown') === 'true'; } catch { return false; }
}
function setDayProgressShown(shown) {
  try {
    if (shown) localStorage.setItem('dayProgressShown', 'true');
    else localStorage.removeItem('dayProgressShown');
  } catch { /* dann eben nur für diese Sitzung */ }
}
function isPatternDisabled() {
  try { return localStorage.getItem('scorePatternDisabled') === 'true'; } catch { return false; }
}
function setPatternDisabled(disabled) {
  try {
    if (disabled) localStorage.setItem('scorePatternDisabled', 'true');
    else localStorage.removeItem('scorePatternDisabled');
  } catch { /* z.B. privater Modus — wirkt dann nur für die laufende Sitzung */ }
}

// Haptisches Feedback beim Setzen/Entfernen eines Werts - damit ein versehentlich
// eingetragener oder verstellter Wert (z.B. ein beim Scrollen gestreifter
// Schieberegler) eher auffällt. Standardmäßig an, aber abschaltbar: Vibration kann für
// manche unangenehm sein (z.B. bei sensorischer Empfindlichkeit). Geräte-lokal wie
// Theme/Streifenmuster. Nur Android: Safari auf iOS bietet Webseiten keine
// Vibration-API an - der Schalter erscheint dort deshalb gar nicht erst.
function hapticsSupported() {
  return typeof navigator.vibrate === 'function';
}
function isHapticsDisabled() {
  try { return localStorage.getItem('hapticsDisabled') === 'true'; } catch { return false; }
}
function setHapticsDisabled(disabled) {
  try {
    if (disabled) localStorage.setItem('hapticsDisabled', 'true');
    else localStorage.removeItem('hapticsDisabled');
  } catch { /* z.B. privater Modus — wirkt dann nur für die laufende Sitzung */ }
}
function haptic() {
  if (!hapticsSupported() || isHapticsDisabled()) return;
  try { navigator.vibrate(12); } catch { /* nicht erlaubt (z.B. ohne vorherige Nutzer-Geste) - egal */ }
}

// --- Datum/Zeit: locale-abhängige Formatierung -----------------------------
// Ersetzt frühere feste WEEKDAYS/MONTHS-Arrays + manuelles DD.MM.YYYY-Bauen.
// Die Montag-zuerst-Wochentag-Reihenfolge ((d.getDay()+6)%7) bleibt an den
// jeweiligen Aufrufstellen unverändert — reine Tages-Erzeugungslogik, keine
// Formatierungsfrage, dafür hat Intl kein verlässliches Grid-Primitiv.
function localeTag() {
  return currentLocale === 'en' ? 'en-US' : 'de-DE';
}
const dtfCache = new Map();
// Sprache der App + Region des Geräts ("en" + "GB" -> en-GB): Datums-Schreibweise und 12 oder
// 24 Stunden hängen an der Region, nicht an der Sprache - in England 30/10/2026 statt der
// US-Schreibweise, ein englisch eingestelltes Handy in Deutschland zeigt 24 Stunden. Ohne
// erkennbare Region wie localeTag().
function regionTag() {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    if (region) return `${currentLocale}-${region}`;
  } catch { /* alter Browser */ }
  return localeTag();
}
const clock12hCache = new Map();
function clockUses12h() {
  const tag = regionTag();
  if (!clock12hCache.has(tag)) {
    let twelve = false;
    try {
      // Die Gewohnheit der Region (getHourCycles); DateTimeFormat allein nähme die der
      // Sprache ("de-US" ergäbe 24 Stunden).
      const loc = new Intl.Locale(tag);
      const hc = (loc.getHourCycles?.() || loc.hourCycles)?.[0]
        || new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hourCycle;
      twelve = hc === 'h11' || hc === 'h12';
    } catch { /* dann 24 Stunden */ }
    clock12hCache.set(tag, twelve);
  }
  return clock12hCache.get(tag);
}
function dtf(options) {
  const tag = regionTag();
  const key = tag + JSON.stringify(options);
  if (!dtfCache.has(key)) dtfCache.set(key, new Intl.DateTimeFormat(tag, options));
  return dtfCache.get(key);
}
function weekdayShort(date) { return dtf({ weekday: 'short' }).format(date); }
function weekdayLong(date) { return dtf({ weekday: 'long' }).format(date); }
function monthName(date) { return dtf({ month: 'long' }).format(date); }
function monthShort(date) { return dtf({ month: 'short' }).format(date); }
// 2024-01-01 ist ein Montag – fester Referenzpunkt, um Montag-zuerst-Kurznamen
// unabhängig vom aktuellen Datum aus Intl zu erzeugen (reine Label-Erzeugung, hat
// nichts mit der eigentlichen Tages-Reihenfolge-Logik an den Aufrufstellen zu tun).
function mondayFirstWeekdayShortNames() {
  return Array.from({ length: 7 }, (_, i) => weekdayShort(new Date(2024, 0, 1 + i)));
}
function longDate(date) { return dtf({ day: 'numeric', month: 'long', year: 'numeric' }).format(date); }
function formatDMY(dateKeyOrDate) {
  const d = typeof dateKeyOrDate === 'string' ? new Date(dateKeyOrDate + 'T00:00:00') : dateKeyOrDate;
  return dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Einzige Quelle für die client-seitig angezeigte Mindestlänge (Browser-Validierung
// via minlength-Attribut). Muss mit dem serverseitigen Supabase-Wert
// (auth.minimum_password_length in supabase/config.toml, Dashboard-verwaltet)
// übereinstimmen, ist aber rein kosmetisch — Supabase lehnt zu kurze Passwörter
// ohnehin serverseitig ab, unabhängig von diesem Attribut.
const AUTH_MIN_PASSWORD_LENGTH = 10;

// Supabase liefert Auth-Fehlermeldungen nur auf Englisch. "Invalid login credentials"
// bleibt bewusst unspezifisch (verrät nicht, ob die E-Mail existiert oder nur das
// Passwort falsch ist — sonst ließe sich der Nutzerbestand durchscannen), wird aber
// zumindest übersetzt. Unbekannte Meldungen kommen unverändert durch.
const AUTH_ERROR_TRANSLATIONS = {
  de: {
    'Invalid login credentials': 'E-Mail oder Passwort falsch.',
    'User already registered': 'Für diese E-Mail gibt es schon ein Konto.',
    'Email not confirmed': 'Bitte bestätige zuerst deine E-Mail-Adresse über den Link, den wir dir geschickt haben.',
  },
  en: {
    'Invalid login credentials': 'Email or password incorrect.',
    'User already registered': 'An account already exists for this email address.',
    'Email not confirmed': 'Please confirm your email address first via the link we sent you.',
  },
};
function translateAuthError(message) {
  // "Password should be at least N characters" trägt die serverseitig konfigurierte
  // Mindestlänge direkt in der Zahl — fest übersetzte Strings würden bei jeder
  // künftigen Policy-Änderung wieder auseinanderlaufen (genau das ist hier passiert,
  // als minimum_password_length von 6 auf 10 erhöht wurde).
  const shortMatch = /^Password should be at least (\d+) characters?/.exec(message);
  if (shortMatch) return tPlain('auth.error.passwordTooShort', { min: shortMatch[1] });
  return (AUTH_ERROR_TRANSLATIONS[currentLocale] || AUTH_ERROR_TRANSLATIONS.de)[message] || message;
}

// Übersetzt/vereinfacht technische Postgres-/Netzwerk-Fehlermeldungen (z.B. aus
// Datenbank-Operationen wie Feld anlegen/speichern) für Laien – die rohen
// Postgres-Meldungen (Constraint-Namen, Fachjargon) sind für Nicht-Techniker kaum
// verständlich. Unbekannte Meldungen kommen unverändert durch (wie
// translateAuthError), damit trotzdem etwas Nützliches angezeigt wird statt nichts.
function translateDbError(message) {
  if (/duplicate key value violates unique constraint "habit_definitions_user_id_slug_key"/.test(message)) {
    return t('error.db.duplicateSlug');
  }
  if (/duplicate key value violates unique constraint/.test(message)) {
    return t('error.db.duplicateGeneric');
  }
  if (/violates not-null constraint/.test(message)) {
    return t('error.db.notNull');
  }
  if (/push subscription limit reached/.test(message)) {
    return t('error.db.pushLimit');
  }
  if (/violates check constraint/.test(message)) {
    return t('error.db.check');
  }
  if (/violates foreign key constraint "\w+_user_id_fkey"/.test(message)) {
    // Der referenzierte Account existiert serverseitig nicht mehr - z.B. von einem
    // anderen Gerät aus gelöscht, während dieses Gerät noch einen gültigen, aber
    // inzwischen verwaisten Access-Token hatte (Supabase kann bereits ausgestellte
    // Access-Token nicht vorzeitig entziehen, siehe CLAUDE.md "Datenschutz &
    // Sicherheit"). Statt des kryptischen FK-Fehlers hier lokal ausloggen.
    forceLogoutAccountGone();
    return t('error.db.accountGone');
  }
  if (/violates foreign key constraint/.test(message)) {
    return t('error.db.foreignKey');
  }
  if (/Failed to fetch|NetworkError|network error/i.test(message)) {
    return t('error.db.network');
  }
  if (/JWT expired|invalid JWT|refresh_token_not_found/i.test(message)) {
    return t('error.db.sessionExpired');
  }
  return message;
}

// Best effort, ausgelöst aus translateDbError: lokale Session sofort verwerfen
// (scope: 'local' statt des Standard-Aufrufs, da der Server bei einem bereits
// gelöschten Account ohnehin keinen gültigen Refresh-Token mehr kennt - der
// Server-Roundtrip darf das lokale Ausloggen nicht blockieren). accountGoneHandled
// verhindert, dass mehrere gleichzeitig fehlschlagende Requests das mehrfach anstoßen.
let accountGoneHandled = false;
async function forceLogoutAccountGone() {
  if (accountGoneHandled) return;
  accountGoneHandled = true;
  clearCurrentDek();
  endPushForThisDevice({ deleteServerRow: false }); // Server-Zeilen sind mit dem Konto schon weg
  try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* egal, wir wollen nur lokal raus */ }
}

// Text-/Passwort-Eingabe mit optionalem "×"-Button zum Leeren (nur wenn nicht leer)
// und optionalem Sichtbar/Verbergen-Umschalter fürs Passwort — beides eigene kleine
// Buttons statt nativer Browser-Mechanismen, damit es plattformübergreifend gleich
// aussieht/funktioniert.
function clearableInputHtml(id, type, value, opts = {}) {
  const { autocomplete = '', required = true, minlength, showVisibilityToggle = false, visible = false } = opts;
  const inputType = showVisibilityToggle ? (visible ? 'text' : 'password') : type;
  return `
    <div class="input-clear-wrap">
      <input type="${inputType}" id="${id}" value="${esc(value)}" ${required ? 'required' : ''}
        ${autocomplete ? `autocomplete="${autocomplete}"` : ''} ${minlength ? `minlength="${minlength}"` : ''} />
      ${value ? `<button type="button" class="input-clear-btn" data-action="clear-input" data-target="${id}" tabindex="-1" aria-label="${esc(t('ariaLabel.clearInput'))}">×</button>` : ''}
    </div>
  `;
}

// Kleine "?"-Box mit Erklärungstext, per Tap auf-/zuklappbar (natives <details>, kein
// JS nötig) — für Erklärungen, die nicht direkt sichtbar sein sollen (zu viel auf
// einmal), aber bei Bedarf griffbereit sind.
function infoTip(text) {
  return `<details class="info-tip"><summary aria-label="${esc(t('ariaLabel.explain'))}">?</summary><p>${esc(text)}</p></details>`;
}

// Zentrale Stelle für state.notice → DOM: state.notice wird an vielen Stellen im
// Code gesetzt, aber nur hier gerendert — role/aria-live sorgen dafür, dass
// Screenreader neue Fehler-/Erfolgsmeldungen automatisch mitbekommen, ohne dass
// der Nutzer erst zur Meldung navigieren muss. Fehler unterbrechen sofort
// (assertive/alert), Erfolgsmeldungen kündigen sich nur höflich an (polite/status).
// state.notice.text ist reiner Text (wird hier escaped) - Meldungen mit Parametern
// deshalb mit tPlain(), nicht t() bauen.
// Fehlermeldung aus einem Fehler: verständlicher Satz vorn; bekannte Fehler übersetzt
// translateDbError in Klartext (Verbindung weg, Konto gelöscht …), alles andere kommt als
// "Bitte versuch es nochmal" plus aufklappbare technische Details (für Feedback an mich) -
// vorher stand der rohe Datenbank-Fehler direkt im Satz.
function errorNotice(key, rawMessage) {
  const raw = String(rawMessage ?? '');
  const friendly = translateDbError(raw);
  const known = friendly !== raw;
  return { type: 'error', text: `${t(key)} ${known ? friendly : t('notice.tryAgain')}`, detail: known || !raw ? null : raw };
}

// --- Meldungen als schwebender Kasten unten (seit 2026-10-01) -------------------
// Vorher standen Meldungen oben unter dem Kopf - wer weiter unten etwas tat (z.B. im
// langen Feld-Formular auf "Speichern"), sah den Fehler nicht. Jetzt immer im Blick am
// unteren Rand, in einem eigenen Element außerhalb von #app (render() ersetzt #app, der
// Kasten soll aber nicht bei jedem Neuzeichnen neu einfliegen). Erfolgsmeldungen
// verschwinden nach ein paar Sekunden von selbst (länger bei längerem Text; antippen oder
// fokussieren hält sie fest), Fehler bleiben bis × oder zur nächsten Aktion. Ausnahme:
// Anmelde-Seiten zeigen Meldungen weiter im Text (dort sind es Anleitungen wie "Ich hab
// dir eine Mail geschickt", die nicht verschwinden dürfen, und die Seite ist kurz).
let toastShown = null;
let toastTimer = null;
function toastDuration(n) { return Math.min(12000, Math.max(n.action ? 7000 : 0, 4000 + n.text.length * 50)); }
function syncToast(hidden = false) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const n = hidden ? null : state.notice;
  if (n === toastShown) return;
  toastShown = n;
  clearTimeout(toastTimer);
  document.documentElement.classList.toggle('has-toast', !!n);
  if (!n) { root.innerHTML = ''; return; }
  const isErr = n.type !== 'ok';
  root.innerHTML = `
    <div class="toast${isErr ? ' toast--error' : ''}">
      <div class="toast-body">
        <p class="toast-text">${esc(n.text)}</p>
        ${n.detail ? `<details class="toast-details"><summary>${t('notice.details')}</summary><p>${esc(n.detail)}</p></details>` : ''}
      </div>
      ${n.action ? `<button type="button" class="toast-action">${esc(n.action.label)}</button>` : ''}
      <button type="button" class="toast-close" aria-label="${esc(t('ariaLabel.closeNotice'))}">×</button>
    </div>
  `;
  if (isErr) announceAlert(n.text); else announce(n.text);
  if (!isErr) toastTimer = setTimeout(() => dismissToast(n), toastDuration(n));
}
function dismissToast(n = toastShown) {
  if (n && state.notice === n) state.notice = null;
  syncToast();
}
{
  const root = document.getElementById('toast-root');
  root?.addEventListener('click', (e) => {
    if (e.target.closest('.toast-close')) dismissToast();
    if (e.target.closest('.toast-action')) {
      const n = toastShown;
      dismissToast(n);
      n?.action?.run();
    }
  });
  const hold = () => clearTimeout(toastTimer);
  root?.addEventListener('pointerdown', hold);
  root?.addEventListener('focusin', hold);
}

function renderNotice() {
  if (!state.notice) return '';
  const isErr = state.notice.type !== 'ok';
  return isErr
    ? `<div class="notice" role="alert" aria-live="assertive">${esc(state.notice.text)}</div>`
    : `<div class="notice notice--ok" role="status" aria-live="polite">${esc(state.notice.text)}</div>`;
}

// Zahlen-Eingabe mit +/- Buttons daneben, für kurze/eingeschränkte Wertebereiche
// (z.B. Anzahl Stufen) — spart das Eintippen. Ändert direkt das Input-Element und
// feuert ein 'change'-Event (siehe stepper-inc/-dec im Klick-Handler), damit ein
// evtl. daran hängender bestehender Change-Listener (z.B. für die Label-Stufenzahl)
// weiterhin greift.
function stepperInput(id, value, min, max, disabled, extraAttrs = '') {
  return `
    <div class="stepper-row">
      <button type="button" class="stepper-btn" data-action="stepper-dec" data-target="${id}" ${disabled ? 'disabled' : ''} aria-label="${esc(t('ariaLabel.decrease'))}">−</button>
      <input type="number" id="${id}" min="${min}" max="${max}" value="${value}" ${extraAttrs} ${disabled ? 'disabled' : ''} />
      <button type="button" class="stepper-btn" data-action="stepper-inc" data-target="${id}" ${disabled ? 'disabled' : ''} aria-label="${esc(t('ariaLabel.increase'))}">+</button>
    </div>
  `;
}

// Einen Schritt am Zahlenfeld eines Steppers, begrenzt auf dessen min/max. Rückgabe: ob
// sich der Wert geändert hat.
function stepInput(target, delta) {
  const min = target.min !== '' ? Number(target.min) : -Infinity;
  const max = target.max !== '' ? Number(target.max) : Infinity;
  const before = Math.round(Number(target.value));
  const n = Math.max(min, Math.min(max, before + delta));
  target.value = n;
  return n !== before;
}
// Gedrückthalten zählt weiter (seit 2026-09-29) - bei z.B. 100 Stufen sonst 99 einzelne
// Tipps. Nach einer kurzen Wartezeit (ein normaler Tipp bleibt ein Schritt) immer
// schneller. Währenddessen ändert sich nur die Zahl im Feld; gespeichert/neu gerendert
// wird einmal beim Loslassen (sonst ersetzte jedes render() mitten im Halten den Knopf).
const STEPPER_HOLD_DELAY_MS = 400;
let stepperHold = null;
let stepperHoldSwallowClick = false;
function stopStepperHold() {
  if (!stepperHold) return;
  clearTimeout(stepperHold.timer);
  const { target, ticks } = stepperHold;
  stepperHold = null;
  if (ticks > 0) {
    stepperHoldSwallowClick = true;
    // Ließ man neben dem Knopf los, kommt kein Klick - dann nicht den nächsten verschlucken.
    setTimeout(() => { stepperHoldSwallowClick = false; }, 400);
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('[data-action="stepper-inc"], [data-action="stepper-dec"]');
  stepperHoldSwallowClick = false;
  if (!btn || btn.disabled || e.button > 0) return;
  const target = document.getElementById(btn.dataset.target);
  if (!target) return;
  const delta = btn.dataset.action === 'stepper-inc' ? 1 : -1;
  const tick = () => {
    if (!stepperHold) return;
    if (!stepInput(target, delta)) { stopStepperHold(); return; } // am Rand angekommen
    stepperHold.ticks += 1;
    stepperHold.timer = setTimeout(tick, Math.max(35, 110 - stepperHold.ticks * 5));
  };
  stepperHold = { target, ticks: 0, timer: setTimeout(tick, STEPPER_HOLD_DELAY_MS) };
});
['pointerup', 'pointercancel'].forEach((type) => document.addEventListener(type, stopStepperHold));
document.addEventListener('pointerleave', stopStepperHold);

// --- Datenzugriff --------------------------------------------------------
// PostgREST liefert höchstens api.max_rows (1000) Zeilen pro Anfrage und kappt still -
// bei den Tages-Einträgen wären das nach ~2,7 Jahren täglicher Nutzung nicht mehr alle
// (ohne Sortierung sogar eine zufällige Auswahl). Deshalb seitenweise; buildQuery muss
// eine eindeutige Sortierung setzen, sonst sind die Seiten nicht stabil.
const FETCH_PAGE_SIZE = 1000;
async function fetchAllRows(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += FETCH_PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) return { data: null, error };
    rows.push(...data);
    if (data.length < FETCH_PAGE_SIZE) return { data: rows, error: null };
  }
}

// Tage, deren Eintrag sich nicht entschlüsseln ließ (z.B. beschädigt oder mit einem
// anderen Schlüssel geschrieben). Sie erscheinen leer, dürfen aber nie überschrieben
// werden - sonst wäre der Inhalt endgültig weg, auch falls er sich später doch noch
// lesen ließe. saveDay verweigert deshalb das Speichern dort.
let undecryptableEntryDates = new Set();
// { keepLocalChanges: true } (Neuladen nach der Rückkehr in die App): hat sich
// state.entries während des Ladens geändert (jemand hat schon etwas angetippt), wird das
// Ergebnis verworfen statt diese Änderung zu überschreiben - die Speicherung führt sie
// ohnehin mit dem Server-Stand zusammen (saveDay).
async function loadEntries({ keepLocalChanges = false } = {}) {
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
  undecryptableEntryDates = undecryptable;
  syncedEntries.clear();
  synced.forEach((v, k) => syncedEntries.set(k, v));
  if (undecryptableEntryDates.size) {
    state.notice = { type: 'error', text: tPlain('notice.entriesUndecryptable', { count: undecryptableEntryDates.size }) };
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
async function repadOldEntries() {
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

const SUPPORTED_KINDS = ['scale', 'number', 'counter', 'computed', 'text', 'time', 'multi'];
const SUPPORTED_AGGREGATES = [null, 'sum', 'avg', 'min', 'max', 'duration', 'since'];
function isSupportedHabit(h) {
  return SUPPORTED_KINDS.includes(h.kind) && (h.kind !== 'computed' || SUPPORTED_AGGREGATES.includes(h.aggregate));
}
async function loadHabits() {
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
async function loadSections() {
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
let accessGroup = null; // 'owner' | 'tester' | null (eigene Zeile in user_access)
function featureVisible(stage, group) {
  return stage === 'all' || (stage === 'testers' && (group === 'tester' || group === 'owner')) || (stage === 'owner' && group === 'owner');
}
function featureOn(key) { return featureVisible(featureStages[key], accessGroup); }
async function loadFeatureAccess() {
  const [flags, access] = await Promise.all([
    supabase.from('feature_flags').select('key, stage'),
    supabase.from('user_access').select('access_group').maybeSingle(),
  ]);
  if (flags.error || access.error) console.error('[Logbuch] Schalter nicht geladen', flags.error || access.error);
  featureStages = Object.fromEntries((flags.data || []).map((f) => [f.key, f.stage]));
  accessGroup = access.data?.access_group ?? null;
}
function clearFeatureAccess() { featureStages = {}; accessGroup = null; }

async function loadUserSettings() {
  const { data, error } = await supabase.from('user_settings')
    .select('default_reminder_minute, onboarding_completed, locale, summary_notifications, timezone, last_seen_changelog').maybeSingle();
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
  };
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentDek) syncTimezone();
  // Zurück aus den Handy-Einstellungen, wo Mitteilungen wieder erlaubt wurden: Anleitung
  // durch "Einschalten" ersetzen, ohne dass man neu laden muss.
  if (document.visibilityState === 'visible' && state.pushStatus === 'blocked' && pushOffStatus() !== 'blocked') {
    state.pushStatus = 'off';
    renderUnlessTyping();
  }
});

async function saveDefaultReminderMinute(minutes) {
  state.userSettings = { ...state.userSettings, defaultReminderMinute: minutes };
  render();
  const { error } = await supabase.from('user_settings')
    .upsert({ user_id: state.session.user.id, default_reminder_minute: minutes }, { onConflict: 'user_id' });
  if (error) {
    state.notice = errorNotice('notice.saveFailed', error.message);
    render();
  }
}

async function saveSummaryNotifications(enabled) {
  state.userSettings = { ...state.userSettings, summaryNotifications: enabled };
  render();
  const { error } = await supabase.from('user_settings')
    .upsert({ user_id: state.session.user.id, summary_notifications: enabled }, { onConflict: 'user_id' });
  if (error) {
    state.notice = errorNotice('notice.saveFailed', error.message);
    render();
  }
}

async function saveLocale(locale) {
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

// --- Verschlüsselungs-Lebenszyklus -------------------------------------------
async function fetchEncryptionRow(userId) {
  const { data, error } = await supabase.from('user_encryption').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function unwrapDekWithPassword(row, password) {
  const kek = await deriveKek(password, base64ToBuf(row.salt), row.kdf_iterations);
  return unwrapDek(row.wrapped_dek, row.wrap_iv, kek);
}

async function unwrapDekWithRecoveryKey(row, recoveryKeyHex) {
  const wrappingKey = await importRecoveryKeyAsCryptoKey(hexToBuf(recoveryKeyHex));
  return unwrapDek(row.wrapped_dek_recovery, row.recovery_wrap_iv, wrappingKey);
}

// Verschlüsselt alle noch im alten Klartext-Format vorliegenden habit_entries dieses
// Nutzers (einmalig, beim allerersten Setup). Bereits verschlüsselte Zeilen (erkennbar
// am {iv, ciphertext}-Format) werden übersprungen - macht die Funktion sicher erneut
// aufrufbar, falls sie mal unterbrochen wird.
async function migrateExistingEntries(userId, dek) {
  const { data: rows, error } = await supabase.from('habit_entries').select('id, data').eq('user_id', userId);
  if (error) throw error;
  for (const row of rows ?? []) {
    const isAlreadyEncrypted = row.data && typeof row.data === 'object' && 'iv' in row.data && 'ciphertext' in row.data;
    if (isAlreadyEncrypted) continue;
    const plain = row.data && typeof row.data === 'object' ? row.data : {};
    const enc = await encryptData(dek, plain);
    const { error: updErr } = await supabase.from('habit_entries')
      .update({ data: enc, filled_slugs: Object.keys(plain) })
      .eq('id', row.id);
    if (updErr) throw updErr;
  }
}

// Erzeugt DEK + Passwort-Wrapping + Recovery-Key-Wrapping neu, migriert bestehende
// Klartext-Einträge und markiert den Ersatzschlüssel als unbestätigt (spareKeyPending).
// Genutzt beim allerersten Setup (Neu-Signup oder Bestandskonto vor diesem Umbau) und beim
// "Recovery-Key auch verloren"-Fallback im Passwort-Reset (dort verliert der Nutzer bewusst
// seine alten Einträge) - NUR dort mit replace: true. Beim ersten Setup wird bewusst
// eingefügt statt überschrieben: meldet man sich auf zwei Geräten fast gleichzeitig zum
// ersten Mal an (z.B. App + Bestätigungslink im Browser), würde das zweite sonst den
// Schlüssel des ersten ersetzen - und was das erste inzwischen verschlüsselt hat, wäre
// unlesbar. Existiert die Zeile schon, wirft das einen KEY_EXISTS-Fehler (siehe
// unlockEncryption).
const KEY_EXISTS = 'key-exists';
async function setupEncryption(userId, password, { replace = false } = {}) {
  const dek = await generateDek();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKek(password, salt, PBKDF2_ITERATIONS);
  const { iv: wrapIv, wrapped: wrappedDek } = await wrapDek(dek, kek);

  const recoveryBytes = generateRecoveryKeyBytes();
  const recoveryKey = await importRecoveryKeyAsCryptoKey(recoveryBytes);
  const { iv: recoveryWrapIv, wrapped: wrappedDekRecovery } = await wrapDek(dek, recoveryKey);
  // Neuer DEK = neue Kennung - macht die Caches anderer Geräte ungültig (usableCachedDek).
  const dekId = crypto.randomUUID();

  const row = {
    user_id: userId,
    dek_id: dekId,
    salt: bufToBase64(salt),
    kdf_iterations: PBKDF2_ITERATIONS,
    wrap_iv: wrapIv,
    wrapped_dek: wrappedDek,
    recovery_wrap_iv: recoveryWrapIv,
    wrapped_dek_recovery: wrappedDekRecovery,
    recovery_key_confirmed: false,
  };
  const { error } = replace
    ? await supabase.from('user_encryption').upsert(row, { onConflict: 'user_id' })
    : await supabase.from('user_encryption').insert(row);
  if (error?.code === '23505') throw new Error(KEY_EXISTS);
  if (error) throw error;

  await migrateExistingEntries(userId, dek);

  setCurrentDek(dek, dekId, userId);
  await cacheDek(userId, dek, dekId);
  // Den gerade erzeugten Ersatzschlüssel bekommt niemand zu sehen - angezeigt wird erst
  // nach dem Tutorial ein frisch erzeugter (maybeShowSpareKey), damit der erste Eindruck
  // keine Sicherheitswarnung ist. Bis dahin ist das Konto einfach "unbestätigt".
  spareKeyPending = true;
}

// Der lokal gecachte DEK, sofern er noch der aktuelle des Kontos ist (row = dessen
// user_encryption-Zeile). Nach einem Passwort-Reset ohne Recovery-Key hat das Konto einen
// neuen DEK - ein Gerät mit altem Cache würde sonst weiter mit dem alten Schlüssel
// speichern, und alle übrigen Geräte könnten diese Einträge nicht lesen. Ein veralteter
// Cache wird deshalb gelöscht (stale: true, dann muss das Passwort her). Caches von vor
// der Kennung (dekId null) werden einmalig übernommen und bekommen sie nachgetragen
// (Nutzer-Entscheidung: kein erneutes Passwort für alle nach dem Update).
async function usableCachedDek(userId, row) {
  const cached = await loadCachedDek(userId).catch(() => null);
  if (!cached) return { dek: null, stale: false };
  if (row && (cached.dekId === null || cached.dekId === row.dek_id)) {
    if (cached.dekId === null) await cacheDek(userId, cached.dek, row.dek_id).catch(() => {});
    return { dek: cached.dek, stale: false };
  }
  await clearCachedDek(userId);
  return { dek: null, stale: Boolean(row) };
}

// Haupteinstieg nach erfolgreichem signIn/signUp (Passwort ist zu diesem Zeitpunkt im
// Klartext verfügbar). Schneller Pfad über den lokalen Cache, sonst Passwort-Ableitung;
// erstmaliger Aufruf für ein Konto legt die Verschlüsselung überhaupt erst an.
// verifyPassword: das Passwort kommt NICHT aus einer gerade erfolgreichen Anmeldung (die
// Entsperr-Maske, z.B. nach dem Bestätigungslink) - dann vor dem Einrichten bei Supabase
// prüfen. Sonst würde ein Tippfehler zum Schlüssel-Passwort, und auf jedem anderen Gerät
// hieße es danach für immer "Falsches Passwort". Bei bestehender Verschlüsselung prüft
// das Entpacken selbst (falsches Passwort -> wirft).
const WRONG_PASSWORD = 'wrong-password';
async function unlockEncryption(userId, password, { verifyPassword = false } = {}) {
  const row = await fetchEncryptionRow(userId);
  const { dek: cached } = await usableCachedDek(userId, row);
  if (cached) { setCurrentDek(cached, row.dek_id, userId); spareKeyPending = !row.recovery_key_confirmed; return; }

  if (!row) {
    if (verifyPassword) {
      const { error } = await supabase.auth.signInWithPassword({ email: state.session.user.email, password });
      if (error) throw new Error(/invalid login credentials/i.test(error.message) ? WRONG_PASSWORD : error.message);
    }
    state.encryptionSetupInProgress = true;
    render();
    try {
      await setupEncryption(userId, password);
      // Einmalig beim allerersten Login: die vom Gerät erkannte Sprache statt des
      // festen DB-Standards ('de', siehe Migration) übernehmen — sonst bliebe ein
      // Konto, dessen Registrierung z.B. schon auf Englisch angezeigt wurde (weil das
      // Gerät auf Englisch steht), nach dem Einloggen trotzdem auf Deutsch stehen, bis
      // manuell im Menü umgestellt wird. Best effort: schlägt der Schreibzugriff fehl,
      // bleibt einfach der DB-Standard bestehen, kein Grund, den Login abzubrechen.
      await supabase.from('user_settings')
        .update({ locale: detectInitialLocale() })
        .eq('user_id', userId);
      return;
    } catch (err) {
      // Ein anderes Gerät hat den Schlüssel gerade eben angelegt - dann einfach den
      // benutzen (unten), statt ihn zu ersetzen.
      if (err.message !== KEY_EXISTS) throw err;
    } finally {
      state.encryptionSetupInProgress = false;
    }
    return unlockEncryption(userId, password, { verifyPassword });
  }
  let dek;
  try {
    dek = await unwrapDekWithPassword(row, password);
  } catch {
    throw new Error(WRONG_PASSWORD);
  }
  setCurrentDek(dek, row.dek_id, userId);
  spareKeyPending = !row.recovery_key_confirmed;
  await cacheDek(userId, dek, row.dek_id);
  if (row.kdf_iterations < PBKDF2_ITERATIONS) upgradePasswordWrap(row, dek, password);
}

// Verpackt den DEK mit der aktuellen Rundenzahl neu (siehe PBKDF2_ITERATIONS) - im
// Hintergrund, best effort: klappt es nicht, bleibt die alte Verpackung gültig. Nur, wenn
// die Verpackung seit dem Laden unverändert ist (.eq wrapped_dek) - ein gleichzeitiger
// Passwort-Reset auf einem anderen Gerät darf nicht überschrieben werden.
async function upgradePasswordWrap(row, dek, password) {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKek(password, salt, PBKDF2_ITERATIONS);
    const { iv, wrapped } = await wrapDek(dek, kek);
    const { error } = await supabase.from('user_encryption')
      .update({ salt: bufToBase64(salt), kdf_iterations: PBKDF2_ITERATIONS, wrap_iv: iv, wrapped_dek: wrapped })
      .eq('user_id', row.user_id)
      .eq('wrapped_dek', row.wrapped_dek);
    if (error) console.warn('[Logbuch] Schlüssel-Verpackung nicht hochgestuft:', error.message);
  } catch (err) {
    console.warn('[Logbuch] Schlüssel-Verpackung nicht hochgestuft:', err);
  }
}

// Passwort ändern im angemeldeten Zustand. Das Passwort verpackt zugleich den DEK - beides
// muss zusammen wechseln, sonst passt nach dem nächsten Anmelden das Passwort nicht mehr zum
// Schlüssel. Der DEK selbst bleibt gleich (keine Daten neu verschlüsseln, Caches anderer
// Geräte und der Ersatzschlüssel bleiben gültig).
// Reihenfolge: erst die neue Verpackung speichern, dann das Passwort bei Supabase ändern.
// Lehnt Supabase ab (4xx: sicher nichts geändert), kommt die alte Verpackung zurück. Bei
// einem Verbindungsabbruch ist offen, ob Supabase geändert hat - dann bleibt die neue
// Verpackung stehen, und ein erneuter Versuch erkennt sie (das neue Passwort öffnet sie
// schon) und schließt nur noch den Rest ab.
// Wirft PASSWORD_CHANGE_WRONG_CURRENT, PASSWORD_CHANGE_INCOMPLETE (die neue Verpackung steht,
// das Passwort bei Supabase womöglich noch nicht - nur ein erneuter Versuch bringt beides
// wieder zusammen, das muss die Meldung sagen) oder den Supabase-Fehler.
const PASSWORD_CHANGE_WRONG_CURRENT = 'password-change-wrong-current';
const PASSWORD_CHANGE_INCOMPLETE = 'password-change-incomplete';
async function changePassword(current, next) {
  const userId = state.session.user.id;
  const row = await fetchEncryptionRow(userId);
  if (!row) throw new Error(t('recovery.error.noConfig'));
  let dek = null;
  try { dek = await unwrapDekWithPassword(row, current); } catch { /* evtl. früherer Versuch */ }
  let wrapDone = false;
  if (!dek) {
    try { await unwrapDekWithPassword(row, next); wrapDone = true; } catch { throw new Error(PASSWORD_CHANGE_WRONG_CURRENT); }
  }
  let newWrapped = null;
  if (!wrapDone) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKek(next, salt, PBKDF2_ITERATIONS);
    const { iv, wrapped } = await wrapDek(dek, kek);
    // .eq wrapped_dek: nur, wenn seit dem Laden niemand anders die Verpackung geändert hat.
    const { data, error } = await supabase.from('user_encryption')
      .update({ salt: bufToBase64(salt), kdf_iterations: PBKDF2_ITERATIONS, wrap_iv: iv, wrapped_dek: wrapped })
      .eq('user_id', userId)
      .eq('wrapped_dek', row.wrapped_dek)
      .select('user_id');
    if (error) throw error;
    if (!data.length) throw new Error('wrapping changed meanwhile');
    newWrapped = wrapped;
  }
  // current_password: Supabase verlangt es ("Require current password when updating",
  // siehe docs/datenschutz-sicherheit.md) - nur der Link aus "Passwort vergessen" ist ausgenommen.
  const { error } = await supabase.auth.updateUser({ password: next, current_password: current });
  if (error) {
    // Früherer Versuch abgebrochen: hat Supabase das neue Passwort schon, ist alles fertig.
    if (wrapDone && error.code === 'current_password_invalid') {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: state.session.user.email, password: next });
      if (!signInError) return;
    }
    let wrapIsNew = Boolean(newWrapped) || wrapDone;
    if (newWrapped && error.status >= 400 && error.status < 500) {
      const { error: rollbackError } = await supabase.from('user_encryption')
        .update({ salt: row.salt, kdf_iterations: row.kdf_iterations, wrap_iv: row.wrap_iv, wrapped_dek: row.wrapped_dek })
        .eq('user_id', userId)
        .eq('wrapped_dek', newWrapped);
      if (rollbackError) console.warn('[Logbuch] Alte Schlüssel-Verpackung nicht zurückgeschrieben:', rollbackError.message);
      else wrapIsNew = false;
    }
    if (error.code === 'current_password_invalid' || error.code === 'current_password_required') throw new Error(PASSWORD_CHANGE_WRONG_CURRENT);
    if (wrapIsNew) throw new Error(PASSWORD_CHANGE_INCOMPLETE);
    throw error;
  }
}

async function handleEmailChangeSubmit() {
  const ec = state.emailChange;
  if (!ec || ec.busy) return;
  ec.value = document.getElementById('email-change-input').value.trim();
  ec.password = document.getElementById('email-change-password').value;
  ec.error = null;
  if (ec.value.toLowerCase() === (state.session?.user?.email ?? '').toLowerCase()) {
    ec.error = t('emailChange.error.same');
    render();
    document.getElementById('email-change-input')?.select();
    return;
  }
  ec.busy = true;
  render();
  // Passwort nur hier auf dem Gerät prüfen (öffnet es den Schlüssel?) - Supabase selbst
  // verlangt es für die Adresse nicht.
  try {
    const row = await fetchEncryptionRow(state.session.user.id);
    if (!row) throw new Error(t('recovery.error.noConfig'));
    try { await unwrapDekWithPassword(row, ec.password); } catch {
      ec.busy = false;
      ec.error = t('emailChange.error.wrongPassword');
      render();
      document.getElementById('email-change-password')?.select();
      return;
    }
  } catch (err) {
    ec.busy = false;
    ec.error = errorNotice('emailChange.error.failed', err?.message || String(err)).text;
    render();
    return;
  }
  // locale: die Bestätigungs-Mails sind zweisprachig über .Data.locale (wie bei der
  // Registrierung) - ältere Konten haben es noch nicht.
  const { error } = await supabase.auth.updateUser(
    { email: ec.value, data: { locale: currentLocale } },
    { emailRedirectTo: window.location.origin + window.location.pathname },
  );
  ec.busy = false;
  if (error) {
    ec.error = error.code === 'email_exists' ? t('emailChange.error.taken')
      : error.code === 'email_address_invalid' || error.code === 'validation_failed' ? t('emailChange.error.invalid')
      : error.code === 'over_email_send_rate_limit' ? t('emailChange.error.rateLimit')
      : errorNotice('emailChange.error.failed', error.message).text;
    render();
    document.getElementById('email-change-input')?.focus();
    return;
  }
  ec.sentTo = ec.value;
  ec.password = '';
  render();
}

async function handleSpareKeyCheckSubmit() {
  const sc = state.spareKeyCheck;
  if (!sc || sc.busy) return;
  sc.value = document.getElementById('spare-key-check-input').value;
  sc.busy = true;
  sc.result = null;
  render();
  let row;
  try {
    row = await fetchEncryptionRow(state.session.user.id);
    if (!row) throw new Error(t('recovery.error.noConfig'));
  } catch (err) {
    sc.busy = false;
    sc.result = 'error';
    sc.errorText = errorNotice('spareKeyCheck.failed', err?.message || String(err)).text;
    render();
    return;
  }
  try { await unwrapDekWithRecoveryKey(row, sc.value); sc.result = 'ok'; } catch { sc.result = 'wrong'; }
  sc.busy = false;
  render();
  if (sc.result === 'wrong') document.getElementById('spare-key-check-input')?.select();
}

async function handlePasswordChangeSubmit() {
  const pc = state.passwordChange;
  if (!pc || pc.busy) return;
  pc.current = document.getElementById('password-change-current').value;
  pc.next = document.getElementById('password-change-new').value;
  pc.error = null;
  let focusId = null;
  if (pc.current === pc.next) {
    pc.error = t('passwordChange.error.same');
    focusId = 'password-change-new';
  } else {
    pc.busy = true;
    render();
    try {
      await changePassword(pc.current, pc.next);
      // Wie beim Passwort-Reset: andere Geräte abmelden (Supabase tut es nicht von selbst).
      try { await supabase.auth.signOut({ scope: 'others' }); } catch { /* best effort */ }
      state.passwordChange = null;
      state.notice = { type: 'ok', text: t('passwordChange.saved') };
      render();
      restoreModalFocus();
      return;
    } catch (err) {
      pc.busy = false;
      if (err?.message === PASSWORD_CHANGE_WRONG_CURRENT) {
        pc.error = t('passwordChange.error.wrongCurrent');
        focusId = 'password-change-current';
      } else if (err?.message === PASSWORD_CHANGE_INCOMPLETE) {
        pc.error = t('passwordChange.error.incomplete');
      } else if (err?.code === 'same_password') {
        pc.error = t('passwordChange.error.same');
        focusId = 'password-change-new';
      } else if (err?.code === 'weak_password') {
        pc.error = translateAuthError(err.message);
        focusId = 'password-change-new';
      } else {
        pc.error = errorNotice('passwordChange.error.failed', err?.message || String(err)).text;
      }
    }
  }
  render();
  if (focusId) document.getElementById(focusId)?.select();
}

// Meldung für einen fehlgeschlagenen Entsperr-Versuch: "Falsches Passwort" nur, wenn es
// wirklich am Passwort lag - ein Netzwerkfehler beim Laden der Schlüssel-Zeile soll nicht
// so aussehen.
function unlockErrorText(err) {
  if (err?.message === WRONG_PASSWORD) return t('unlock.wrongPassword');
  const raw = err?.message || String(err);
  const friendly = translateDbError(raw);
  return `${t('unlock.failed')} ${friendly !== raw ? friendly : t('notice.tryAgain')}`;
}

// Beim Zurückkehren in die App: wurde der DEK inzwischen auf einem anderen Gerät neu
// erzeugt (Reset ohne Recovery-Key), bleibt dieses Gerät sonst bis zum Ablauf seines
// Zugangs-Tokens (bis zu 1 h) angemeldet und speichert mit dem alten Schlüssel. Dann
// alles Geladene verwerfen - ausstehende Speicherungen bewusst NICHT mehr senden, sie
// wären mit dem alten Schlüssel verschlüsselt - und das Passwort neu abfragen.
// Netzwerkfehler: still, beim nächsten Zurückkehren wird erneut geprüft.
async function checkDekStillCurrent() {
  if (!currentDek || !currentDekId || !state.session || authFlowInFlight) return;
  const userId = state.session.user.id;
  let row;
  try { row = await fetchEncryptionRow(userId); } catch { return; }
  if (!row || row.dek_id === currentDekId || !currentDek) return;
  dropPendingDaySaves();
  await clearCachedDek(userId);
  clearLoadedAccountState();
  state.menuOpen = false;
  state.habitForm = null;
  state.unlockError = t('unlock.keyChanged');
  render();
}
// --- Rückkehr in die App -------------------------------------------------------
// Eine installierte App bleibt oft tage- oder nächtelang im Hintergrund offen. Beim
// Zurückkehren: 1. Schlüssel noch aktuell? (checkDekStillCurrent) 2. Ein neuer Tag hat
// begonnen - wer auf dem damaligen "heute" stand, landet auf dem neuen (sonst trüge man
// abends in den Vortag ein, neben dem Datum stand nur klein "Gestern"); wer bewusst woanders
// hingeblättert hat, bleibt dort. 3. Nach längerer Abwesenheit die Daten neu laden - auf
// einem anderen Gerät kann inzwischen etwas eingetragen worden sein.
const RETURN_REFRESH_AFTER_MS = 5 * 60 * 1000;
let hiddenSince = null;
let lastKnownTodayKey = formatKey(new Date());
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') { hiddenSince = Date.now(); return; }
  const awayMs = hiddenSince ? Date.now() - hiddenSince : 0;
  hiddenSince = null;
  await checkDekStillCurrent();
  const rolledOver = rollOverToNewDay();
  if (awayMs >= RETURN_REFRESH_AFTER_MS) await refreshAfterReturn();
  else if (rolledOver && !isEditingSomething()) renderUnlessTyping();
});
function rollOverToNewDay() {
  const todayKey = formatKey(new Date());
  if (todayKey === lastKnownTodayKey) return false;
  const oldToday = parseDateKey(lastKnownTodayKey);
  const now = startOfDay(new Date());
  lastKnownTodayKey = todayKey;
  if (formatKey(state.currentDate) === formatKey(oldToday)) state.currentDate = now;
  if (formatKey(state.weekAnchor) === formatKey(startOfWeek(oldToday))) state.weekAnchor = startOfWeek(now);
  if (state.monthAnchor.getFullYear() === oldToday.getFullYear() && state.monthAnchor.getMonth() === oldToday.getMonth()) {
    const m = new Date(now); m.setDate(1); state.monthAnchor = m;
  }
  if (state.yearAnchor === oldToday.getFullYear()) state.yearAnchor = now.getFullYear();
  return true;
}
// Offene Formulare/Editoren: ein Neuzeichnen würde Getipptes verwerfen bzw. mitten im
// Bearbeiten den Stand austauschen - dann weder neu laden noch neu zeichnen.
function isEditingSomething() {
  return Boolean(state.habitForm || state.sectionForm || state.noteEditor);
}
async function refreshAfterReturn() {
  if (!currentDek || !state.session || authFlowInFlight || state.loading || isEditingSomething()) return;
  await Promise.all([loadEntries({ keepLocalChanges: true }), loadHabits(), loadSections()]);
  if (!currentDek) return;
  invalidateTodayAutoCollapse(); // zählt als neues Betreten des Tages
  saveFieldNamesForPush();
  if (!isEditingSomething()) renderUnlessTyping();
}

// Für den "Recovery-Key neu erzeugen"-Menüpunkt: nutzt den bereits im Speicher
// gehaltenen DEK direkt (kein Passwort nötig), macht den bisherigen Code ungültig.
// onlyIfUnconfirmed (automatische Anzeige, maybeShowSpareKey): nur ersetzen, solange der
// Schlüssel serverseitig noch unbestätigt ist - hat man ihn inzwischen auf einem anderen
// Gerät bestätigt, würde ein neuer den dort gespeicherten sonst still ungültig machen.
async function regenerateRecoveryKey({ onlyIfUnconfirmed = false } = {}) {
  if (!currentDek || !state.session) return;
  const recoveryBytes = generateRecoveryKeyBytes();
  const recoveryKey = await importRecoveryKeyAsCryptoKey(recoveryBytes);
  const { iv: recoveryWrapIv, wrapped: wrappedDekRecovery } = await wrapDek(currentDek, recoveryKey);
  // Unbestätigt, bis der Nutzer das Speichern abhakt - schließt er vorher, ist der alte
  // schon ungültig und der neue ungesehen, dann gibt es beim nächsten Öffnen einen neuen.
  let query = supabase.from('user_encryption')
    .update({ recovery_wrap_iv: recoveryWrapIv, wrapped_dek_recovery: wrappedDekRecovery, recovery_key_confirmed: false })
    .eq('user_id', state.session.user.id);
  if (onlyIfUnconfirmed) query = query.eq('recovery_key_confirmed', false);
  const { data, error } = await query.select('user_id');
  if (error) {
    state.notice = errorNotice('notice.recoveryKeySaveError', error.message);
    render();
    return;
  }
  if (!data.length) { spareKeyPending = false; return; } // schon anderswo bestätigt
  spareKeyPending = true;
  state.menuOpen = false;
  // wrapped: woran confirmSpareKey erkennt, ob noch genau DIESER Schlüssel gilt.
  state.recoveryKeyToShow = { hex: bufToHex(recoveryBytes), wrapped: wrappedDekRecovery };
  render();
  document.querySelector('.onb h1')?.focus({ preventScroll: true });
}
// Unbestätigten Ersatzschlüssel anzeigen - aber erst, wenn das Tutorial durch ist (bzw.
// übersprungen wurde): der erste Eindruck soll keine Sicherheitswarnung sein. Aufgerufen
// nach jedem Laden des Kontos und nach dem Tutorial.
let spareKeyInFlight = false;
async function maybeShowSpareKey() {
  if (!spareKeyPending || spareKeyInFlight || !currentDek || !state.session
    || state.recoveryKeyToShow || state.loading || !state.userSettings.onboardingCompleted) return;
  spareKeyInFlight = true;
  try { await regenerateRecoveryKey({ onlyIfUnconfirmed: true }); } finally { spareKeyInFlight = false; }
}
// Bestätigt nur, wenn in der Datenbank noch genau der angezeigte Schlüssel steht. Hat ein
// anderes Gerät ihn inzwischen ersetzt (dort ebenfalls angezeigt oder im Menü neu
// erzeugt), wäre der hier gezeigte ungültig - dann erklären und einen neuen zeigen, statt
// ihn als gesichert zu markieren.
async function confirmSpareKey() {
  const shown = state.recoveryKeyToShow;
  state.recoveryKeyToShow = null;
  render();
  if (!spareKeyPending || !state.session || !shown) return;
  const { data, error } = await supabase.from('user_encryption')
    .update({ recovery_key_confirmed: true })
    .eq('user_id', state.session.user.id)
    .eq('wrapped_dek_recovery', shown.wrapped)
    .select('user_id');
  if (error) {
    state.notice = errorNotice('notice.saveFailed', error.message);
    render();
    return;
  }
  if (!data.length) {
    await regenerateRecoveryKey();
    state.notice = { type: 'error', text: t('recoveryDisplay.replacedElsewhere') };
    render();
    return;
  }
  spareKeyPending = false;
  const finishedOnboarding = isOnbInProgress();
  setOnbInProgress(false); // Einrichten abgeschlossen
  if (finishedOnboarding) {
    setTodayIntroPending(true); // danach einmal die Karte(n) in "Heute"
    render();
  }
}

// --- Felder-Verwaltung -----------------------------------------------------
// Bringt ein Bezeichnungs-Array auf die aktuelle Stufenzahl, ohne bereits eingetippten
// Text an gleicher Position zu verwerfen - gebraucht bei jeder Änderung von Von/Bis
// bzw. der Schieberegler-Stufenzahl (siehe 'habit-range-change'/'habit-labels-toggle'
// weiter unten), unabhängig davon, ob Bezeichnungen aktuell aktiv sind, damit das Array
// beim späteren Aktivieren schon die richtige Länge hat. defaultForIndex (optional)
// befüllt neue/leere Positionen statt mit '' - beim Aktivieren der Bezeichnungen bleibt
// so zunächst die Zahl als Text stehen (siehe 'habit-labels-toggle'), macht sichtbar,
// dass es weiterhin dieselbe Skala ist, bis man sie überschreibt.
function resizeLabels(labels, newLength, defaultForIndex) {
  return Array.from({ length: Math.max(0, newLength) }, (_, i) => labels[i] || (defaultForIndex ? defaultForIndex(i) : ''));
}
// Aktuelle Stufenzahl eines Skala-Formulars, abgeleitet aus Darstellung + Bereich -
// einzige Quelle dafür, sowohl für die Bezeichnungs-Liste als auch die Live-Vorschau.
// Erinnerungstag eines Zeitraum-Felds (habit_definitions.period_reminder_day): Woche ISO-
// Wochentag 1-7, Monat 1-31 oder -1 = letzter Tag, Jahr MMTT. Standard: Sonntag / letzter
// Tag / 31.12. (gespeichert als null).
const PERIOD_REMINDER_DEFAULT = { week: 7, month: -1, year: 1231 };
function periodReminderControl(f) {
  const day = f.periodReminderDay ?? PERIOD_REMINDER_DEFAULT[f.period];
  const dayOptions = (selected) => Array.from({ length: 31 }, (_, i) => i + 1)
    .map((d) => `<option value="${d}" ${d === selected ? 'selected' : ''}>${d}.</option>`).join('');
  let control;
  if (f.period === 'week') {
    control = `<select id="habit-form-period-day">${Array.from({ length: 7 }, (_, i) => i + 1)
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

function habitFormStepCount(f) {
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
function goalControlHtml(f) {
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
function goalSliderText(f, value) {
  const text = tPlain(f.good === 'low' ? 'habitForm.goalUpTo' : 'habitForm.goalFrom', { value: formatNumber(value) });
  if (!f.labelsEnabled) return { text, span: '' };
  const lower = Math.floor(value + 0.05);
  const upper = Math.ceil(value - 0.05);
  const at = (v) => tPlain('habitForm.goalLabelAt', { label: goalScaleLabel(f, v - f.min), value: formatNumber(v) });
  return { text, span: lower >= upper ? at(lower) : tPlain('habitForm.goalBetween', { a: at(lower), b: at(upper) }) };
}
// Ziel einer Zahl / eines Zählers: keins / mindestens / höchstens + Zahl.
function numberGoalField(f) {
  const unit = (f.unit || '').trim();
  return `
    <div class="auth-field">
      <label id="habit-form-numgoal-label">${t('habitForm.numberGoal')}</label>
      <div class="pill-group seg" role="group" aria-labelledby="habit-form-numgoal-label">
        ${[['', 'habitForm.numberGoal.none'], ['high', 'habitForm.numberGoal.min'], ['low', 'habitForm.numberGoal.max']].map(([d, key]) => `<button type="button" class="pill-toggle${(f.numberGoalDir || '') === d ? ' pill-toggle--active' : ''}" data-action="habit-numgoal" data-dir="${d}" aria-pressed="${(f.numberGoalDir || '') === d}">${t(key)}</button>`).join('')}
      </div>
      ${f.numberGoalDir ? `
        <div class="schedule-inline">
          <input type="number" id="habit-form-numgoal-value" inputmode="decimal" step="any" min="0" value="${esc(f.numberGoalValue)}" aria-labelledby="habit-form-numgoal-label" aria-describedby="habit-form-goal-note" />
          ${unit ? `<span>${esc(unit)}</span>` : ''}
        </div>
      ` : ''}
      <p class="habit-form-lock-note" id="habit-form-goal-note">${t(f.numberGoalDir ? 'habitForm.numberGoalNote' : 'habitForm.goalNote')}</p>
    </div>
  `;
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
const CHOICE_STEP_CAP = 7;
const SLIDER_STEP_CAP = 100;
function habitFormStepCap(f) {
  return f.displayStyle === 'buttons' || f.labelsEnabled ? CHOICE_STEP_CAP : SLIDER_STEP_CAP;
}
// Gesperrtes Feld (hat Daten, Stufenzahl fest): würde diese Darstellung die Obergrenze
// für gezielt wählbare Stufen erst überschreiten? Was das Feld schon vorher so hatte
// (z.B. 12 Buttons aus der Zeit vor der Grenze), bleibt erlaubt.
function lockedChoiceBlocked(f, displayStyle, labelsEnabled) {
  if (!f.locked || habitFormStepCount(f) <= CHOICE_STEP_CAP) return false;
  const original = state.habits.find((h) => h.defId === f.defId);
  return (displayStyle === 'buttons' && original?.displayStyle !== 'buttons')
    || (labelsEnabled && !original?.labels);
}
// Der zugrundeliegende Zahlenwert der i-ten Stufe - f.min ist bei neuen/noch leeren
// Feldern immer 1 (siehe defaultHabitForm), bei bereits bestehenden Feldern deren
// echtes, ggf. historisch anderes min (z.B. alte Schieberegler-Felder mit Basis 0).
function habitFormStepValue(f, i) {
  return f.min + i;
}
// Deckelt die aktuelle Stufenzahl auf den je nach Darstellung/Bezeichnungen gültigen
// Höchstwert (habitFormStepCap) - gebraucht beim Wechsel der Darstellung oder beim
// Aktivieren von Bezeichnungen, da f.max zwischen beiden Darstellungen geteilt wird.
// Gesperrte Felder nie: deren Stufenzahl ist fest (siehe lockedChoiceBlocked).
function clampHabitFormSteps(f) {
  if (f.locked) return;
  f.max = Math.min(f.max, f.min + habitFormStepCap(f) - 1);
}

// Neue (bzw. noch unbefüllte) Skala-Felder starten immer bei 1 - kein frei wählbares
// "Von" mehr, unabhängig von Buttons/Schieberegler (siehe habitFormStepCount/-StepValue
// unten). Wer andere Bezeichnungen will, nutzt dafür Bezeichnungen statt eines
// verschobenen Zahlenbereichs. Bereits bestehende (ggf. historisch andere) Felder
// behalten beim Bearbeiten ihr echtes min (siehe habitToForm) - nur Von/Bis sind bei
// vorhandenen Daten ohnehin gesperrt (Tier 3, siehe CLAUDE.md).
function defaultHabitForm() {
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
    step: 1, // nur Zähler
    numberGoalDir: null, numberGoalValue: '', // Zahl/Zähler: Ziel 'high' = mindestens, 'low' = höchstens
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
function scheduleToForm(schedule) {
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
function habitFormSummable(f) {
  return f.kind === 'number' || f.kind === 'counter' || (f.kind === 'computed' && f.computedType !== 'scale' && f.computedType !== 'since');
}

function habitToForm(h) {
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
    step: h.step ?? 1,
    numberGoalDir: isNumberKind(h) || isCounterKind(h) ? h.good || null : null,
    numberGoalValue: Number.isFinite(h.target) ? String(h.target) : '',
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
function syncHabitFormFromDom() {
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
    const numGoalEl = document.getElementById('habit-form-numgoal-value');
    if (numGoalEl) f.numberGoalValue = numGoalEl.value;
  }
  readPeriodReminderFromDom(f);
  readReminderTimesFromDom(f);
  const everyEl = document.getElementById('habit-form-every');
  if (everyEl) f.schedule.every = everyEl.value;
  const startEl = document.getElementById('habit-form-every-start');
  if (startEl) f.schedule.start = startEl.value;
  const showInStatsEl = document.getElementById('habit-form-show-in-stats');
  if (showInStatsEl) f.showInStats = showInStatsEl.checked;
  const sectionEl = document.getElementById('habit-form-section');
  if (sectionEl) f.sectionId = sectionEl.value || null;
}

async function handleHabitSave() {
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
    // Die Meldung erscheint oben auf der Seite (siehe renderApp) - bei einem langen
    // Formular weiter unten sonst außerhalb des sichtbaren Bereichs, ohne dass man
    // merkt, warum das Speichern scheinbar nichts getan hat.
    if (state.notice) {
      requestAnimationFrame(() => {
        document.querySelector('.notice')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }
}

// Aus einem Formular-Zustand die zu speichernde Definition - nur aus f, nie aus der Seite
// (das Formular liest syncHabitFormFromDom vorher ein), damit Vorlagen dieselben Felder anlegen
// wie das Formular, ohne dass es angezeigt wird. -> { name, fields, period, periodReminderDay,
// reminderTimes, reminderBelow } oder { notice } bei einer ungültigen Eingabe.
function habitFormDefinition(f) {
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
    // Ziel: "mindestens/höchstens X" - mit Richtung braucht es eine Zahl (bei "mindestens" > 0).
    const goalRaw = f.numberGoalValue;
    const target = f.numberGoalDir ? Number(String(goalRaw).replace(',', '.')) : null;
    if (f.numberGoalDir && (!Number.isFinite(target) || target < 0 || (f.numberGoalDir === 'high' && target === 0))) {
      return { notice: { type: 'error', text: t('habitForm.error.numberGoal') } };
    }
    fields = { kind: f.kind, min: null, max: null, labels: null, good: f.numberGoalDir, target, unit: unit || null, display_style: 'buttons', slider_show_value: true, group_members: null, goal_threshold: null };
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
  // Standard entspricht (Sonntag / letzter Tag / 31.12.) - eine Darstellung für "Standard".
  // Uhrzeiten nur als Tagesfeld - "ins Bett" einmal pro Woche ergibt keinen Sinn. Mehrfachauswahl
  // vorerst auch (ihre Auswertung zählt Tage).
  const period = f.kind === 'computed' || f.kind === 'time' || f.kind === 'multi' ? 'day' : f.period;
  const periodReminderDay = period === 'day' || f.periodReminderDay === null || f.periodReminderDay === PERIOD_REMINDER_DEFAULT[period]
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

  return { name, fields, period, periodReminderDay, reminderTimes, reminderBelow };
}

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
  const { name, fields, period, periodReminderDay, reminderTimes, reminderBelow } = def;

  // Alles Inhaltliche verschlüsselt in enc (siehe habitFromParts), im Klartext nur, was
  // die Erinnerungen brauchen. Immer die vollständige payload - bei gesperrten Feldern
  // enthält fields schon die unveränderten Original-Werte für min/max.
  const key = f.defId ? state.habits.find((h) => h.defId === f.defId).id : newHabitKey();
  const payload = {
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
    summary: habitFormSummable(f) && f.summary === 'sum' ? 'sum' : undefined,
    archivedInStats: f.defId ? !!state.habits.find((h) => h.defId === f.defId)?.archivedInStats : false,
    counterSince: f.kind === 'counter' && f.defId ? state.habits.find((h) => h.defId === f.defId)?.counterSince ?? undefined : undefined,
    reminderBelow,
    stepChange: f.kind === 'scale' && f.defId ? state.habits.find((h) => h.defId === f.defId)?.stepChange ?? undefined : undefined,
  };
  const sectionId = period === 'day' && state.sections.some((sec) => sec.id === f.sectionId) ? f.sectionId : null;
  const row = {
    kind: fields.kind,
    schedule: fields.schedule,
    reminder_minute: reminderTimes[0] ?? null,
    reminder_minutes: reminderTimes.length > 1 ? reminderTimes : null,
    section_id: sectionId,
    period,
    period_reminder_day: periodReminderDay,
    enc: await encryptData(currentDek, payload),
    ...DEF_PLAINTEXT_CLEARED,
  };
  // Neues oder in eine andere Gruppe verschobenes Feld: ans Ende seines Behälters.
  const original = f.defId ? state.habits.find((h) => h.defId === f.defId) : null;
  if (!original || (original.sectionId || null) !== sectionId) row.sort_order = containerMaxSortOrder(sectionId) + 1;
  if (f.defId) {
    const { data, error } = await supabase.from('habit_definitions').update(row).eq('id', f.defId).select().single();
    if (error) {
      state.notice = errorNotice('notice.saveFailed', error.message);
      return;
    }
    const idx = state.habits.findIndex((h) => h.defId === f.defId);
    state.habits[idx] = habitFromParts(data, payload);
  } else {
    const { data, error } = await supabase.from('habit_definitions')
      .insert({ user_id: state.session.user.id, ...row })
      .select().single();
    if (error) {
      state.notice = errorNotice('notice.createFailed', error.message);
      return;
    }
    state.habits = [...state.habits, habitFromParts(data, payload)];
    if (state.tutorialStep === TUTORIAL_STEP_FIELD) tutorialLastFieldDefId = data.id;
  }
  saveFieldNamesForPush();
  // Ziel oder Zeiten eines Zählers geändert: den Erinnerungs-Stand von heute neu schreiben.
  const today = formatKey(new Date());
  if (fields.kind === 'counter' && state.entries[today]) saveDay(today);

  closeHabitForm();
  // Im Tutorial (Schritt 2, erstes Feld) gilt jedes erfolgreich angelegte (oder über
  // "Zurück" nochmal bearbeitete) Feld als Abschluss des Schritts – automatischer Sprung zu
  // "Geschafft", kein zusätzlicher Klick.
  if (state.tutorialStep === TUTORIAL_STEP_FIELD) state.tutorialStep = TUTORIAL_STEP_DONE;
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
function canConvertToCounter(f) {
  return !!f.defId && f.locked && (f.kind === 'number' || (f.kind === 'scale' && f.min === 0));
}
async function convertHabitToCounter(defId) {
  const h = state.habits.find((x) => x.defId === defId);
  if (!h) return;
  // Ziel übernehmen: aus einer Skala mit Bewertung wird "mindestens/höchstens" der Wert, ab dem
  // sie voll erreicht war (z.B. Zähne 0-2, hohe Werte gut -> mindestens 2).
  let good = null, target = null;
  if (h.kind === 'number') { good = h.good || null; target = h.target ?? null; }
  else if (h.good) {
    const g = h.goalThreshold ?? 1;
    good = h.good;
    target = h.good === 'high' ? h.min + g * (h.max - h.min) : h.min + (1 - g) * (h.max - h.min);
    target = Math.round(target * 10) / 10;
  }
  const payload = {
    key: h.id, name: h.name, unit: h.kind === 'number' ? h.unit ?? null : null, target,
    min: null, max: null, labels: null, good, displayStyle: 'buttons', sliderShowValue: true,
    groupMembers: null, goalThreshold: null, aggregate: null,
    hideInStats: !!h.hideInStats, archivedInStats: !!h.archivedInStats,
    step: 1, counterSince: formatKey(new Date()),
  };
  const { data, error } = await supabase.from('habit_definitions')
    .update({ kind: 'counter', reminder_minute: null, reminder_minutes: null, enc: await encryptData(currentDek, payload), ...DEF_PLAINTEXT_CLEARED })
    .eq('id', defId).select().single();
  if (error) {
    state.notice = errorNotice('notice.saveFailed', error.message);
    render();
    return;
  }
  state.habits = state.habits.map((x) => (x.defId === defId ? habitFromParts(data, payload) : x));
  saveFieldNamesForPush();
  closeHabitForm();
  state.notice = { type: 'ok', text: tPlain('habitForm.convertDone', { name: h.name }) };
  render();
}

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
function valueAsText(def, v) {
  if ((def.kind ?? 'scale') === 'scale') return def.labels?.[v - def.min] || formatNumber(v);
  return def.unit ? `${formatNumber(v)} ${def.unit}` : formatNumber(v);
}
// Neuer Wert eines alten (null = entfernen): die Zuordnung des Nutzers, sonst der Vorschlag
// (z.B. für Werte, die inzwischen auf einem anderen Gerät eingetragen wurden).
function stepChangeMapValue(sc, old) {
  const key = String(old);
  return key in sc.map ? sc.map[key] : stepChangeConvert(sc.from, sc.to, sc.preset ?? 'spread', old, sc.range);
}
function isTypeChange(sc) {
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
function remapSince(since, sc, undo, stagesNow) {
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
async function startStepChange(defId, to, map, extra = {}) {
  const h = state.habits.find((x) => x.defId === defId);
  if (!h) return false;
  const from = Object.fromEntries(Object.keys(to).map((k) => [k, h[k] ?? null]));
  const sc = { id: stepChangeId(), date: formatKey(new Date()), state: 'apply', from, to, map, ...extra };
  if (!(await markStepChange(h, sc))) return false;
  return runStepChange(defId);
}
async function startStepChangeUndo(defId) {
  const h = state.habits.find((x) => x.defId === defId);
  if (!h || !stepChangeUndoable(h)) return false;
  if (!(await markStepChange(h, { ...h.stepChange, state: 'undo' }))) return false;
  return runStepChange(defId);
}
// Schreibt alle noch offenen Tage einer laufenden Umstellung (bzw. Rückgängig) und setzt danach
// die Definition. Rückgabe: true = fertig. Fortschritt direkt ins DOM (#step-change-progress),
// ohne render() je Tag.
async function runStepChange(defId) {
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
    let done = 0, failed = 0;
    const queue = [...todo];
    const showProgress = () => {
      const el = document.getElementById('step-change-progress');
      if (el) el.textContent = tPlain('stepEdit.progress', { done: done + failed, total: todo.length });
    };
    showProgress();
    const worker = async () => {
      while (queue.length) {
        const dateKey = queue.shift();
        const before = state.entries[dateKey];
        const changed = transform(before);
        state.entries = { ...state.entries, [dateKey]: changed };
        if (await saveDay(dateKey)) done++;
        else {
          failed++;
          // Nicht gespeichert: den alten Stand zurück, sonst hielte der nächste Lauf den Tag für fertig.
          if (state.entries[dateKey] === changed) state.entries = { ...state.entries, [dateKey]: before };
        }
        showProgress();
      }
    };
    await Promise.all(Array.from({ length: STEP_CHANGE_PARALLEL }, worker));
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
function stepEditKey(se) {
  return JSON.stringify([se.steps, se.labels, se.map]);
}
function stepEditCap(h) {
  return h.displayStyle === 'buttons' || h.labels ? CHOICE_STEP_CAP : SLIDER_STEP_CAP;
}
function stepEditFrom(h) {
  return { min: h.min, max: h.max, labels: h.labels ?? null };
}
function stepEditTo(h, se) {
  return { min: h.min, max: h.min + se.steps - 1, labels: se.labels ? se.labels.map((l) => l.trim()) : null };
}
function applyStepEditPreset(h, se) {
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
function stepEditCountChanged(h, se, steps) {
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
function stepEditSummary(h, se) {
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
function stepEditNothingToDo(h, se) {
  const to = stepEditTo(h, se);
  return to.max === h.max && Object.entries(se.map).every(([k, v]) => v === Number(k))
    && JSON.stringify(to.labels) === JSON.stringify(h.labels ?? null);
}
// Teil "Anzahl Stufen" eines gesperrten Skala-Felds im Formular: Anzeige, Rückgängig,
// "Stufen ändern". Das Ändern selbst läuft im eigenen Dialog (renderStepDialog) - ein eigener
// Mechanismus mit Folgen für alle Einträge, der sich vom übrigen Formular abheben soll.
function stepEditHtml(f) {
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
function stepDialogOpen() {
  const f = state.habitForm;
  return !!f && (!!f.stepEdit || !!f.typeEdit || !!f.stepUndoConfirm || stepChangeRunning.has(f.defId) || stepChangeStarting.has(f.defId));
}
// Escape, Android-Zurück: wie "Abbrechen" bzw. in der Rückfrage "Zurück". Ist im Dialog schon
// etwas eingestellt, erst die übliche Rückfrage "Änderungen verwerfen?". Während des Umstellens
// nichts (der Lauf soll zu Ende kommen).
function closeStepDialog() {
  const f = state.habitForm;
  if (!f || stepChangeRunning.has(f.defId) || stepChangeStarting.has(f.defId)) return;
  if (f.stepUndoConfirm) { f.stepUndoConfirm = false; return; }
  const se = f.stepEdit ?? f.typeEdit;
  if (!se) return;
  if (se.confirm) { se.confirm = false; return; }
  syncHabitFormFromDom();
  if ((f.stepEdit ? stepEditKey(se) : typeEditKey(se)) === se.initial) { f.stepEdit = null; f.typeEdit = null; return; }
  pendingFormLeave = () => { if (state.habitForm) { state.habitForm.stepEdit = null; state.habitForm.typeEdit = null; } };
  state.leaveFormConfirm = true;
  modalTriggerSelector = '#step-dialog-title'; // "Weiter bearbeiten" führt zurück in den Dialog
}
function renderStepDialog() {
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
function finishStepChangeAction(f, ok, doneKey, typeChange = false) {
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
async function resumeStepChanges() {
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
// Alle Eigenschaften, die vom Typ abhängen - from hält sie fest, Rückgängig stellt sie wieder her.
const TYPE_CHANGE_KEYS = ['kind', 'min', 'max', 'labels', 'good', 'goalThreshold', 'target', 'unit', 'displayStyle', 'sliderShowValue', 'step', 'reminderBelow', 'counterSince'];
const TYPE_MAP_ROWS_MAX = 20; // mehr verschiedene alte Werte: keine Einzel-Zuordnung, nur die Regel
function typeChangeTargets(h) {
  if (h.kind === 'scale') return ['number', 'text'];
  if (h.kind === 'number' || h.kind === 'counter') return ['scale', 'text'];
  return [];
}
function typeChangeBlocker(h) {
  return state.habits.find((x) => x.kind === 'computed' && (x.members || []).includes(h.id)) ?? null;
}
function kindLabel(kind) {
  return tPlain({ scale: 'habitForm.kindScale', number: 'habitForm.kindNumber', text: 'habitForm.kindText', counter: 'habitForm.kindCounter', time: 'habitForm.kindTime', multi: 'habitForm.kindMulti' }[kind] ?? 'habitForm.kindText');
}
function usedValueRange(h) {
  const used = usedStepValues(h);
  return used.length ? { lo: used[0][0], hi: used[used.length - 1][0] } : { lo: 1, hi: 1 };
}
// Formular-Zustand: f.typeEdit = { kind, steps, preset ('round'|'spread'|'custom', nur Skala),
// unit, map { "<alt>": neu }, confirm }. map hält bei Zahl/Text den Text der Eingabefelder
// (umgerechnet erst in typeEditFinalMap), bei Skala die gewählte Stufe bzw. null.
function typeEditKey(te) {
  return JSON.stringify([te.kind, te.steps, te.preset, te.unit, te.map]);
}
function typeEditScaleMin(h, te) {
  // "Runden" mit Werten unter 1 (z.B. 0 Gläser): die Skala beginnt bei 0 statt sie alle auf 1 zu legen.
  return te.preset === 'round' && usedValueRange(h).lo < 1 ? 0 : 1;
}
function typeEditTo(h, te) {
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
function applyTypeEditPreset(h, te) {
  const rows = typeEditRows(h);
  if (!rows) { te.map = {}; return; }
  const to = typeEditTo(h, te);
  const range = usedValueRange(h);
  te.map = Object.fromEntries(rows.map(([v]) => {
    const value = stepChangeConvert(h, to, te.preset, v, range);
    return [String(v), te.kind === 'scale' ? value : String(value)];
  }));
}
function typeEditKindChanged(h, te, kind) {
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
function typeEditStepsChanged(h, te, steps) {
  te.steps = steps;
  if (te.preset !== 'custom') { applyTypeEditPreset(h, te); return; }
  const max = typeEditTo(h, te).max;
  for (const k of Object.keys(te.map)) if (te.map[k] !== null) te.map[k] = Math.min(max, te.map[k]);
}
// -> { map } oder { error } (Zahl nicht lesbar). Leeres Eingabefeld = Eintrag entfernen.
function typeEditFinalMap(te) {
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
function typeEditSummary(h, te) {
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
function typeEditHtml(f) {
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

async function handleHabitArchive(defId, archive) {
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
// 'habit'|'section', id, moveOut? }. moveOut: Feld verlässt dabei seine Gruppe (beim
// Löschen einer Gruppe). Gemeinsamer Pfad für Ziehen UND die ↑/↓-Buttons, damit beide
// exakt gleich speichern.
async function commitLayoutOrder(items) {
  const order = new Map(items.map((it, i) => [it.id, i + 1]));
  const movedOut = new Set(items.filter((it) => it.moveOut).map((it) => it.id));
  state.habits = state.habits
    .map((h) => (order.has(h.defId) ? { ...h, sortOrder: order.get(h.defId), sectionId: movedOut.has(h.defId) ? null : h.sectionId } : h))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  state.sections = state.sections
    .map((sec) => (order.has(sec.id) ? { ...sec, sortOrder: order.get(sec.id) } : sec))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  render();

  const results = await Promise.all(items.map((it, i) => (it.type === 'section'
    ? supabase.from('habit_sections').update({ sort_order: i + 1 }).eq('id', it.id)
    : supabase.from('habit_definitions').update({ sort_order: i + 1, ...(it.moveOut ? { section_id: null } : {}) }).eq('id', it.id))));
  const failed = results.find((r) => r.error);
  if (failed) {
    state.notice = errorNotice('notice.reorderFailed', failed.error.message);
    render();
  }
}

// --- Gruppen (intern: sections) - Formular -------------------------------------
// Eigene Ebene der Verwaltung wie das Feld-Formular (openHabitForm): Name + Liste aller
// aktiven Felder zum Ankreuzen, beliebig gemischt. Ein Feld kann nur in EINER Gruppe
// sein - Felder aus einer anderen Gruppe erscheinen ausgegraut mit deren Namen. Scroll-
// Position und Rückweg teilen sich den Mechanismus des Feld-Formulars.
// returnToTab: aus dem Zeilen-Menü in "Heute" geöffnet - danach dorthin zurück (wie beim
// Feld-Formular, siehe closeHabitForm).
function openSectionForm(id, { returnToTab = false } = {}) {
  habitFormReturnScrollY = window.scrollY;
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
function closeSectionForm() {
  const returnToTab = state.sectionForm?.returnToTab;
  state.sectionForm = null;
  if (returnToTab && state.view === 'manage') state.view = state.previousTabView || 'today';
  pendingScrollRestore = habitFormReturnScrollY;
  habitFormReturnScrollY = null;
}
function readSectionFormFromDom() {
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
async function saveSectionForm() {
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
    const sortOrder = containerMaxSortOrder(null) + 1;
    const { data, error } = await supabase.from('habit_sections')
      .insert({ user_id: state.session.user.id, enc, sort_order: sortOrder, reminder_minute: reminderMinute })
      .select().single();
    if (error) {
      state.notice = errorNotice('notice.createFailed', error.message);
      render();
      return;
    }
    id = data.id;
    state.sections = [...state.sections, { id, name, collapse, sortOrder, reminderMinute }];
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
function renderSectionForm() {
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
async function deleteSection(id) {
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

async function handleHabitDelete(defId) {
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

// --- Notizen ---------------------------------------------------------------
// Liegen verschlüsselt im selben Tagesobjekt wie die Werte, unter EINEM reservierten
// Schlüssel: { mood: 3, _notes: { mood: "…", _day: "…" } }. Kann nie mit einem Feld
// kollidieren: Feld-Schlüssel bestehen nur aus a-z0-9 (alte aus dem Namen abgeleitete
// wie "mood", neue zufällige aus newHabitKey). Alles mit "_" am Anfang ist dadurch
// "kein Feldwert" - wichtig v.a. für filled_slugs (siehe filledFieldIds): eine Notiz
// allein zählt für die Erinnerungen nicht als eingetragen. Die Werte-Logik (Scores,
// Graphen, habitHasData, ...) greift immer gezielt per Feld-Schlüssel zu und sieht den
// Notiz-Schlüssel nie.
const NOTES_KEY = '_notes';
const DAY_NOTE_KEY = '_day';
// Notizen zu einer Gruppe: unter 'section:<id>' (gleicher Schlüssel wie ihr Zeilen-Menü).
// Kollidiert nie mit Feld-Schlüsseln (nur a-z0-9) oder _day.
const SECTION_NOTE_PREFIX = 'section:';
// Eine Gruppe steht in "Heute" nur, wenn heute mindestens eines ihrer aktiven Felder
// geplant ist (siehe renderToday/renderBySection) - nur dann ist ihre Notiz sichtbar.
function sectionShownToday(sectionId) {
  return state.sections.some((sec) => sec.id === sectionId)
    && activeHabits().some((h) => h.sectionId === sectionId && isPlannedOn(h, state.currentDate));
}
function keyHasNotes(key) {
  return Object.values(state.entries).some((day) => day?.[NOTES_KEY]?.[key] !== undefined);
}
function getNote(dateKey, key) {
  return state.entries[dateKey]?.[NOTES_KEY]?.[key] ?? '';
}
function dayHasNote(dateKey) {
  return Object.keys(state.entries[dateKey]?.[NOTES_KEY] ?? {}).length > 0;
}
// Gibt das Tagesobjekt mit gesetzter (bzw. bei leerem Text entfernter) Notiz zurück -
// ohne verbleibende Notizen verschwindet auch der _notes-Schlüssel selbst wieder.
function withNote(day, key, text) {
  const notes = { ...(day[NOTES_KEY] || {}) };
  if (text) notes[key] = text;
  else delete notes[key];
  const next = { ...day };
  if (Object.keys(notes).length) next[NOTES_KEY] = notes;
  else delete next[NOTES_KEY];
  return next;
}
// Sicherung der Werte von vor "Stufen ändern" (siehe runStepChange): im selben Tagesobjekt
// unter { _prev: { <Feld>: { c: <Umstellungs-Id>, v: <alter Wert> } } }. Wie bei withNote
// verschwindet _prev ohne Inhalt wieder; backup undefined entfernt den Eintrag des Felds.
const PREV_KEY = '_prev';
function withPrev(day, key, backup) {
  const prev = { ...(day[PREV_KEY] || {}) };
  if (backup !== undefined) prev[key] = backup;
  else delete prev[key];
  const next = { ...day };
  if (Object.keys(prev).length) next[PREV_KEY] = prev;
  else delete next[PREV_KEY];
  return next;
}
const NOTE_MAX_LENGTH = 2000;
// Schreibt den Entwurf eines offenen Editors in den Tages-Eintrag (nur wenn er sich
// vom gespeicherten Stand unterscheidet), ohne den Editor zu schließen.
function persistNoteDraft() {
  const ed = state.noteEditor;
  if (!ed) return;
  const text = ed.draft.trim().slice(0, NOTE_MAX_LENGTH);
  if (text === getNote(ed.dateKey, ed.key)) return;
  const day = withNote(state.entries[ed.dateKey] || {}, ed.key, text);
  state.entries = { ...state.entries, [ed.dateKey]: day };
  saveDay(ed.dateKey);
}
// Speichern und schließen. Außer über den Speichern-Button auch immer dann, wenn der
// Editor nicht mehr sichtbar ist (Tag-/Tab-Wechsel, anderer Editor geöffnet, siehe
// render()) - Getipptes soll nie still verloren gehen oder unbemerkt ungespeichert
// herumliegen. Auch Android-Zurück speichert (closeTopLayer); nur "Abbrechen" verwirft bewusst.
function commitPendingNoteDraft() {
  persistNoteDraft();
  state.noteEditor = null;
}
// Abbrechen: stellt den Stand von vor dem Öffnen wieder her - nötig, weil ein Wechsel
// in eine andere App den Entwurf zwischendurch schon gespeichert haben kann (siehe
// visibilitychange-Listener).
function discardNoteDraft() {
  const ed = state.noteEditor;
  if (!ed) return;
  state.noteEditor = null;
  if (getNote(ed.dateKey, ed.key) === ed.original) return;
  const day = withNote(state.entries[ed.dateKey] || {}, ed.key, ed.original);
  state.entries = { ...state.entries, [ed.dateKey]: day };
  saveDay(ed.dateKey);
}
function openNoteEditor(key) {
  const dateKey = entryKeyFor(key, formatKey(state.currentDate)); // Notiz eines Zeitraum-Felds: am Zeitraum
  // Schon offen (z.B. erneut über das Zeilen-Menü gewählt, während man darin schreibt):
  // nichts neu anlegen, nur zurück ins Textfeld - sonst passierte scheinbar gar nichts.
  if (!(state.noteEditor?.dateKey === dateKey && state.noteEditor.key === key)) {
    commitPendingNoteDraft();
    const original = getNote(dateKey, key);
    state.noteEditor = { dateKey, key, draft: original, original };
  }
  render();
  const input = document.getElementById('note-input');
  if (input) {
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    ensureNoteEditorVisible();
  }
}
// Hält Textfeld + Speichern/Abbrechen im sichtbaren Bereich, auch wenn die
// Bildschirmtastatur aufgeht: die verkleinert auf Android/iOS nur den *visuellen*
// Viewport (window.visualViewport), nicht das Layout - scrollIntoView() allein weiß
// davon nichts und ließ den Editor unter der Tastatur. Deshalb von Hand gegen die
// visualViewport-Maße gerechnet, aufgerufen beim Öffnen und bei jeder Größenänderung
// des visuellen Viewports (Tastatur geht auf), solange die Textarea den Fokus hat.
// Oben zusätzlich der angepinnte Header (.sticky-top), unter dem nichts landen soll.
// Unterkante des angepinnten Kopfs (Header + Tab-Leiste) - 0, wenn er gerade nicht
// angepinnt ist (wenig Höhe, siehe @media max-height in logbuch.html): dann verdeckt er
// nichts, und seine Position beim Scrollen spielt keine Rolle.
function stickyHeaderBottom() {
  const el = document.querySelector('.sticky-top');
  if (!el || getComputedStyle(el).position !== 'sticky') return 0;
  return Math.max(0, el.getBoundingClientRect().bottom);
}
function ensureNoteEditorVisible() {
  const editor = document.querySelector('.note-editor');
  if (!editor || document.activeElement?.id !== 'note-input') return;
  const vv = window.visualViewport;
  const viewTop = (vv ? vv.offsetTop : 0) + (stickyHeaderBottom());
  const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const margin = 12;
  const r = editor.getBoundingClientRect();
  if (r.bottom + margin > viewBottom) window.scrollBy(0, Math.min(r.bottom + margin - viewBottom, r.top - viewTop - margin));
  else if (r.top - margin < viewTop) window.scrollBy(0, r.top - margin - viewTop);
}
// Die Tastatur fährt animiert auf und feuert dabei mehrere resize-Events - beim ersten
// ist sie oft erst halb offen. Deshalb sofort UND nach dem Ende der Animation (kein
// weiteres resize mehr für 250ms) nachrechnen, sonst blieb ein Teil verdeckt.
let noteEditorSettleTimer = null;
function onViewportResize() {
  ensureNoteEditorVisible();
  clearTimeout(noteEditorSettleTimer);
  noteEditorSettleTimer = setTimeout(ensureNoteEditorVisible, 250);
}
window.visualViewport?.addEventListener('resize', onViewportResize);
window.addEventListener('resize', onViewportResize);
// Beim Wechsel in eine andere App (oder Sperren des Handys) den Entwurf schon mal
// sichern - der Browser kann die Seite im Hintergrund jederzeit verwerfen. Der Editor
// bleibt dabei offen, man schreibt nach der Rückkehr einfach weiter.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { persistNoteDraft(); flushAllDaySaves(); }
});
// Speichern UND Abbrechen: danach zurück auf das Element, von dem aus man gekommen ist
// (⋮-Button des Feldes bzw. der Tagesnotiz-Bereich), da render() den Fokus sonst verwirft.
// Der Entwurf ist über den 'input'-Listener immer aktuell in state.noteEditor.draft.
function closeNoteEditor(save) {
  const { key } = state.noteEditor;
  if (save) commitPendingNoteDraft();
  else discardNoteDraft();
  render();
  const focusTarget = key === DAY_NOTE_KEY
    ? document.querySelector('.day-note [data-action="note-edit"]')
    : document.querySelector(`.row-menu-trigger[data-menu="${key}"]`);
  focusTarget?.focus({ preventScroll: true });
}

// Für filled_slugs (Erinnerungen): die IDs der Felder mit Wert an dem Tag - nicht ihre
// Schlüssel (bei alten Feldern aus dem Namen abgeleitet, z.B. "gekifft"). Notizen
// (_-Schlüssel) und Werte endgültig gelöschter Felder fallen weg.
function filledFieldIds(dayData) {
  return Object.keys(dayData)
    .filter((k) => !k.startsWith('_'))
    .map((k) => (state.habits.find((h) => h.id === k) || state.unsupportedHabits.find((h) => h.id === k))?.defId)
    .filter(Boolean);
}

// Für reminder_progress (Erinnerungen an Zähler, Nutzer-Entscheidung 2026-10-28): je Zähler
// mit eigenen Zeiten und Bedingungen ("falls weniger als", counterReminderThresholds), wie
// viele davon erfüllt sind - Stufe i ist erreicht, sobald der Zählerstand die i-te Zahl
// erreicht. Der Server sieht nur die Stufe, nicht Zählerstand oder Zahlen. Zähler ohne
// Bedingungen fehlen hier: die erinnern zu jeder ihrer Zeiten (Stufe 0).
function reminderProgress(dayData) {
  const progress = {};
  for (const h of state.habits) {
    if (!isCounterKind(h) || isPeriodField(h) || h.archivedAt || !h.reminderTimes.length) continue;
    const thresholds = counterReminderThresholds(h);
    if (thresholds.some((x) => x === null)) continue;
    const count = Number(dayData[h.id]) || 0;
    let reached = 0;
    while (reached < thresholds.length && count >= thresholds[reached]) reached++;
    progress[h.defId] = reached;
  }
  return progress;
}

// Ändert einzelne verschlüsselte Eigenschaften eines bestehenden Felds (außerhalb des
// Feld-Formulars, z.B. "In der Auswertung anzeigen" bei archivierten Feldern): baut die
// vollständige payload aus dem Feld-Objekt, verschlüsselt neu und speichert sie. Leert
// dabei vorsorglich die Klartext-Spalten (falls das Feld noch unverschlüsselt war).
async function updateHabitPayload(habit, changes) {
  const next = { ...habit, ...changes };
  const payload = {
    key: next.id, name: next.name, unit: next.unit ?? null, min: next.min ?? null, max: next.max ?? null,
    labels: next.labels ?? null, good: next.good ?? null, displayStyle: next.displayStyle ?? 'buttons',
    sliderShowValue: next.sliderShowValue ?? true, groupMembers: next.members ?? null,
    goalThreshold: next.goalThreshold ?? null, aggregate: next.aggregate ?? null, since: next.since ?? undefined, options: next.options ?? undefined,
    hideInStats: !!next.hideInStats, archivedInStats: !!next.archivedInStats,
    // Ohne diese gingen Ziel/Schritt/Summe einer Zahl bzw. eines Zählers hier still verloren.
    step: isCounterKind(next) ? next.step : undefined, target: next.target ?? undefined,
    summary: next.summary === 'sum' ? 'sum' : undefined, counterSince: next.counterSince ?? undefined,
    reminderBelow: next.reminderBelow ?? undefined, stepChange: next.stepChange ?? undefined,
  };
  const enc = await encryptData(currentDek, payload);
  // Typwechsel (siehe startStepChange): kind steht im Klartext, weil die Erinnerungen ihn brauchen.
  const kindChange = next.kind !== habit.kind ? { kind: next.kind } : {};
  const { error } = await supabase.from('habit_definitions').update({ enc, ...DEF_PLAINTEXT_CLEARED, ...kindChange }).eq('id', habit.defId);
  if (error) {
    state.notice = errorNotice('notice.saveFailed', error.message);
    render();
    return false;
  }
  state.habits = state.habits.map((h) => (h.defId === habit.defId ? next : h));
  render();
  return true;
}

// --- Speichern eines Tages -------------------------------------------------
// Ein Tag ist EIN verschlüsseltes Objekt (alle Werte + Notizen). Zwei Gefahren dabei:
// 1. Mehrere Geräte: ein Gerät mit veraltetem Stand (App seit gestern im Hintergrund
//    offen) würde beim Speichern die inzwischen anderswo eingetragenen Werte des Tages
//    still überschreiben. Deshalb wird vor jedem Schreiben die aktuelle Zeile geholt; hat
//    sie sich seit unserem letzten bekannten Stand (syncedEntries, erkennbar am IV) geändert,
//    werden beide Stände Schlüssel für Schlüssel zusammengeführt (mergeDay).
// 2. Schnelle Änderungen hintereinander: jede ist ein eigener Request - kämen sie in
//    falscher Reihenfolge an, bliebe der ältere Stand gespeichert. Deshalb laufen die
//    Speicherungen eines Tages nacheinander (daySaveChains), und jede schreibt den dann
//    AKTUELLEN Stand aus state.entries (Aufrufer ändern state.entries immer vorher) - keine
//    ältere Momentaufnahme.
const syncedEntries = new Map(); // dateKey -> { day, iv } - zuletzt bekannter Server-Stand
const daySaveChains = new Map(); // dateKey -> Promise der letzten eingereihten Speicherung
function saveDay(dateKey) {
  const prev = daySaveChains.get(dateKey) || Promise.resolve();
  const next = prev.then(() => saveDayNow(dateKey));
  daySaveChains.set(dateKey, next);
  next.finally(() => { if (daySaveChains.get(dateKey) === next) daySaveChains.delete(dateKey); });
  return next;
}
// Rückgabe: true = gespeichert (gebraucht von runStepChange, die anderen Aufrufer melden
// Fehler nur über die Meldung).
async function saveDayNow(dateKey) {
  if (undecryptableEntryDates.has(dateKey)) {
    state.entries = { ...state.entries, [dateKey]: {} }; // die Änderung nicht stehen lassen - sie ist ja nicht gespeichert
    state.notice = { type: 'error', text: t('notice.dayUndecryptable') };
    render();
    return false;
  }
  if (!currentDek || !state.session) return false; // inzwischen abgemeldet / Schlüssel verworfen
  try {
    const { data: row, error: fetchErr } = await supabase.from('habit_entries')
      .select('data').eq('entry_date', dateKey).maybeSingle();
    if (fetchErr) throw fetchErr;
    const base = syncedEntries.get(dateKey) || { day: {}, iv: null };
    let day = state.entries[dateKey] || {};
    if ((row?.data?.iv ?? null) !== base.iv) {
      // Seit unserem letzten Stand hat ein anderes Gerät diesen Tag gespeichert.
      let server;
      try {
        server = row?.data ? await decryptData(currentDek, row.data) : {};
      } catch {
        undecryptableEntryDates.add(dateKey);
        return saveDayNow(dateKey); // -> Meldung, nichts überschreiben
      }
      day = mergeDay(base.day, day, server);
      state.entries = { ...state.entries, [dateKey]: day };
      renderUnlessTyping();
    }
    if (!currentDek) return false;
    const encrypted = await encryptData(currentDek, day);
    const { error } = await supabase
      .from('habit_entries')
      .upsert(
        { user_id: state.session.user.id, entry_date: dateKey, data: encrypted, filled_slugs: filledFieldIds(day), reminder_progress: reminderProgress(day) },
        { onConflict: 'user_id,entry_date' }
      );
    if (error) throw error;
    syncedEntries.set(dateKey, { day, iv: encrypted.iv });
    return true;
  } catch (err) {
    state.notice = errorNotice('notice.saveFailed', err?.message || String(err));
    render();
    return false;
  }
}
// Dreiwege-Zusammenführung eines Tages: was WIR seit dem gemeinsamen Stand (base)
// geändert haben, gewinnt; alles andere kommt vom Server (die Änderungen des anderen
// Geräts). Pro Feld-Schlüssel und pro Notiz einzeln.
function mergeDay(base, local, server) {
  const pick = (b, l, s) => {
    const out = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(s)])) {
      if (k === NOTES_KEY) continue;
      const v = JSON.stringify(l[k]) !== JSON.stringify(b[k]) ? l[k] : s[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  const merged = pick(base, local, server);
  const notes = pick(base[NOTES_KEY] || {}, local[NOTES_KEY] || {}, server[NOTES_KEY] || {});
  if (Object.keys(notes).length) merged[NOTES_KEY] = notes;
  return merged;
}
// Neu zeichnen - außer jemand tippt gerade (Fokus in einem Eingabefeld): render() baut
// die Ansicht neu auf und würde Cursor/Tastatur mitten im Schreiben zurücksetzen. Der
// zusammengeführte Stand erscheint dann beim nächsten regulären Neuzeichnen.
function renderUnlessTyping() {
  const el = document.activeElement;
  if (el && app.contains(el) && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'range'))) {
    syncTodayOpenMarkers();
    return;
  }
  render();
}

// Ein entfernter Wert lässt sich über die Meldung wiederherstellen. Gilt für alle: wer
// einen Wert "zur Sicherheit nochmal antippt", entfernt ihn (Umschalten, siehe
// handleSelect) - vorher ging er dabei still verloren.
function offerUndoRemoval(dateKey, habitId, previous) {
  const habit = state.habits.find((h) => h.id === habitId);
  state.notice = {
    type: 'ok',
    text: tPlain('notice.valueRemoved', { name: habit?.name ?? '' }),
    action: {
      label: t('notice.undo'),
      run: () => {
        const day = { ...(state.entries[dateKey] || {}) };
        if (day[habitId] !== undefined) return; // inzwischen neu eingetragen
        day[habitId] = previous;
        state.entries = { ...state.entries, [dateKey]: day };
        render();
        saveDay(dateKey);
      },
    },
  };
}

function handleSelect(dateKey, habitId, value) {
  dateKey = entryKeyFor(habitId, dateKey);
  const day = { ...(state.entries[dateKey] || {}) };
  if (day[habitId] === value) {
    delete day[habitId];
    offerUndoRemoval(dateKey, habitId, value);
  } else day[habitId] = value;
  state.entries = { ...state.entries, [dateKey]: day };
  haptic();
  render();
  saveDay(dateKey);
}

// Mehrfachauswahl: optionId = Option an-/abwählen, null = "nichts davon" (nochmal = wieder leer).
// Wird die letzte Option abgewählt, ist das Feld wieder offen (wie das Abwählen einer Stufe);
// "nichts davon" ist eine bewusste Angabe und steht deshalb für sich.
function handleMultiToggle(dateKey, habitId, optionId) {
  dateKey = entryKeyFor(habitId, dateKey);
  const day = { ...(state.entries[dateKey] || {}) };
  const prev = Array.isArray(day[habitId]) ? day[habitId] : null;
  let next;
  if (optionId === null) next = prev?.length === 0 ? null : [];
  else {
    next = prev?.includes(optionId) ? prev.filter((x) => x !== optionId) : [...(prev || []), optionId];
    if (!next.length) next = null;
  }
  if (next) day[habitId] = next;
  else {
    delete day[habitId];
    if (prev) offerUndoRemoval(dateKey, habitId, prev);
  }
  state.entries = { ...state.entries, [dateKey]: day };
  haptic();
  render();
  saveDay(dateKey);
}

// Schieberegler: setzt immer (nie das Umschalten von handleSelect, wo derselbe Wert
// ein zweites Mal den Eintrag entfernt - beim Regler ist "loslassen auf demselben Wert"
// keine Absicht zum Löschen, dafür gibt es das ×). Idempotent, da der Regler-Commit auf
// zwei Wegen ankommen kann (siehe 'change' und 'pointerup' weiter unten).
function handleSetValue(dateKey, habitId, value) {
  dateKey = entryKeyFor(habitId, dateKey);
  const day = { ...(state.entries[dateKey] || {}) };
  if (day[habitId] === value) return;
  day[habitId] = value;
  state.entries = { ...state.entries, [dateKey]: day };
  haptic();
  render();
  saveDay(dateKey);
}

// Text-Felder (kind='text'): jeder Tastendruck aktualisiert sofort state.entries (ohne
// render() - das würde Fokus/Cursor stören; ein anderweitig ausgelöster Re-Render zeigt
// so trotzdem immer den aktuellen Text), gespeichert wird aber erst, wenn eine Sekunde
// lang nicht mehr getippt wurde - sonst ein verschlüsselter Upsert pro Buchstabe.
// Sofort gespeichert wird zusätzlich beim Verlassen des Feldes ('change'), beim
// Wechsel in eine andere App und beim Abmelden (flushAllDaySaves).
const TEXT_SAVE_DELAY_MS = 1000;
const pendingDaySaves = new Map(); // dateKey -> Timer
function updateTextValue(dateKey, habitId, raw) {
  dateKey = entryKeyFor(habitId, dateKey);
  const day = { ...(state.entries[dateKey] || {}) };
  if (raw.trim()) day[habitId] = raw.slice(0, NOTE_MAX_LENGTH);
  else delete day[habitId];
  state.entries = { ...state.entries, [dateKey]: day };
  syncTodayOpenMarkers();
  clearTimeout(pendingDaySaves.get(dateKey));
  pendingDaySaves.set(dateKey, setTimeout(() => flushDaySave(dateKey), TEXT_SAVE_DELAY_MS));
}
function flushDaySave(dateKey) {
  if (!pendingDaySaves.has(dateKey)) return;
  clearTimeout(pendingDaySaves.get(dateKey));
  pendingDaySaves.delete(dateKey);
  if (!currentDek || !state.session) return;
  saveDay(dateKey);
}
function flushAllDaySaves() {
  [...pendingDaySaves.keys()].forEach(flushDaySave);
}
// Verwirft ausstehende Speicherungen ungesendet (veralteter Schlüssel, checkDekStillCurrent).
function dropPendingDaySaves() {
  pendingDaySaves.forEach((timer) => clearTimeout(timer));
  pendingDaySaves.clear();
}

// Löscht Werte UND Notizen des Tages - deshalb immer erst nach Rückfrage
// (renderResetConfirm), nie direkt über den Button.
function handleReset(dateKey) {
  state.entries = { ...state.entries, [dateKey]: {} };
  if (state.noteEditor?.dateKey === dateKey) state.noteEditor = null;
  render();
  saveDay(dateKey);
}

// Einzelnen Eintrag löschen (nicht den ganzen Tag) — für den Slider gebraucht, der
// anders als Buttons (nochmal klicken) oder Zahlenfeld (leeren) sonst keine
// Möglichkeit hat, einen Wert wieder auszutragen.
function handleClearValue(dateKey, habitId) {
  dateKey = entryKeyFor(habitId, dateKey);
  const day = { ...(state.entries[dateKey] || {}) };
  if (day[habitId] !== undefined) offerUndoRemoval(dateKey, habitId, day[habitId]);
  delete day[habitId];
  state.entries = { ...state.entries, [dateKey]: day };
  haptic();
  render();
  saveDay(dateKey);
}

// Zähler um einen Schritt ändern; nie unter 0. Auf 0 heruntergezählt = kein Eintrag (gilt
// ohnehin als 0). Gerundet, damit z.B. 0,1-Schritte keine Fließkomma-Reste ansammeln.
function handleCounterStep(dateKey, habitId, dir) {
  dateKey = entryKeyFor(habitId, dateKey);
  const h = state.habits.find((x) => x.id === habitId);
  if (!h) return;
  const day = { ...(state.entries[dateKey] || {}) };
  const next = Math.max(0, Math.round(((day[habitId] ?? 0) + dir * h.step) * 1e6) / 1e6);
  if (next === 0) delete day[habitId]; else day[habitId] = next;
  state.entries = { ...state.entries, [dateKey]: day };
  haptic();
  render();
  saveDay(dateKey);
}

function handleSaveNumber(dateKey, habitId, rawValue) {
  dateKey = entryKeyFor(habitId, dateKey);
  const day = { ...(state.entries[dateKey] || {}) };
  const trimmed = String(rawValue).trim().replace(',', '.');
  if (trimmed === '') {
    delete day[habitId];
  } else {
    const num = Number(trimmed);
    // Number statt parseFloat: "12abc" ist keine Zahl; isFinite: "1e400" wäre Infinity und
    // würde als null gespeichert (JSON kennt kein Infinity).
    if (!Number.isFinite(num)) {
      state.notice = { type: 'error', text: t('notice.invalidNumber') };
      render();
      return;
    }
    day[habitId] = num;
  }
  state.entries = { ...state.entries, [dateKey]: day };
  render();
  saveDay(dateKey);
}

function findLastValue(habitId, beforeOrOnDateKey) {
  const keys = Object.keys(state.entries)
    .filter((k) => k <= beforeOrOnDateKey && state.entries[k]?.[habitId] !== undefined)
    .sort();
  if (!keys.length) return null;
  const lastKey = keys[keys.length - 1];
  return { dateKey: lastKey, value: state.entries[lastKey][habitId] };
}

// --- "Zum Homescreen hinzufügen"-Hinweis --------------------------------
// Auf iOS funktioniert Web-Push NUR, wenn die Seite zum Home-Bildschirm hinzugefügt
// wurde (harte Plattform-Einschränkung seit iOS 16.4, kein normaler Safari-Tab-Push
// möglich) - auf Android/Desktop ist das "nice to have", kein Muss. Deshalb früh und
// deutlich darauf hinweisen, mit iOS-spezifischer Anleitung.
function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

// iOS übernimmt beim Start einer über "Zum Home-Bildschirm" installierten Web-App
// manchmal einen alten Zoom-Stand (z.B. von Safari zum Zeitpunkt des Hinzufügens)
// statt bei initial-scale=1.0 zu starten — wirkt wie "leicht reingezoomt". Fix ohne
// Zoomen dauerhaft zu sperren: den Viewport kurz auf maximum-scale=1 setzen (zwingt
// iOS, auf 100% zurückzuspringen), danach die Beschränkung sofort wieder entfernen,
// damit Pinch-to-Zoom für den Nutzer weiterhin uneingeschränkt funktioniert.
function resetIOSZoomOnStandaloneStart() {
  if (!isIOSDevice() || !isStandaloneDisplay()) return;
  const viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) return;
  const original = viewport.getAttribute('content');
  viewport.setAttribute('content', original + ', maximum-scale=1.0');
  setTimeout(() => viewport.setAttribute('content', original), 300);
}
function isInstallHintDismissed() {
  try { return localStorage.getItem('installHintDismissed') === 'true'; } catch { return false; /* z.B. privater Modus */ }
}

// Alle aufklappbaren Abschnitte in "Über Logbuch" (hervorgehobene Bereiche und
// Tipp-Gruppen) sind bei JEDEM Öffnen der Seite zugeklappt (Nutzer-Wunsch 2026-09-27) -
// kein dauerhaftes Merken mehr. Was man während eines Besuchs aufklappt, bleibt nur so
// lange offen, wie man auf der Seite ist (übersteht einen Re-Render), enterSubpage
// setzt es beim nächsten Öffnen zurück.
let openAboutSections = new Set();
function isAboutSectionCollapsed(key) {
  return !openAboutSections.has(key);
}
function installHintText() {
  return isIOSDevice() ? t('installHint.ios') : t('installHint.other');
}
function isMobileDevice() {
  return isIOSDevice() || /Android/.test(navigator.userAgent);
}
// Der dauerhafte In-App-Hinweis lohnt sich nur auf Mobilgeräten: auf iOS ist die
// Installation zwingend für Push (siehe oben), auf Android zumindest ein spürbares
// Plus. Auf Desktop funktioniert Push schon im normalen Browser-Tab genauso
// zuverlässig — "installieren" brächte dort nur kosmetische Vorteile (eigenes
// Fenster), das würde der bisherige Text aber fälschlich als Zuverlässigkeits-Vorteil
// verkaufen. Statt den Text zu verwässern, blendet der Hinweis auf Desktop komplett
// aus (genau wie die Installations-Seite vor dem Anmelden, renderInstallGate).
// Handy im Browser (nicht als App geöffnet): nur dann gibt es Hinweis und Menüpunkt.
function canInstallFromHere() { return isMobileDevice() && !isStandaloneDisplay(); }
function renderInstallHint() {
  if (!canInstallFromHere() || isInstallHintDismissed() || state.view === 'install') return '';
  return `
    <div class="install-hint">
      <span>${esc(installHintText())}<button type="button" class="install-hint-show" data-action="open-install">${t('installHint.show')}</button></span>
      <button type="button" class="install-hint-close" data-action="dismiss-install-hint" aria-label="${esc(t('ariaLabel.dismissHint'))}">×</button>
    </div>
  `;
}

// --- Push-Benachrichtigungen ------------------------------------------
async function checkPushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    state.pushStatus = 'unsupported';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    const sub = await reg.pushManager.getSubscription();
    // Das Abo des Browsers gehört nicht zwingend zu diesem Konto: es kann von einem
    // anderen Konto auf diesem Gerät stammen oder serverseitig schon aufgeräumt sein
    // (abgelaufen). Fehlt die eigene Server-Zeile, ist es für dieses Konto nutzlos - dann
    // kündigen, damit "Erinnerungen einschalten" ein frisches anlegen kann. Nur bei
    // eindeutiger Antwort, nicht bei einem Netzwerkfehler.
    if (sub && state.session) {
      const { data, error } = await supabase.from('push_subscriptions')
        .select('id').eq('endpoint', sub.endpoint).maybeSingle();
      if (!error && !data) {
        await sub.unsubscribe();
        state.pushStatus = pushOffStatus();
        return;
      }
    }
    state.pushStatus = sub ? 'on' : pushOffStatus();
  } catch {
    state.pushStatus = 'unsupported';
  }
}

// Beendet die Erinnerungen dieses Geräts für das angemeldete Konto - beim Abmelden und
// beim Löschen des Kontos: Server-Zeile löschen (solange die Session noch gilt), das Abo
// im Browser kündigen und die lokale Namensliste leeren. Sonst kämen die Erinnerungen
// des alten Kontos samt Feldnamen weiter auf das Gerät, auch wenn sich danach jemand
// anders anmeldet. getRegistration statt serviceWorker.ready: ready wartet ohne
// registrierten Service Worker für immer. Best effort, darf das Abmelden nie blockieren.
async function endPushForThisDevice({ deleteServerRow = true } = {}) {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      if (deleteServerRow) await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
  } catch { /* best effort */ }
  await clearFieldNamesForPush();
  if (state.pushStatus !== 'unsupported') state.pushStatus = 'off';
}

// Ohne Abo: 'blocked', wenn Mitteilungen für Logbuch verboten sind (einmal "Blockieren"
// gedrückt - der Browser fragt dann nie wieder, nur eine Anleitung hilft weiter), sonst 'off'.
function pushOffStatus() {
  return typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'blocked' : 'off';
}
// Kurze Anleitung, wie man Mitteilungen wieder erlaubt - je nach Gerät und ob Logbuch
// installiert ist. Steht in den Einstellungen und im Tutorial statt einer Sackgasse.
function pushBlockedHelp() {
  const key = isIOSDevice() ? 'push.blocked.ios'
    : /Android/.test(navigator.userAgent) ? (isStandaloneDisplay() ? 'push.blocked.androidApp' : 'push.blocked.androidBrowser')
      : 'push.blocked.other';
  return `
    <div class="push-blocked">
      <p>${t('push.blocked.intro')}</p>
      <p>${t(key)}</p>
      <p>${t('push.blocked.retryHint')}</p>
      <button type="button" class="push-toggle" data-action="enable-push">${t('push.blocked.retry')}</button>
    </div>
  `;
}
async function enablePush() {
  state.pushStatus = 'busy';
  render();
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      // 'denied': Anleitung statt Meldung (pushBlockedHelp); 'default' = Dialog nur
      // weggeklickt, dann fragt der Browser beim nächsten Versuch wieder.
      state.pushStatus = pushOffStatus();
      // Blockiert fragt der Browser gar nicht erst - ohne Meldung wirkte "Nochmal versuchen"
      // wie kaputt.
      state.notice = { type: 'error', text: t(state.pushStatus === 'blocked' ? 'push.blocked.still' : 'notice.pushPermissionDenied') };
      render();
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    const json = sub.toJSON();
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        user_id: state.session.user.id,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth_key: json.keys.auth,
      },
      { onConflict: 'endpoint' }
    );
    if (error) throw new Error(translateDbError(error.message));
    state.pushStatus = 'on';
    state.notice = { type: 'ok', text: t('notice.pushEnabled') };
  } catch (err) {
    state.pushStatus = 'off';
    state.notice = errorNotice('notice.enableFailed', (err.message || err));
  }
  render();
}

async function disablePush() {
  state.pushStatus = 'busy';
  render();
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
    state.pushStatus = 'off';
  } catch (err) {
    state.notice = errorNotice('notice.disableFailed', (err.message || err));
  }
  render();
}

// --- Datenexport (Auskunftsrecht/Datenportabilität) -------------------------
// Exportiert die eigenen Rohdaten (nicht das App-interne, transformierte Modell) direkt
// aus dem Browser — RLS scoped die Abfragen automatisch auf den eigenen user_id, kein
// Server-Roundtrip über eine eigene Function nötig.
async function handleExportData() {
  state.menuOpen = false;
  const [defsRes, entriesRes, settingsRes, subsRes, sectionsRes] = await Promise.all([
    supabase.from('habit_definitions').select('*'),
    fetchAllRows(() => supabase.from('habit_entries').select('*').order('entry_date')),
    supabase.from('user_settings').select('*'),
    supabase.from('push_subscriptions').select('*'),
    supabase.from('habit_sections').select('*'),
  ]);
  const err = defsRes.error || entriesRes.error || settingsRes.error || subsRes.error || sectionsRes.error;
  if (err) {
    state.notice = errorNotice('notice.exportFailed', err.message);
    render();
    return;
  }
  // habit_entries.data liegt in der DB nur noch als Chiffretext vor - für einen
  // nutzbaren Export (Art. 15/20 DSGVO: die eigenen, lesbaren Daten) hier mit dem
  // bereits im Speicher gehaltenen DEK entschlüsseln.
  const decryptedEntries = await Promise.all(
    entriesRes.data.map(async (row) => {
      try {
        return { ...row, data: row.data ? await decryptData(currentDek, row.data) : {} };
      } catch {
        return { ...row, data: null, decrypt_error: true };
      }
    })
  );

  // Feld-Definitionen ebenso: lesbare Eigenschaften statt des Chiffretexts in enc.
  const decryptedDefs = await Promise.all(
    defsRes.data.map(async (row) => {
      if (!row.enc) return row;
      const { enc, ...rest } = row;
      try {
        const p = await decryptData(currentDek, enc);
        return {
          ...rest, slug: p.key, name: p.name, unit: p.unit, min: p.min, max: p.max, labels: p.labels,
          good: p.good, display_style: p.displayStyle, slider_show_value: p.sliderShowValue,
          group_members: p.groupMembers, goal_threshold: p.goalThreshold, aggregate: p.aggregate ?? null, since: p.since ?? null,
          hide_in_stats: !!p.hideInStats, archived_in_stats: !!p.archivedInStats,
        };
      } catch {
        return { ...rest, decrypt_error: true };
      }
    })
  );

  const exportObj = {
    exported_at: new Date().toISOString(),
    habit_definitions: decryptedDefs,
    habit_sections: await Promise.all(sectionsRes.data.map(async ({ enc, ...rest }) => {
      try { return { ...rest, name: (await decryptData(currentDek, enc)).name }; } catch { return { ...rest, decrypt_error: true }; }
    })),
    habit_entries: decryptedEntries,
    user_settings: settingsRes.data,
    access_group: accessGroup,
    push_subscriptions: subsRes.data,
  };
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `logbuch-export-${formatKey(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Erst verzögert freigeben: Safari/iOS bricht den Download sonst teils ab, weil die
  // Datei beim tatsächlichen Speichern schon weg ist.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  state.notice = { type: 'ok', text: t('notice.exportDownloaded') };
  render();
}

// --- Konto löschen (Recht auf Löschung) -------------------------------------
// Nach dem Löschen des Kontos: auf dem Gerät gemerkte Spuren des Kontos bzw. seines
// Einrichtens mit entfernen ("Löschen" soll möglichst wenig übrig lassen; danach beginnt
// man wieder bei der Startseite). Einstellungen des Geräts bzw. der Person (Hell/Dunkel,
// Textgröße, Streifenmuster, Vibration) bleiben bewusst erhalten.
function clearDeviceAccountTraces() {
  try {
    ['signedInHere', 'onboardingMode', 'onboardingInProgress', 'onboardingWithInstall', 'installGateSkipped', 'installHintDismissed', 'todayIntroPending', 'groupTipDismissed']
      .forEach((key) => localStorage.removeItem(key));
    Object.keys(localStorage).filter((key) => key.startsWith('sectionCollapsed:')).forEach((key) => localStorage.removeItem(key));
  } catch { /* nichts gespeichert oder kein Zugriff - dann gibt es auch nichts zu löschen */ }
  onbModeThisVisit = null;
  onbInProgressThisVisit = false;
  installGateSkippedThisVisit = false;
}

async function handleDeleteAccount() {
  const input = (document.getElementById('delete-confirm-input')?.value || '').trim();
  if (input !== t('deleteAccount.confirmWord')) {
    state.notice = { type: 'error', text: tPlain('deleteAccount.confirmMismatch', { word: t('deleteAccount.confirmWord') }) };
    render();
    return;
  }
  state.deleteConfirm.busy = true;
  render();

  const userId = state.session?.user?.id;
  const { data, error } = await supabase.functions.invoke('delete-account');
  if (error || data?.error) {
    // Bei Nicht-2xx liefert supabase-js die eigentliche Antwort in error.context.
    let code = data?.error ?? null;
    try { if (!code) code = (await error.context.json()).error; } catch { /* z.B. Netzwerkfehler */ }
    state.deleteConfirm.busy = false;
    state.notice = code === 'protected'
      ? { type: 'error', text: t('deleteAccount.protected') }
      : errorNotice('notice.deleteFailed', code || error?.message);
    render();
    return;
  }

  // Best effort: lokale Push-Subscription, Namensliste und gecachten
  // Verschlüsselungs-Schlüssel im Browser aufräumen (die DB-Zeilen sind durch die
  // Kontolöschung ohnehin schon weg). Darf das eigentliche Löschen nicht blockieren.
  await endPushForThisDevice({ deleteServerRow: false });
  if (userId) await clearCachedDek(userId);
  clearCurrentDek();
  clearDeviceAccountTraces();
  state.authMode = 'welcome';

  state.deleteConfirm = null;
  state.authEmail = '';
  state.authPassword = '';
  state.authPasswordVisible = false;
  await supabase.auth.signOut();
}

// --- Anti-Bot-Schutz bei der Registrierung (statt Turnstile) ----------------
// Sichtbares Drittanbieter-Captcha (egal ob Turnstile/hCaptcha/reCAPTCHA) wird von
// Adblockern/Tracking-Schutz auf vielen Geräten blockiert und verhindert dann echte
// Registrierungen — struktureller Nachteil der ganzen Kategorie, nicht Turnstile-
// spezifisch. Stattdessen zwei simple, dependency-freie Filter gegen die typische
// unsophistizierte Bot-Masse: ein für Menschen unsichtbares Honeypot-Feld (Bots füllen
// Formularfelder oft blind aus) und eine Mindest-Ausfüllzeit (Bots senden praktisch
// sofort ab). Kein Ersatz für ein echtes Captcha gegen gezielte Angriffe, aber in
// Kombination mit der ohnehin verpflichtenden E-Mail-Bestätigung und Supabase's
// eingebautem Rate-Limiting pro IP für den aktuellen Rahmen ausreichend — und vor
// allem: reibungslos für echte Nutzer, unabhängig von Adblocker/Netzwerk.
const SIGNUP_MIN_FILL_MS = 1500;
let signupFormShownAt = null;

// --- Rendering: Auth -------------------------------------------------------
// Hilfe, falls die Bestätigungsmail nicht ankommt: sie landet bei manchen Anbietern im
// Spam (neue Absender-Domain, Link auf eine andere Domain), und wer das nicht weiß, kommt
// ohne diesen Hinweis nicht weiter. Die Adresse steht dabei, damit ein Tippfehler auffällt.
function renderConfirmEmailHelp() {
  const r = state.confirmResend;
  const status = r === 'sent' ? t('auth.confirmHelp.resent') : r?.error ? esc(r.error) : '';
  return `
    <div class="confirm-help">
      <p>${t('auth.confirmHelp.spam')}</p>
      <p>${t('auth.confirmHelp.sentTo', { email: state.confirmEmailFor })}</p>
      <button type="button" class="manage-new-btn manage-new-btn--secondary" data-action="resend-confirm">${r === 'sending' ? t('auth.confirmHelp.resending') : t('auth.confirmHelp.resend')}</button>
      ${status ? `<p class="confirm-help-status">${status}</p>` : ''}
    </div>
  `;
}
async function resendConfirmEmail() {
  state.confirmResend = 'sending';
  render();
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: state.confirmEmailFor,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (!error) state.confirmResend = 'sent';
  else {
    // Supabase erlaubt eine Mail pro Minute und Adresse (auth.email.max_frequency).
    const wait = /after (\d+) seconds?/.exec(error.message);
    state.confirmResend = { error: wait ? tPlain('auth.confirmHelp.wait', { seconds: wait[1] }) : t('auth.confirmHelp.failed') };
  }
  render();
  // Bewusst nicht deaktiviert, solange gesendet wird (ein doppelter Klick wird oben
  // abgefangen) - ein deaktivierter Button verlöre den Tastatur-Fokus.
  announce(state.confirmResend === 'sent' ? t('auth.confirmHelp.resent') : state.confirmResend.error);
}

// --- Onboarding-Gerüst (seit 2026-10-01) ------------------------------------------
// Einstiegsfrage "Wie möchtest du starten?": Schritt für Schritt (mehr Erklärung offen)
// oder Kurz und knapp. EIN Ablauf für beide - Faustregel: klarer formulieren gilt für
// alle, mehr erklären bekommt nur, wer Schritt für Schritt gewählt hat (aufklappbare
// Erklärungen sind dann von Anfang an offen, siehe whyBox). Gemerkt nur auf dem Gerät.
// iPhone: Safari und die installierte App teilen keinen Speicher - die frisch installierte
// App fragt deshalb noch einmal (authMode 'installed').
function getOnbMode() {
  try { return localStorage.getItem('onboardingMode'); } catch { return null; } // 'guided' | 'short' | null
}
function setOnbMode(mode) {
  try { localStorage.setItem('onboardingMode', mode); } catch { /* dann eben nur bis zum Neuladen */ }
  onbModeThisVisit = mode;
}
let onbModeThisVisit = null;
function isGuided() { return (getOnbMode() || onbModeThisVisit) === 'guided'; }
// Läuft gerade das Einrichten eines neuen Kontos (von "Ich bin neu hier" bis zum gesicherten
// Ersatzschlüssel)? Steuert die Fortschrittsleiste auf den Seiten davor und danach.
function isOnbInProgress() {
  try { return localStorage.getItem('onboardingInProgress') === 'true'; } catch { return onbInProgressThisVisit; }
}
let onbInProgressThisVisit = false;
function setOnbInProgress(on) {
  onbInProgressThisVisit = on;
  try { if (on) localStorage.setItem('onboardingInProgress', 'true'); else localStorage.removeItem('onboardingInProgress'); } catch { /* s.o. */ }
}
// Die Etappen des Einrichtens. "Aufs Handy holen" zählt nur mit, wenn der Schritt auf
// diesem Gerät auch kommt (bzw. schon geschafft ist): Handy, und entweder schon installiert
// oder die Installations-Seite wurde hier nicht früher schon weggeklickt. Festgelegt bei der
// Einstiegsfrage (onbIncludesInstall) - wer die Seite mitten im Einrichten überspringt,
// behält dieselbe Zählung, sonst spränge "Schritt 2 von 4" auf "Schritt 1 von 3".
function onbIncludesInstall() {
  try {
    const v = localStorage.getItem('onboardingWithInstall');
    if (v !== null) return v === 'true';
  } catch { /* s.u. */ }
  return isMobileDevice() && (isStandaloneDisplay() || shouldShowInstallGate());
}
function rememberOnbIncludesInstall() {
  const v = isMobileDevice() && (isStandaloneDisplay() || shouldShowInstallGate());
  try { localStorage.setItem('onboardingWithInstall', String(v)); } catch { /* dann jedes Mal neu bestimmt */ }
}
function onbStages() {
  return [...(onbIncludesInstall() ? ['install'] : []), 'account', 'setup', 'reminders', 'key'];
}
// Fortschrittsleiste "Schritt X von N: …" (optional mit Unterschritt, z.B. im Tutorial).
function onbProgress(stage, part = null) {
  const stages = onbStages();
  const idx = stages.indexOf(stage);
  if (idx < 0) return '';
  const label = t('onb.progress.label', { n: idx + 1, total: stages.length, name: t(`onb.stage.${stage}`) });
  // Unterschritt (z.B. im Tutorial) als eigene, kleinere Zeile mit Punkten darunter - in
  // derselben Überschrift wirkte "Schritt 2 von 3 … Teil 2 von 4" überladen.
  const sub = part ? `
      <div class="onb-substeps" role="img" aria-label="${esc(t('onb.progress.part', { part: part[0], parts: part[1] }))}">
        ${Array.from({ length: part[1] }, (_, i) => `<span class="onb-substep${i + 1 < part[0] ? ' onb-substep--done' : i + 1 === part[0] ? ' onb-substep--current' : ''}"></span>`).join('')}
      </div>` : '';
  return `
    <div class="onb-progress">
      <div class="onb-progress-bar" aria-hidden="true">${stages.map((st, i) => `<span class="onb-progress-seg${i < idx ? ' onb-progress-seg--done' : i === idx ? ' onb-progress-seg--current' : ''}"></span>`).join('')}</div>
      <p class="onb-progress-label">${label}</p>
      ${sub}
    </div>
  `;
}

function signedInHereBefore() {
  try { return localStorage.getItem('signedInHere') === 'true'; } catch { return false; }
}
function rememberSignedInHere() {
  try { localStorage.setItem('signedInHere', 'true'); } catch { /* dann eben nicht */ }
}
// Startseite vor dem Anmelde-Formular: zwei Knöpfe, die die Lage der Person beschreiben
// statt des Fachbegriffs - ein "Anmelden" klingt für Neulinge nach "ich bin neu, also melde
// ich mich an". Wer sich auf dem Gerät schon einmal angemeldet hat, startet direkt beim
// Anmelden (signedInHereBefore).
function renderAuthWelcome() {
  app.innerHTML = `
    <div class="auth-box auth-box--welcome">
      <h1 tabindex="-1">Logbuch</h1>
      <p class="auth-welcome-lead">${t('auth.welcome.lead')}</p>
      ${renderNotice()}
      ${choiceCard({ action: 'auth-choose', mode: 'mode', title: t('auth.welcome.new'), note: t('auth.welcome.newNote') })}
      ${choiceCard({ action: 'auth-choose', mode: 'signin', title: t('auth.welcome.existing'), note: t('auth.welcome.existingNote') })}
      <div class="onb-display onb-display--welcome">
        <p class="onb-display-title">${t('onbDisplay.welcomeTitle')}</p>
        ${onbDisplayChoicesHtml()}
      </div>
    </div>
  `;
}

// Textgröße und Hell/Dunkel schon vor dem Konto: sonst muss, wer schlecht sieht, die ganze
// Einführung in normaler Schrift schaffen (die Einstellungen kommen erst danach). Startseite:
// offen unter den Karten; alle weiteren Seiten der Einführung: Knopf "Aa Anzeige" oben rechts
// (addOnbDisplayBar) - auch, weil auf dem iPhone die installierte App einen eigenen Speicher
// hat und eine im Browser gewählte Größe dort wieder weg ist.
function onbDisplayChoicesHtml() {
  const seg = (labelId, label, buttons) => `
    <span class="onb-display-label" id="${labelId}">${label}</span>
    <div class="pill-group seg" role="group" aria-labelledby="${labelId}">${buttons}</div>`;
  const theme = getThemeOverride() || '';
  return `
    ${seg('onb-text-size-label', t('textSize.label'), TEXT_SIZES.map((size) => `<button type="button" class="pill-toggle${getTextSize() === size ? ' pill-toggle--active' : ''}" data-action="text-size-set" data-size="${size}" aria-pressed="${getTextSize() === size}">${t('textSize.' + (size || 'normal'))}</button>`).join(''))}
    ${seg('onb-theme-label', t('theme.label'), [['', 'theme.system'], ['light', 'theme.light'], ['dark', 'theme.dark']].map(([v, key]) => `<button type="button" class="pill-toggle${theme === v ? ' pill-toggle--active' : ''}" data-action="theme-set" data-theme="${v}" aria-pressed="${theme === v}">${t(key)}</button>`).join(''))}
  `;
}
// Zentral aus render() statt in jeder der vielen Seiten der Einführung: Zeile mit Zurück-Pfeil
// (falls die Seite einen hat) links und "Aa Anzeige" rechts, darunter aufgeklappt die Auswahl.
// Auf der nächsten Seite wieder zu (sonst schöbe die offene Auswahl jeden Inhalt nach unten).
let onbDisplayPage = null;
function addOnbDisplayBar() {
  const box = app.querySelector('.auth-box');
  if (!box || box.classList.contains('auth-box--welcome')) return;
  const page = box.querySelector('h1')?.textContent ?? '';
  if (page !== onbDisplayPage) { onbDisplayPage = page; state.onbDisplayOpen = false; }
  const back = box.firstElementChild?.classList.contains('auth-back') ? box.firstElementChild : null;
  box.insertAdjacentHTML('afterbegin', `
    <div class="onb-topbar">
      <span class="onb-topbar-back"></span>
      <button type="button" class="onb-display-btn" data-action="onb-display-toggle" aria-expanded="${state.onbDisplayOpen}"${state.onbDisplayOpen ? ' aria-controls="onb-display-panel"' : ''}><span class="onb-display-btn-icon" aria-hidden="true">A<span>a</span></span>${t('onbDisplay.button')}</button>
    </div>
    ${state.onbDisplayOpen ? `<div class="onb-display" id="onb-display-panel">${onbDisplayChoicesHtml()}</div>` : ''}
  `);
  if (back) box.querySelector('.onb-topbar-back').replaceWith(back);
}
// Gleichwertige Antworten auf eine Frage (Startseite, Einstiegsfrage): gleich aussehende
// Karten mit dem erklärenden Satz IM Knopf. Ein gefüllter Knopf neben einem umrandeten
// wirkte wie eine Empfehlung, und der Satz darunter wurde überlesen - Testpersonen wählten
// so oft das, was nicht zu ihnen passte. Gefüllt bleibt nur ein empfohlener Weg (z.B.
// Installieren, Erinnerungen).
function choiceCard({ action, mode, title, note }) {
  return `
    <button type="button" class="onb-choice" data-action="${action}" data-mode="${mode}">
      <span class="onb-choice-title">${title}</span>
      <span class="onb-choice-note">${note}</span>
    </button>
  `;
}

// Nach dem Registrieren: was jetzt zu tun ist, als nummerierte Schritte - vorher standen
// Meldung, Hilfe und Anmelde-Formular untereinander, und alle drei wollten etwas.
function renderCheckMail() {
  const steps = ['auth.checkMail.step1', 'auth.checkMail.step2', 'auth.checkMail.step3'];
  app.innerHTML = `
    <div class="auth-box onb">
      ${authBackButton('signup')}
      ${onbProgress('account')}
      <div class="onb-icon" aria-hidden="true">${iconSvg('mail')}</div>
      <h1 tabindex="-1">${t('auth.checkMail.title')}</h1>
      <p class="tutorial-text">${t('auth.checkMail.body')}</p>
      <details class="why-box" ${isGuided() ? 'open' : ''}>
        <summary class="why-box-title">${t('auth.checkMail.howTitle')}</summary>
        <ol class="onb-steps">${steps.map((k) => `<li>${t(k)}</li>`).join('')}</ol>
      </details>
      <p class="onb-hint">${t('auth.checkMail.after')}</p>
      <button type="button" class="auth-submit" data-action="check-mail-done">${t('auth.checkMail.continue')}</button>
      ${renderConfirmEmailHelp()}
    </div>
  `;
}

function authBackButton(target) {
  return `
    <button type="button" class="back-btn auth-back" data-action="auth-choose" data-mode="${target}" aria-label="${esc(t('ariaLabel.back'))}">
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  `;
}
// Die zwei Antworten der Einstiegsfrage - fragt nach dem Wunsch, nicht nach dem Können
// ("kennst du dich aus?" schätzen viele falsch ein und kann herablassend wirken).
function onbModeChoices() {
  return `
    ${choiceCard({ action: 'onb-mode', mode: 'guided', title: t('onb.mode.guided'), note: t('onb.mode.guidedNote') })}
    ${choiceCard({ action: 'onb-mode', mode: 'short', title: t('onb.mode.short'), note: t('onb.mode.shortNote') })}
  `;
}
function renderOnbMode() {
  app.innerHTML = `
    <div class="auth-box onb">
      ${authBackButton('welcome')}
      <h1 tabindex="-1">${t('onb.mode.title')}</h1>
      ${onbModeChoices()}
    </div>
  `;
}
// Persönliche Nachricht nach der Einstiegsfrage, bei beiden Varianten (Nutzer-Entscheidung
// 2026-10-12): Testpersonen lasen die Erklärungen oft nicht - ein paar Dinge muss man aber
// verstehen, um Logbuch richtig zu nutzen.
function renderOnbIntro() {
  app.innerHTML = `
    <div class="auth-box onb">
      ${authBackButton('mode')}
      <div class="onb-icon" aria-hidden="true">${iconSvg('feedback')}</div>
      <h1 tabindex="-1">${t('onb.intro.title')}</h1>
      <p class="tutorial-text">${t('onb.intro.body')}</p>
      <p class="tutorial-text">${t('onb.intro.help')}</p>
      <button type="button" class="auth-submit" data-action="auth-choose" data-mode="${isGuided() ? 'overview' : 'signup'}">${t('onb.intro.ok')}</button>
    </div>
  `;
}
function renderOnbOverview() {
  const icons = { install: 'install', account: 'mail', setup: 'manage', reminders: 'reminders', key: 'key' };
  app.innerHTML = `
    <div class="auth-box onb">
      ${authBackButton('intro')}
      <h1 tabindex="-1">${t('onb.overview.title')}</h1>
      <ol class="onb-overview">${onbStages().map((st) => `<li>${icon(icons[st])}${t(`onb.overview.${st}`)}</li>`).join('')}</ol>
      <p class="onb-hint">${t('onb.overview.duration')}</p>
      <div class="why-box"><p>${icon('tip')}${t('onb.overview.helper')}</p></div>
      <button type="button" class="auth-submit" data-action="auth-choose" data-mode="signup">${t('onb.overview.start')}</button>
    </div>
  `;
}
// Frisch installierte App ohne Anmeldung (Startzustand 'installed'): erst einmal
// bestätigen, dass es geklappt hat. Ist die Einstiegsfrage auf diesem Speicher schon
// beantwortet (Android teilt ihn mit dem Browser), geht es direkt weiter, sonst kommt sie
// hier noch einmal (iPhone).
function renderOnbInstalled() {
  app.innerHTML = `
    <div class="auth-box onb">
      ${onbProgress('account')}
      <div class="onb-icon" aria-hidden="true">${iconSvg('celebrate')}</div>
      <h1 tabindex="-1">${t('onb.installed.title')}</h1>
      <p class="tutorial-text">${t('onb.installed.body')}</p>
      ${getOnbMode()
        ? `<button type="button" class="auth-submit auth-choice" data-action="auth-choose" data-mode="signup">${t('onb.installed.continue')}</button>`
        : `<p class="tutorial-text">${t('onb.mode.title')}</p>${onbModeChoices()}`}
      <button type="button" class="auth-toggle" data-action="auth-choose" data-mode="signin">${t('auth.welcome.existing')}</button>
    </div>
  `;
}

let authSubmitBusy = false;
// Mindestlänge beim Registrieren als Bedingung, die sich beim Erreichen abhakt - so sieht
// man vor dem Absenden, ob sie erfüllt ist. Ein laufender Zähler ("0 von mindestens 10
// Zeichen") las sich verwirrend; der Haken zeigt es auch ohne Farbe.
function passwordRuleText(len) {
  return `${len >= AUTH_MIN_PASSWORD_LENGTH ? '✓ ' : ''}${t('auth.passwordRule', { min: AUTH_MIN_PASSWORD_LENGTH })}`;
}
function renderAuth() {
  if (state.authMode === 'welcome') { renderAuthWelcome(); return; }
  if (state.authMode === 'mode') { renderOnbMode(); return; }
  if (state.authMode === 'intro') { renderOnbIntro(); return; }
  if (state.authMode === 'overview') { renderOnbOverview(); return; }
  if (state.authMode === 'installed') { renderOnbInstalled(); return; }
  if (state.authMode === 'checkMail') { renderCheckMail(); return; }
  const isSignup = state.authMode === 'signup';
  const isForgot = state.authMode === 'forgot';
  const title = isForgot ? t('auth.title.forgot') : isSignup ? t('auth.title.signup') : t('auth.title.login');

  app.innerHTML = `
    <div class="auth-box">
      ${!isForgot ? authBackButton(isSignup ? (isStandaloneDisplay() ? 'installed' : 'mode') : (isStandaloneDisplay() && !signedInHereBefore() ? 'installed' : 'welcome')) : ''}
      ${!isForgot && isOnbInProgress() ? onbProgress('account') : ''}
      <h1>Logbuch</h1>
      <p class="sub" tabindex="-1">${title}</p>
      ${state.authError ? `<div class="notice" role="alert">${esc(state.authError)}</div>` : ''}
      ${renderNotice()}
      ${isForgot ? `<p class="habit-form-lock-note">${t('auth.forgotRecoveryNote')}</p>` : ''}
      ${!isSignup && !isForgot && state.confirmEmailFor ? renderConfirmEmailHelp() : ''}
      <form id="auth-form">
        <div class="auth-field">
          <label for="email">${t('auth.email')}</label>
          ${clearableInputHtml('email', 'email', state.authEmail, { autocomplete: 'email' })}
          ${isSignup ? `<p class="onb-hint auth-email-hint">${t('auth.emailWhy')}</p>` : ''}
        </div>
        ${!isForgot ? `
          <div class="auth-field">
            <div class="auth-field-label-row">
              <label for="password">${t('auth.password')}</label>
              <button type="button" class="push-toggle" data-action="toggle-password-visibility">${state.authPasswordVisible ? t('auth.hide') : t('auth.show')}</button>
            </div>
            ${clearableInputHtml('password', 'password', state.authPassword, {
              autocomplete: isSignup ? 'new-password' : 'current-password',
              minlength: AUTH_MIN_PASSWORD_LENGTH,
              showVisibilityToggle: true,
              visible: state.authPasswordVisible,
            })}
            ${isSignup ? `
              <p class="password-count${state.authPassword.length >= AUTH_MIN_PASSWORD_LENGTH ? ' password-count--ok' : ''}" id="password-count" aria-live="polite">${passwordRuleText(state.authPassword.length)}</p>
              <p class="onb-hint auth-password-hint">${t('auth.passwordHint')}</p>
              <details class="why-details" ${isGuided() ? 'open' : ''}><summary>${t('auth.passwordWhyTitle')}</summary><p>${t('auth.passwordWhy')}</p></details>
            ` : ''}
          </div>
        ` : ''}
        ${isSignup ? `
          <div class="auth-field honeypot-field" aria-hidden="true">
            <label for="website">Website</label>
            <input type="text" id="website" name="website" tabindex="-1" autocomplete="off" />
          </div>
        ` : ''}
        <button type="submit" class="auth-submit">${isForgot ? t('auth.sendResetLink') : isSignup ? t('auth.createAccount') : t('auth.login')}</button>
      </form>
      ${!isSignup ? `
        <button type="button" class="auth-toggle" data-action="${isForgot ? 'cancel-forgot' : 'start-forgot'}">
          ${isForgot ? t('auth.backToLogin') : t('auth.forgotPassword')}
        </button>
      ` : ''}
    </div>
  `;

  // Nur beim ERSTEN Aufbau des Signup-Formulars starten, nicht bei jedem Re-Render
  // (z.B. durch den ×-Button, den Passwort-sichtbar-Umschalter oder einen
  // Validierungsfehler) — sonst würde ein Re-Render kurz vor dem Absenden die
  // tatsächliche Ausfüllzeit fälschlich auf ~0 zurücksetzen und echte Nutzer träfe
  // der "zu schnell ausgefüllt"-Bot-Filter.
  if (isSignup) { if (signupFormShownAt === null) signupFormShownAt = Date.now(); }
  else signupFormShownAt = null;

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Registrieren dauert ein paar Sekunden - ohne sichtbare Rückmeldung tippten viele
    // nochmal, und der zweite Versuch meldete einen Fehler, obwohl der erste geklappt hatte.
    // Knopf deshalb sofort sperren und beschriften; das nächste render() baut ihn neu auf.
    if (authSubmitBusy) return;
    authSubmitBusy = true;
    const submitBtn = e.target.querySelector('.auth-submit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = t(isForgot ? 'auth.busy.forgot' : isSignup ? 'auth.busy.signup' : 'auth.busy.login'); }
    try {
    const email = document.getElementById('email').value.trim();
    state.authError = null;
    state.notice = null;
    if (isForgot) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
      });
      if (error) { state.authError = translateAuthError(error.message); render(); return; }
      state.notice = { type: 'ok', text: t('auth.resetLinkSent') };
      render();
      return;
    }
    const password = document.getElementById('password').value;
    // Muss VOR dem signUp/signInWithPassword-Aufruf gesetzt werden, nicht erst danach:
    // onAuthStateChange kann schon in der Lücke dazwischen feuern (siehe Kommentar bei
    // authFlowInFlight weiter unten im Skript).
    authFlowInFlight = true;
    try {
      if (isSignup) {
        const honeypotFilled = document.getElementById('website')?.value;
        const filledTooFast = signupFormShownAt !== null && Date.now() - signupFormShownAt < SIGNUP_MIN_FILL_MS;
        if (honeypotFilled || filledTooFast) {
          // Stillschweigend ablehnen statt konkret zu sagen warum — sonst lässt sich
          // der Filter durch einen Bot leicht anpassen ("Website"-Feld leer lassen,
          // langsamer abschicken).
          state.authError = t('auth.signupFailedGeneric');
          render();
          return;
        }
        const { data, error } = await supabase.auth.signUp({
          email, password,
          // locale landet in den Nutzer-Metadaten - die Vorlage der Bestätigungsmail
          // (Supabase-Dashboard, siehe CLAUDE.md) wählt damit Deutsch oder Englisch.
          options: { emailRedirectTo: window.location.origin + window.location.pathname, data: { locale: currentLocale } },
        });
        if (error) { state.authError = translateAuthError(error.message); render(); return; }
        if (!data.session) {
          state.confirmEmailFor = email;
          state.confirmResend = null;
          state.authMode = 'checkMail';
          render();
          return;
        }
        // E-Mail-Bestätigung war nicht nötig (sofortige Session) - Verschlüsselung kann
        // gleich eingerichtet werden.
        await completeAuthFlow(data.user.id, password);
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          state.authError = translateAuthError(error.message);
          if (error.message === 'Email not confirmed' && state.confirmEmailFor !== email) {
            state.confirmEmailFor = email;
            state.confirmResend = null;
          }
          render();
          return;
        }
        state.confirmEmailFor = null;
        state.confirmResend = null;
        await completeAuthFlow(data.user.id, password);
      }
    } catch (err) {
      // Angemeldet, aber Entsperren gescheitert (z.B. Verbindung weg) - die Entsperr-Maske
      // übernimmt und zeigt, woran es lag.
      state.unlockError = unlockErrorText(err);
      state.loading = false;
      render();
    } finally {
      authFlowInFlight = false;
    }
    } finally {
      authSubmitBusy = false;
    }
  });
}

function renderPasswordRecovery() {
  const fallback = state.recoveryFallbackConfirm;
  app.innerHTML = `
    <div class="auth-box">
      <h1>Logbuch</h1>
      <p class="sub">${t('recovery.title')}</p>
      ${state.authError ? `<div class="notice" role="alert">${esc(state.authError)}</div>` : ''}
      <form id="recovery-form">
        <div class="auth-field">
          <label for="new-password">${t('recovery.newPassword')}</label>
          <input type="password" id="new-password" required autocomplete="new-password" minlength="${AUTH_MIN_PASSWORD_LENGTH}" ${state.recoveryBusy ? 'disabled' : ''} />
        </div>
        ${!fallback ? `
          <div class="auth-field">
            <label for="recovery-key-input">${t('recovery.key')}</label>
            <input type="text" id="recovery-key-input" placeholder="${esc(t('recovery.keyPlaceholder'))}" autocomplete="off" ${state.recoveryBusy ? 'disabled' : ''} />
          </div>
          <button type="submit" class="auth-submit" ${state.recoveryBusy ? 'disabled' : ''}>${state.recoveryBusy ? t('recovery.saving') : t('recovery.savePassword')}</button>
          <button type="button" class="auth-toggle" data-action="toggle-recovery-fallback">${t('recovery.keyAlsoLost')}</button>
        ` : `
          <div class="notice">${t('recovery.fallbackWarning')}</div>
          <button type="submit" class="auth-submit" ${state.recoveryBusy ? 'disabled' : ''}>${state.recoveryBusy ? t('recovery.saving') : t('recovery.setAnyway')}</button>
          <button type="button" class="auth-toggle" data-action="toggle-recovery-fallback">${t('recovery.cancelHaveKey')}</button>
        `}
      </form>
    </div>
  `;

  document.getElementById('recovery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('new-password').value;
    state.authError = null;
    state.notice = null;
    state.recoveryBusy = true;
    authFlowInFlight = true; // siehe Kommentar bei der Deklaration weiter unten im Skript
    render();
    try {
      const userId = state.session.user.id;
      let cleanupFailed = false;
      if (fallback) {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        await setupEncryption(userId, password, { replace: true });
        cleanupFailed = !(await deleteUndecryptableData(userId));
      } else {
        const recoveryKeyHex = document.getElementById('recovery-key-input').value;
        let dek;
        let dekId;
        let keyConfirmed;
        try {
          const row = await fetchEncryptionRow(userId);
          if (!row) throw new Error(t('recovery.error.noConfig'));
          dek = await unwrapDekWithRecoveryKey(row, recoveryKeyHex);
          dekId = row.dek_id;
          keyConfirmed = row.recovery_key_confirmed;
        } catch {
          throw new Error(t('recovery.error.wrongKey'));
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const kek = await deriveKek(password, salt, PBKDF2_ITERATIONS);
        const { iv: wrapIv, wrapped: wrappedDek } = await wrapDek(dek, kek);
        const { error: updErr } = await supabase.from('user_encryption')
          .update({ salt: bufToBase64(salt), kdf_iterations: PBKDF2_ITERATIONS, wrap_iv: wrapIv, wrapped_dek: wrappedDek })
          .eq('user_id', userId);
        if (updErr) throw updErr;
        // Gleicher DEK wie vorher, also auch gleiche Kennung - Caches anderer Geräte bleiben gültig.
        setCurrentDek(dek, dekId, userId);
        spareKeyPending = !keyConfirmed;
        await cacheDek(userId, dek, dekId);
      }
      // Supabase invalidiert andere Sessions beim Passwort-Ändern NICHT automatisch
      // (bekannte Lücke, siehe supabase/auth#797) - sonst bliebe ein anderes Gerät mit
      // dem alten Passwort/DEK-Stand eingeloggt. Best effort: schlägt der Aufruf fehl,
      // ist das eigentliche Passwort-Update trotzdem schon durch, deshalb kein throw.
      try { await supabase.auth.signOut({ scope: 'others' }); } catch { /* best effort */ }
      state.recoveryBusy = false;
      state.passwordRecovery = false;
      state.recoveryFallbackConfirm = false;
      state.notice = cleanupFailed
        ? { type: 'error', text: t('recovery.cleanupFailed') }
        : { type: 'ok', text: t('recovery.passwordSaved') };
      state.loading = true;
      render();
      await Promise.all([loadEntries(), loadHabits(), loadUserSettings(), loadSections(), loadFeatureAccess()]);
      state.loading = false;
      saveFieldNamesForPush(); // siehe completeAuthFlow
      render();
      maybeShowSpareKey();
    } catch (err) {
      state.recoveryBusy = false;
      state.authError = err.message || String(err);
      render();
    } finally {
      authFlowInFlight = false;
    }
  });
}

// Reset ohne Recovery-Key: alles mit dem alten DEK Verschlüsselte ist ab jetzt
// unlesbar - löschen statt es liegen zu lassen (sonst dauerhaft die Meldung "Feld(er)
// konnten nicht entschlüsselt werden", alte Tage erschienen leer und würden beim
// Eintragen überschrieben). Erst NACH setupEncryption: schlägt die fehl, bleibt der alte
// Stand erhalten, und wer den Recovery-Key doch noch findet, kommt wieder an alles.
// Feld-Definitionen nur mit enc - noch unverschlüsselte (Konto seit der Umstellung nicht
// geöffnet) bleiben lesbar und damit erhalten; Gruppen sind immer verschlüsselt.
// Best effort: das neue Passwort ist zu diesem Zeitpunkt schon gesetzt, ein Fehler hier
// darf den Reset nicht abbrechen (ein zweiter Versuch mit demselben Passwort würde von
// Supabase abgelehnt). Rückgabe: true = alles gelöscht.
async function deleteUndecryptableData(userId) {
  const results = await Promise.all([
    supabase.from('habit_entries').delete().eq('user_id', userId),
    supabase.from('habit_definitions').delete().eq('user_id', userId).not('enc', 'is', null),
    supabase.from('habit_sections').delete().eq('user_id', userId),
  ]).catch((err) => [{ error: err }]);
  const failed = results.filter((r) => r.error);
  failed.forEach((r) => console.error('Alte Daten nach Reset nicht gelöscht:', r.error.message || r.error));
  return failed.length === 0;
}

// "Ersatzschlüssel" (intern weiter recoveryKey): eigener Schritt NACH dem Tutorial, im
// Stil der Tutorial-Bildschirme (Symbol, Begründung, "Warum?"-Kasten, Details hinter
// "Mehr erfahren"). Nur über die Bestätigungs-Checkbox schließbar (auch Escape/Zurück
// greifen hier bewusst nicht).
// Ersatzschlüssel anzeigen (neu gestaltet 2026-10-01 nach einem Onboarding-Test: "Kopieren"
// und Zwischenablage waren unbekannt, die wichtigsten Knöpfe die unscheinbarsten, und ein
// ausgegrautes "Fertig" sagte nicht, warum es nicht geht). Vier gleich große Wege zum
// Aufbewahren, die bekanntesten (Aufschreiben, Foto) vorn; jeder zeigt danach, was zu tun
// ist. Der Abschluss-Knopf geht immer, fragt aber nach, wenn noch kein Weg benutzt wurde.
// Zustand je angezeigtem Schlüssel in state.recoveryKeyToShow (method, ask).
const SPARE_KEY_METHODS = ['write', 'photo', 'file', 'copy']; // zugleich die Namen ihrer Symbole (ICONS)
function spareKeyMethodHelp(method) {
  if (method === 'photo') {
    return t(isIOSDevice() ? 'recoveryDisplay.help.photoIos' : /Android/.test(navigator.userAgent) ? 'recoveryDisplay.help.photoAndroid' : 'recoveryDisplay.help.photoOther');
  }
  if (method === 'file') {
    return t(isIOSDevice() ? 'recoveryDisplay.help.fileIos' : /Android/.test(navigator.userAgent) ? 'recoveryDisplay.help.fileAndroid' : 'recoveryDisplay.help.fileOther');
  }
  if (method === 'copy') return t(isGuided() ? 'recoveryDisplay.help.copyGuided' : 'recoveryDisplay.help.copy');
  return t('recoveryDisplay.help.write');
}
// "Was, wenn ich beides verliere?" ist nur für den Ausnahmefall und deshalb auch bei
// "Schritt für Schritt" zugeklappt (kein whyBox) - die Seite war sonst zu lang.
function renderRecoveryKeyDisplay() {
  const shown = state.recoveryKeyToShow;
  const formatted = formatRecoveryKey(shown.hex);
  const ask = shown.ask;
  app.innerHTML = `
    <div class="auth-box onb">
      ${isOnbInProgress() ? onbProgress('key') : ''}
      <div class="onb-icon" aria-hidden="true">${iconSvg('key')}</div>
      <h1 tabindex="-1">${t('recoveryDisplay.title')}</h1>
      <p class="tutorial-text">${t('recoveryDisplay.lead')}</p>
      ${whyBox('recoveryDisplay.whyTitle', 'recoveryDisplay.explain')}
      <p class="recovery-key-code" aria-label="${esc(t('recoveryDisplay.codeLabel'))}">${formatted.split('-').map((g) => `<span>${esc(g)}</span>`).join(' ')}</p>
      <p class="onb-hint"><strong>${t('recoveryDisplay.secret')}</strong></p>
      <h2 class="spare-key-question">${t('recoveryDisplay.how')}</h2>
      <div class="spare-key-methods" role="group" aria-label="${esc(t('recoveryDisplay.how'))}">
        ${SPARE_KEY_METHODS.map((m) => `<button type="button" class="spare-key-method${shown.method === m ? ' spare-key-method--active' : ''}" data-action="spare-key-method" data-method="${m}" aria-pressed="${shown.method === m}"><span class="spare-key-method-icon" aria-hidden="true">${iconSvg(m)}</span>${t(`recoveryDisplay.method.${m}`)}</button>`).join('')}
      </div>
      ${shown.method ? `<div class="form-tip spare-key-help" role="status">${icon('tip')}<p>${spareKeyMethodHelp(shown.method)}</p></div>` : ''}
      <details class="why-box"><summary class="why-box-title">${t('recoveryDisplay.moreLabel')}</summary><p>${t('recoveryDisplay.more')}</p></details>
      ${ask ? `
        <div class="spare-key-ask" role="alert">
          <p>${t(shown.method === 'write' ? 'recoveryDisplay.askWritten' : 'recoveryDisplay.askNone')}</p>
          <div class="habit-form-actions">
            <button type="button" class="habit-form-cancel" data-action="spare-key-ask-back">${t('recoveryDisplay.notYet')}</button>
            <button type="button" class="auth-submit" data-action="spare-key-finish">${t(shown.method === 'write' ? 'recoveryDisplay.yesWritten' : 'recoveryDisplay.yesKept')}</button>
          </div>
        </div>
      ` : `<button type="button" class="auth-submit" data-action="spare-key-done">${t('recoveryDisplay.done')}</button>`}
    </div>
  `;
}

// --- Installation vor dem Anmelden (seit 2026-09-29) ------------------------------
// Auf dem Handy im Browser kommt als Allererstes die Bitte, Logbuch auf den Home-
// Bildschirm zu holen - noch vor dem Registrieren, damit man sich gleich in der
// installierten App registriert bzw. anmeldet (vorher kam der Hinweis erst nach dem
// Anmelden, und man musste sich in der App ein zweites Mal anmelden; oft wurde er
// einfach weggeklickt). Mit Begründung ("Warum?") statt nur einer Aufforderung. Wer im
// Browser bleiben will, sieht die Seite auf diesem Gerät nicht wieder (localStorage).
function isInstallGateSkipped() {
  try { return localStorage.getItem('installGateSkipped') === 'true'; } catch { return false; }
}
let installGateSkippedThisVisit = false; // falls localStorage nicht geht (privater Modus)
function shouldShowInstallGate() {
  return isMobileDevice() && !isStandaloneDisplay() && !isInstallGateSkipped() && !installGateSkippedThisVisit;
}
// Android/Chrome bietet einen echten Installations-Dialog an - dann ein Knopf statt nur
// einer Anleitung. iOS kennt das nicht, dort bleibt es bei der Anleitung.
let deferredInstallPrompt = null;
let appJustInstalled = false;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // Nur neu zeichnen, wenn die Installations-Seite gerade zu sehen ist - nicht mitten ins
  // Anmelde-Formular hinein.
  if (!state.session && shouldShowInstallGate()) render();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  appJustInstalled = true;
  if (!state.session && shouldShowInstallGate()) render();
});
// Welcher Browser? Die Anleitung unterscheidet sich je nachdem, wo Teilen/Menü sitzen.
function installBrowser() {
  const ua = navigator.userAgent;
  if (isIOSDevice()) return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  if (/Android/.test(ua)) {
    if (/SamsungBrowser/.test(ua)) return 'samsung';
    if (/Firefox/.test(ua)) return 'firefox';
    // Opera, Edge, Vivaldi, Yandex & Co. tragen "Chrome" in der Kennung, haben aber andere
    // Menüs - dort lieber die allgemeine Anleitung als eine falsche genaue.
    if (/OPR\//.test(ua)) return 'opera';
    if (/EdgA|Vivaldi|YaBrowser|DuckDuckGo|MiuiBrowser|HuaweiBrowser/.test(ua)) return 'other';
    return 'chrome';
  }
  return 'other';
}
// Gezeichnete Skizzen statt Screenshots (Nutzer-Entscheidung 2026-10-01): vereinfachte
// Handy-Ansicht, der richtige Knopf grün eingekreist, Beschriftung aus der App (eine Skizze
// für beide Sprachen), passt sich Hell/Dunkel an und altert langsamer als Screenshots.
// viewBox 200x300; Klassen sk-* siehe CSS.
function sketchFrame(content, label) {
  return `<svg class="install-sketch" viewBox="0 0 200 300" role="img" aria-label="${esc(label)}">
    <rect x="12" y="4" width="176" height="292" rx="22" class="sk-frame"/>
    ${content}
  </svg>`;
}
function sketchPage(top = 56) {
  return [0, 1, 2, 3, 4].map((i) => `<rect x="30" y="${top + i * 18}" width="${[140, 110, 130, 90, 120][i]}" height="7" rx="3" class="sk-line"/>`).join('');
}
function sketchText(x, y, text, opts = '') {
  return `<text x="${x}" y="${y}" class="sk-text" ${opts}>${esc(text)}</text>`;
}
const SK_SHARE = (x, y) => `<g class="sk-icon" transform="translate(${x - 7} ${y - 9})"><path d="M7 1v10M3.5 4.5 7 1l3.5 3.5"/><path d="M4 7H2.5v9h9V7H10"/></g>`;
function sketchHtml(kind) {
  const L = (k) => t(`installSketch.${k}`);
  switch (kind) {
    case 'iosShare':
      return sketchFrame(`${sketchPage()}
        <rect x="26" y="226" width="148" height="22" rx="11" class="sk-bar"/>${sketchText(100, 241, 'logbuch', 'text-anchor="middle"')}
        ${['‹', '›', '', '▢', '⧉'].map((c, i) => (c ? sketchText(44 + i * 28, 274, c, 'text-anchor="middle"') : '')).join('')}
        ${SK_SHARE(100, 270)}<circle cx="100" cy="268" r="14" class="sk-hl"/>`, L('ariaIosShare'));
    case 'iosShareTop':
      return sketchFrame(`<rect x="26" y="18" width="148" height="24" rx="12" class="sk-bar"/>${sketchText(90, 34, 'logbuch', 'text-anchor="middle"')}
        ${SK_SHARE(160, 31)}<circle cx="160" cy="29" r="13" class="sk-hl"/>${sketchPage(60)}`, L('ariaIosShareTop'));
    case 'iosSheet': {
      const rows = [L('copy'), L('readingList'), L('addHome'), L('bookmark')];
      return sketchFrame(`${sketchPage()}<rect x="16" y="120" width="168" height="170" rx="14" class="sk-sheet"/>
        ${rows.map((r, i) => `<rect x="30" y="${136 + i * 36}" width="12" height="12" rx="3" class="sk-line"/>${sketchText(50, 146 + i * 36, r)}`).join('')}
        <rect x="22" y="${128 + 2 * 36}" width="156" height="28" rx="8" class="sk-hl"/>`, L('ariaIosSheet'));
    }
    case 'iosAdd':
      return sketchFrame(`<rect x="16" y="20" width="168" height="270" rx="14" class="sk-sheet"/>
        ${sketchText(28, 44, L('cancel'))}${sketchText(172, 44, L('add'), 'text-anchor="end" font-weight="600"')}
        <rect x="106" y="28" width="76" height="24" rx="8" class="sk-hl"/>
        <rect x="30" y="72" width="40" height="40" rx="10" class="sk-appicon"/>${sketchText(82, 96, 'Logbuch')}`, L('ariaIosAdd'));
    case 'chromeMenu':
      return sketchFrame(`<rect x="24" y="18" width="128" height="24" rx="12" class="sk-bar"/>${sketchText(88, 34, 'logbuch', 'text-anchor="middle"')}
        ${[24, 30, 36].map((y) => `<circle cx="170" cy="${y}" r="1.8" class="sk-dot"/>`).join('')}<circle cx="170" cy="30" r="13" class="sk-hl"/>${sketchPage(60)}`, L('ariaChromeMenu'));
    case 'chromeList': {
      const rows = [[L('newTab')], [L('history')], [L('bookmarks')], [L('addHomeAndroid1'), L('addHomeAndroid2')]];
      return sketchFrame(`${sketchPage(60)}<rect x="62" y="16" width="122" height="176" rx="8" class="sk-sheet"/>
        ${rows.map((r, i) => r.map((line, j) => sketchText(74, 42 + i * 34 + j * 13, line)).join('')).join('')}
        <rect x="66" y="${24 + 3 * 34}" width="114" height="40" rx="6" class="sk-hl"/>`, L('ariaChromeList'));
    }
    case 'samsungMenu':
      return sketchFrame(`${sketchPage()}<rect x="24" y="18" width="152" height="24" rx="12" class="sk-bar"/>${sketchText(100, 34, 'logbuch', 'text-anchor="middle"')}
        ${['‹', '›', '⌂', '▢'].map((c, i) => sketchText(36 + i * 34, 274, c, 'text-anchor="middle"')).join('')}
        ${[264, 269, 274].map((y) => `<rect x="161" y="${y - 0.9}" width="14" height="1.8" rx="0.9" class="sk-dot"/>`).join('')}<circle cx="168" cy="269" r="14" class="sk-hl"/>`, L('ariaSamsungMenu'));
    case 'samsungList': {
      const tiles = [[L('bookmarks')], [L('history')], [L('addPageTo1'), L('addPageTo2')], [L('downloads')]];
      return sketchFrame(`${sketchPage()}<rect x="16" y="150" width="168" height="140" rx="14" class="sk-sheet"/>
        ${tiles.map((tile, i) => { const cx = 58 + (i % 2) * 84, y = 166 + Math.floor(i / 2) * 56; return `<rect x="${cx - 8}" y="${y - 4}" width="16" height="16" rx="4" class="sk-line"/>${tile.map((line, j) => sketchText(cx, y + 24 + j * 10, line, 'text-anchor="middle" font-size="9"')).join('')}`; }).join('')}
        <rect x="18" y="${166 + 56 - 6}" width="80" height="46" rx="8" class="sk-hl"/>`, L('ariaSamsungList'));
    }
    case 'genericMenu':
      // Zwei übliche Stellen fürs Menü, beide gestrichelt markiert: "hier oder hier".
      return sketchFrame(`<rect x="24" y="18" width="128" height="24" rx="12" class="sk-bar"/>${sketchText(88, 34, 'logbuch', 'text-anchor="middle"')}
        ${[24, 30, 36].map((y) => `<circle cx="170" cy="${y}" r="1.8" class="sk-dot"/>`).join('')}<circle cx="170" cy="30" r="13" class="sk-hl sk-hl--maybe"/>
        ${sketchPage(60)}
        ${[264, 269, 274].map((y) => `<rect x="161" y="${y - 0.9}" width="14" height="1.8" rx="0.9" class="sk-dot"/>`).join('')}<circle cx="168" cy="269" r="14" class="sk-hl sk-hl--maybe"/>
        ${sketchText(100, 210, L('or'), 'text-anchor="middle" font-style="italic"')}`, L('ariaGenericMenu'));
    case 'genericList': {
      const rows = [[L('newTab')], [L('history')], [L('addHomeGeneric1'), L('addHomeGeneric2')], [L('settings')]];
      return sketchFrame(`${sketchPage(60)}<rect x="62" y="16" width="122" height="176" rx="8" class="sk-sheet"/>
        ${rows.map((r, i) => r.map((line, j) => sketchText(74, 42 + i * 34 + j * 13, line)).join('')).join('')}
        <rect x="66" y="${24 + 2 * 34}" width="114" height="40" rx="6" class="sk-hl"/>`, L('ariaGenericList'));
    }
    case 'operaList': {
      const rows = [[L('reload')], [L('share')], [L('addTo')], [L('zoom')]];
      return sketchFrame(`${sketchPage(60)}<rect x="62" y="16" width="122" height="176" rx="8" class="sk-sheet"/>
        ${rows.map((r, i) => r.map((line, j) => sketchText(74, 42 + i * 34 + j * 13, line)).join('')).join('')}
        ${sketchText(172, 110, '›', 'text-anchor="middle"')}
        <rect x="66" y="${26 + 2 * 34}" width="114" height="30" rx="6" class="sk-hl"/>`, L('ariaOperaList'));
    }
    case 'permIos':
      return sketchFrame(`${sketchPage()}<rect x="30" y="110" width="140" height="96" rx="14" class="sk-sheet"/>
        ${sketchText(100, 136, L('permIosLine1'), 'text-anchor="middle" font-weight="600"')}${sketchText(100, 150, L('permIosLine2'), 'text-anchor="middle" font-weight="600"')}
        <line x1="30" y1="170" x2="170" y2="170" class="sk-sep"/><line x1="100" y1="170" x2="100" y2="206" class="sk-sep"/>
        ${sketchText(65, 192, L('permDeny'), 'text-anchor="middle" font-size="9"')}${sketchText(135, 192, L('permAllow'), 'text-anchor="middle" font-weight="600"')}
        <rect x="104" y="174" width="62" height="28" rx="8" class="sk-hl"/>`, L('ariaPerm'));
    case 'permAndroid':
      // Drei kurze Zeilen: "Benachrichtigungen zu senden?" in einer Zeile ragte über den Dialog.
      return sketchFrame(`${sketchPage()}<rect x="26" y="104" width="148" height="122" rx="14" class="sk-sheet"/>
        ${['permAndroidLine1', 'permAndroidLine2', 'permAndroidLine3'].map((k, i) => sketchText(100, 128 + i * 14, L(k), 'text-anchor="middle" font-weight="600" font-size="10"')).join('')}
        ${sketchText(100, 192, L('permAllowAndroid'), 'text-anchor="middle" font-weight="600"')}${sketchText(100, 214, L('permDenyAndroid'), 'text-anchor="middle" font-size="10"')}
        <rect x="46" y="178" width="108" height="22" rx="8" class="sk-hl"/>`, L('ariaPerm'));
    default: return '';
  }
}
// Schritte je Browser: [Text-Schlüssel, Skizze]. Danach immer eine kurze Vorwarnung
// (der Browser schließt sich meist von selbst - laut Nutzer-Erfahrung kein Problem, daher
// kein eigener Schritt).
function installSteps() {
  switch (installBrowser()) {
    case 'ios-safari': return [['iosSafari1', 'iosShare'], ['ios2', 'iosSheet'], ['ios3', 'iosAdd']];
    case 'ios-other': return [['iosOther1', 'iosShareTop'], ['ios2', 'iosSheet'], ['ios3', 'iosAdd']];
    case 'samsung': return [['samsung1', 'samsungMenu'], ['samsung2', 'samsungList'], ['confirm', null]];
    case 'firefox': return [['firefox1', null], ['firefox2', null], ['confirm', null]];
    case 'chrome': return [['chrome1', 'chromeMenu'], ['chrome2', 'chromeList'], ['confirm', null]];
    case 'opera': return [['opera1', 'chromeMenu'], ['opera2', 'operaList'], ['confirm', null]];
    default: return [['other1', 'genericMenu'], ['other2', 'genericList'], ['confirm', null]];
  }
}
// Faustregel: bei "Schritt für Schritt" die Skizzen direkt im Ablauf, sonst die kurze
// Text-Fassung mit den Skizzen zum Aufklappen.
// Teilen-Symbol von iOS klein im Text statt einer Beschreibung ("Quadrat mit Pfeil nach oben") -
// das Wort "Teilen-Symbol" bleibt davor stehen, für Screenreader ist das Bild ausgeblendet.
const SHARE_ICON_SVG = '<svg class="inline-icon" width="0.9em" height="1.1em" viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 7.5H2.5v11h11v-11h-3"/><path d="M8 1.5v11"/><path d="M4.75 4.5L8 1.5l3.25 3"/></svg>';
// forceSketches: Skizzen direkt im Ablauf (wie bei "Schritt für Schritt") - auf der Seite
// "Logbuch aufs Handy holen" in der App ist man gezielt wegen der Anleitung da.
function installManualHtml(forceSketches = false) {
  const steps = installSteps();
  const list = (withSketches) => `
    <p class="onb-hint">${t('installGate.vary')}</p>
    <ol class="onb-steps install-steps">
      ${steps.map(([key, sketch]) => `<li><span>${t(`installGate.step.${key}`).replace('[share]', SHARE_ICON_SVG)}</span>${withSketches && sketch ? sketchHtml(sketch) : ''}</li>`).join('')}
    </ol>
  `;
  return isGuided() || forceSketches
    ? list(true)
    : `${list(false)}<details class="why-box"><summary class="why-box-title">${t('installGate.showPictures')}</summary>${list(true)}</details>`;
}
// Installieren-Knopf (falls der Browser einen anbietet) bzw. Anleitung von Hand - gemeinsam
// für die Installations-Seite der Einführung und die Seite "Logbuch aufs Handy holen".
function installHowHtml({ forceSketches = false } = {}) {
  const manual = installManualHtml(forceSketches);
  return appJustInstalled
    ? `<p class="tutorial-text"><strong>${t('installGate.installed')}</strong></p>`
    : `
      ${otherBrowserBox()}
      ${deferredInstallPrompt ? `
        <button type="button" class="auth-submit" data-action="install-prompt">${t('installGate.installButton')}</button>
        <p class="onb-hint onb-hint--after">${t('installGate.installButtonNote')}</p>
        <details class="why-box install-fallback"><summary class="why-box-title">${t('installGate.manualFallback')}</summary>${manual}</details>
      ` : manual}
      <p class="onb-hint">${t('installGate.afterwards')}</p>
    `;
}
// Seite "Logbuch aufs Handy holen" (Menü bzw. "Zeig mir, wie" im Hinweis): dieselbe Anleitung
// wie in der Einführung, für alle, die dort "Ich bleib erst mal im Browser" gewählt haben.
function renderInstallGuide() {
  return `
    <div class="onb install-guide">
      <p class="tutorial-text">${t('installGate.body')}</p>
      ${whyBox('installGate.whyTitle', isIOSDevice() ? 'installGate.whyIos' : 'installGate.whyAndroid')}
      ${installHowHtml({ forceSketches: true })}
    </div>
  `;
}
function renderInstallGate() {
  const ios = isIOSDevice();
  const how = installHowHtml();
  app.innerHTML = `
    <div class="auth-box onb">
      ${authBackButton(state.authMode === 'signup' ? (isGuided() ? 'overview' : 'intro') : 'welcome')}
      ${isOnbInProgress() ? onbProgress('install') : ''}
      <div class="onb-icon" aria-hidden="true">${iconSvg('install')}</div>
      <h1 tabindex="-1">${t('installGate.title')}</h1>
      <p class="tutorial-text">${t('installGate.body')}</p>
      ${whyBox('installGate.whyTitle', ios ? 'installGate.whyIos' : 'installGate.whyAndroid')}
      ${how}
      <button type="button" class="auth-toggle" data-action="install-gate-skip">${t('installGate.skip')}</button>
      <p class="onb-hint onb-hint--after onb-center">${t(ios ? 'installGate.skipNoteIos' : 'installGate.skipNote')}</p>
    </div>
  `;
}
// Android-Browser außer Chrome/Samsung Internet: nach unserem Wissen erzeugt nur Chrome (und
// Samsung Internet) eine eigenständige App; Opera, Firefox & Co.
// legen eine Verknüpfung an, deren Mitteilungen an den Browser-Einstellungen hängen (am
// Gerät des Nutzers so gesehen: "Logbuch (Opera Verknüpfung)", App-Info zeigt auf Opera).
// Erkennen lässt sich nur der Browser, nicht, was er anlegt - deshalb informieren und den
// Weg über Chrome anbieten, nicht drängen. Auch wenn der Browser selbst einen
// Installieren-Knopf anbietet (beforeinstallprompt) - ob der dann eine echte App anlegt,
// ist bei Opera & Co. nicht belegt. Der Intent-Link öffnet die Seite direkt in
// Chrome; ?onb= nimmt dort das Einrichten wieder auf (Chrome hat einen eigenen Speicher).
function otherBrowserBox() {
  const browser = installBrowser();
  if (!/Android/.test(navigator.userAgent) || !['opera', 'firefox', 'other'].includes(browser)) return '';
  const name = t(browser === 'opera' ? 'installGate.browserOpera' : browser === 'firefox' ? 'installGate.browserFirefox' : 'installGate.browserOther');
  const intent = `intent://${location.host}${location.pathname}?onb=${isGuided() ? 'guided' : 'short'}#Intent;scheme=https;package=com.android.chrome;end`;
  const address = `${location.host}${location.pathname.replace(/logbuch\.html$/, '')}`;
  return `
    <div class="why-box install-other-browser">
      <p>${t('installGate.otherBrowser', { browser: name })}</p>
      <a class="auth-toggle install-chrome-link" href="${esc(intent)}">${t('installGate.openInChrome')}</a>
      <p class="onb-hint onb-hint--after">${t('installGate.openInChromeNote', { address })}</p>
    </div>
  `;
}
// Der Bestätigungslink aus der Registrierungs-Mail öffnet sich im Browser, nicht in der
// installierten App. Statt sich dann im Browser anzumelden: zurück in die App schicken
// (dort meldet man sich einmal an). Nur auf dem Handy und nur, wenn man nicht bewusst im
// Browser geblieben ist; "hier weitermachen" bleibt möglich.
function renderConfirmLanding() {
  app.innerHTML = `
    <div class="auth-box onb">
      <div class="onb-icon" aria-hidden="true">${iconSvg('done')}</div>
      <h1 tabindex="-1">${t('confirmLanding.title')}</h1>
      <p class="tutorial-text">${t('confirmLanding.body')}</p>
      ${spamFeedbackHtml()}
      <button type="button" class="auth-toggle" data-action="confirm-landing-continue">${t('confirmLanding.continueHere')}</button>
    </div>
  `;
}

// Freiwillige Frage auf der Seite, die der Bestätigungslink öffnet (Nutzer-Entscheidung
// 2026-10-28): lag die Mail im Spam? Der Server speichert nur Antwort + großen Mail-Anbieter,
// ohne Konto-Bezug (record_signup_mail_feedback). Nach der Antwort nur ein Dank, danach weg.
let spamFeedbackAnswered = false;
function spamFeedbackHtml() {
  if (spamFeedbackAnswered) return '';
  return `
    <div class="spam-feedback" role="group" aria-labelledby="spam-feedback-q">
      <p id="spam-feedback-q" class="spam-feedback-q">${t('spamFeedback.question')}</p>
      <div class="spam-feedback-actions">
        <button type="button" class="manage-btn" data-action="spam-feedback" data-in-spam="true">${t('spamFeedback.yes')}</button>
        <button type="button" class="manage-btn" data-action="spam-feedback" data-in-spam="false">${t('spamFeedback.no')}</button>
      </div>
      <p class="habit-form-lock-note">${t('spamFeedback.why')}</p>
    </div>
  `;
}

function renderUnlockPrompt() {
  app.innerHTML = `
    <div class="auth-box">
      ${isOnbInProgress() ? onbProgress('account') : ''}
      <h1>Logbuch</h1>
      <p class="sub">${t('unlock.title')}</p>
      ${state.session?.user?.email ? `<p class="unlock-account">${t('unlock.account', { email: state.session.user.email })}</p>` : ''}
      ${ARRIVED_VIA_SIGNUP_CONFIRM && !isStandaloneDisplay() ? `<div class="notice notice--ok">${t('unlock.afterConfirm')}</div>` : ''}
      ${ARRIVED_VIA_SIGNUP_CONFIRM ? spamFeedbackHtml() : ''}
      <p class="onb-hint">${t('unlock.explain')}</p>
      <details class="why-details" ${isGuided() ? 'open' : ''}><summary>${t('unlock.whyTitle')}</summary><p>${t('unlock.why')}</p></details>
      ${state.unlockError ? `<div class="notice" role="alert">${esc(state.unlockError)}</div>` : ''}
      <form id="unlock-form">
        <div class="auth-field">
          <label for="unlock-password">${t('auth.password')}</label>
          <input type="password" id="unlock-password" required autocomplete="current-password" ${state.unlockBusy ? 'disabled' : ''} />
        </div>
        <button type="submit" class="auth-submit" ${state.unlockBusy ? 'disabled' : ''}>${state.unlockBusy ? t('unlock.unlocking') : t('unlock.unlock')}</button>
      </form>
      <button type="button" class="auth-toggle" data-action="logout">${t('common.logout')}</button>
    </div>
  `;

  document.getElementById('unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('unlock-password').value;
    state.unlockBusy = true;
    state.unlockError = null;
    state.notice = null;
    render();
    try {
      // unlockEncryption deckt beide Fälle ab: bestehende Verschlüsselung entsperren
      // (Passwort falsch -> wirft) UND, falls noch keine user_encryption-Zeile
      // existiert (z.B. Konto gerade erst per E-Mail-Bestätigungslink angemeldet,
      // ohne dass je ein Passwort-Formular durchlaufen wurde), sie mit diesem
      // Passwort neu einrichten — bisher landete dieser Fall in einer Sackgasse
      // (immer "Falsches Passwort", obwohl gar keine Konfiguration existierte).
      // verifyPassword: hier hat niemand das Passwort bei Supabase geprüft (siehe
      // unlockEncryption); die Prüfung meldet sich neu an - authFlowInFlight hält
      // onAuthStateChange dabei heraus.
      authFlowInFlight = true;
      await completeAuthFlow(state.session.user.id, password, { verifyPassword: true });
      state.unlockBusy = false;
    } catch (err) {
      state.unlockBusy = false;
      state.unlockError = unlockErrorText(err);
      render();
    } finally {
      authFlowInFlight = false;
    }
  });
}

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
function sliderColor(habit, v) {
  return isNeutralScale(habit) ? NEUTRAL_SELECTED : habitColor(habit, normalize(habit, v));
}
function habitSliderValueText(habit, v) {
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
function previewHabitFromForm(f) {
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
function effectivePreviewValue(f) {
  const v = f.previewValue === undefined
    ? (f.good === 'low' ? f.min : f.good === 'high' ? f.max : Math.round((f.min + f.max) / 2))
    : f.previewValue;
  return Number.isInteger(v) && v >= f.min && v <= f.max ? v : undefined;
}
// Beispiele vor dem ersten Feld (Nutzer-Entscheidung 2026-10-28): wie Felder später in
// "Heute" aussehen, nur zum Anschauen - bewusst keine Vorlagen zum Antippen (siehe
// docs/onboarding.md). Nachgebaut aus denselben CSS-Bausteinen wie "Heute", aber als
// reine Bilder (keine Knöpfe), die Beschreibung darunter ist der Text für Screenreader.
function tutorialExamplesHtml() {
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
function renderHabitFormPreview(f) {
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
function refreshHabitFormPreview() {
  const preview = document.querySelector('.field-preview');
  if (!preview || !state.habitForm) return false;
  preview.outerHTML = renderHabitFormPreview(state.habitForm);
  return true;
}
// Wert in der Vorschau setzen/entfernen: nur die Vorschau austauschen (kein render(), das
// Formular bleibt, wie es ist) und den Fokus auf dasselbe Element zurückgeben.
function setPreviewValue(value, focusSelector) {
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
      <div class="computed-readout computed-readout--number">${value !== null ? esc(formatSeriesValue(habit, value)) : '–'}</div>
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
      <div class="computed-readout computed-readout--number">${value !== null ? esc(formatNumber(value)) + (unit ? ' ' + esc(unit) : '') : '–'}</div>
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
function renderRowMenuButton(key, label) {
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
function renderSectionMenuPanel(section) {
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
function statsFieldName(h, ctx) {
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
function positionFloatingRowMenu() {
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
const DAY_MENU_KEY = 'day';
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
function openRowMenu(key) {
  state.rowMenu = key;
  render();
  document.querySelector('.row-menu button')?.focus({ preventScroll: true });
}
function closeRowMenu() {
  const key = state.rowMenu;
  state.rowMenu = null;
  render();
  document.querySelector(`.row-menu-trigger[data-menu="${key}"]`)?.focus({ preventScroll: true });
}

// Notiz unter einem Feld bzw. im Tagesnotiz-Bereich: entweder der offene Editor, oder
// die vorhandene Notiz als antippbarer Text (öffnet den Editor), oder nichts. key: Feld,
// Gruppe ('section:<id>') oder Tag (DAY_NOTE_KEY). Nur Text-Felder haben keine Notizen
// (wären doppelt zum Freitext, siehe renderRowMenuPanel).
function renderNote(dateKey, key, label) {
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
function isOpenToday(h, dayEntry) { return h.kind !== 'computed' && !isCounterKind(h) && dayEntry[h.id] === undefined; }
function todayTrackedFields() {
  return activeHabits().filter((h) => h.kind !== 'computed' && !isCounterKind(h) && !isPeriodField(h) && isPlannedOn(h, state.currentDate));
}
// Punkt + Screenreader-Text; bleibt (versteckt) im DOM, damit syncTodayOpenMarkers ihn
// beim Tippen in Text-Feldern ohne Re-Render umschalten kann.
function openMarkerHtml(h, dayEntry) {
  return `<span class="open-marker" data-open-for="${h.id}"${isOpenToday(h, dayEntry) ? '' : ' hidden'}><span class="open-dot" aria-hidden="true"></span><span class="visually-hidden">${t('today.openField')}</span></span>`;
}
// Text-Felder speichern beim Tippen ohne render() (updateTextValue) - Punkt und
// Abschluss-Hinweis hier direkt nachziehen.
function syncTodayOpenMarkers() {
  const dayEntry = state.entries[formatKey(state.currentDate)] || {};
  const dateKey = formatKey(state.currentDate);
  document.querySelectorAll('.open-marker[data-open-for]').forEach((m) => {
    const id = m.dataset.openFor;
    m.hidden = (state.entries[entryKeyFor(id, dateKey)] || {})[id] !== undefined;
  });
  document.querySelectorAll('.section-done[data-done-fields]').forEach((m) => {
    const ids = m.dataset.doneFields.split(' ').filter(Boolean);
    m.hidden = !ids.length || ids.some((id) => dayEntry[id] === undefined);
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
function focusTodayField(habitId, { editInput = false } = {}) {
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
      ${renderRowHead(h, nameWithUnit + marker, lastNote ? `<span class="number-last">${lastNote}</span>` : '')}
      <input type="number" inputmode="decimal" step="any" id="number-input-${h.id}" class="number-input" data-action="number-input" data-habit="${h.id}" value="${esc(currentValue)}" aria-label="${nameWithUnit}"${currentValue === '' ? '' : goalValueStyle(h, currentValue)} />${hasNumberGoal(h) ? goalSuffixHtml(h) : ''}
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
let timePicker = null;
const TIME_PICKER_STEPS = [5, 15, 60];
const TIME_PICKER_MAX = 2 * MINUTES_PER_DAY - 1; // höchstens 23:59 am nächsten Tag

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
  return Math.max(Math.ceil(-p.value / u), Math.min(Math.floor((TIME_PICKER_MAX - p.value) / u), r));
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
  p.value = p.dateKey ? Math.max(0, Math.min(TIME_PICKER_MAX, v)) : ((v % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
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

function openTimePicker(p) {
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
function closeTimePicker({ viaPopstate = false, focus = true } = {}) {
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
  const goal = hasNumberGoal(h);
  return `
    <div class="habit-row habit-row--counter">
      ${renderRowHead(h, nameWithUnit)}
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

function renderTodayHabitRow(h, dateKey, dayEntry, { trackOpen = false } = {}) {
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
function setTodayIntroPending(on) {
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
function periodRangeLabel(period, date) {
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
function renderTodayDayNav() {
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

function renderToday() {
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
      ${!allActive.length ? `<p class="manage-meta">${t('today.noFields')}</p>` : habits.length && !planned.length ? `<p class="manage-meta">${t('today.nothingPlanned')}</p>` : ''}
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
function hasAnyEntries() {
  return Object.values(state.entries).some((day) => dayHasValues(day));
}
function renderStatsEmpty() {
  return `<div class="stats-empty">${icon('stats')}${t('stats.empty')}</div>`;
}
// "Was bedeuten Farben und Zahlen?" - dauerhaft, zugeklappt, unter Woche/Monat/Jahr/Gesamt
// (kind 'week' oder 'stats'). Klein gehalten; die große Überarbeitung der Auswertung ist ein
// eigenes Thema.
function renderStatsLegend(kind) {
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
function renderWeek() {
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
    const numVals = hasNumberGoal(h) ? dayKeys.filter((k, i) => scores[i] !== null).map((k) => habitNumericValue(h, k)) : [];
    const numAvg = numVals.length ? numVals.reduce((a, b) => a + b, 0) / numVals.length : null;
    const avgLong = avg !== null ? `${h.name}: ${habitAvgLong(h, avg, valid.length, hits, numAvg)}${isYesNoScale(h) || hasNumberGoal(h) ? '' : ` (${valid.length}×)`}` : '';
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
function renderMonth() {
  const year = state.monthAnchor.getFullYear();
  const month = state.monthAnchor.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
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
      ${mondayFirstWeekdayShortNames().map((w) => `<div class="month-weekday">${w}</div>`).join('')}
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
function renderYear() {
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
function dayHasValues(day) {
  return Object.keys(day || {}).some((k) => !k.startsWith('_'));
}
function dayHasDayValues(day) {
  return Object.keys(day || {}).some((k) => !k.startsWith('_') && !isPeriodField(state.habits.find((h) => h.id === k)));
}
function renderGlobal() {
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

// --- Rendering: Über Logbuch / Tipps -----------------------------------------
// Ruhige, freiwillig aufsuchbare Sammelstelle für Bedienhinweise, die sonst nirgends
// erklärt werden (Wischen, Tag antippen zum Springen, Gruppen, ...) — bewusst kein
// aufdringliches Tutorial/Tooltip-Overlay, sondern eine Seite, die da ist, wenn man
// neugierig ist. Die Tipp-Gruppen (tipGroup) sind eine simple Array-Struktur statt
// vieler Einzel-Strings, damit neue Tipps sich leicht ergänzen lassen.
// Ein Tipp in "Über Logbuch". link (optional): wohin der Tipp verweist - { menu:
// '<data-menu-target>' } öffnet die Einstellungen und springt zur Einstellung (focusSettingsTarget),
// { manage: true } öffnet "Felder verwalten". Der Tipp-Titel steht im Link zusätzlich
// unsichtbar für Screenreader, sonst hießen alle Links nur "Im Menü zeigen".
// bodyTag 'div' für Texte mit Liste (Datenschutz), sonst 'p'.
function renderTip([titleKey, bodyKey, link], bodyTag = 'p') {
  const linkHtml = !link ? '' : link.menu
    ? `<button type="button" class="link-btn tip-link" data-action="open-settings-at" data-target="${link.menu}">${t('about.link.menu')}<span class="visually-hidden">: ${t(titleKey)}</span></button>`
    : `<button type="button" class="link-btn tip-link" data-action="open-manage">${t('about.link.manage')}<span class="visually-hidden">: ${t(titleKey)}</span></button>`;
  return `
    <div class="tip">
      <p class="tip-title">${t(titleKey)}</p>
      <${bodyTag} class="tip-body">${t(bodyKey)}</${bodyTag}>
      ${linkHtml}
    </div>
  `;
}
function tipGroup(groupTitleKey, tips, iconName) {
  const collapseKey = `tipGroup:${groupTitleKey}`;
  return `
    <details class="tip-group" data-collapse-key="${collapseKey}" ${isAboutSectionCollapsed(collapseKey) ? '' : 'open'}>
      <summary class="manage-section-title">${iconName ? icon(iconName) : ''}${t(groupTitleKey)}</summary>
      ${tips.map((tip) => renderTip(tip)).join('')}
    </details>
  `;
}

// Eigener, optisch hervorgehobener Bereich (statt nur einer weiteren Tipp-Gruppe) —
// ausdrücklicher Nutzerwunsch, das Thema sichtbar stärker zu gewichten als die
// übrigen, eher beiläufigen Bedienungs-Tipps. Ausführlichere Texte inkl. der
// Begründung, warum uns das wichtig ist (siehe CLAUDE.md-Präferenz "Accessibility
// als proaktiver Standard" bzw. die dahinterliegende Motivation), nicht nur die
// nackten Fakten.
function renderA11ySection() {
  const items = [
    ['about.a11y.pattern.title', 'about.a11y.pattern.body', { menu: 'pattern' }],
    ['about.a11y.textSize.title', 'about.a11y.textSize.body', { menu: 'text-size' }],
    ['about.a11y.buttons.title', 'about.a11y.buttons.body'],
    ['about.a11y.keyboard.title', 'about.a11y.keyboard.body'],
    ['about.a11y.screenreader.title', 'about.a11y.screenreader.body'],
  ];
  return `
    <details class="a11y-highlight" data-collapse-key="aboutA11yCollapsed" ${isAboutSectionCollapsed('aboutA11yCollapsed') ? '' : 'open'}>
      <summary class="manage-section-title">${icon('a11y')}${t('about.a11y.title')}</summary>
      <p class="tip-body">${t('about.a11y.intro')}</p>
      ${items.map((tip) => renderTip(tip)).join('')}
      <p class="tip-body a11y-feedback">${t('about.a11y.feedback')} <button type="button" class="link-btn" data-action="open-feedback">${t('menu.feedback')}</button></p>
    </details>
  `;
}

// Ebenfalls eigener hervorgehobener Bereich, gleiches Muster wie renderA11ySection —
// derselbe Gedanke, dass ein Produkt, das beim An-sich-selbst-Arbeiten helfen soll,
// auch aktiv auf einen gesunden Umgang damit hinweisen sollte, statt das nur implizit
// zu hoffen. Der Krisen-Hinweis (Telefonseelsorge) ist bewusst optisch eigenständig
// (rust- statt moss-Ton) hervorgehoben, da er der konkret handlungsrelevante Teil ist.
function renderMentalHealthSection() {
  const items = [
    ['about.mentalHealth.observation.title', 'about.mentalHealth.observation.body'],
    ['about.mentalHealth.noSubstitute.title', 'about.mentalHealth.noSubstitute.body'],
  ];
  return `
    <details class="mental-health-highlight" data-collapse-key="aboutMentalHealthCollapsed" ${isAboutSectionCollapsed('aboutMentalHealthCollapsed') ? '' : 'open'}>
      <summary class="manage-section-title">${icon('mentalHealth')}${t('about.mentalHealth.title')}</summary>
      <p class="tip-body">${t('about.mentalHealth.intro')}</p>
      ${items.map((tip) => renderTip(tip)).join('')}
      <div class="tip mental-health-crisis">
        <p class="tip-title">${t('about.mentalHealth.crisis.title')}</p>
        ${detectLikelyCountry() === 'DE' ? `
          <p class="tip-body">${t('about.mentalHealth.crisis.germany')}</p>
          <div class="crisis-actions">
            <a class="crisis-action-button" href="https://www.telefonseelsorge.de" target="_blank" rel="noopener">${esc(t('about.mentalHealth.crisis.websiteButton'))}</a>
            <a class="crisis-action-button" href="tel:+498001110111">${esc(t('about.mentalHealth.crisis.callButton1'))}</a>
            <a class="crisis-action-button" href="tel:+498001110222">${esc(t('about.mentalHealth.crisis.callButton2'))}</a>
          </div>
        ` : ''}
        <p class="tip-body">${t('about.mentalHealth.crisis.international')}</p>
        <p class="tip-body">${t('about.mentalHealth.crisis.emergency')}</p>
        <p class="tip-body">${t('about.mentalHealth.crisis.closing')}</p>
      </div>
      <p class="tip-body mental-health-feedback">${t('about.mentalHealth.feedback')} <button type="button" class="link-btn" data-action="open-feedback">${t('menu.feedback')}</button></p>
    </details>
  `;
}

// Dritter hervorgehobener Bereich, gleiches Muster wie renderA11ySection: was der
// Betreiber sehen kann und was nicht, und warum. WICHTIG: muss mit der Technik
// übereinstimmen - ändert sich, was der Server im Klartext sieht (neue unverschlüsselte
// Spalte, Log, Auswertung o.ä.), diesen Text mit anpassen (siehe CLAUDE.md
// "Verschlüsselung"). Die Punkte stehen in <div> statt <p>, da einer eine Liste enthält.
function renderPrivacySection() {
  const items = [
    ['about.privacy.cannotSee.title', 'about.privacy.cannotSee.body'],
    ['about.privacy.canSee.title', 'about.privacy.canSee.body'],
    ['about.privacy.recoveryKey.title', 'about.privacy.recoveryKey.body', { menu: 'recovery-key' }],
    ['about.privacy.yourData.title', 'about.privacy.yourData.body', { menu: 'export' }],
  ];
  return `
    <details class="privacy-highlight" data-collapse-key="aboutPrivacyCollapsed" ${isAboutSectionCollapsed('aboutPrivacyCollapsed') ? '' : 'open'}>
      <summary class="manage-section-title">${icon('privacy')}${t('about.privacy.title')}</summary>
      <p class="tip-body">${t('about.privacy.intro')}</p>
      ${items.map((tip) => renderTip(tip, 'div')).join('')}
      <p class="tip-body privacy-feedback">${t('about.privacy.feedback')} <button type="button" class="link-btn" data-action="open-feedback">${t('menu.feedback')}</button></p>
    </details>
  `;
}

// Von Hand hochgezählt bei größeren Änderungen - kein Build-Step im Projekt, der das
// automatisch aus Git ableiten könnte, und ein Datum genügt hier als Rückverfolgbarkeit
// (siehe Diskussion in CLAUDE.md-Kontext: keine echte Versionsnummer nötig, solange es
// keine Release-Branches/nennenswerten externen Nutzerkreis gibt).
// "Was ist neu" (Nutzer-Entscheidung 2026-10-11): neueste zuerst, Kennung = Datum des
// Live-Gangs (zweiter am selben Tag: "2026-10-11b" - sonst gälte er als schon gesehen). Nur,
// was Nutzer weiterbringt (neue Möglichkeiten), keine Interna; de + en, kurz, ohne
// Fachbegriffe. **Ein schon live gegangener Eintrag wird nie mehr erweitert** (wer ihn
// geschlossen hat, sähe die Ergänzung nie) - stattdessen ein neuer; wer mehrere verpasst hat,
// sieht alle gestapelt (das Fenster scrollt). Siehe CLAUDE.md. Nach einem Update zeigt die App die noch nicht gesehenen Einträge einmal als
// Fenster (renderWhatsNew), gesehen gilt pro Konto (user_settings.last_seen_changelog);
// "Über Logbuch" zeigt alle.
// Zwei Stufen (Nutzer-Entscheidung 2026-10-29): short = eine Zeile pro Neuerung fürs Fenster,
// verständlich auch ohne die App gut zu kennen; de/en = ausführlicher für "Über Logbuch".
// Ältere Einträge ohne short zeigen im Fenster die ausführliche Fassung.
const CHANGELOG = [
  {
    id: '2026-10-29',
    short: {
      de: ['Felder, in die du schon etwas eingetragen hast, kannst du jetzt umbauen – z. B. einer Skala mehr Stufen geben.'],
      en: ['You can now rework fields you’ve already filled in – e.g. give a scale more steps.'],
    },
    de: [
      'Felder, in die du schon etwas eingetragen hast, kannst du jetzt umbauen: einer Skala mehr oder weniger Stufen geben („Stufen ändern“) oder den Typ wechseln, z. B. von Skala zu Zahl („Typ ändern“). Beides findest du, wenn du das Feld bearbeitest. Du legst selbst fest, was aus deinen bisherigen Einträgen wird, und kannst es wieder rückgängig machen.',
    ],
    en: [
      'You can now rework fields you’ve already filled in: give a scale more or fewer steps (“Change steps”) or switch its type, e.g. from scale to number (“Change type”). You’ll find both when you edit the field. You decide what happens to your previous entries, and you can undo it.',
    ],
  },
  {
    id: '2026-10-28',
    short: {
      de: [
        'Mehrere Erinnerungen pro Feld, auch für Zähler.',
        'Felder können jetzt auch alle paar Tage dran sein.',
        'Tipp in „Heute“ aufs Datum, um direkt einen Tag auszuwählen.',
        'In Woche, Monat, Jahr und Gesamt: Tipp auf den Namen eines Felds, um es zu bearbeiten.',
      ],
      en: [
        'Several reminders per field, counters included.',
        'Fields can now also be due every few days.',
        'Tap the date in “Today” to pick a day directly.',
        'In Week, Month, Year and Overall: tap a field’s name to edit it.',
      ],
    },
    de: [
      'Ein Feld kann jetzt bis zu vier Erinnerungszeiten haben, z. B. morgens und abends. Auch Zähler erinnern dich jetzt – auf Wunsch nur, wenn sie zu der Zeit unter einer Zahl liegen, die du festlegst.',
      'Ein Feld kann jetzt auch alle paar Tage dran sein, z. B. alle 3 Tage – wenn du ein Feld anlegst, unter „An welchen Tagen?“.',
      'Tippst du in „Heute“ auf das Datum, kannst du direkt einen Tag auswählen.',
      'In Woche, Monat, Jahr und Gesamt kannst du ein Feld bearbeiten, indem du auf seinen Namen tippst.',
    ],
    en: [
      'A field can now have up to four reminder times, e.g. morning and evening. Counters can remind you now too – if you like, only when they’re below a number you choose at that time.',
      'A field can now also be due every few days, e.g. every 3 days – when you create a field, under “On which days?”.',
      'Tap the date in “Today” to pick a day directly.',
      'In Week, Month, Year and Overall you can edit a field by tapping its name.',
    ],
  },
  {
    id: '2026-10-14',
    de: [
      'Woche, Monat, Jahr und Gesamt sind jetzt besser lesbar.',
      'Menüs und Fenster erscheinen sanfter, Knöpfe reagieren sichtbar, wenn du sie antippst.',
      'Hat eine Zahl ein Ziel, steht es in „Heute“ direkt daneben, zum Beispiel „1 / 2“ – und die Zahl wird grüner, je näher du dran bist.',
      'Den Tag siehst du in „Heute“ jetzt beim Scrollen immer oben, darunter steht, wenn alles eingetragen ist. Wer mag, lässt dort auch den Stand anzeigen, z. B. „3 von 7“ – in den Einstellungen unter Anzeige.',
    ],
    en: [
      'Week, Month, Year and Overall are now easier to read.',
      'Menus and windows appear more smoothly, and buttons respond visibly when you tap them.',
      'If a number has a goal, “Today” shows it right next to it, e.g. “1 / 2” – and the number turns greener the closer you get.',
      'In “Today” the day now always stays at the top while you scroll, with a note once everything is filled in. If you like, it can also show your progress, e.g. “3 of 7” – in the settings under Display.',
    ],
  },
  {
    id: '2026-10-12',
    de: [
      'Wenn du ein Feld anlegst oder änderst, ist alles übersichtlicher geordnet, mit einer Vorschau, wie es später aussieht.',
      'Zahlen kannst du in Woche, Monat und Jahr jetzt auch als Summe sehen statt als Durchschnitt, etwa bei Arbeitszeit – einstellbar im Feld unter „Auswertung“.',
      'Feste Tage stellst du jetzt einfach über die Wochentage ein, alle sind vorausgewählt.',
    ],
    en: [
      'When you create or change a field, everything is laid out more clearly, with a preview of how it will look.',
      'Numbers can now show a total instead of an average in week, month and year, e.g. for working hours – set it in the field under “Statistics”.',
      'Fixed days are now set simply via the weekdays, all of which are preselected.',
    ],
  },
  {
    id: '2026-10-11',
    de: [
      'Felder können jetzt wöchentlich, monatlich oder jährlich sein, zum Beispiel „Diese Woche geputzt?“ – du findest sie in „Heute“ ganz unten.',
      'Zahlen kannst du jetzt auch mit „+“ hochzählen, etwa Zigaretten oder Gläser Wasser – und ihnen ein Ziel geben wie „mindestens 8“ oder „höchstens 3“.',
      'Gruppen sind als Block hervorgehoben und klappen zu, sobald alles eingetragen ist (einstellbar pro Gruppe).',
      'Ziele und Auswertung in verständlichen Zahlen statt Prozent, zum Beispiel „an 3 von 7 Tagen“ oder „Ø 3,4 von 5“.',
    ],
    en: [
      'Fields can now be weekly, monthly or yearly, for example “Cleaned this week?” – you find them at the very bottom of “Today”.',
      'Numbers can now be counted up with “+”, e.g. cigarettes or glasses of water – and get a goal like “at least 8” or “at most 3”.',
      'Groups stand out as a block and collapse once everything is filled in (adjustable per group).',
      'Goals and statistics in plain numbers instead of percent, for example “on 3 of 7 days” or “avg. 3.4 of 5”.',
    ],
  },
];
// "Beta – Stand …" in "Über Logbuch" = neuester Eintrag (früher eine eigene Konstante, die man
// zusätzlich pflegen musste).
const APP_STATUS_DATE = CHANGELOG[0].id;
function changelogItems(entry) { return entry[currentLocale] || entry.de; }
function changelogShortItems(entry) { return entry.short ? (entry.short[currentLocale] || entry.short.de) : changelogItems(entry); }
function unseenChangelog() {
  const last = state.userSettings.lastSeenChangelog;
  return CHANGELOG.filter((e) => !last || e.id > last);
}
function renderWhatsNew() {
  const entries = unseenChangelog();
  return `
    <div class="modal-overlay">
      <div class="modal-box whats-new" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
        <h2 id="whats-new-title">${icon('news')}${t('whatsNew.title')}</h2>
        ${entries.map((e) => `
          ${entries.length > 1 ? `<h3 class="whats-new-date">${esc(formatDMY(e.id))}</h3>` : ''}
          <ul class="whats-new-list">${changelogShortItems(e).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
        `).join('')}
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="whats-new-all">${t('whatsNew.all')}</button>
          <button type="button" class="auth-submit" data-action="whats-new-close">${t('whatsNew.close')}</button>
        </div>
      </div>
    </div>
  `;
}
// Schließen = gesehen, auf allen Wegen (Knopf, Escape, Zurück), sonst käme es beim nächsten
// Öffnen wieder. Best effort: schlägt das Speichern fehl, kommt das Fenster eben nochmal.
function closeWhatsNew() {
  state.whatsNew = false;
  const latest = CHANGELOG[0].id;
  state.userSettings = { ...state.userSettings, lastSeenChangelog: latest };
  if (state.session) {
    supabase.from('user_settings').upsert({ user_id: state.session.user.id, last_seen_changelog: latest }, { onConflict: 'user_id' })
      .then(({ error }) => { if (error) console.warn('Neuigkeiten nicht als gesehen gespeichert:', error.message); });
  }
}
// Aufklappbar und zu Beginn zu wie die übrigen Bereiche hier; "Alle Neuigkeiten" im
// "Was ist neu"-Fenster öffnet ihn (whats-new-all).
function renderAboutNews() {
  return `
    <details class="tip-group about-news" id="about-news" data-collapse-key="aboutNewsCollapsed" ${isAboutSectionCollapsed('aboutNewsCollapsed') ? '' : 'open'}>
      <summary class="manage-section-title">${icon('news')}${t('about.news.title')}</summary>
      ${CHANGELOG.map((e) => `
        <h3 class="whats-new-date">${esc(formatDMY(e.id))}</h3>
        <ul class="whats-new-list">${changelogItems(e).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      `).join('')}
    </details>
  `;
}

function renderAbout() {
  return `
    <p class="about-status">${t('about.status', { date: formatDMY(APP_STATUS_DATE) })} <button type="button" class="link-btn" data-action="open-feedback">${t('menu.feedback')}</button></p>
    <p class="about-status about-status--secondary">${t('about.monetizationNote')}</p>
    <p class="about-intro">${t('about.intro')}</p>
    ${renderMentalHealthSection()}
    ${renderA11ySection()}
    ${renderPrivacySection()}
    <div class="manage-section-divider"></div>
    ${renderAboutNews()}
    <div class="manage-section-divider"></div>
    ${tipGroup('about.group.usage', [
      ['about.tip.swipe.title', 'about.tip.swipe.body'],
      ['about.tip.keys.title', 'about.tip.keys.body'],
      ['about.tip.jumpDay.title', 'about.tip.jumpDay.body'],
      ['about.tip.toggleOff.title', 'about.tip.toggleOff.body'],
      ['about.tip.openDot.title', 'about.tip.openDot.body'],
      ['about.tip.fieldMenu.title', 'about.tip.fieldMenu.body'],
      ['about.tip.reorder.title', 'about.tip.reorder.body', { manage: true }],
    ], 'usage')}
    <div class="manage-section-divider"></div>
    ${tipGroup('about.group.fields', [
      ['about.tip.noValuation.title', 'about.tip.noValuation.body'],
      ['about.tip.computed.title', 'about.tip.computed.body'],
      ['about.tip.goalThreshold.title', 'about.tip.goalThreshold.body'],
      ['about.tip.slider.title', 'about.tip.slider.body'],
      ['about.tip.textFields.title', 'about.tip.textFields.body'],
      ['about.tip.customReminder.title', 'about.tip.customReminder.body'],
      ['about.tip.sections.title', 'about.tip.sections.body', { manage: true }],
      ['about.tip.schedule.title', 'about.tip.schedule.body', { manage: true }],
      ['about.tip.archiveVsDelete.title', 'about.tip.archiveVsDelete.body', { manage: true }],
    ], 'fields')}
    <div class="manage-section-divider"></div>
    ${tipGroup('about.group.appearance', [
      ['about.tip.theme.title', 'about.tip.theme.body', { menu: 'theme' }],
      ['about.tip.textSize.title', 'about.tip.textSize.body', { menu: 'text-size' }],
      ['about.tip.language.title', 'about.tip.language.body', { menu: 'language' }],
    ], 'appearance')}
  `;
}

// Übergangslösung, bis es ggf. einen Community-Bereich gibt. Das eigentliche Limit
// (5 pro 24h) und die Mail an den Betreiber laufen serverseitig in der Edge Function
// submit-feedback. Der Absender-Hinweis wird beim Umschalten direkt im DOM getauscht
// statt per render() - ein Re-Render würde den Fokus von der Checkbox wegreißen.
// t() escaped die E-Mail-Adresse bereits - das Ergebnis ist fertiges HTML (innerHTML,
// nie noch einmal durch esc()).
function feedbackSenderNote(anonymous) {
  return anonymous ? t('feedback.anonymousNote') : t('feedback.replyNote', { email: state.session?.user?.email ?? '' });
}
function renderFeedback() {
  const f = state.feedback;
  return `
    <div class="feedback-form">
      <p class="tip-body feedback-intro">${t('feedback.intro')}</p>
      <div class="auth-field">
        <label for="feedback-message">${t('feedback.messageLabel')}</label>
        <textarea id="feedback-message" maxlength="5000" ${f.busy ? 'disabled' : ''}>${esc(f.message)}</textarea>
      </div>
      <label class="checkbox-field">
        <input type="checkbox" data-action="feedback-anonymous" aria-describedby="feedback-sender-note" ${f.anonymous ? 'checked' : ''} ${f.busy ? 'disabled' : ''} />
        ${t('feedback.anonymousLabel')}
      </label>
      <p class="habit-form-lock-note" id="feedback-sender-note">${feedbackSenderNote(f.anonymous)}</p>
      <button type="button" class="manage-new-btn" data-action="feedback-submit" ${f.busy ? 'disabled' : ''}>${f.busy ? t('feedback.sending') : t('feedback.submit')}</button>
    </div>
  `;
}

async function handleFeedbackSubmit() {
  const message = state.feedback.message.trim();
  if (!message) {
    state.notice = { type: 'error', text: t('feedback.error.empty') };
    render();
    return;
  }
  state.feedback.busy = true;
  render();
  const { error } = await supabase.functions.invoke('submit-feedback', {
    body: { message, anonymous: state.feedback.anonymous, locale: currentLocale },
  });
  state.feedback.busy = false;
  if (error) {
    // Bei Nicht-2xx liefert supabase-js die eigentliche Antwort in error.context.
    let code = null;
    try { code = (await error.context.json()).error; } catch { /* z.B. Netzwerkfehler */ }
    state.notice = { type: 'error', text: code === 'rate_limited' ? t('feedback.error.rateLimited') : t('feedback.error.failed') };
  } else {
    state.feedback = { message: '', anonymous: false, busy: false };
    state.notice = { type: 'ok', text: t('feedback.sent') };
  }
  render();
}

// Durchschnitt eines bewerteten Felds in natürlichen Begriffen (Nutzer-Entscheidung
// 2026-10-10, statt Prozent für alle): Ja/Nein "an 2 von 5 Tagen „Ja“", mehrstufige Skala
// "Ø 3,4" in den Werten des Felds (bei eigenen Bezeichnungen zusätzlich, zwischen welchen
// sie liegt), berechnete Felder weiter in % (sie mitteln über verschiedene Skalen).
// avg = Mittel der normalisierten Scores über die eingetragenen Tage, count = deren Anzahl.
function isYesNoScale(h) { return h.kind === 'scale' && !!h.good && h.max - h.min === 1; }
function scaleLabelAt(h, value) { return h.labels ? h.labels[value - h.min] : String(value); }
function avgScaleValue(h, avg) {
  return h.good === 'low' ? h.max - avg * (h.max - h.min) : h.min + avg * (h.max - h.min);
}
// Zwischen welchen Bezeichnungen der Ø liegt, mit ihren Zahlen (dieselben wie im
// Feld-Formular vor den Bezeichnungen), damit die Zahl davor zuzuordnen ist:
// "keine (1) – leicht (2)"; liegt der Ø auf einer Stufe, nur deren Bezeichnung.
function avgLabelSpan(h, avg) {
  if (!h.labels) return '';
  const v = avgScaleValue(h, avg);
  const lower = Math.floor(v + 0.05);
  const upper = Math.ceil(v - 0.05);
  return lower >= upper
    ? scaleLabelAt(h, lower)
    : `${scaleLabelAt(h, lower)} (${formatNumber(lower)}) – ${scaleLabelAt(h, upper)} (${formatNumber(upper)})`;
}
// Mini-Skala mit Punkt an der Stelle des Ø (Skalen ab drei Stufen): eine Zahl allein verrät
// nicht, wie viele Stufen es gibt, eine Bezeichnung passt oft nicht in die Wochenspalte.
// Ausgerichtet wie das Feld selbst (links der erste Wert, wie die Knöpfe in "Heute"); ob gut
// oder schlecht, zeigt die Farbe (Nutzer-Entscheidung 2026-10-11 - "rechts = besser" war bei
// "Niedrige Werte erstrebenswert" verwirrend).
function isMultiStepScale(h) { return h.kind === 'scale' && !!h.good && h.max - h.min > 1; }
function avgMiniScale(h, avg, extraClass = '') {
  const pos = h.good === 'low' ? 1 - avg : avg; // avg ist "wie gut" - zurück auf die Feldrichtung
  return `<span class="avg-scale${extraClass}" aria-hidden="true"><span class="avg-scale-dot" style="left:${(pos * 100).toFixed(1)}%"></span></span>`;
}
// Kurzform für die schmale Ø-Spalte der Woche (HTML); den genauen Wert zeigt Antippen.
// Zahlen mit Ziel: der Durchschnitt ist die Hauptzahl (Zahlen denkt man in Schnitten - "2/7"
// sah wie ein Wert aus), wie oft das Ziel erreicht war steht in der Langform.
function habitAvgShort(h, avg, count, hits = 0, numAvg = null) {
  if (hasNumberGoal(h)) return formatNumber(round1(numAvg ?? 0));
  if (isMultiStepScale(h)) return avgMiniScale(h, avg);
  if (isYesNoScale(h)) return `${Math.round(avg * count)}/${count}`;
  if (h.kind === 'scale') return formatNumber(round1(avgScaleValue(h, avg)));
  return Math.round(avg * 100) + '%';
}
function habitAvgLong(h, avg, count, hits = 0, numAvg = null) {
  if (hasNumberGoal(h)) {
    return `Ø ${formatNumber(round1(numAvg ?? 0))}${h.unit ? ` ${h.unit}` : ''} · ${tPlain('stats.goalHits' + (isPeriodField(h) ? `.${h.period}` : ''), { n: hits, total: count })}`;
  }
  if (isYesNoScale(h)) {
    const best = scaleLabelAt(h, h.good === 'low' ? h.min : h.max);
    const unit = isPeriodField(h) ? `.${h.period}` : '';
    return tPlain((h.labels ? 'stats.yesNoDaysLabel' : 'stats.yesNoDays') + unit, { n: Math.round(avg * count), total: count, label: best });
  }
  if (h.kind === 'scale') {
    // Eigene Bezeichnungen: Zahl + zwischen welchen Bezeichnungen sie liegt (Nutzer-
    // Entscheidung 2026-10-11: die Zahl soll stehen bleiben, die Zuordnung klar sein).
    // Sonst die Zahl samt Spanne - "von 5" bei Skalen ab 1 (alle seit 2026-09-18 angelegten);
    // ältere Felder mit Daten behalten ihren Startwert (Schieberegler ab 0, Knöpfe auch z.B.
    // -2 bis 2), dort "(0 bis 10)".
    const v = formatNumber(round1(avgScaleValue(h, avg)));
    if (h.labels) return `Ø ${v} · ${avgLabelSpan(h, avg)}`;
    return h.min === 1
      ? tPlain('stats.scaleOf', { value: v, max: h.max })
      : tPlain('stats.scaleRange', { value: v, min: formatNumber(h.min), max: formatNumber(h.max) });
  }
  return Math.round(avg * 100) + '%';
}
// Mehrfachauswahl in der Auswertung (Nutzer-Idee 2026-10-30): das Feld als eigene Zeile, darunter
// je Option eine Unterzeile wie ein Ja/Nein-Feld - eingetragen wird gesammelt, ausgewertet jede
// Option für sich. "an n von m Tagen": m = Tage, an denen das Feld eingetragen war (auch "nichts
// davon"). Ausgeblendete Optionen nur, solange sie im Zeitraum vorkommen.
function multiOptionCounts(h, dateKeys) {
  const entered = dateKeys.filter((k) => multiValue(h, k) !== null);
  const options = (h.options || []).filter((o) => !o.hidden || entered.some((k) => multiValue(h, k).includes(o.id)));
  return { entered: entered.length, options: options.map((o) => ({ option: o, n: entered.filter((k) => multiValue(h, k).includes(o.id)).length })) };
}
function multiWeekRows(h, dayKeys, days) {
  const values = dayKeys.map((k) => multiValue(h, k));
  const cellAttrs = (i) => (isFutureKey(dayKeys[i]) ? '' : `data-action="open-day" data-date="${dayKeys[i]}" data-focus-habit="${h.id}"`);
  const { entered, options } = multiOptionCounts(h, dayKeys);
  // Kopfzeile: wie viele Optionen am Tag gewählt waren (0 = "nichts davon").
  const head = `
    <div class="grid-row">
      <div class="grid-label">${statsFieldName(h, 'grid')}</div>
      ${values.map((v, i) => `<div class="grid-cell grid-cell--count${getNote(dayKeys[i], h.id) ? ' has-note' : ''}${v === null && !isPlannedOn(h, days[i]) ? ' grid-cell--unplanned' : ''}" ${cellAttrs(i)} aria-hidden="true">${v === null ? '' : v.length}</div>`).join('')}
      <div class="grid-cell grid-cell--avg grid-cell--blank"></div>
    </div>
  `;
  return head + options.map(({ option, n }) => {
    const long = `${option.label}: ${tPlain('stats.yesNoDays', { n, total: entered })}`;
    return `
      <div class="grid-row grid-row--sub">
        <div class="grid-label grid-label--sub">${esc(option.label)}</div>
        ${values.map((v, i) => `<div class="grid-cell" ${cellAttrs(i)}${v?.includes(option.id) ? ` style="background-color:${NEUTRAL_FILL}"` : ''} aria-hidden="true"></div>`).join('')}
        ${entered
          ? `<button type="button" class="grid-cell grid-cell--avg grid-cell--plain" data-action="avg-info" data-text="${esc(long)}" aria-label="${esc(long)}">${n}/${entered}</button>`
          : '<div class="grid-cell grid-cell--avg grid-cell--plain">–</div>'}
      </div>
    `;
  }).join('');
}
function renderMultiStatsRows(h, dateKeys) {
  const { entered, options } = multiOptionCounts(h, dateKeys);
  return `
    <div class="month-stat-row">
      <span class="habit-name">${statsFieldName(h, 'rows')}</span>
      <span class="month-stat-value">${entered ? `<span class="month-stat-count">${entered}×</span>` : '<span class="month-stat-count">–</span>'}</span>
    </div>
    ${entered ? options.map(({ option, n }) => `
      <div class="month-stat-row month-stat-row--sub">
        <span class="habit-name">${esc(option.label)}</span>
        <span class="month-stat-value">${esc(tPlain('stats.yesNoDays', { n, total: entered }))}</span>
      </div>
    `).join('') : ''}
  `;
}
// Liste pro Feld in Monat/Jahr/Gesamt: bewertete Felder mit Durchschnitt, Mehrfachauswahl mit
// ihren Unterzeilen - in der Reihenfolge der Verwaltung, nach Gruppen.
function inFieldStatsList(h) { return isScoredKind(h) || isMultiKind(h); }
function renderFieldStatsList(habits, dateKeys) {
  const listed = habits.filter(inFieldStatsList);
  const stats = computeHabitStats(listed.filter(isScoredKind), dateKeys);
  return renderBySection(listed, 'stats', (list) => list.map((h) => (isMultiKind(h)
    ? renderMultiStatsRows(h, dateKeys)
    : renderStatsRows(stats.filter((st) => st.habit === h)))).join(''));
}
function renderStatsRows(stats) {
  return stats.map(({ habit, avg, count, hits, numAvg }) => `
    <div class="month-stat-row">
      <span class="habit-name">${statsFieldName(habit, 'rows')}</span>
      ${isNeutralScale(habit)
        ? `<span class="month-stat-value"><span class="month-stat-count">${count}×</span></span>`
        : `<span class="month-stat-value" style="color:${avg === null ? 'var(--sand)' : scoreTextColor(habitColor(habit, applyGoal(habit, avg)))}">${avg !== null && isMultiStepScale(habit) ? avgMiniScale(habit, avg, ' avg-scale--inline') : ''}${avg !== null ? esc(habitAvgLong(habit, avg, count, hits, numAvg)) : '–'}${avg !== null && !isYesNoScale(habit) && !hasNumberGoal(habit) ? ` <span class="month-stat-count">(${count}×)</span>` : ''}</span>`}
    </div>
  `).join('');
}

// Handgezeichneter Inline-SVG-Linienverlauf für ein Zahlenwert-Feld über eine Menge von
// Datums-Keys — bewusst ohne Chart-Library, passend zum Build-Step-freien Ansatz.
function round1(n) { return Math.round(n * 10) / 10; }

// Durchschnitt erste vs. zweite Hälfte der Reihe statt reinem Endpunkt-Vergleich —
// robuster gegen einzelne Ausreißer am Rand. Unterschiede unter 5% der Spannweite
// gelten als Rauschen ("gleichbleibend"), nicht als echter Trend.
function trendDirection(series, range) {
  const mid = Math.floor(series.length / 2);
  const firstAvg = series.slice(0, mid).reduce((a, p) => a + p.value, 0) / mid;
  const secondHalf = series.slice(mid);
  const secondAvg = secondHalf.reduce((a, p) => a + p.value, 0) / secondHalf.length;
  const delta = secondAvg - firstAvg;
  if (Math.abs(delta) < range * 0.05) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

// Zähler-Tagesfelder lückenlos über alle Tage des Bereichs: Jahr und Gesamt übergeben nur Tage
// mit irgendeinem Eintrag - ein Tag ohne App-Nutzung zählte dort sonst nicht als 0, im Monat
// (alle Tage) aber schon.
function counterDayKeys(dateKeys) {
  if (!dateKeys.length) return dateKeys;
  const sorted = [...dateKeys].sort();
  const todayKey = formatKey(new Date());
  const keys = [];
  for (let d = parseDateKey(sorted[0]); formatKey(d) <= sorted[sorted.length - 1] && formatKey(d) <= todayKey; d = addDays(d, 1)) keys.push(formatKey(d));
  return keys;
}
function renderNumberChart(habit, dateKeys, interactive) {
  if (isCounterKind(habit) && !isPeriodField(habit)) dateKeys = counterDayKeys(dateKeys);
  const stats = numberFieldStats(habit, dateKeys);
  // Uhrzeiten und Dauern auf die Minute statt auf eine Nachkommastelle (7,53 h -> 7:32, nicht 7:30).
  const fmt = (v, rounded) => formatSeriesValue(habit, rounded && !isTimeKind(habit) && !isDurationComputed(habit) ? round1(v) : v);
  const head = `
    <div class="number-chart-head">
      <span class="habit-name">${statsFieldName(habit, 'chart')}</span>
      ${stats ? `<span class="number-chart-meta">${isSinceComputed(habit)
        ? t('numberChart.metaLast', { last: fmt(stats.last) }) // Ø oder Anzahl von Zähl-Tagen sagen nichts
        : habit.summary === 'sum'
        ? t('numberChart.metaSum', { sum: fmt(stats.sum, true), avg: fmt(stats.avg, true), per: t('numberChart.per.' + (habit.period || 'day')), count: stats.count })
        : t('numberChart.meta', { last: fmt(stats.last), avg: fmt(stats.avg, true), count: stats.count })}${hasNumberGoal(habit) ? ` · ${esc(numberGoalText(habit))}` : ''}</span>` : ''}
    </div>
  `;
  if (!stats || stats.series.length < 2) {
    return `<div class="number-chart-box">${head}<p class="manage-meta">${stats ? t('numberChart.tooFewValues') : t('numberChart.noValues')}</p></div>`;
  }
  const w = 280, h = 56, pad = 4;
  const n = stats.series.length;
  // Mit Ziel: Bereich so weit, dass die Ziellinie sichtbar ist.
  const goal = hasNumberGoal(habit) ? habit.target : null;
  const lo = goal !== null ? Math.min(stats.min, goal) : stats.min;
  const hi = goal !== null ? Math.max(stats.max, goal) : stats.max;
  const range = hi - lo || 1;
  const yOf = (v) => h - pad - ((v - lo) / range) * (h - 2 * pad);
  const points = stats.series.map((p, i) => {
    const x = pad + (i / (n - 1)) * (w - 2 * pad);
    return [x, yOf(p.value)];
  });
  const goalLine = goal !== null
    ? `<line x1="0" x2="${w}" y1="${yOf(goal).toFixed(1)}" y2="${yOf(goal).toFixed(1)}" style="stroke:var(--sand);stroke-width:1;stroke-dasharray:4 3" vector-effect="non-scaling-stroke" />`
    : '';
  const pointsAttr = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const dots = points.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6" style="fill:var(--ink)" />`).join('');
  // Tage mit Notiz zu diesem Feld: Ring um den Datenpunkt. Als HTML über dem SVG statt
  // als <circle> darin - das SVG wird per preserveAspectRatio="none" nur waagerecht
  // gestreckt, ein Kreis darin würde zur Ellipse. Senkrecht entspricht 1 Einheit genau
  // 1px (Höhe fest 56px, siehe .number-chart-svg), waagerecht wird in % umgerechnet.
  const noteRings = stats.series
    .map((p, i) => (getNote(p.key, habit.id) ? points[i] : null))
    .filter(Boolean);
  const rings = noteRings
    .map(([x, y]) => `<span class="number-chart-note" style="left:${((x / w) * 100).toFixed(2)}%;top:${y.toFixed(1)}px"></span>`)
    .join('');
  // Antippbare Spalten statt nur der winzigen Punkte: die ganze senkrechte Spalte um
  // einen Punkt (Breite = Abstand zwischen zwei Punkten) öffnet dessen Tag. Bewusst
  // nur für Zeige-Geräte (aria-hidden, nicht fokussierbar): per Tastatur erreicht man
  // denselben Tag schon über die Wochentage bzw. Monatszellen - bis zu 31 weitere
  // Tab-Stopps hier würden nur verlängern, ohne etwas Neues zugänglich zu machen.
  const hits = interactive
    ? stats.series.map((p, i) => {
      // Am Rand abgeschnitten statt um den Punkt zentriert - die äußeren Spalten ragten
      // sonst zur Hälfte über den Graphen hinaus und machten die ganze Seite waagerecht
      // scrollbar.
      const center = (points[i][0] / w) * 100;
      const left = Math.max(0, center - 50 / n);
      const right = Math.min(100, center + 50 / n);
      return `<span class="number-chart-hit" data-action="open-day" data-date="${p.key}" data-focus-habit="${habit.id}" style="left:${left.toFixed(2)}%;width:${(right - left).toFixed(2)}%"></span>`;
    }).join('')
    : '';
  const trend = trendDirection(stats.series, range);
  const summary = isSinceComputed(habit) ? t('numberChart.summaryLast', { name: habit.name, last: fmt(stats.last) }) : t('numberChart.summary', {
    name: habit.name,
    count: stats.count,
    last: fmt(stats.last),
    avg: fmt(stats.avg, true),
    min: fmt(stats.min),
    max: fmt(stats.max),
    trend: t(`numberChart.trend.${trend}`),
  });
  return `
    <div class="number-chart-box">
      ${head}
      <div class="number-chart-plot">
        <svg viewBox="0 0 ${w} ${h}" class="number-chart-svg" preserveAspectRatio="none" aria-hidden="true">
          ${goalLine}
          <polyline points="${pointsAttr}" fill="none" style="stroke:var(--moss);stroke-width:1.5" />
          ${dots}
        </svg>
        ${rings ? `<div aria-hidden="true">${rings}</div>` : ''}
        ${hits ? `<div aria-hidden="true">${hits}</div>` : ''}
      </div>
      <p class="visually-hidden">${summary}${noteRings.length ? ' ' + t('numberChart.withNotes', { count: noteRings.length }) : ''}</p>
    </div>
  `;
}

// interactive: Datenpunkte antippbar (→ dieser Tag in "Heute"), nur in Woche/Monat -
// bei Jahr/Gesamt lägen bis zu 365 Punkte auf Handybreite, ~1px pro Tag, nicht mehr
// gezielt treffbar.
function renderNumberCharts(visibleHabits, dateKeys, interactive = false) {
  const numberHabits = visibleHabits.filter(hasNumericSeries);
  if (!numberHabits.length) return '';
  return `<div class="month-stats">${renderBySection(numberHabits, 'stats', (list) => list.map((h) => renderNumberChart(h, dateKeys, interactive)).join(''))}</div>`;
}

// Rückblick für Text-Felder: pro Feld eine Liste der Antworten im Zeitraum, jeder
// Eintrag öffnet seinen Tag. In allen Ansichten gleich: eingeklappt mit Anzahl im
// Titel, neueste zuerst (in langen Listen ist das Neueste meist das Relevanteste - eine
// je nach Ansicht umgekehrte Reihenfolge war verwirrend). Felder ohne Antwort im
// Zeitraum erscheinen gar nicht.
function renderTextReviews(habits, dateKeys, labelFor = formatDMY) {
  const renderOne = (h) => {
    const entries = dateKeys
      .map((k) => ({ key: k, text: state.entries[k]?.[h.id] }))
      .filter((e) => typeof e.text === 'string' && e.text.trim());
    if (!entries.length) return '';
    entries.reverse();
    const title = `${esc(h.name)}${h.archivedAt ? ` <span class="manage-meta">(${t('common.archived')})</span>` : ''}`;
    const list = `
      <ul class="text-review-list">
        ${entries.map((e) => `
          <li><button type="button" class="text-review-entry" data-action="open-day" data-date="${e.key}" data-focus-habit="${h.id}">
            <span class="text-review-date">${esc(labelFor(e.key))}</span>
            <span class="text-review-text">${esc(e.text.trim())}</span>
          </button></li>
        `).join('')}
      </ul>
    `;
    const count = t(entries.length === 1 ? 'textReview.countOne' : 'textReview.countMany', { count: entries.length });
    return `<details class="text-review"><summary class="text-review-title">${title} <span class="manage-meta">· ${count}</span></summary>${list}</details>`;
  };
  const withEntries = habits.filter(isTextKind).filter((h) => renderOne(h));
  if (!withEntries.length) return '';
  return `<div class="month-stats">${renderBySection(withEntries, 'stats', (list) => list.map(renderOne).join(''))}</div>`;
}

// --- Rendering: Felder-Verwaltung -------------------------------------------
// Titel des Formulars - in der Verwaltung steht er im Seitenkopf (titleInHeader),
// im Tutorial als eigene Überschrift im Formular.
function habitFormTitleKey(f) {
  return f.defId ? 'habitForm.title.editField' : 'habitForm.title.newField';
}
function renderHabitForm({ titleInHeader = false } = {}) {
  const f = state.habitForm;
  const defaultReminderMinute = state.userSettings.defaultReminderMinute;

  const goalField = goalControlHtml(f);

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
      <label id="habit-form-display-label">${t('habitForm.display')}${f.locked ? infoTip(t('habitForm.displayLockedExplain')) : ''}</label>
      <div class="pill-group seg" role="group" aria-labelledby="habit-form-display-label">
        <button type="button" class="pill-toggle${f.displayStyle === 'buttons' ? ' pill-toggle--active' : ''}" data-action="habit-display-style" data-style="buttons" ${buttonsBlocked ? 'disabled' : ''}>${t('habitForm.buttons')}</button>
        <button type="button" class="pill-toggle${f.displayStyle === 'slider' ? ' pill-toggle--active' : ''}" data-action="habit-display-style" data-style="slider">${t('habitForm.slider')}</button>
      </div>
      ${buttonsBlocked ? lockedCapNote : ''}
    </div>
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
    ${f.displayStyle === 'slider' ? `
      <div class="auth-field">
        <label class="checkbox-field">
          <input type="checkbox" id="habit-form-slider-show-value" data-action="habit-slider-show-value" ${f.sliderShowValue ? 'checked' : ''} />
          ${t('habitForm.showValueWhileEntering')}
        </label>
      </div>
    ` : ''}
    <div class="auth-field">
      <label class="checkbox-field">
        <input type="checkbox" id="habit-form-labels-toggle" data-action="habit-labels-toggle" ${f.labelsEnabled ? 'checked' : ''} ${labelsBlocked ? 'disabled' : ''} />
        ${t('habitForm.ownLabels')}
      </label>
      ${labelsBlocked && !buttonsBlocked ? lockedCapNote : ''}
    </div>
    ${!f.locked && !f.labelsEnabled ? `
      <div class="auth-field">
        <label id="habit-form-numbers-label">${t('habitForm.numbers')}${infoTip(t('habitForm.numbersExplain'))}</label>
        <div class="pill-group seg" role="group" aria-labelledby="habit-form-numbers-label">
          ${[1, 0].map((start) => `<button type="button" class="pill-toggle${(f.min === 0 ? 0 : 1) === start ? ' pill-toggle--active' : ''}" data-action="habit-start" data-start="${start}">${tPlain('habitForm.numbersRange', { min: start, max: start + stepCount - 1 })}</button>`).join('')}
        </div>
      </div>
    ` : ''}
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
  `;

  const textBody = `<p class="habit-form-lock-note">${t('habitForm.textNote')}</p>`;

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
    <p class="habit-form-lock-note">${t('habitForm.counterNote')}</p>
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
  const computedTypes = [['scale', 'habitForm.computedType.scale'], ['number', 'habitForm.computedType.number'], ['duration', 'habitForm.computedType.duration']]
    .concat(featureOn('since') || isSinceForm ? [['since', 'habitForm.computedType.since']] : []);
  const computedBody = `
    <p class="habit-form-lock-note">${t('habitForm.computedExplain')}</p>
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
    <p class="habit-form-lock-note">${t('habitForm.timeNote')}</p>
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
    <p class="habit-form-lock-note">${t('habitForm.multiNote')}</p>
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
  const scheduleBody = `
    <div class="auth-field">
      <label id="habit-form-days-label">${t('habitForm.days')}</label>
      <div class="pill-group seg" role="group" aria-labelledby="habit-form-days-label">
        ${[['weekdays', 'habitForm.days.modeWeekdays'], ['interval', 'habitForm.days.modeInterval']].map(([m, key]) => `<button type="button" class="pill-toggle${sch.mode === m ? ' pill-toggle--active' : ''}" data-action="habit-schedule-mode" data-mode="${m}" aria-pressed="${sch.mode === m}">${t(key)}</button>`).join('')}
      </div>
      ${isInterval ? `
        <div class="schedule-inline schedule-interval">
          <label for="habit-form-every">${t('habitForm.days.every')}</label>
          <input type="number" id="habit-form-every" class="schedule-every" inputmode="numeric" min="2" max="365" step="1" value="${esc(sch.every)}" aria-describedby="habit-form-days-note" />
          <span>${t('habitForm.days.everyUnit')}</span>
        </div>
        <div class="schedule-inline schedule-interval">
          <label for="habit-form-every-start">${t('habitForm.days.everyStart')}</label>
          <input type="date" id="habit-form-every-start" class="schedule-start" value="${esc(sch.start)}" aria-describedby="habit-form-days-note" />
        </div>
      ` : `
        <div class="pill-group weekday-group" role="group" aria-label="${esc(t('habitForm.days.modeWeekdays'))}">
          ${shortNames.map((name, i) => {
            const on = sch.days.includes(i);
            return `<button type="button" class="pill-toggle weekday-toggle${on ? ' pill-toggle--active' : ''}" data-action="habit-schedule-day" data-day="${i}" aria-pressed="${on}" aria-label="${esc(weekdayLong(new Date(2024, 0, 1 + i)))}">${esc(name)}</button>`;
          }).join('')}
        </div>
      `}
      <p class="habit-form-lock-note" id="habit-form-days-note">${t(isInterval ? 'habitForm.days.intervalHint' : sch.days.length === 7 ? 'habitForm.days.hint' : 'habitForm.days.explain')}</p>
    </div>
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
  const computedPossible = isComputed || (!tutorialForm && (false
    || others.filter((h) => h.kind === 'scale' && !isNeutralScale(h)).length >= 2
    || others.filter((h) => h.kind === 'number').length >= 2
    || others.filter(isTimeKind).length >= 2
    || (featureOn('since') && others.some(sinceSourceCandidate))));
  // Zähler ist für Nutzer eine Art, eine Zahl einzutragen ("hochzählen"), kein eigener Typ -
  // intern 'counter', weil der Server ihn für Erinnerungen unterscheiden muss.
  const kinds = [['scale', 'habitForm.kindScale'], ['number', 'habitForm.kindNumber']]
    .concat(tutorialForm ? [] : [['time', 'habitForm.kindTime']])
    .concat(!tutorialForm && (featureOn('multi') || f.kind === 'multi') ? [['multi', 'habitForm.kindMulti']] : [])
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
  const part = (key, body) => (body.trim() ? `
    <section class="form-part" aria-labelledby="habit-form-part-${key}">
      <h3 class="form-part-title" id="habit-form-part-${key}">${t('habitForm.part.' + key)}</h3>
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
  const statsBody = `
    ${showGoal ? goalField : ''}
    ${f.kind === 'number' || f.kind === 'counter' ? numberGoalField(f) : ''}
    ${summaryField}
    <div class="auth-field">
      <label class="checkbox-field">
        <input type="checkbox" id="habit-form-show-in-stats" aria-describedby="habit-form-show-in-stats-note" ${f.showInStats ? 'checked' : ''} />
        ${t('habitForm.showInStats')}
      </label>
      <p class="habit-form-lock-note" id="habit-form-show-in-stats-note">${t('habitForm.showInStatsNote')}</p>
    </div>
  `;
  const groupBody = state.sections.length && !isPeriod ? `
    <div class="auth-field">
      <select id="habit-form-section" aria-labelledby="habit-form-part-group">
        <option value="">${t('habitForm.sectionNone')}</option>
        ${[...state.sections].sort((a, b) => a.sortOrder - b.sortOrder).map((sec) => `<option value="${sec.id}" ${f.sectionId === sec.id ? 'selected' : ''}>${esc(sec.name)}</option>`).join('')}
      </select>
    </div>
  ` : '';
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
      ${part('entry', entryBody)}
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
function habitFormReminderShown(f) {
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
function habitFormReminderNote(f) {
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
function renderManage() {
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
            <button type="button" class="move-btn" data-action="habit-move" data-id="${h.defId}" data-dir="up" ${idx === 0 ? 'disabled' : ''} aria-label="${esc(t('ariaLabel.moveUp'))}">↑</button>
            <button type="button" class="move-btn" data-action="habit-move" data-id="${h.defId}" data-dir="down" ${idx === list.length - 1 ? 'disabled' : ''} aria-label="${esc(t('ariaLabel.moveDown'))}">↓</button>
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
  // oberster Ebene wie ein Feld verschieben lässt; seine Felder verschiebt man innerhalb.
  // Umhängen zwischen Gruppen läuft bewusst über die Formulare (Gruppe bearbeiten bzw.
  // "Gruppe" im Feld-Formular) statt per Ziehen - einfach und für Tastatur/Screenreader
  // gleich gut bedienbar, siehe CLAUDE.md.
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

// --- Onboarding-Tutorial für neue Accounts ----------------------------------
// state.userSettings.onboardingCompleted kommt aus der DB (Default false bei neuen
// Accounts, siehe supabase/migrations/) und steuert in render(), ob statt der normalen
// App dieses Tutorial gezeigt wird - und danach der eigenständige Erinnerungs-Schritt
// (gehört nicht zum Tutorial, kommt aber auch nach "Tutorial überspringen"; erst er setzt
// onboardingCompleted). state.tutorialStep (TUTORIAL_STEP_*) lebt nur im Speicher,
// kein Reload-Resume nötig — dafür verhindert die beforeunload-Warnung im offenen
// Formular (Feld-Schritt) ein versehentliches Verlassen mitten im Feld-Anlegen.
//
async function saveOnboardingCompleted() {
  state.userSettings = { ...state.userSettings, onboardingCompleted: true, lastSeenChangelog: CHANGELOG[0].id };
  state.tutorialStep = null;
  state.tutorialSkipConfirm = false;
  state.habitForm = null;
  render();
  maybeShowSpareKey(); // direkt nach den Erinnerungen, auch wenn das Tutorial übersprungen wurde
  const { error } = await supabase.from('user_settings')
    .upsert({ user_id: state.session.user.id, onboarding_completed: true, last_seen_changelog: CHANGELOG[0].id }, { onConflict: 'user_id' });
  if (error) {
    state.notice = errorNotice('notice.saveFailed', error.message);
    render();
  }
}

function renderTutorialSkipConfirm() {
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="tutorial-skip-confirm-title">
        <h2 id="tutorial-skip-confirm-title">${t('tutorial.skipConfirm.title')}</h2>
        <p>${t('tutorial.skipConfirm.body')}</p>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="tutorial-skip-cancel">${t('common.cancel')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="tutorial-skip-confirm">${t('tutorial.skipConfirm.confirmButton')}</button>
        </div>
      </div>
    </div>
  `;
}

// Bausteine der Tutorial-Bildschirme (Neufassung 2026-09-29): ein Bildschirm, ein
// Thema - Symbol, kurze Überschrift, der eine wichtige Satz fett, Begründungen im
// wiedererkennbaren "Warum?"-Kasten (Leitlinie des Nutzers: nie nur sagen, dass etwas so
// ist, sondern warum; locker statt förmlich, die App als Freund). Fortschritt über die
// Leiste des ganzen Einrichtens (onbProgress), das Tutorial ist darin Etappe "kennenlernen".
// Die Erinnerungen kommen erst nach dem ersten Feld (Nutzer-Entscheidung 2026-10-12): dann
// weiß man, woran erinnert wird, und die Frage kann das Feld nennen.
const TUTORIAL_STEP_HELLO = 1;
const TUTORIAL_STEP_FIELD = 2;
const TUTORIAL_STEP_DONE = 3;
const TUTORIAL_STEP_REMINDERS = 4; // eigene Etappe, nicht Teil des Tutorials
const TUTORIAL_STEPS = 3; // Unterschritte der Etappe "kennenlernen"
// Im Tutorial: die Etappe "Logbuch kennenlernen" mit dem Tutorial-Schritt als Unterschritt;
// der Erinnerungs-Schritt als eigene Etappe ohne Unterschritte.
function tutorialProgress(step) {
  return step === TUTORIAL_STEP_REMINDERS ? onbProgress('reminders') : onbProgress('setup', [step, TUTORIAL_STEPS]);
}
// "Warum?"/"Genauer erklären": aufklappbar - bei "Schritt für Schritt" von Anfang an offen.
function whyBox(titleKey, bodyKey) {
  return `<details class="why-box" ${isGuided() ? 'open' : ''}><summary class="why-box-title">${t(titleKey)}</summary><p>${t(bodyKey)}</p></details>`;
}
function tutorialScreen({ step, icon, title, body }) {
  return `
    <div class="auth-box onb">
      ${tutorialProgress(step)}
      <div class="onb-icon" aria-hidden="true">${iconSvg(icon)}</div>
      <h1 tabindex="-1">${title}</h1>
      ${body}
    </div>
    ${state.tutorialSkipConfirm ? renderTutorialSkipConfirm() : ''}
  `;
}
// Zurück/Überspringen als eigene Fußleiste mit Trennlinie (Zurück links, Überspringen
// rechts) - direkt unter dem Inhalt hingen sie vorher so dran, dass nicht erkennbar war,
// ob sie zum Inhalt gehören. Aktionen des Inhalts ("Lieber nicht", "Noch ein Feld")
// bleiben beim Hauptknopf.
function tutorialNav({ back = false, skip = false }) {
  return `
    <nav class="onb-nav" aria-label="${esc(t('tutorial.navLabel'))}">
      ${back ? `<button type="button" class="onb-nav-btn" data-action="tutorial-back"><span aria-hidden="true">← </span>${t('common.back')}</button>` : '<span></span>'}
      ${skip ? `<button type="button" class="onb-nav-btn" data-action="tutorial-skip-arm">${t('tutorial.skip')}</button>` : ''}
    </nav>
  `;
}

function renderTutorialHello() {
  const promises = [['privacy', 'private'], ['sprout', 'noPressure'], ['manage', 'yours']].map(([name, key]) => `
    <li><span class="onb-promise-icon" aria-hidden="true">${iconSvg(name)}</span><span><strong>${t(`tutorial.hello.${key}Title`)}</strong> ${t(`tutorial.hello.${key}Body`)}</span></li>
  `).join('');
  return tutorialScreen({
    step: TUTORIAL_STEP_HELLO, icon: 'hello', title: t('tutorial.hello.title'),
    body: `
      <p class="tutorial-text">${t('tutorial.hello.body')}</p>
      <ul class="onb-promises">${promises}</ul>
      <button type="button" class="auth-submit" data-action="tutorial-next">${t('tutorial.hello.start')}</button>
    `,
  });
}

// Erinnerungen: erst die Frage mit Begründung, die Uhrzeit erst, wenn sie aktiv sind
// (vorher stand sie ausgegraut daneben und wurde übersehen bzw. verwirrte).
function renderTutorialReminders() {
  const firstField = activeHabits()[0];
  let body;
  if (state.pushStatus === 'on') {
    body = `
      <p class="tutorial-text"><strong>${t('tutorial.reminders.activeTitle')}</strong></p>
      <div class="auth-field">
        <span class="settings-label" id="tutorial-default-time-label">${t('tutorial.reminders.timeLabel')}</span>
        ${reminderTimeInputHtml('tutorial-default-time', state.userSettings.defaultReminderMinute, 'menu-default-time', false, 'tutorial-time-note', 'tutorial-default-time-label')}
        <p class="habit-form-lock-note" id="tutorial-time-note">${t('tutorial.reminders.timeNote')}</p>
      </div>
      <button type="button" class="auth-submit" data-action="tutorial-finish">${t('common.next')}</button>
    `;
  } else if (state.pushStatus === 'blocked') {
    body = `
      <p class="tutorial-text">${t('tutorial.reminders.blocked')}</p>
      ${pushBlockedHelp()}
      <button type="button" class="auth-submit" data-action="tutorial-finish">${t('common.next')}</button>
    `;
  } else if (state.pushStatus === 'unsupported') {
    body = `
      <p class="tutorial-text">${isIOSDevice() ? t('tutorial.reminders.iosNeedsInstall') : t('push.unsupported')}</p>
      ${isIOSDevice() && !isStandaloneDisplay() ? `<details class="why-box" ${isGuided() ? 'open' : ''}><summary class="why-box-title">${t('tutorial.reminders.howInstall')}</summary>${installManualHtml()}</details>` : ''}
      <button type="button" class="auth-submit" data-action="tutorial-finish">${t('common.next')}</button>
    `;
  } else {
    const busy = state.pushStatus === 'busy' || state.pushStatus === 'unknown';
    body = `
      <p class="tutorial-text">${firstField ? t('tutorial.reminders.bodyField', { name: firstField.name }) : t('tutorial.reminders.body')}</p>
      ${whyBox('tutorial.reminders.whyTitle', 'tutorial.reminders.whyBody')}
      <p class="onb-hint">${t('tutorial.reminders.permissionNote')}</p>
      ${isGuided() ? sketchHtml(isIOSDevice() ? 'permIos' : 'permAndroid') : ''}
      <button type="button" class="auth-submit" data-action="enable-push" ${busy ? 'disabled' : ''}>${busy ? t('push.checking') : t('tutorial.reminders.yes')}</button>
      <button type="button" class="auth-toggle" data-action="tutorial-finish">${t('tutorial.reminders.no')}</button>
      <p class="onb-hint onb-hint--after onb-center">${t('tutorial.reminders.laterNote')}</p>
    `;
  }
  return tutorialScreen({
    step: TUTORIAL_STEP_REMINDERS, icon: 'reminders', title: t('tutorial.reminders.title'),
    body: `${body}${tutorialNav({ back: true })}`,
  });
}

// Feld-Schritt: direkt das echte Feld-Formular, Stück für Stück aufgedeckt (siehe
// renderHabitForm, f.revealStage). Keine Vorlagen/Beispiele zum Antippen (Nutzer: Vorlagen
// erst sinnvoll, wenn man das Formular einmal selbst durchgegangen ist) - nur Ideen als
// Text unter dem Namen.
function renderTutorialFieldForm() {
  if (!state.habitForm) state.habitForm = { ...defaultHabitForm(), revealStage: 1 };
  return tutorialScreen({
    step: TUTORIAL_STEP_FIELD, icon: 'manage', title: t('tutorial.field.title'),
    body: `
      <p class="tutorial-text">${t('tutorial.field.intro')}</p>
      ${whyBox('tutorial.field.whyTitle', 'tutorial.field.whyBody')}
      ${renderHabitForm({ titleInHeader: true })}
      ${tutorialNav({ back: true, skip: true })}
    `,
  });
}

function renderTutorialDone() {
  const count = activeHabits().length;
  return tutorialScreen({
    step: TUTORIAL_STEP_DONE, icon: 'sprout', title: count > 1 ? t('tutorial.done.titleMore', { count }) : t('tutorial.done.title'),
    body: `
      <p class="tutorial-text">${t('tutorial.done.body')}</p>
      <button type="button" class="auth-submit" data-action="tutorial-next">${t('tutorial.done.start')}</button>
      <button type="button" class="auth-toggle" data-action="tutorial-add-more">${t('tutorial.done.addMore')}</button>
      ${tutorialNav({ back: true })}
    `,
  });
}

function renderTutorial() {
  if (!state.tutorialStep) state.tutorialStep = TUTORIAL_STEP_HELLO;
  app.innerHTML =
    state.tutorialStep === TUTORIAL_STEP_HELLO ? renderTutorialHello() :
    state.tutorialStep === TUTORIAL_STEP_FIELD ? renderTutorialFieldForm() :
    state.tutorialStep === TUTORIAL_STEP_DONE ? renderTutorialDone() :
    renderTutorialReminders();
  // Bei jedem Wechsel des Bildschirms die Überschrift fokussieren (Screenreader hören so,
  // wo sie sind) - nicht bei jedem render(), sonst spränge der Fokus z.B. nach dem
  // Aktivieren der Erinnerungen weg.
  const screenKey = `${state.tutorialStep}:${state.habitForm ? 'form' : ''}`;
  if (screenKey !== lastTutorialScreen) {
    lastTutorialScreen = screenKey;
    app.querySelector('.onb h1')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}
let lastTutorialScreen = null;
let tutorialLastFieldDefId = null; // zuletzt im Tutorial angelegtes Feld (Zurück von "Geschafft")

// --- Rendering: Haupt-App --------------------------------------------------
function renderPushRow() {
  if (state.pushStatus === 'unsupported') {
    return `<div class="push-row push-row--muted">${t('push.unsupported')}</div>`;
  }
  if (state.pushStatus === 'unknown' || state.pushStatus === 'busy') {
    return `<div class="push-row push-row--muted">${t('push.checking')}</div>`;
  }
  if (state.pushStatus === 'on') {
    return `<div class="push-row"><span>${icon('reminders')}${t('push.active')}</span> <button type="button" class="push-toggle" data-action="disable-push">${t('push.disable')}</button></div>`;
  }
  if (state.pushStatus === 'blocked') {
    return `<div class="push-row push-row--blocked"><span>${icon('remindersOff')}${t('push.blocked.status')}</span>${pushBlockedHelp()}</div>`;
  }
  return `
    <div class="push-row">
      <span>${icon('remindersOff')}${t('push.none')}</span>
      <button type="button" class="push-toggle" data-action="enable-push">${t('push.enable')}</button>
    </div>
  `;
}

// Symbole an Menüpunkten, Seitenköpfen und Abschnitts-Überschriften - alle an EINER Stelle,
// damit der geplante Wechsel von Emojis zu eigenen, gezeichneten Symbolen (Gestaltungs-
// Durchgang) nur hier passiert. Dekorativ (aria-hidden), der Text daneben sagt dasselbe.
// Symbole (Nutzer-Entscheidung 2026-10-29: eigene, gezeichnete statt Emojis, Stil "Feder +
// Moos-Fläche"): einfarbige Linie in Textfarbe, Flächen (class "f") leicht in Moos - passt sich
// so Dunkelmodus und Textgröße an und sieht auf jedem Gerät gleich aus (Emojis nicht). Raster
// 24x24, Strich/Farbe per CSS (.icon). Alle Symbole stehen hier; neue im selben Stil zeichnen.
const PEN = '<path class="f" d="M4.5 19.5l1-4.2L15.8 5a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L8.7 18.5z"/><path d="M14 7l3 3"/>';
const BELL = '<path class="f" d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>';
const PALETTE = '<path class="f" d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 1.6-2.1-.5-1.3.3-2.4 1.7-2.4H18a2.5 2.5 0 0 0 2.5-2.5c0-5.5-3.8-10-8.5-10z"/><circle cx="8" cy="11" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/>';
const SPARKLE = '<path class="f" d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 16v4M16.5 18h4"/>';
const ICONS = {
  manage: PEN, newField: PEN, fields: PEN, write: PEN,
  settings: '<path class="f" d="M12.0 4.8L13.9 2.7L15.6 3.2L16.0 6.0L17.1 6.9L19.9 6.7L20.8 8.4L19.1 10.6L19.2 12.0L21.3 13.9L20.8 15.6L18.0 16.0L17.1 17.1L17.3 19.9L15.6 20.8L13.4 19.1L12.0 19.2L10.1 21.3L8.4 20.8L8.0 18.0L6.9 17.1L4.1 17.3L3.2 15.6L4.9 13.4L4.8 12.0L2.7 10.1L3.2 8.4L6.0 8.0L6.9 6.9L6.7 4.1L8.4 3.2L10.6 4.9Z"/><circle cx="12" cy="12" r="3"/>',
  about: '<path class="f" d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z"/><path d="M12 6.5v13"/>',
  feedback: '<path class="f" d="M4 5.5h16v10.5H10.5L6.5 20v-4H4z"/>',
  newGroup: '<path class="f" d="M3.5 6.5v12a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2.5h-5a1 1 0 0 0-1 1z"/>',
  reminders: BELL,
  remindersOff: BELL + '<path d="M4 4l16 16"/>',
  display: PALETTE, appearance: PALETTE,
  account: '<circle class="f" cx="12" cy="8" r="3.5"/><path class="f" d="M5 20c.5-3.8 3.3-6 7-6s6.5 2.2 7 6z"/>',
  a11y: '<circle cx="12" cy="4.5" r="1.5"/><path d="M5 8.5l7 1.5 7-1.5M12 10v4.5M12 14.5l-3 6M12 14.5l3 6"/>',
  mentalHealth: '<path class="f" d="M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.6 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  privacy: '<rect class="f" x="5" y="11" width="14" height="9.5" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3M12 14.5v2.5"/>',
  usage: '<circle cx="12" cy="12" r="8"/><circle class="f" cx="12" cy="12" r="3.5"/>',
  news: SPARKLE,
  install: '<rect class="f" x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  hello: '<path class="f" d="M6 17a6 6 0 0 1 12 0z"/><path d="M3.5 17h17M12 5.5V8M5.5 9l1.7 1.7M18.5 9l-1.7 1.7M8 20.5h8"/>',
  calendar: '<rect class="f" x="4" y="5.5" width="16" height="14.5" rx="1.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  mail: '<rect class="f" x="3.5" y="6" width="17" height="12.5" rx="1.5"/><path d="M4 7l8 6 8-6"/>',
  key: '<circle class="f" cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16.5 6.5L19 9M14 9l2 2"/>',
  tip: '<path class="f" d="M8.6 14.2a5.5 5.5 0 1 1 6.8 0c-.8.7-1.2 1.6-1.3 2.8H9.9c-.1-1.2-.5-2.1-1.3-2.8z"/><path d="M10 20h4"/>',
  celebrate: '<path class="f" d="M4 20l4.5-11 6.5 6.5z"/><path d="M14 4.5v2M19.5 10h-2M17 6l1.5-1.5M12 8.5c1-1 1-2.5 0-3.5M15.5 12c1-1 2.5-1 3.5 0"/>',
  sprout: '<path d="M12 21v-8.5"/><path class="f" d="M12 12.5C12 8.5 9 6 4.5 6c0 4.2 3 6.5 7.5 6.5z"/><path class="f" d="M12 14.5c0-3.2 2.4-5.5 6.5-5.5 0 3.3-2.4 5.5-6.5 5.5z"/>',
  photo: '<path class="f" d="M4 8.5h3.5L9 6h6l1.5 2.5H20V19H4z"/><circle cx="12" cy="13.5" r="3.2"/>',
  file: '<path d="M12 4v9.5M8.5 10l3.5 3.5 3.5-3.5"/><path class="f" d="M4 15.5h4l1 2h6l1-2h4v4H4z"/>',
  copy: '<rect class="f" x="5.5" y="5" width="13" height="16" rx="1.5"/><path d="M9 5V3.5h6V5M9 11h6M9 15h4"/>',
  done: '<circle class="f" cx="12" cy="12" r="8.5"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
  stats: '<path d="M4 20h16"/><rect class="f" x="5.5" y="12" width="3" height="6"/><rect class="f" x="10.5" y="7" width="3" height="11"/><rect class="f" x="15.5" y="10" width="3" height="8"/>',
};
function iconSvg(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}
function icon(name) {
  return `<span class="item-icon" aria-hidden="true">${iconSvg(name)}</span>`;
}

// Das ☰-Menü enthält seit 2026-10-01 nur noch die Ziele; alle Einstellungen und
// Konto-Aktionen stehen auf der eigenen Seite "Einstellungen" (renderSettings). Vorher
// steckte alles in diesem schmalen Fenster, das dafür in sich scrollen musste (klappte
// nicht zuverlässig) und keinen Platz für Erklärungen hatte.
function renderMenu() {
  return `
    <div class="menu-panel">
      ${[['open-manage', 'manage', 'menu.manageFields'], ['open-settings', 'settings', 'menu.settings'], ['open-about', 'about', 'menu.about'], ['open-feedback', 'feedback', 'menu.feedback'],
        ...(canInstallFromHere() ? [['open-install', 'install', 'menu.install']] : [])]
        .map(([action, iconName, key]) => `<button type="button" class="menu-item-btn" data-action="${action}">${icon(iconName)}${t(key)}</button>`).join('')}
    </div>
  `;
}

// Einstellungen: Erinnerungen, Anzeige, Konto, je einklappbar. Erklärungen stehen direkt unter der
// jeweiligen Einstellung statt hinter einem "?" (Neulinge fanden die nicht). data-menu-
// target: Sprungziel für die Links aus "Über Logbuch" (focusSettingsTarget).
function renderSettings() {
  return `
    ${settingsSectionStart('reminders', 'settings.reminders')}
      <div data-menu-target="push">${renderPushRow()}</div>
      <div class="settings-row">
        <span class="settings-label" id="menu-default-time-label">${t('menu.defaultReminderTime')}</span>
        ${reminderTimeInputHtml('menu-default-time', state.userSettings.defaultReminderMinute, 'menu-default-time', false, 'menu-timezone-note', 'menu-default-time-label')}
        <p class="settings-note" id="menu-timezone-note">${t('settings.defaultReminderNote')} ${t('menu.timezoneNote', { tz: state.userSettings.timezone.replace(/_/g, ' ') })}</p>
      </div>
      <div class="settings-row">
        <label class="checkbox-field">
          <input type="checkbox" data-action="summary-notifications-toggle" aria-describedby="settings-summary-note" ${state.userSettings.summaryNotifications ? 'checked' : ''} />
          ${t('menu.summaryNotifications')}
        </label>
        <p class="settings-note" id="settings-summary-note">${t('menu.summaryNotificationsExplain')}</p>
      </div>
    </details>
    <div class="manage-section-divider"></div>
    ${settingsSectionStart('display', 'settings.display')}
      <div class="settings-row" data-menu-target="text-size">
        <span class="settings-label" id="menu-text-size-label">${t('textSize.label')}</span>
        <div class="pill-group seg" role="group" aria-labelledby="menu-text-size-label">
          ${TEXT_SIZES.map((size) => `<button type="button" class="pill-toggle${getTextSize() === size ? ' pill-toggle--active' : ''}" data-action="text-size-set" data-size="${size}" aria-pressed="${getTextSize() === size}">${t('textSize.' + (size || 'normal'))}</button>`).join('')}
        </div>
      </div>
      <div class="settings-row" data-menu-target="theme">
        <span class="settings-label" id="menu-theme-label">${t('theme.label')}</span>
        <div class="pill-group seg" role="group" aria-labelledby="menu-theme-label">
          <button type="button" class="pill-toggle${!getThemeOverride() ? ' pill-toggle--active' : ''}" data-action="theme-set" data-theme="" aria-pressed="${!getThemeOverride()}">${t('theme.system')}</button>
          <button type="button" class="pill-toggle${getThemeOverride() === 'light' ? ' pill-toggle--active' : ''}" data-action="theme-set" data-theme="light" aria-pressed="${getThemeOverride() === 'light'}">${t('theme.light')}</button>
          <button type="button" class="pill-toggle${getThemeOverride() === 'dark' ? ' pill-toggle--active' : ''}" data-action="theme-set" data-theme="dark" aria-pressed="${getThemeOverride() === 'dark'}">${t('theme.dark')}</button>
        </div>
      </div>
      <div class="settings-row" data-menu-target="language">
        <label for="menu-locale">${t('menu.language')}</label>
        <select id="menu-locale" data-action="menu-locale">
          <option value="de" ${currentLocale === 'de' ? 'selected' : ''}>Deutsch</option>
          <option value="en" ${currentLocale === 'en' ? 'selected' : ''}>English</option>
        </select>
      </div>
      <div class="settings-row" data-menu-target="pattern">
        <label class="checkbox-field">
          <input type="checkbox" data-action="pattern-toggle" aria-describedby="settings-pattern-note" ${isPatternDisabled() ? '' : 'checked'} />
          ${t('pattern.enableLabel')}
        </label>
        <p class="settings-note" id="settings-pattern-note">${t('pattern.explain')}</p>
      </div>
      <div class="settings-row" data-menu-target="day-progress">
        <label class="checkbox-field">
          <input type="checkbox" data-action="day-progress-toggle" aria-describedby="settings-day-progress-note" ${isDayProgressShown() ? 'checked' : ''} />
          ${t('dayProgress.label')}
        </label>
        <p class="settings-note" id="settings-day-progress-note">${t('dayProgress.explain')}</p>
      </div>
      ${hapticsSupported() ? `
        <div class="settings-row">
          <label class="checkbox-field">
            <input type="checkbox" data-action="haptics-toggle" ${isHapticsDisabled() ? '' : 'checked'} />
            ${t('haptics.enableLabel')}
          </label>
        </div>
      ` : ''}
    </details>
    <div class="manage-section-divider"></div>
    ${settingsSectionStart('account', 'menu.groupAccount')}
      <div class="settings-row" data-menu-target="password">
        <button type="button" class="menu-item-btn" data-action="open-password-change">${t('menu.changePassword')}</button>
      </div>
      <div class="settings-row" data-menu-target="email">
        <button type="button" class="menu-item-btn" data-action="open-email-change">${t('menu.changeEmail')}</button>
        <p class="settings-note">${state.session?.user?.new_email
          ? t('settings.emailPending', { email: state.session.user.new_email })
          : t('settings.emailCurrent', { email: state.session?.user?.email ?? '' })}</p>
      </div>
      <div class="settings-row" data-menu-target="export">
        <button type="button" class="menu-item-btn" data-action="export-data">${t('menu.exportData')}</button>
        <p class="settings-note">${t('settings.exportNote')}</p>
      </div>
      <div class="settings-row" data-menu-target="spare-key-check">
        <button type="button" class="menu-item-btn" data-action="open-spare-key-check">${t('menu.checkSpareKey')}</button>
        <p class="settings-note">${t('settings.checkSpareKeyNote')}</p>
      </div>
      <div class="settings-row" data-menu-target="recovery-key">
        <button type="button" class="menu-item-btn" data-action="regenerate-recovery-key">${t('menu.regenerateRecoveryKey')}</button>
        <p class="settings-note">${t('settings.recoveryKeyNote')}</p>
      </div>
      <div class="settings-row settings-row--buttons">
        <button type="button" class="menu-item-btn" data-action="logout-arm">${t('common.logout')}</button>
        <button type="button" class="menu-item-btn menu-item-btn--danger" data-action="open-delete-confirm">${t('menu.deleteAccount')}</button>
      </div>
    </details>
  `;
}
// Wie die Abschnitte in "Über Logbuch": bei jedem Öffnen der Seite zugeklappt (siehe
// openAboutSections), so ist auf einen Blick zu sehen, was es gibt.
function settingsSectionStart(id, titleKey) {
  const key = `settings:${id}`;
  return `
    <details class="tip-group settings-section" data-collapse-key="${key}" ${isAboutSectionCollapsed(key) ? '' : 'open'}>
      <summary class="manage-section-title">${icon(id)}${t(titleKey)}</summary>`;
}

function renderResetConfirm() {
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="reset-confirm-title">
        <h2 id="reset-confirm-title">${t('resetConfirm.title')}</h2>
        <p>${t('resetConfirm.body', { date: formatDMY(state.resetConfirm) })}</p>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="reset-day-cancel">${t('common.cancel')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="reset-day-confirm">${t('resetConfirm.confirm')}</button>
        </div>
      </div>
    </div>
  `;
}

// Ein neuer Ersatzschlüssel macht den alten sofort ungültig - auch den, den man
// aufgeschrieben oder abgelegt hat. Ohne Rückfrage genügte ein neugieriger Tipp im Menü.
function renderRegenKeyConfirm() {
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="regen-key-confirm-title">
        <h2 id="regen-key-confirm-title">${t('regenKeyConfirm.title')}</h2>
        <p>${t('regenKeyConfirm.body')}</p>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="regen-key-cancel">${t('common.cancel')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="regen-key-confirm">${t('regenKeyConfirm.confirm')}</button>
        </div>
      </div>
    </div>
  `;
}

// Abmelden beendet die Erinnerungen auf diesem Gerät und verlangt danach wieder das
// Passwort - beides sollte man vorher wissen (und nicht per Versehen auslösen).
function renderLogoutConfirm() {
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="logout-confirm-title">
        <h2 id="logout-confirm-title">${t('logoutConfirm.title')}</h2>
        <p>${t('logoutConfirm.body')}</p>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="logout-cancel">${t('common.cancel')}</button>
          <button type="button" class="auth-submit" data-action="logout">${t('common.logout')}</button>
        </div>
      </div>
    </div>
  `;
}

// Siehe leaveFormGuarded. "Weiter bearbeiten" links als sichere Wahl (Anfangsfokus).
function renderLeaveFormConfirm() {
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="leave-form-title" aria-describedby="leave-form-body">
        <h2 id="leave-form-title">${t('leaveForm.title')}</h2>
        <p id="leave-form-body">${t(state.sectionForm ? 'leaveForm.bodyGroup' : 'leaveForm.bodyField')}</p>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="leave-form-stay">${t('leaveForm.stay')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="leave-form-discard">${t('leaveForm.discard')}</button>
        </div>
      </div>
    </div>
  `;
}

// Eigenes Formular statt der Anmelde-Felder: Passwort-Manager erkennen am versteckten
// Benutzernamen (autocomplete="username") und an current-/new-password, zu welchem Konto das
// neue Passwort gehört, und bieten an, es zu ersetzen.
function renderPasswordChange() {
  const pc = state.passwordChange;
  const off = pc.busy ? 'disabled' : '';
  const type = pc.visible ? 'text' : 'password';
  const ok = pc.next.length >= AUTH_MIN_PASSWORD_LENGTH;
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="password-change-title">
        <h2 id="password-change-title">${t('passwordChange.title')}</h2>
        ${pc.error ? `<div class="notice" role="alert">${esc(pc.error)}</div>` : ''}
        <form id="password-change-form">
          <input type="email" class="visually-hidden" autocomplete="username" value="${esc(state.session?.user?.email ?? '')}" readonly tabindex="-1" aria-hidden="true" />
          <div class="auth-field">
            <div class="auth-field-label-row">
              <label for="password-change-current">${t('passwordChange.current')}</label>
              <button type="button" class="push-toggle" data-action="password-change-visibility" ${off}>${pc.visible ? t('auth.hide') : t('auth.show')}</button>
            </div>
            <input type="${type}" id="password-change-current" value="${esc(pc.current)}" required autocomplete="current-password" data-autofocus ${off} />
          </div>
          <div class="auth-field">
            <label for="password-change-new">${t('passwordChange.new')}</label>
            <input type="${type}" id="password-change-new" value="${esc(pc.next)}" required autocomplete="new-password" minlength="${AUTH_MIN_PASSWORD_LENGTH}" aria-describedby="password-change-count" ${off} />
            <p class="password-count${ok ? ' password-count--ok' : ''}" id="password-change-count" aria-live="polite">${passwordRuleText(pc.next.length)}</p>
          </div>
          <p class="settings-note">${t('passwordChange.note')}</p>
          <div class="habit-form-actions">
            <button type="button" class="habit-form-cancel" data-action="password-change-cancel" ${off}>${t('common.cancel')}</button>
            <button type="submit" class="auth-submit" ${off}>${pc.busy ? t('passwordChange.saving') : t('passwordChange.submit')}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// Prüft nur auf dem Gerät (entpackt der Schlüssel den DEK?) - nichts wird gespeichert oder
// verändert. Wer erst beim Passwort-Reset merkt, dass der aufgeschriebene Schlüssel nicht
// (mehr) passt, verliert sonst alle Daten.
function renderSpareKeyCheck() {
  const sc = state.spareKeyCheck;
  const off = sc.busy ? 'disabled' : '';
  const result = sc.result === 'ok'
    ? `<div class="notice notice--ok" role="status">${t('spareKeyCheck.ok')}</div>`
    : sc.result === 'wrong' ? `<div class="notice" role="alert">${t('spareKeyCheck.wrong')}</div>`
    : sc.result === 'error' ? `<div class="notice" role="alert">${esc(sc.errorText)}</div>` : '';
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="spare-key-check-title">
        <h2 id="spare-key-check-title">${t('spareKeyCheck.title')}</h2>
        <p>${t('spareKeyCheck.body')}</p>
        <form id="spare-key-check-form">
          <div class="auth-field">
            <label for="spare-key-check-input">${t('recovery.key')}</label>
            <input type="text" id="spare-key-check-input" value="${esc(sc.value)}" required autocomplete="off" autocapitalize="off" spellcheck="false" data-autofocus ${off} />
          </div>
          ${result}
          <div class="habit-form-actions">
            <button type="button" class="habit-form-cancel" data-action="spare-key-check-close" ${off}>${t('common.close')}</button>
            <button type="submit" class="auth-submit" ${off}>${sc.busy ? t('spareKeyCheck.checking') : t('spareKeyCheck.submit')}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// Supabase ändert die Adresse erst, wenn in der Mail an die neue bestätigt wurde - bis dahin
// gilt die bisherige weiter. Die bisherige muss nicht zustimmen (man hat oft keinen Zugang
// mehr), deshalb hier das Passwort (siehe docs/datenschutz-sicherheit.md).
function renderEmailChange() {
  const ec = state.emailChange;
  const off = ec.busy ? 'disabled' : '';
  if (ec.sentTo) {
    return `
      <div class="modal-overlay">
        <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="email-change-title">
          <h2 id="email-change-title">${t('emailChange.sentTitle')}</h2>
          <p>${t('emailChange.sentBody', { email: ec.sentTo })}</p>
          <p class="settings-note">${t('emailChange.sentSpam')}</p>
          <div class="habit-form-actions">
            <button type="button" class="auth-submit" data-action="email-change-close">${t('common.close')}</button>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="email-change-title">
        <h2 id="email-change-title">${t('emailChange.title')}</h2>
        <p>${t('emailChange.current', { email: state.session?.user?.email ?? '' })}</p>
        ${ec.error ? `<div class="notice" role="alert">${esc(ec.error)}</div>` : ''}
        <form id="email-change-form">
          <div class="auth-field">
            <label for="email-change-input">${t('emailChange.new')}</label>
            <input type="email" id="email-change-input" value="${esc(ec.value)}" required autocomplete="email" data-autofocus ${off} />
          </div>
          <div class="auth-field">
            <label for="email-change-password">${t('emailChange.password')}</label>
            <input type="password" id="email-change-password" value="${esc(ec.password)}" required autocomplete="current-password" ${off} />
          </div>
          <p class="settings-note">${t('emailChange.note')}</p>
          <div class="habit-form-actions">
            <button type="button" class="habit-form-cancel" data-action="email-change-close" ${off}>${t('common.cancel')}</button>
            <button type="submit" class="auth-submit" ${off}>${ec.busy ? t('emailChange.sending') : t('emailChange.submit')}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderDeleteConfirm() {
  const busy = state.deleteConfirm.busy;
  return `
    <div class="modal-overlay">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
        <h2 id="delete-confirm-title">${t('deleteAccount.title')}</h2>
        <p class="delete-account-email">${t('deleteAccount.whichAccount', { email: state.session?.user?.email ?? '' })}</p>
        <p>${t('deleteAccount.warning')}</p>
        <div class="auth-field">
          <label for="delete-confirm-input">${t('deleteAccount.typeToConfirm', { word: t('deleteAccount.confirmWord') })}</label>
          <input type="text" id="delete-confirm-input" autocomplete="off" ${busy ? 'disabled' : ''} />
        </div>
        <div class="habit-form-actions">
          <button type="button" class="habit-form-cancel" data-action="delete-confirm-cancel" ${busy ? 'disabled' : ''}>${t('common.cancel')}</button>
          <button type="button" class="manage-btn manage-btn--danger" data-action="delete-confirm-submit" ${busy ? 'disabled' : ''}>${busy ? t('deleteAccount.deleting') : t('deleteAccount.deletePermanently')}</button>
        </div>
      </div>
    </div>
  `;
}

// Link aus "Über Logbuch" (siehe renderTip): Einstellungen sind schon offen - zur
// Einstellung scrollen, kurz hervorheben und fokussieren (bei einer Pill-Gruppe die gerade
// aktive Pill; Auswahllisten nicht nach Bedienung per Finger, siehe focusReopensPicker).
function focusSettingsTarget(target) {
  const row = document.querySelector(`[data-menu-target="${target}"]`);
  if (!row) return;
  const section = row.closest('details');
  if (section) section.open = true; // eingeklappten Abschnitt aufklappen (merkt sich der toggle-Listener)
  row.scrollIntoView({ block: 'center' });
  row.classList.add('field-highlight');
  row.addEventListener('animationend', () => row.classList.remove('field-highlight'), { once: true });
  const focusEl = row.querySelector('[aria-pressed="true"]') || row.querySelector('button, input, select');
  if (focusEl && !focusReopensPicker(focusEl)) focusEl.focus({ preventScroll: true });
}

// Header+☰-Menü sind für Tabs und Unterseiten identisch aufgebaut (nur der linke Teil
// unterscheidet sich: "Logbuch"-Wortmarke vs. ←-Button + Seitentitel) - deshalb hier
// als eigener Baustein statt zweimal dupliziert.
function renderMenuButton() {
  return `
    <div class="header-menu-wrap">
      <button type="button" class="menu-btn" data-action="toggle-menu" aria-expanded="${state.menuOpen}"><span aria-hidden="true">☰</span> ${t('ariaLabel.menu')}</button>
      ${state.menuOpen ? renderMenu() : ''}
    </div>
  `;
}

function renderSubpageHeader(titleKey, iconName) {
  return `
    <div class="header subpage-header">
      <div class="subpage-header-title">
        <button type="button" class="back-btn" data-action="subpage-back" aria-label="${esc(t('ariaLabel.back'))}">
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <h1 tabindex="-1">${iconName ? icon(iconName) : ''}${t(titleKey)}</h1>
      </div>
      ${renderMenuButton()}
    </div>
  `;
}

let lastFocusedSubpageLevel = null;
function renderApp() {
  // Ein Re-Render, während in einer Textarea getippt wird (Notiz-Editor oder Text-Feld,
  // z.B. durch einen im Hintergrund fertig werdenden Push-Status-Check), ersetzt sie -
  // der Text selbst überlebt über state (noteEditor.draft bzw. state.entries, siehe
  // updateTextValue), Fokus und Cursor-Position hier.
  const active = document.activeElement;
  const caret = active?.tagName === 'TEXTAREA' && active.id ? { id: active.id, range: [active.selectionStart, active.selectionEnd] } : null;
  const subpage = isSubpageView(state.view);
  // Rutsch-Animation nach einem Zeitraum-Wechsel (shiftPeriod): der neue Zeitraum kommt
  // aus der Richtung, in die man gewischt/geblättert hat. Bewusst nur um den Inhalt, nicht
  // um die Dialoge (position: fixed verträgt kein verschobenes Elternelement).
  const slide = !state.loading && SWIPEABLE_VIEWS.includes(state.view) ? pendingPeriodSlide : 0;
  const slideClass = slide > 0 ? ' view-slide-next' : slide < 0 ? ' view-slide-prev' : '';
  pendingPeriodSlide = 0;
  const body = state.loading ? `<div class="loading">${t('common.loading')}</div>` :
    state.view === 'today' ? renderToday() :
    state.view === 'week' ? renderWeek() :
    state.view === 'month' ? renderMonth() :
    state.view === 'year' ? renderYear() :
    state.view === 'global' ? renderGlobal() :
    state.view === 'about' ? renderAbout() :
    state.view === 'feedback' ? renderFeedback() :
    state.view === 'settings' ? renderSettings() :
    state.view === 'install' ? renderInstallGuide() : renderManage();

  app.innerHTML = `
    <div class="sticky-top">
      ${subpage
        ? renderSubpageHeader(state.view === 'manage' && state.habitForm
          ? habitFormTitleKey(state.habitForm)
          : state.view === 'manage' && state.sectionForm
            ? (state.sectionForm.id ? 'habitForm.title.editGroup' : 'habitForm.title.newGroup')
            : { manage: 'menu.manageFields', about: 'about.title', feedback: 'feedback.title', settings: 'menu.settings', install: 'menu.install' }[state.view], state.view === 'manage' ? (state.sectionForm ? 'newGroup' : 'manage') : state.view)
        : `
          <div class="header">
            <h1>Logbuch</h1>
            ${renderMenuButton()}
          </div>
          <div class="tabs">
            <button type="button" class="tab${state.view === 'today' ? ' tab--active' : ''}" data-action="set-view" data-view="today">${t('tabs.today')}</button>
            <button type="button" class="tab${state.view === 'week' ? ' tab--active' : ''}" data-action="set-view" data-view="week">${t('tabs.week')}</button>
            <button type="button" class="tab${state.view === 'month' ? ' tab--active' : ''}" data-action="set-view" data-view="month">${t('tabs.month')}</button>
            <button type="button" class="tab${state.view === 'year' ? ' tab--active' : ''}" data-action="set-view" data-view="year">${t('tabs.year')}</button>
            <button type="button" class="tab${state.view === 'global' ? ' tab--active' : ''}" data-action="set-view" data-view="global">${t('tabs.global')}</button>
          </div>
          ${state.view === 'today' && !state.loading ? renderTodayDayNav() : ''}
        `}
    </div>
    ${renderInstallHint()}
    <div class="view-body${slideClass}">${body}</div>
    ${state.deleteConfirm ? renderDeleteConfirm() : ''}
    ${state.passwordChange ? renderPasswordChange() : ''}
    ${state.spareKeyCheck ? renderSpareKeyCheck() : ''}
    ${state.emailChange ? renderEmailChange() : ''}
    ${state.resetConfirm ? renderResetConfirm() : ''}
    ${state.regenKeyConfirm ? renderRegenKeyConfirm() : ''}
    ${state.logoutConfirm ? renderLogoutConfirm() : ''}
    ${state.leaveFormConfirm ? renderLeaveFormConfirm() : ''}
    ${state.view === 'manage' && stepDialogOpen() && !state.leaveFormConfirm ? renderStepDialog() : ''}
    ${state.whatsNew && !state.deleteConfirm && !state.passwordChange && !state.spareKeyCheck && !state.emailChange && !state.resetConfirm && !state.regenKeyConfirm && !state.logoutConfirm && !state.leaveFormConfirm ? renderWhatsNew() : ''}
  `;
  // preventScroll: der Header ist ohnehin (sticky) sichtbar - der native
  // Scroll-in-View-Effekt beim Fokussieren kennt "position: sticky" nicht und hat
  // dadurch leicht falsch/zu weit gescrollt (Header wirkte oben angeschnitten).
  // Überschrift nur beim Betreten einer Unterseite bzw. Wechsel ihrer Ebene (Liste ↔
  // Feld-Formular) fokussieren - vorher bei JEDEM render(), wodurch z.B. jede
  // Umschaltung im Feld-Formular den Tastatur-Fokus wieder ganz nach oben warf.
  const subpageLevel = subpage ? state.view + (state.view === 'manage' && state.habitForm ? ':form' : state.view === 'manage' && state.sectionForm ? ':section-form' : '') : null;
  if (subpageLevel && subpageLevel !== lastFocusedSubpageLevel) document.querySelector('.subpage-header h1')?.focus({ preventScroll: true });
  lastFocusedSubpageLevel = subpageLevel;
  const caretInput = caret && document.getElementById(caret.id);
  if (caretInput) {
    caretInput.focus({ preventScroll: true });
    caretInput.setSelectionRange(...caret.range);
  }
  // Screenreader erfahren so, welcher Zeitraum jetzt gezeigt wird (der Pfeil sagt nur
  // "Nächster Tag").
  if (slide) announce(document.querySelector('.day-nav .day-label')?.textContent.replace(/\s+/g, ' ').trim() ?? '');
}
function announceAlert(text) {
  const el = document.getElementById('sr-alert');
  if (!el || !text) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 50);
}
function announce(text) {
  const el = document.getElementById('sr-announcer');
  if (!el || !text) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 50); // leeren + neu setzen: auch Gleiches wird erneut angesagt
}

// Fokussiert nach einem Re-Render das erste fokussierbare Element im gerade
// offenen Modal (falls eins offen ist) — zentral hier statt an jeder
// Öffnungsstelle einzeln, da render() das DOM immer komplett neu aufbaut und
// damit jeden zuvor gesetzten Fokus ohnehin verwirft.
function focusModalIfOpen() {
  const modalBox = document.querySelector('.modal-box');
  if (!modalBox) return;
  const focusable = modalBox.querySelector('[data-autofocus]')
    || modalBox.querySelector('input, button, select, textarea, [tabindex]:not([tabindex="-1"])');
  focusable?.focus();
}

// Merkt sich die zuletzt gerenderte Ansicht, um beim tatsächlichen Wechsel (Tab oder
// Unterseite) nach oben zu scrollen - sonst behält der Browser die Scroll-Position
// einer SPA über einen kompletten Inhaltswechsel hinweg bei (kein echter
// Seitenwechsel), z.B. wäre man nach dem Wechsel von einem herunter gescrollten
// "Heute" zu "Monat" dort ebenfalls mitten in der Seite statt oben gelandet.
let lastRenderedView = null;
// Startbildschirm statt Passwort-Abfrage, solange der Schlüssel gerade ohne Zutun geladen
// wird: beim Öffnen mit gespeicherter Anmeldung (sessionRestoreInFlight, siehe
// onAuthStateChange) und nach dem Absenden der Anmeldung (authFlowInFlight). Vorher stand
// dort sekundenlang "Passwort eingeben" - man tippte es ein, obwohl die App gleich von
// selbst aufging. startupShownAt: seit wann er steht (für den Hinweis bei langem Laden).
let sessionRestoreInFlight = false;
let startupShownAt = null;
const STARTUP_SLOW_HINT_MS = 8000;
function isOpeningAccount() {
  return Boolean(state.session) && !currentDek && (sessionRestoreInFlight || authFlowInFlight)
    && !state.unlockError && !state.unlockBusy;
}
function renderStartupScreen() {
  startupShownAt ??= Date.now();
  // Der Hinweis erscheint per CSS-Verzögerung - gerechnet ab dem ersten Anzeigen, damit
  // ein zwischendurch neu gezeichneter Bildschirm die Wartezeit nicht neu startet.
  const hintDelay = Math.max(0, STARTUP_SLOW_HINT_MS - (Date.now() - startupShownAt));
  app.innerHTML = `
    <div class="auth-box startup" role="status">
      <h1>Logbuch</h1>
      <p class="sub">${t('startup.opening')}</p>
      <p class="onb-hint startup-slow" style="animation-delay:${hintDelay}ms">${t('startup.slow')}</p>
    </div>
  `;
}
// Tastatur-Fokus über render() hinweg erhalten: render() ersetzt das ganze #app, das
// fokussierte Element verschwindet also bei jeder Aktion - wer per Tastatur, Schalter-
// Steuerung oder Screenreader einen Wert wählt, eine Gruppe aufklappt oder im Formular
// etwas umschaltet, stünde danach wieder am Seitenanfang. Deshalb vorher merken, WAS
// fokussiert war (id bzw. data-action + übrige data-Merkmale - bei den neu gebauten
// Elementen gleich), und nachher das entsprechende neue Element fokussieren. Nur wenn
// nichts anderes den Fokus bekommen hat (Dialog, Überschrift einer neuen Unterseite) -
// Aktionen, die bewusst woandershin fokussieren, tun das nach render() und gewinnen.
function focusKeyOf(el) {
  if (!el || el === document.body || !app.contains(el)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (!el.dataset.action) return null;
  return [...el.attributes]
    .filter((a) => a.name.startsWith('data-') && a.name !== 'data-dirty')
    .map((a) => `[${a.name}="${CSS.escape(a.value)}"]`)
    .join('');
}
function restoreFocus(key) {
  const active = document.activeElement;
  if (!key || (active && active !== document.body && app.contains(active))) return;
  let el = null;
  try { el = app.querySelector(key); } catch { /* ungültiger Selektor - egal */ }
  if (el && !focusReopensPicker(el)) el.focus({ preventScroll: true });
}
// Eine Auswahlliste (<select>) nach einer Bedienung per Finger nicht per Skript
// fokussieren: auf iOS öffnet das sofort wieder ihr Auswahl-Menü - nach jeder Auswahl, die
// ein render() auslöst, sah es aus, als müsse man zweimal wählen. Tastatur-Nutzer (letzte
// Zeige-Eingabe Maus bzw. keine) behalten ihren Platz.
function focusReopensPicker(el) {
  return (el.tagName === 'SELECT' || el.type === 'date') && lastPointerType !== 'mouse';
}

// Sanftes Erscheinen von Menüs, Dialogen und Notiz-Editor (.layer-in, CSS). render() baut
// #app jedes Mal neu - eine CSS-Animation am Element liefe deshalb bei jedem render()
// erneut ab (beim Notiz-Editor bei jedem Tastendruck). Darum bekommt nur eine Ebene die
// Klasse, die vor diesem render() noch nicht da war (Schlüssel aus Klasse + id/Titel).
const LAYER_SELECTOR = '.menu-panel, .row-menu, .modal-overlay, .note-editor';
function layerKey(el) {
  return `${el.classList[0]}|${el.id || el.querySelector('[id]')?.id || ''}|${el.querySelector('[aria-label]')?.getAttribute('aria-label') || ''}`;
}
function openLayerKeys() {
  return new Set([...app.querySelectorAll(LAYER_SELECTOR)].map(layerKey));
}
function markNewLayers(before) {
  app.querySelectorAll(LAYER_SELECTOR).forEach((el) => { if (!before.has(layerKey(el))) el.classList.add('layer-in'); });
}

// Zeichenzähler "35/40" unter Eingabefeldern mit maxlength - erst, wenn man sich der Grenze
// nähert (sonst merkte man nicht, warum das Feld plötzlich nichts mehr annimmt bzw. beim
// Einfügen abschneidet). Hängt am Feld selbst, gilt so für alle Felder mit maxlength.
function syncCharCounter(el) {
  const max = Number(el.getAttribute('maxlength'));
  if (!max) return;
  let counter = el.nextElementSibling?.classList.contains('char-count') ? el.nextElementSibling : null;
  const len = el.value.length;
  if (max - len > Math.max(3, Math.round(max * 0.15))) { counter?.remove(); return; }
  if (!counter) {
    counter = document.createElement('span');
    counter.className = 'char-count';
    counter.setAttribute('aria-live', 'polite');
    el.after(counter);
  }
  counter.classList.toggle('char-count--full', len >= max);
  counter.innerHTML = `<span aria-hidden="true">${len}/${max}</span><span class="visually-hidden">${esc(tPlain('charCount.sr', { n: len, max }))}</span>`;
}
function syncCharCounters() {
  app.querySelectorAll('input[maxlength], textarea[maxlength]').forEach(syncCharCounter);
}
app.addEventListener('input', (e) => {
  if (e.target.matches?.('input[maxlength], textarea[maxlength]')) syncCharCounter(e.target);
});

function render() {
  const focusKey = focusKeyOf(document.activeElement);
  const layersBefore = openLayerKeys();
  // Ein Notiz-Editor, der durch einen Tag-/Tab-Wechsel o.ä. nicht mehr sichtbar ist,
  // wird hier zentral gespeichert und geschlossen, statt an jeder der vielen Stellen,
  // die Tag oder Ansicht ändern (Klicks, Wischen, Deep-Links, Kalenderzellen, ...).
  if (state.noteEditor && !isNoteEditorOpen()) commitPendingNoteDraft();
  if (!isOpeningAccount()) startupShownAt = null;
  if (!state.session || state.view !== 'today') invalidateTodayAutoCollapse();
  if (state.passwordRecovery) { renderPasswordRecovery(); }
  else if (!state.session) {
    // Die Installations-Seite kommt erst nach Startseite bzw. Einstiegsfrage - direkt vor
    // dem Formular (so registriert man sich gleich in der installierten App).
    if (['signup', 'signin'].includes(state.authMode) && shouldShowInstallGate()) renderInstallGate(); else renderAuth();
  }
  else if (state.confirmLanding) { renderConfirmLanding(); }
  else if (state.recoveryKeyToShow) { renderRecoveryKeyDisplay(); }
  else if (state.encryptionSetupInProgress) { app.innerHTML = `<div class="loading">${t('common.encryptingData')}</div>`; }
  else if (isOpeningAccount()) { renderStartupScreen(); }
  else if (!currentDek) { renderUnlockPrompt(); }
  else if (!state.loading && !state.userSettings.onboardingCompleted) { renderTutorial(); }
  else { renderApp(); }
  // Uhrzeit-Auswahl offen, aber ihr Knopf ist weg (z.B. Abmelden auf einem anderen Weg): schließen.
  if (timePicker && !document.getElementById(timePicker.triggerId)) closeTimePicker({ focus: false });
  if (!app.querySelector('.view-body')) addOnbDisplayBar();
  syncCharCounters();
  markNewLayers(layersBefore);
  positionFloatingRowMenu();
  syncToast(state.passwordRecovery || !state.session); // Anmelde-Seiten: Meldung im Text
  focusModalIfOpen();
  restoreFocus(focusKey);
  syncLayerHistory();
  if (state.view !== lastRenderedView) {
    lastRenderedView = state.view;
    window.scrollTo(0, 0);
  }
  if (pendingScrollRestore !== null) {
    window.scrollTo(0, pendingScrollRestore);
    pendingScrollRestore = null;
  }
  if (pendingFieldFocus) consumePendingFieldFocus();
}

// --- Event-Delegation ----------------------------------------------------
app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  // Jede neue Aktion räumt eine noch angezeigte Meldung von einer früheren Aktion weg
  // (z.B. einen Validierungsfehler, der sonst nach erfolgreicher Korrektur einfach
  // stehen bliebe, bis man aktiv neu lädt) – die aktuelle Aktion setzt bei Bedarf
  // gleich danach ihre eigene, aktuelle Meldung.
  state.notice = null;
  // Jede andere Aktion (Wert wählen, Tag/Tab wechseln, ...) schließt ein offenes
  // Zeilen-Menü mit - die Menüpunkte selbst lesen ihr Ziel aus el.dataset, nicht aus
  // state.rowMenu.
  if (action !== 'row-menu') state.rowMenu = null;

  if (action === 'pick-date') {
    // Finger: das Gerät öffnet seinen Kalender selbst. Maus: Chrome/Edge täten es nur über
    // das kleine Kalender-Symbol, das hier unsichtbar ist.
    if (lastPointerType === 'mouse') { try { el.showPicker(); } catch { /* ältere Browser: Tastatur-Eingabe */ } }
    return;
  }
  if (action === 'onb-mode') {
    setOnbMode(el.dataset.mode);
    setOnbInProgress(true);
    rememberOnbIncludesInstall();
    // Von der Einstiegsfrage aus erst die persönliche Nachricht; in der frisch installierten
    // App (iPhone) kam sie schon im Browser, dort direkt weiter.
    state.authMode = state.authMode === 'mode' ? 'intro' : 'signup';
    render();
    document.querySelector('.auth-box h1, .auth-box .sub')?.focus({ preventScroll: true });
  } else if (action === 'avg-info') {
    state.notice = { type: 'ok', text: el.dataset.text };
    render();
  } else if (action === 'group-tip-hide') {
    try { localStorage.setItem('groupTipDismissed', 'true'); } catch { /* dann eben nur bis zum Neuladen */ }
    render();
    document.querySelector('[data-action="group-new"]')?.focus({ preventScroll: true });
  } else if (action === 'today-intro-next') {
    // Ohne data-Merkmal für "letzte Karte", damit der Fokus beim Weiterblättern auf dem
    // Knopf bleibt (restoreFocus findet ihn über data-action).
    const lastStep = (isGuided() ? 3 : 1) - 1;
    if ((state.todayIntroStep || 0) >= lastStep) { setTodayIntroPending(false); state.todayIntroStep = 0; }
    else state.todayIntroStep = (state.todayIntroStep || 0) + 1;
    render();
  } else if (action === 'check-mail-done') {
    // Die Hilfe beim Anmelden erscheint wieder, falls die Adresse doch noch nicht bestätigt ist.
    state.confirmEmailFor = null;
    state.confirmResend = null;
    state.authMode = 'signin';
    render();
    document.querySelector('.auth-box .sub')?.focus({ preventScroll: true });
  } else if (action === 'auth-choose') {
    // Wer "Ich habe schon ein Konto" wählt, richtet kein neues Konto ein.
    if (el.dataset.mode === 'signin' && ['welcome', 'installed'].includes(state.authMode)) setOnbInProgress(false);
    state.authMode = el.dataset.mode;
    state.authError = null;
    state.notice = null;
    render();
    // Neue Seite: Fokus auf ihren Titel (nicht ins E-Mail-Feld - das öffnete auf dem Handy
    // sofort die Tastatur).
    document.querySelector(['welcome', 'mode', 'intro', 'overview', 'installed'].includes(state.authMode) ? '.auth-box h1' : '.auth-box .sub')?.focus({ preventScroll: true });
  } else if (action === 'resend-confirm') {
    if (state.confirmEmailFor && state.confirmResend !== 'sending') resendConfirmEmail();
  } else if (action === 'start-forgot') {
    state.authMode = 'forgot';
    state.authError = null;
    render();
  } else if (action === 'cancel-forgot') {
    state.authMode = 'signin';
    state.authError = null;
    render();
  } else if (action === 'toggle-recovery-fallback') {
    state.recoveryFallbackConfirm = !state.recoveryFallbackConfirm;
    state.authError = null;
    render();
  } else if (action === 'spare-key-method') {
    const shown = state.recoveryKeyToShow;
    if (!shown) return;
    shown.method = el.dataset.method;
    shown.used = true;
    shown.ask = false;
    if (shown.method === 'copy') {
      try {
        await navigator.clipboard.writeText(formatRecoveryKey(shown.hex));
      } catch {
        state.notice = { type: 'error', text: t('recoveryDisplay.copyFailed') };
      }
    } else if (shown.method === 'file') {
      const blob = new Blob(
        [`${t('recoveryDisplay.fileTitle')}\n${formatRecoveryKey(shown.hex)}\n\n${t('recoveryDisplay.fileBody')}\n`],
        { type: 'text/plain' }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = t('recoveryDisplay.fileName');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60_000); // siehe handleExportData
    }
    render();
  } else if (action === 'spare-key-done') {
    const shown = state.recoveryKeyToShow;
    if (!shown) return;
    // Ohne benutzten Weg - oder nach "Aufschreiben", wo die App nicht sehen kann, ob es
    // passiert ist - einmal freundlich nachfragen.
    if (!shown.used || shown.method === 'write') {
      shown.ask = true;
      render();
      document.querySelector('.spare-key-ask .auth-submit')?.focus();
      return;
    }
    await confirmSpareKey();
  } else if (action === 'spare-key-ask-back') {
    if (state.recoveryKeyToShow) state.recoveryKeyToShow.ask = false;
    render();
  } else if (action === 'spare-key-finish') {
    await confirmSpareKey();
  } else if (action === 'regenerate-recovery-key') {
    modalTriggerSelector = '[data-action="regenerate-recovery-key"]';
    state.regenKeyConfirm = true;
    state.menuOpen = false;
    render();
  } else if (action === 'regen-key-cancel') {
    state.regenKeyConfirm = false;
    render();
    restoreModalFocus();
  } else if (action === 'regen-key-confirm') {
    state.regenKeyConfirm = false;
    modalTriggerSelector = null; // danach kommt die Anzeige des neuen Schlüssels
    await regenerateRecoveryKey();
  } else if (action === 'logout-arm') {
    modalTriggerSelector = '[data-action="logout-arm"]';
    state.logoutConfirm = true;
    state.menuOpen = false;
    render();
  } else if (action === 'logout-cancel') {
    state.logoutConfirm = false;
    render();
    restoreModalFocus();
  } else if (action === 'logout') {
    state.logoutConfirm = false;
    modalTriggerSelector = null;
    flushAllDaySaves(); // ausstehende Text-Feld-Speicherungen noch mit dem Schlüssel verschicken
    await endPushForThisDevice();
    clearCurrentDek();
    state.authEmail = '';
    state.authPassword = '';
    state.authPasswordVisible = false;
    await supabase.auth.signOut();
  } else if (action === 'dismiss-install-hint') {
    try { localStorage.setItem('installHintDismissed', 'true'); } catch { /* egal, blendet dann halt nicht dauerhaft aus */ }
    render();
  } else if (action === 'toggle-menu') {
    state.menuOpen = !state.menuOpen;
    render();
  } else if (action === 'onb-display-toggle') {
    state.onbDisplayOpen = !state.onbDisplayOpen;
    render();
  } else if (action === 'text-size-set') {
    setTextSize(el.dataset.size);
    render();
  } else if (action === 'theme-set') {
    setThemeOverride(el.dataset.theme || null);
    render();
  } else if (action === 'open-manage') {
    enterSubpage('manage');
    render();
  } else if (action === 'leave-form-stay') {
    closeModals();
    render();
    restoreModalFocus();
  } else if (action === 'leave-form-discard') {
    const proceed = pendingFormLeave;
    closeModals();
    modalTriggerSelector = null; // die Ebene darunter ist gleich weg, render() fokussiert neu
    proceed?.();
    render();
  } else if (action === 'open-settings' || action === 'open-about' || action === 'open-feedback' || action === 'open-install') {
    // Aus einem geänderten Feld-/Gruppen-Formular heraus erst nachfragen (enterSubpage schließt es).
    const view = action.slice('open-'.length);
    leaveFormGuarded(() => enterSubpage(view));
    render();
  } else if (action === 'open-settings-at') {
    enterSubpage('settings');
    render();
    focusSettingsTarget(el.dataset.target);
  } else if (action === 'whats-new-close') {
    closeWhatsNew();
    render();
  } else if (action === 'whats-new-all') {
    closeWhatsNew();
    enterSubpage('about');
    openAboutSections.add('aboutNewsCollapsed');
    render();
    requestAnimationFrame(() => document.getElementById('about-news')?.scrollIntoView({ block: 'start' }));
  } else if (action === 'feedback-submit') {
    await handleFeedbackSubmit();
  } else if (action === 'subpage-back') {
    subpageBack();
    render();
  } else if (action === 'export-data') {
    await handleExportData();
  } else if (action === 'open-password-change') {
    modalTriggerSelector = '[data-action="open-password-change"]';
    state.passwordChange = { current: '', next: '', visible: false, busy: false, error: null };
    state.menuOpen = false;
    render();
  } else if (action === 'password-change-cancel') {
    state.passwordChange = null;
    render();
    restoreModalFocus();
  } else if (action === 'password-change-visibility') {
    state.passwordChange.visible = !state.passwordChange.visible;
    render();
    document.querySelector('[data-action="password-change-visibility"]')?.focus();
  } else if (action === 'open-email-change') {
    modalTriggerSelector = '[data-action="open-email-change"]';
    state.emailChange = { value: '', password: '', busy: false, error: null, sentTo: null };
    state.menuOpen = false;
    render();
  } else if (action === 'email-change-close') {
    state.emailChange = null;
    render();
    restoreModalFocus();
  } else if (action === 'open-spare-key-check') {
    modalTriggerSelector = '[data-action="open-spare-key-check"]';
    state.spareKeyCheck = { value: '', busy: false, result: null, errorText: '' };
    state.menuOpen = false;
    render();
  } else if (action === 'spare-key-check-close') {
    state.spareKeyCheck = null;
    render();
    restoreModalFocus();
  } else if (action === 'open-delete-confirm') {
    modalTriggerSelector = '[data-action="open-delete-confirm"]';
    state.deleteConfirm = { busy: false };
    state.menuOpen = false;
    render();
  } else if (action === 'delete-confirm-cancel') {
    state.deleteConfirm = null;
    render();
    restoreModalFocus();
  } else if (action === 'delete-confirm-submit') {
    await handleDeleteAccount();
  } else if (action === 'set-view') {
    state.view = el.dataset.view;
    render();
  } else if (action === 'nav-day' || action === 'nav-week' || action === 'nav-month' || action === 'nav-year') {
    shiftPeriod(Number(el.dataset.dir));
    render();
    // render() ersetzt den Pfeil - Fokus zurück, damit man per Tastatur weiterblättern kann.
    document.querySelector(`[data-action="${action}"][data-dir="${el.dataset.dir}"]`)?.focus({ preventScroll: true });
  } else if (action === 'jump-today') {
    const today = startOfDay(new Date());
    pendingPeriodSlide = today > state.currentDate ? 1 : -1;
    state.currentDate = today;
    render();
  } else if (action === 'open-day') {
    if (isFutureKey(el.dataset.date)) return;
    state.currentDate = parseDateKey(el.dataset.date);
    state.view = 'today';
    render();
    if (el.dataset.focusHabit) focusTodayField(el.dataset.focusHabit);
  } else if (action === 'select') {
    const dateKey = formatKey(state.currentDate);
    const value = JSON.parse(el.dataset.value);
    handleSelect(dateKey, el.dataset.habit, value);
  } else if (action === 'multi-toggle' || action === 'multi-none') {
    handleMultiToggle(formatKey(state.currentDate), el.dataset.habit, action === 'multi-none' ? null : el.dataset.option);
  } else if (action === 'reset-day-arm') {
    // Das Menü ist nach dem Dialog zu - der Fokus kehrt deshalb auf dessen ⋮ zurück.
    modalTriggerSelector = `.row-menu-trigger[data-menu="${DAY_MENU_KEY}"]`;
    state.resetConfirm = formatKey(state.currentDate);
    render();
  } else if (action === 'reset-day-cancel') {
    state.resetConfirm = null;
    render();
    restoreModalFocus();
  } else if (action === 'reset-day-confirm') {
    const dateKey = state.resetConfirm;
    state.resetConfirm = null;
    handleReset(dateKey);
    restoreModalFocus();
  } else if (action === 'note-edit') {
    openNoteEditor(el.dataset.note);
  } else if (action === 'note-save') {
    closeNoteEditor(true);
  } else if (action === 'note-cancel') {
    closeNoteEditor(false);
  } else if (action === 'counter-step') {
    handleCounterStep(formatKey(state.currentDate), el.dataset.habit, Number(el.dataset.dir));
  } else if (action === 'time-pick') {
    // Leer startet die Auswahl bei "jetzt" - heute und gestern (nach Mitternacht am Vortag =
    // heute Nacht); an älteren Tagen ergäbe "jetzt" keinen Sinn, dort nur die Uhrzeit.
    const dateKey = formatKey(state.currentDate);
    const h = state.habits.find((x) => x.id === el.dataset.habit);
    if (!h) return;
    const now = new Date();
    const yesterday = dateKey === formatKey(addDays(startOfDay(now), -1));
    const nowAllowed = yesterday || dateKey === formatKey(now);
    const old = state.entries[dateKey]?.[h.id];
    const has = typeof old === 'number';
    openTimePicker({
      title: h.name, dateKey, step: 1, nowAllowed, triggerId: el.id,
      value: has ? old : nowAllowed ? timeValueOn(dateKey, now) : now.getHours() * 60 + now.getMinutes(),
      onPick: (v) => handleSetValue(dateKey, h.id, v),
      onClear: has ? () => { handleClearValue(dateKey, h.id); flushDaySave(dateKey); } : null,
    });
  } else if (action === 'reminder-time-pick') {
    const labelId = (el.getAttribute('aria-labelledby') || '').split(' ')[0];
    openTimePicker({
      title: (labelId && document.getElementById(labelId)?.textContent.trim()) || t('time.label'),
      step: REMINDER_TIME_STEP, value: Number(el.dataset.value), triggerId: el.id,
      onPick: (v) => reminderTimePicked(el.id, v),
    });
  } else if (action === 'clear-value') {
    handleClearValue(formatKey(state.currentDate), el.dataset.habit);
  } else if (action === 'preview-select') {
    // Wie in "Heute": derselbe Wert nochmal entfernt ihn wieder.
    const v = JSON.parse(el.dataset.value);
    setPreviewValue(state.habitForm && effectivePreviewValue(state.habitForm) === v ? null : v, `[data-value='${JSON.stringify(v)}']`);
  } else if (action === 'preview-clear') {
    setPreviewValue(null, '.value-slider');
  } else if (action === 'enable-push') {
    enablePush();
  } else if (action === 'disable-push') {
    disablePush();
  } else if (action === 'today-new-field') {
    enterSubpage('manage');
    openHabitForm({ ...defaultHabitForm(), returnToTab: true });
  } else if (action === 'row-menu') {
    if (state.rowMenu === el.dataset.menu) closeRowMenu();
    else openRowMenu(el.dataset.menu);
  } else if (action === 'section-menu-edit') {
    enterSubpage('manage');
    openSectionForm(el.dataset.id, { returnToTab: true });
  } else if (action === 'row-menu-edit') {
    // Gleiches Muster wie der "+ Neues Feld"-Shortcut: returnToTab führt nach
    // Speichern/Abbrechen zurück nach "Heute" statt in der Verwaltung zu bleiben.
    const h = state.habits.find((x) => x.defId === el.dataset.id);
    if (h) {
      enterSubpage('manage');
      openHabitForm({ ...habitToForm(h), returnToTab: true });
    }
  } else if (action === 'row-menu-archive') {
    // Anders als in der Verwaltung verschwindet das Feld hier einfach aus der Liste -
    // die Meldung sagt, wo es wieder zu finden ist.
    if (await handleHabitArchive(el.dataset.id, true)) {
      state.notice = { type: 'ok', text: t('notice.fieldArchived') };
      render();
    }
  } else if (action === 'habit-new') {
    openHabitForm(defaultHabitForm());
  } else if (action === 'group-new') {
    openSectionForm(null);
  } else if (action === 'section-edit') {
    openSectionForm(el.dataset.id);
  } else if (action === 'section-form-save') {
    await saveSectionForm();
  } else if (action === 'section-form-cancel') {
    closeSectionForm();
    render();
  } else if (action === 'habit-edit') {
    const h = state.habits.find((x) => x.defId === el.dataset.id);
    if (h) openHabitForm(habitToForm(h));
  } else if (action === 'habit-reveal-next') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    if (f.revealStage === 1 && !f.name.trim()) {
      state.notice = { type: 'error', text: t('habitForm.error.nameRequired') };
      render();
      document.getElementById('habit-form-name')?.focus();
      return;
    }
    f.revealStage = Math.min(3, f.revealStage + 1);
    render();
    // Zum neu aufgedeckten Teil scrollen und dort den Fokus setzen.
    const target = document.getElementById(f.revealStage === 2 ? 'habit-form-kind-field' : 'habit-form-details');
    target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    (f.revealStage === 2 ? target?.querySelector('[aria-pressed="true"]') : document.querySelector('#habit-form .form-part[aria-labelledby="habit-form-part-entry"] :is(button, input)'))?.focus({ preventScroll: true });
  } else if (action === 'habit-convert-counter') {
    syncHabitFormFromDom();
    state.habitForm.convertConfirm = true;
    render();
    document.querySelector('[data-action="habit-convert-cancel"]')?.focus();
  } else if (action === 'habit-convert-cancel') {
    state.habitForm.convertConfirm = false;
    render();
    document.querySelector('[data-action="habit-convert-counter"]')?.focus();
  } else if (action === 'habit-convert-confirm') {
    await convertHabitToCounter(state.habitForm.defId);
  } else if (action === 'step-edit-open') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h) return;
    f.stepEdit = { steps: h.max - h.min + 1, labels: h.labels ? [...h.labels] : null, preset: 'spread', map: {}, confirm: false };
    applyStepEditPreset(h, f.stepEdit);
    f.stepEdit.initial = stepEditKey(f.stepEdit);
    render();
    // Auf die Überschrift, nicht ins Zahlenfeld - dort ginge auf dem Handy sofort die Tastatur auf.
    document.getElementById('step-dialog-title')?.focus();
  } else if (action === 'type-edit-open') {
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h || !typeChangeTargets(h).length || typeChangeBlocker(h)) return;
    // Nach der Umwandlung wird das Formular neu aus dem Feld aufgebaut - andere Eingaben gingen verloren.
    if (openFormHasChanges()) {
      state.notice = { type: 'error', text: t('typeEdit.error.dirty') };
      render();
      return;
    }
    f.typeEdit = { kind: null, steps: 5, preset: 'round', unit: '', map: {}, confirm: false };
    typeEditKindChanged(h, f.typeEdit, typeChangeTargets(h)[0]);
    f.typeEdit.initial = typeEditKey(f.typeEdit);
    render();
    document.getElementById('step-dialog-title')?.focus();
  } else if (action === 'type-edit-kind' || action === 'type-edit-preset') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h || !f.typeEdit) return;
    if (action === 'type-edit-kind') typeEditKindChanged(h, f.typeEdit, el.dataset.kind);
    else {
      f.typeEdit.preset = el.dataset.preset;
      applyTypeEditPreset(h, f.typeEdit);
    }
    render();
    const attr = action === 'type-edit-kind' ? `data-kind="${el.dataset.kind}"` : `data-preset="${el.dataset.preset}"`;
    document.querySelector(`[data-action="${action}"][${attr}]`)?.focus();
  } else if (action === 'type-edit-apply') {
    syncHabitFormFromDom();
    const te = state.habitForm.typeEdit;
    if (!te) return;
    const { error } = typeEditFinalMap(te);
    if (error) state.notice = { type: 'error', text: t(error) };
    else te.confirm = true;
    render();
    document.querySelector(te.confirm ? '[data-action="type-edit-confirm-cancel"]' : '[data-action="type-edit-apply"]')?.focus();
  } else if (action === 'type-edit-confirm-cancel') {
    state.habitForm.typeEdit.confirm = false;
    render();
    document.querySelector('[data-action="type-edit-apply"]')?.focus();
  } else if (action === 'type-edit-confirm') {
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h || !f.typeEdit?.confirm) return; // zweiter Tipp
    const te = f.typeEdit;
    const { map } = typeEditFinalMap(te);
    const to = typeEditTo(h, te);
    const extra = te.kind === 'scale' ? { preset: te.preset === 'custom' ? 'round' : te.preset, range: usedValueRange(h) } : {};
    f.typeEdit = null;
    f.typeRunning = true;
    finishStepChangeAction(f, await startStepChange(h.defId, to, map, extra), 'typeEdit.done', true);
  } else if (action === 'step-edit-cancel') {
    syncHabitFormFromDom();
    const wasType = !!state.habitForm.typeEdit;
    state.habitForm.stepEdit = null;
    state.habitForm.typeEdit = null;
    render();
    document.querySelector(wasType ? '[data-action="type-edit-open"]' : '[data-action="step-edit-open"]')?.focus();
  } else if (action === 'step-edit-preset') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h || !f.stepEdit) return;
    f.stepEdit.preset = el.dataset.preset;
    applyStepEditPreset(h, f.stepEdit);
    render();
    document.querySelector(`[data-action="step-edit-preset"][data-preset="${el.dataset.preset}"]`)?.focus();
  } else if (action === 'step-edit-apply') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h || !f.stepEdit) return;
    const se = f.stepEdit;
    if (se.labels && se.labels.some((l) => !l.trim())) {
      state.notice = { type: 'error', text: t('habitForm.error.fillAllLabels') };
    } else if (stepEditNothingToDo(h, se)) {
      state.notice = { type: 'error', text: t('stepEdit.error.nothing') };
    } else {
      se.confirm = true;
    }
    render();
    document.querySelector(se.confirm ? '[data-action="step-edit-confirm-cancel"]' : '[data-action="step-edit-apply"]')?.focus();
  } else if (action === 'step-edit-confirm-cancel') {
    state.habitForm.stepEdit.confirm = false;
    render();
    document.querySelector('[data-action="step-edit-apply"]')?.focus();
  } else if (action === 'step-edit-confirm') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h || !f.stepEdit) return;
    const to = stepEditTo(h, f.stepEdit);
    const map = { ...f.stepEdit.map };
    f.stepEdit = null;
    finishStepChangeAction(f, await startStepChange(h.defId, to, map), 'stepEdit.done');
  } else if (action === 'step-edit-resume') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const sc = state.habits.find((x) => x.defId === f.defId)?.stepChange;
    const type = !!sc && isTypeChange(sc);
    if (type) f.typeRunning = true;
    const doneKey = sc?.state === 'undo' ? (type ? 'typeEdit.undoDone' : 'stepEdit.undoDone') : (type ? 'typeEdit.done' : 'stepEdit.done');
    finishStepChangeAction(f, await runStepChange(f.defId), doneKey, type);
  } else if (action === 'step-undo') {
    syncHabitFormFromDom();
    state.habitForm.stepUndoConfirm = true;
    render();
    document.querySelector('[data-action="step-undo-cancel"]')?.focus();
  } else if (action === 'step-undo-cancel') {
    state.habitForm.stepUndoConfirm = false;
    render();
    document.querySelector('[data-action="step-undo"]')?.focus();
  } else if (action === 'step-undo-confirm') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    if (!f.stepUndoConfirm) return; // zweiter Tipp
    f.stepUndoConfirm = false;
    const sc = state.habits.find((x) => x.defId === f.defId)?.stepChange;
    const type = !!sc && isTypeChange(sc);
    if (type) f.typeRunning = true;
    finishStepChangeAction(f, await startStepChangeUndo(f.defId), type ? 'typeEdit.undoDone' : 'stepEdit.undoDone', type);
  } else if (action === 'habit-cancel') {
    closeHabitForm();
    render();
  } else if (action === 'habit-kind') {
    syncHabitFormFromDom();
    state.habitForm.kind = el.dataset.kind;
    render();
  } else if (action === 'section-toggle') {
    const { section, scope } = el.dataset;
    if (el.getAttribute('aria-expanded') === 'false') expandSection(scope, section);
    else setSectionCollapsed(scope, section, true);
    render();
    document.querySelector(`[data-action="section-toggle"][data-section="${section}"][data-scope="${scope}"]`)?.focus();
  } else if (action === 'section-delete-arm') {
    state.sectionDeleteConfirm = el.dataset.id;
    render();
  } else if (action === 'section-delete-cancel') {
    state.sectionDeleteConfirm = null;
    render();
  } else if (action === 'section-delete') {
    await deleteSection(el.dataset.id);
  } else if (action === 'computed-type') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    if (f.computedType !== el.dataset.type) {
      f.computedType = el.dataset.type;
      // Mitglieder der anderen Art passen nicht mehr - raus damit.
      f.members = f.members.filter((key) => {
        const h = state.habits.find((x) => x.id === key);
        // "Dauer" wählt seine zwei Felder über eigene Auswahllisten (durationFrom/To).
        return h && f.computedType !== 'duration' && f.computedType !== 'since' && (f.computedType === 'number' ? h.kind === 'number' : h.kind === 'scale');
      });
    }
    render();
    document.querySelector(`[data-action="computed-type"][data-type="${el.dataset.type}"]`)?.focus();
  } else if (action === 'multi-option-add') {
    syncHabitFormFromDom();
    const option = { id: newMultiOptionId(), label: '' };
    state.habitForm.multiOptions.push(option);
    render();
    document.getElementById(`habit-form-multi-option-${option.id}`)?.focus();
  } else if (action === 'multi-option-remove') {
    syncHabitFormFromDom();
    state.habitForm.multiOptions = state.habitForm.multiOptions.filter((o) => o.id !== el.dataset.option);
    render();
    app.querySelector('[data-action="multi-option-add"]')?.focus();
  } else if (action === 'multi-option-hide') {
    syncHabitFormFromDom();
    const option = state.habitForm.multiOptions.find((o) => o.id === el.dataset.option);
    if (option) option.hidden = !option.hidden;
    render();
  } else if (action === 'since-value') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const v = Number(el.dataset.value);
    f.sinceValues = f.sinceValues.includes(v) ? f.sinceValues.filter((x) => x !== v) : [...f.sinceValues, v].sort((a, b) => a - b);
    render();
    document.querySelector(`[data-action="since-value"][data-value="${v}"]`)?.focus();
  } else if (action === 'since-mode') {
    syncHabitFormFromDom();
    state.habitForm.sinceMode = el.dataset.mode === 'start' ? 'start' : 'last';
    render();
    document.querySelector(`[data-action="since-mode"][data-mode="${el.dataset.mode}"]`)?.focus();
  } else if (action === 'habit-reminder-add') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    // Neue Zeit: eine Stunde nach der letzten; geht das nicht (spät abends), die erste volle
    // Stunde, die noch frei ist - nie eine schon vorhandene Zeit.
    const last = f.reminderTimes[f.reminderTimes.length - 1];
    const next = last + 60 <= 1425 && !f.reminderTimes.includes(last + 60) ? last + 60
      : Array.from({ length: 24 }, (_, h) => h * 60).find((m) => !f.reminderTimes.includes(m));
    f.reminderTimes = [...f.reminderTimes, next];
    // Bedingung der neuen Zeit: wie die letzte (alle oder keine brauchen eine Zahl).
    f.reminderBelow = [...f.reminderBelow, f.reminderBelow[f.reminderBelow.length - 1] ?? ''];
    render();
    const i = f.reminderTimes.length - 1;
    document.getElementById(`habit-form-reminder-time-${i}-h`)?.focus();
  } else if (action === 'habit-reminder-remove') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const i = Number(el.dataset.index);
    f.reminderTimes = f.reminderTimes.filter((_, j) => j !== i);
    f.reminderBelow = f.reminderBelow.filter((_, j) => j !== i);
    render();
    // Fokus nicht ins Leere: auf die Zeile, die jetzt an dieser Stelle steht (sonst die letzte).
    document.getElementById(`habit-form-reminder-time-${Math.min(i, f.reminderTimes.length - 1)}-h`)?.focus();
  } else if (action === 'habit-schedule-mode') {
    syncHabitFormFromDom();
    state.habitForm.schedule.mode = el.dataset.mode;
    render();
    document.querySelector(`[data-action="habit-schedule-mode"][data-mode="${el.dataset.mode}"]`)?.focus();
  } else if (action === 'habit-schedule-day') {
    syncHabitFormFromDom();
    const sch = state.habitForm.schedule;
    const day = Number(el.dataset.day);
    sch.days = sch.days.includes(day) ? sch.days.filter((d) => d !== day) : [...sch.days, day];
    render();
    // render() baut das Formular neu auf - Fokus zurück auf denselben Button, sonst
    // landet man per Tastatur nach jedem Umschalten wieder am Seitenanfang.
    document.querySelector(`[data-action="habit-schedule-day"][data-day="${el.dataset.day}"]`)?.focus();
  } else if (action === 'habit-good') {
    syncHabitFormFromDom();
    state.habitForm.good = el.dataset.good || null;
    render();
  } else if (action === 'habit-entry-mode') {
    syncHabitFormFromDom();
    state.habitForm.kind = el.dataset.kind;
    render();
  } else if (action === 'habit-summary') {
    syncHabitFormFromDom();
    state.habitForm.summary = el.dataset.summary === 'sum' ? 'sum' : 'avg';
    render();
    document.querySelector(`[data-action="habit-summary"][data-summary="${state.habitForm.summary}"]`)?.focus();
  } else if (action === 'habit-numgoal') {
    syncHabitFormFromDom();
    state.habitForm.numberGoalDir = el.dataset.dir || null;
    render();
    if (state.habitForm.numberGoalDir) document.getElementById('habit-form-numgoal-value')?.focus();
  } else if (action === 'habit-period') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    f.period = el.dataset.period;
    f.periodReminderDay = null; // Standardtag des neuen Zeitraums
    if (f.period !== 'day') { f.sectionId = null; f.schedule = scheduleToForm(null); }
    render();
  } else if (action === 'habit-start') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const steps = habitFormStepCount(f);
    f.min = Number(el.dataset.start) === 0 ? 0 : 1;
    f.max = f.min + steps - 1;
    render();
  } else if (action === 'habit-display-style') {
    syncHabitFormFromDom();
    const f = state.habitForm;
    f.displayStyle = el.dataset.style;
    clampHabitFormSteps(f);
    f.labels = resizeLabels(f.labels, habitFormStepCount(f), f.labelsEnabled ? (i) => String(habitFormStepValue(f, i)) : undefined);
    render();
  } else if (action === 'habit-steps-to-slider') {
    // Am Deckel für gezielt wählbare Stufen (siehe atChoiceCap in renderHabitForm):
    // Schieberegler ohne Bezeichnungen, danach direkt weiter hochzählen können. Die
    // Bezeichnungs-Texte bleiben im Formular-Zustand erhalten (resizeLabels), falls man
    // zurückwechselt.
    syncHabitFormFromDom();
    const f = state.habitForm;
    f.displayStyle = 'slider';
    f.labelsEnabled = false;
    render();
    document.getElementById('habit-form-steps')?.focus();
  } else if (action === 'stepper-inc' || action === 'stepper-dec') {
    // Nach Gedrückthalten hat stepperHold schon gezählt und gespeichert - der Klick beim
    // Loslassen darf nicht noch einen Schritt draufsetzen.
    if (stepperHoldSwallowClick) { stepperHoldSwallowClick = false; return; }
    const target = document.getElementById(el.dataset.target);
    if (!target) return;
    stepInput(target, action === 'stepper-inc' ? 1 : -1);
    target.dispatchEvent(new Event('change', { bubbles: true }));
    // Der change-Handler rendert neu und ersetzt dabei den Knopf - Fokus zurück, damit man
    // per Tastatur weiterzählen kann.
    document.querySelector(`[data-action="${action}"][data-target="${el.dataset.target}"]`)?.focus({ preventScroll: true });
  } else if (action === 'habit-save') {
    await handleHabitSave();
  } else if (action === 'habit-archive') {
    await handleHabitArchive(el.dataset.id, true);
  } else if (action === 'habit-reactivate') {
    await handleHabitArchive(el.dataset.id, false);
  } else if (action === 'habit-delete-arm') {
    state.habitDeleteConfirm = el.dataset.id;
    render();
  } else if (action === 'habit-delete-cancel') {
    state.habitDeleteConfirm = null;
    render();
  } else if (action === 'habit-delete') {
    state.habitDeleteConfirm = null;
    await handleHabitDelete(el.dataset.id);
  } else if (action === 'habit-move') {
    // Tastatur-/Klick-Alternative zum Pointer-Drag — liest wie der Drag-Handler die
    // aktuellen Geschwister-Zeilen direkt aus dem DOM (derselbe Container-Scope,
    // row.parentElement.children), damit beide Wege exakt dieselbe Reihenfolge
    // berechnen und über commitLayoutOrder() denselben Persistenz-Pfad nutzen.
    const rowEl = el.closest('.manage-item');
    const rows = [...rowEl.parentElement.children].filter((r) => r.classList.contains('manage-item'));
    const fromIndex = rows.indexOf(rowEl);
    const toIndex = el.dataset.dir === 'up' ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= rows.length) return;
    const reordered = [...rows];
    const [movedEl] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, movedEl);
    await commitLayoutOrder(reordered.map((r) => ({ type: r.dataset.orderType, id: r.dataset.orderId })));
    // Fokus auf denselben Button am neuen Platz (render() hat das DOM ersetzt).
    document.querySelector(`.manage-item[data-order-id="${rowEl.dataset.orderId}"] [data-action="habit-move"][data-dir="${el.dataset.dir}"]`)?.focus();
  } else if (action === 'install-prompt') {
    // Android/Chrome: echter Installations-Dialog statt Anleitung (beforeinstallprompt).
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === 'accepted') appJustInstalled = true;
    render();
  } else if (action === 'install-gate-skip') {
    try { localStorage.setItem('installGateSkipped', 'true'); } catch { /* dann eben nur für diesen Besuch */ }
    installGateSkippedThisVisit = true;
    render();
  } else if (action === 'spam-feedback') {
    // Ohne render(): auf der Passwort-Seite ginge sonst ein schon getipptes Passwort verloren.
    spamFeedbackAnswered = true;
    const box = el.closest('.spam-feedback');
    box.innerHTML = `<p class="spam-feedback-q" role="status" tabindex="-1">${t('spamFeedback.thanks')}</p>`;
    box.querySelector('[role="status"]').focus();
    supabase.rpc('record_signup_mail_feedback', { p_in_spam: el.dataset.inSpam === 'true' })
      .then(() => {}, () => {}); // best effort - eine fehlende Rückmeldung ist kein Problem für den Nutzer
  } else if (action === 'confirm-landing-continue') {
    state.confirmLanding = false;
    render();
  } else if (action === 'tutorial-next') {
    state.tutorialStep = Math.min(TUTORIAL_STEP_REMINDERS, state.tutorialStep + 1);
    render();
  } else if (action === 'tutorial-back') {
    // Gibt neuen Nutzern Vertrauen ("kann ich aus Versehen zu weit geklickt haben?"),
    // obwohl technisch nichts verloren geht — jede Einstellung lässt sich später über
    // Menü/Formular erneut ändern. state.habitForm wird mit geleert, damit beim Zurück
    // von "Geschafft" ein frisches Formular statt des schon gespeicherten erscheint.
    // Schritt 1 hat keinen Zurück-Knopf (davor liegt nichts mehr).
    // Nach "Tutorial überspringen" gibt es noch kein Feld - dann zurück zum Feld-Schritt
    // statt zu "Dein erstes Feld steht". Umgekehrt beim zweiten Feld ("Noch ein Feld
    // anlegen"): zurück zu "Geschafft", wo man herkam, nicht zum Anfang.
    // Von "Geschafft" aus öffnet Zurück das eben angelegte Feld zum Bearbeiten - ein leeres
    // Formular verleitete dazu, das Feld zum "Korrigieren" ein zweites Mal anzulegen.
    const hasField = activeHabits().length > 0;
    const justCreated = state.tutorialStep === TUTORIAL_STEP_DONE
      ? activeHabits().find((h) => h.defId === tutorialLastFieldDefId) : null;
    state.tutorialStep = state.tutorialStep === TUTORIAL_STEP_REMINDERS && !hasField ? TUTORIAL_STEP_FIELD
      : state.tutorialStep === TUTORIAL_STEP_FIELD && hasField ? TUTORIAL_STEP_DONE
      : Math.max(TUTORIAL_STEP_HELLO, state.tutorialStep - 1);
    state.habitForm = justCreated ? { ...habitToForm(justCreated), revealStage: 3 } : null;
    render();
  } else if (action === 'tutorial-add-more') {
    state.tutorialStep = TUTORIAL_STEP_FIELD;
    state.habitForm = { ...defaultHabitForm(), revealStage: 1 };
    render();
    document.getElementById('habit-form-name')?.focus();
  } else if (action === 'tutorial-finish') {
    await saveOnboardingCompleted();
  } else if (action === 'tutorial-skip-arm') {
    modalTriggerSelector = '[data-action="tutorial-skip-arm"]';
    state.tutorialSkipConfirm = true;
    render();
  } else if (action === 'tutorial-skip-cancel') {
    state.tutorialSkipConfirm = false;
    render();
    restoreModalFocus();
  } else if (action === 'tutorial-skip-confirm') {
    // Überspringt nur das Tutorial - die Erinnerungen sind ein eigener Schritt und kommen trotzdem.
    state.tutorialSkipConfirm = false;
    state.habitForm = null; // sonst bliebe das Feld-Formular unsichtbar weiter offen
    state.tutorialStep = TUTORIAL_STEP_REMINDERS;
    render();
  } else if (action === 'clear-input') {
    const id = el.dataset.target;
    if (id === 'email') state.authEmail = '';
    if (id === 'password') state.authPassword = '';
    render();
    document.getElementById(id)?.focus();
  } else if (action === 'toggle-password-visibility') {
    state.authPasswordVisible = !state.authPasswordVisible;
    render();
    const input = document.getElementById('password');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
});

// Ziel-Regler im Feld-Formular: Text beim Ziehen mitführen, ohne render() (Fokus bleibt).
app.addEventListener('input', (e) => {
  const goalSliderEl = e.target.closest?.('[data-action="goal-slider"]');
  if (!goalSliderEl || !state.habitForm) return;
  const { text, span } = goalSliderText(state.habitForm, Number(goalSliderEl.value));
  document.getElementById('habit-form-goal-text').textContent = text;
  const spanEl = document.getElementById('habit-form-goal-span');
  spanEl.textContent = span;
  spanEl.hidden = !span;
  goalSliderEl.setAttribute('aria-valuetext', text + (span ? ' · ' + span : ''));
  const lo = Number(goalSliderEl.min), hi = Number(goalSliderEl.max);
  goalSliderEl.style.setProperty('--slider-pct', ((Number(goalSliderEl.value) - lo) / (hi - lo)) * 100 + '%');
});
app.addEventListener('change', async (e) => {
  state.notice = null; // siehe Kommentar beim 'click'-Listener oben
  if (e.target.id === 'day-date-input') {
    if (!e.target.value) return; // "Löschen" in der Datumsauswahl: Tag bleibt
    // max= hält nicht jeder Browser ein: ein Tag in der Zukunft wird zu heute.
    const picked = isFutureKey(e.target.value) ? startOfDay(new Date()) : parseDateKey(e.target.value);
    if (formatKey(picked) === formatKey(state.currentDate)) return;
    pendingPeriodSlide = picked > state.currentDate ? 1 : -1;
    state.currentDate = picked;
    render();
    const input = document.getElementById('day-date-input');
    if (input && !focusReopensPicker(input)) input.focus({ preventScroll: true });
    return;
  }
  // Berechnetes Feld aus Zahlen: nach jeder Mitglieder-Änderung neu rendern, damit Felder mit anderer
  // Einheit gesperrt bzw. wieder freigegeben werden (siehe computedBody).
  // "Tage seit": anderes Quellfeld -> andere Stufen zur Auswahl.
  if (e.target.id === 'habit-form-since-source' && state.habitForm) {
    syncHabitFormFromDom();
    state.habitForm.sinceValues = [];
    render();
    const select = document.getElementById('habit-form-since-source');
    if (select && !focusReopensPicker(select)) select.focus();
    return;
  }
  const memberBox = e.target.closest?.('[data-member-key]');
  if (memberBox && state.habitForm?.computedType === 'number') {
    syncHabitFormFromDom();
    render();
    document.querySelector(`[data-member-key="${CSS.escape(memberBox.dataset.memberKey)}"]`)?.focus();
    return;
  }
  const archivedStatsToggle = e.target.closest?.('[data-action="archived-stats-toggle"]');
  if (archivedStatsToggle) {
    const habit = state.habits.find((h) => h.defId === archivedStatsToggle.dataset.id);
    if (habit) {
      const id = habit.defId;
      await updateHabitPayload(habit, { archivedInStats: archivedStatsToggle.checked });
      document.querySelector(`[data-action="archived-stats-toggle"][data-id="${id}"]`)?.focus(); // render() hat das DOM ersetzt
    }
    return;
  }
  if (e.target.classList?.contains('text-field-input')) {
    flushDaySave(formatKey(state.currentDate)); // Feld verlassen: nicht erst auf den Timer warten
    return;
  }
  const numberInput = e.target.closest('[data-action="number-input"]');
  if (numberInput) {
    // Speichert beim Verlassen des Feldes (Blur/Tab-Wechsel) statt über einen
    // separaten Button — zuverlässiger als Debounce-nach-Tippen (kein Timer, der bei
    // abruptem Verlassen noch nicht abgelaufen sein könnte).
    handleSaveNumber(formatKey(state.currentDate), numberInput.dataset.habit, numberInput.value);
    return;
  }
  // Von/Bis (Buttons) oder Anzahl Stufen (Schieberegler) geändert - Bezeichnungs-Liste
  // (auch wenn aktuell ausgeblendet, siehe resizeLabels) muss auf die neue Stufenzahl
  // gebracht werden, sonst zeigt die Live-Vorschau/das nächste Aktivieren der
  // Bezeichnungen eine falsche Anzahl Zeilen.
  const rangeEl = e.target.closest('[data-action="habit-range-change"]');
  if (rangeEl && state.habitForm) {
    syncHabitFormFromDom();
    const f = state.habitForm;
    // Deckel greift auch, wenn direkt in die Stufenzahl getippt wird (das max-Attribut
    // des Inputs verhindert das allein nicht zuverlässig, siehe clampHabitFormSteps).
    clampHabitFormSteps(f);
    f.labels = resizeLabels(f.labels, habitFormStepCount(f), f.labelsEnabled ? (i) => String(habitFormStepValue(f, i)) : undefined);
    render();
    return;
  }
  // Stufen ändern: neue Anzahl.
  const stepEditCountEl = e.target.closest('[data-action="step-edit-count"]');
  if (stepEditCountEl && state.habitForm?.stepEdit) {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h) return;
    const steps = Math.round(Number(stepEditCountEl.value));
    stepEditCountChanged(h, f.stepEdit, Number.isFinite(steps) ? Math.min(stepEditCap(h), Math.max(2, steps)) : f.stepEdit.steps);
    render();
    return;
  }
  // Typ ändern: Anzahl Stufen der neuen Skala.
  const typeEditCountEl = e.target.closest('[data-action="type-edit-count"]');
  if (typeEditCountEl && state.habitForm?.typeEdit) {
    syncHabitFormFromDom();
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h) return;
    const steps = Math.round(Number(typeEditCountEl.value));
    typeEditStepsChanged(h, f.typeEdit, Number.isFinite(steps) ? Math.min(SLIDER_STEP_CAP, Math.max(2, steps)) : f.typeEdit.steps);
    render();
    return;
  }
  // Typ ändern: Zuordnung eines alten Werts - wie bei Stufen ändern ohne render().
  const typeMapEl = e.target.closest('[data-type-map]');
  if (typeMapEl && state.habitForm?.typeEdit) {
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h) return;
    if (typeMapEl.tagName === 'SELECT') {
      f.typeEdit.map[typeMapEl.dataset.typeMap] = typeMapEl.value === '' ? null : Number(typeMapEl.value);
      f.typeEdit.preset = 'custom';
      document.querySelectorAll('[data-action="type-edit-preset"]').forEach((b) => {
        b.classList.remove('pill-toggle--active');
        b.setAttribute('aria-pressed', 'false');
      });
    } else {
      f.typeEdit.map[typeMapEl.dataset.typeMap] = typeMapEl.value;
    }
    const summary = document.getElementById('type-edit-summary');
    if (summary) summary.innerHTML = typeEditSummary(h, f.typeEdit);
    return;
  }
  // Stufen ändern: eine alte Stufe zugeordnet - ohne render() (iOS öffnet die Auswahl sonst
  // wieder, siehe focusReopensPicker), nur Zusammenfassung und Vorschlag-Knöpfe nachziehen.
  const stepMapEl = e.target.closest('[data-step-map]');
  if (stepMapEl && state.habitForm?.stepEdit) {
    const f = state.habitForm;
    const h = state.habits.find((x) => x.defId === f.defId);
    if (!h) return;
    f.stepEdit.map[stepMapEl.dataset.stepMap] = stepMapEl.value === '' ? null : Number(stepMapEl.value);
    f.stepEdit.preset = 'custom';
    document.querySelectorAll('[data-action="step-edit-preset"]').forEach((b) => {
      b.classList.remove('pill-toggle--active');
      b.setAttribute('aria-pressed', 'false');
    });
    const summary = document.getElementById('step-edit-summary');
    if (summary) summary.innerHTML = stepEditSummary(h, f.stepEdit);
    return;
  }
  // Nur die Vorschau austauschen statt render() - hält den Fokus auf der Checkbox.
  const showValueEl = e.target.closest('[data-action="habit-slider-show-value"]');
  if (showValueEl && state.habitForm) {
    state.habitForm.sliderShowValue = showValueEl.checked;
    refreshHabitFormPreview();
    return;
  }
  const labelsToggleEl = e.target.closest('[data-action="habit-labels-toggle"]');
  if (labelsToggleEl && state.habitForm) {
    syncHabitFormFromDom();
    const f = state.habitForm;
    f.labelsEnabled = labelsToggleEl.checked;
    clampHabitFormSteps(f);
    // Beim Aktivieren bleiben die Zahlen als Startwert stehen (siehe resizeLabels) -
    // macht sichtbar, dass es weiterhin dieselbe Skala ist, bis man sie überschreibt.
    f.labels = resizeLabels(f.labels, habitFormStepCount(f), f.labelsEnabled ? (i) => String(habitFormStepValue(f, i)) : undefined);
    // Mit eigenen Bezeichnungen sind die Zahlen unsichtbar - intern wieder ab 1 (beim
    // Speichern ohnehin, siehe saveHabitForm); die vorbelegten Texte behalten "0 …".
    if (f.labelsEnabled && !f.locked && f.min !== 1) { f.max = f.max - f.min + 1; f.min = 1; }
    render();
    return;
  }
  const sectionReminderToggle = e.target.closest('[data-action="section-reminder-toggle"]');
  if (sectionReminderToggle && state.sectionForm) {
    readSectionFormFromDom();
    render();
    document.getElementById('section-form-reminder-enabled')?.focus();
    return;
  }
  // Gruppe im Feld-Formular gewechselt: nur den Erinnerungs-Hinweis austauschen (kein
  // render(), der Fokus bleibt auf der Auswahl).
  if (e.target.id === 'habit-form-section' && state.habitForm) {
    state.habitForm.sectionId = e.target.value || null;
    const note = document.getElementById('habit-form-reminder-note');
    if (note) note.innerHTML = habitFormReminderNote(state.habitForm);
    return;
  }
  const reminderToggle = e.target.closest('[data-action="habit-reminder-toggle"]');
  if (reminderToggle && state.habitForm) {
    syncHabitFormFromDom();
    state.habitForm.reminderEnabled = reminderToggle.checked;
    render();
    return;
  }
  const dayProgressToggle = e.target.closest('[data-action="day-progress-toggle"]');
  if (dayProgressToggle) {
    setDayProgressShown(dayProgressToggle.checked);
    render();
    return;
  }
  const patternToggle = e.target.closest('[data-action="pattern-toggle"]');
  if (patternToggle) {
    setPatternDisabled(!patternToggle.checked);
    render();
    return;
  }
  // Kein render() nötig (nichts Sichtbares ändert sich) - so bleibt auch der Fokus auf
  // der Checkbox. Beim Einschalten einmal vibrieren, als direkte Rückmeldung.
  const hapticsToggle = e.target.closest('[data-action="haptics-toggle"]');
  if (hapticsToggle) {
    setHapticsDisabled(!hapticsToggle.checked);
    haptic();
    return;
  }
  const feedbackAnonymous = e.target.closest('[data-action="feedback-anonymous"]');
  if (feedbackAnonymous) {
    state.feedback.anonymous = feedbackAnonymous.checked;
    const note = document.getElementById('feedback-sender-note');
    if (note) note.innerHTML = feedbackSenderNote(feedbackAnonymous.checked);
    return;
  }
  const summaryToggle = e.target.closest('[data-action="summary-notifications-toggle"]');
  if (summaryToggle) {
    saveSummaryNotifications(summaryToggle.checked);
    return;
  }
  const localeEl = e.target.closest('[data-action="menu-locale"]');
  if (localeEl) {
    saveLocale(localeEl.value);
    return;
  }
  const slider = e.target.closest('[data-action="value-slider"], [data-action="preview-slider"]');
  if (slider) {
    // Loslassen/Commit — erst hier wird tatsächlich gespeichert, nicht bei jedem
    // Zwischenwert während des Ziehens.
    commitSliderValue(slider);
  }
});

// Nur beim Wechsel erfüllt/unerfüllt anfassen - sonst läse ein Screenreader (aria-live)
// bei jedem Tastendruck denselben Satz vor.
function syncPasswordCount(id, len) {
  const count = document.getElementById(id);
  const ok = len >= AUTH_MIN_PASSWORD_LENGTH;
  if (count && count.classList.contains('password-count--ok') !== ok) {
    count.textContent = passwordRuleText(len);
    count.classList.toggle('password-count--ok', ok);
  }
}
app.addEventListener('submit', (e) => {
  if (e.target.id === 'password-change-form') { e.preventDefault(); handlePasswordChangeSubmit(); }
  if (e.target.id === 'spare-key-check-form') { e.preventDefault(); handleSpareKeyCheckSubmit(); }
  if (e.target.id === 'email-change-form') { e.preventDefault(); handleEmailChangeSubmit(); }
});

// Hält E-Mail/Passwort im Anmelde-Formular auch über einen Re-Render (z.B. nach
// einem Fehler) hinweg – sonst wäre bei jedem Fehlversuch das ganze Formular leer.
app.addEventListener('input', (e) => {
  if (e.target.id === 'email' && !state.session) { state.authEmail = e.target.value; return; }
  if (e.target.id === 'password' && !state.session) {
    state.authPassword = e.target.value;
    syncPasswordCount('password-count', e.target.value.length);
    return;
  }
  if (e.target.id === 'email-change-input' && state.emailChange) { state.emailChange.value = e.target.value; return; }
  if (e.target.id === 'email-change-password' && state.emailChange) { state.emailChange.password = e.target.value; return; }
  if (e.target.id === 'spare-key-check-input' && state.spareKeyCheck) { state.spareKeyCheck.value = e.target.value; return; }
  if (e.target.id === 'password-change-current' && state.passwordChange) { state.passwordChange.current = e.target.value; return; }
  if (e.target.id === 'password-change-new' && state.passwordChange) {
    state.passwordChange.next = e.target.value;
    syncPasswordCount('password-change-count', e.target.value.length);
    return;
  }
  // Kein render() beim Tippen (würde Fokus/Cursor zurücksetzen) - nur merken, damit
  // der Text einen späteren Re-Render (z.B. Meldung beim Absenden) übersteht.
  if (e.target.id === 'feedback-message') { state.feedback.message = e.target.value; return; }
  if (e.target.id === 'note-input' && state.noteEditor) { state.noteEditor.draft = e.target.value; return; }
  if (e.target.id === 'section-form-name' && state.sectionForm) { state.sectionForm.name = e.target.value; return; }
  if (e.target.classList.contains('text-field-input')) { updateTextValue(formatKey(state.currentDate), e.target.dataset.habit, e.target.value); return; }
  // Bezeichnungen im Feld-Formular: Live-Vorschau mitziehen, ohne das ganze Formular
  // neu zu rendern (würde Fokus/Cursor im gerade bearbeiteten Feld zurücksetzen) - nur
  // die Vorschau selbst wird ausgetauscht (der Fokus liegt dabei ja im Bezeichnungs-Feld).
  const labelInput = e.target.closest('[data-label-index]');
  if (labelInput && state.habitForm?.labelsEnabled) {
    state.habitForm.labels[Number(labelInput.dataset.labelIndex)] = labelInput.value;
    refreshHabitFormPreview();
  }
});

// Live-Vorschau während des Ziehens am Schieberegler — nur DOM-Update, kein
// Re-Render/Speichern (verhindert Ruckeln/Sprünge im Formular während der Eingabe).
// Gilt genauso für den Regler in der Vorschau des Feld-Formulars (preview-slider).
function sliderHabit(slider) {
  return slider.dataset.action === 'preview-slider'
    ? (state.habitForm ? previewHabitFromForm(state.habitForm) : null)
    : state.habits.find((h) => h.id === slider.dataset.habit);
}
function commitSliderValue(slider) {
  if (slider.dataset.action === 'preview-slider') setPreviewValue(Number(slider.value), '.value-slider');
  else handleSetValue(formatKey(state.currentDate), slider.dataset.habit, Number(slider.value));
}
app.addEventListener('input', (e) => {
  const slider = e.target.closest('[data-action="value-slider"], [data-action="preview-slider"]');
  if (!slider) return;
  const habit = sliderHabit(slider);
  if (!habit) return;
  const v = Number(slider.value);
  const pct = ((v - habit.min) / (habit.max - habit.min)) * 100;
  slider.classList.remove('value-slider--unset');
  slider.dataset.dirty = '1'; // siehe pointerup-Listener unten
  slider.style.setProperty('--slider-color', sliderColor(habit, v));
  slider.style.setProperty('--slider-pct', pct + '%');
  slider.setAttribute('aria-valuetext', habitSliderValueText(habit, v));
  const valueEl = document.getElementById('slider-value-' + habit.id);
  if (valueEl) valueEl.textContent = habitSliderValueText(habit, v);
});
// Lücke im nativen 'change'-Event: das feuert beim Loslassen nur, wenn sich der Wert
// seit dem Drücken geändert hat. Ein noch leerer Regler steht aber schon mittig -
// zieht man ihn und lässt ihn genau dort wieder los, sah er durch die Live-Vorschau
// oben eingetragen aus (eingefärbt), gespeichert wurde aber nichts, und das × fehlte.
// Deshalb zusätzlich beim Loslassen selbst speichern, sobald während des Ziehens ein
// 'input' kam (data-dirty). Auf document statt app, da die Maus beim Loslassen schon
// außerhalb des Reglers sein kann; setTimeout, damit ein ggf. danach noch feuerndes
// 'change' nicht doppelt rendert - handleSetValue ist ohnehin idempotent, und hat
// 'change' schon neu gerendert, hängt der alte Regler nicht mehr im DOM.
let sliderPointerTarget = null;
app.addEventListener('pointerdown', (e) => {
  sliderPointerTarget = e.target.closest('[data-action="value-slider"], [data-action="preview-slider"]');
});
document.addEventListener('pointerup', () => {
  const slider = sliderPointerTarget;
  sliderPointerTarget = null;
  if (!slider?.dataset.dirty) return;
  setTimeout(() => {
    if (slider.isConnected) commitSliderValue(slider);
  });
});
// Wird aus dem Anfassen ein Scrollen (touch-action: pan-y, siehe CSS), bricht der Browser
// die Geste ab - einen dabei schon vorläufig angezeigten Wert verwerfen statt speichern.
document.addEventListener('pointercancel', () => {
  const slider = sliderPointerTarget;
  sliderPointerTarget = null;
  if (!slider?.dataset.dirty || !slider.isConnected) return;
  delete slider.dataset.dirty;
  renderUnlessTyping();
});
document.addEventListener('pointercancel', () => { sliderPointerTarget = null; });

// Merkt sich, wenn einer der "Über Logbuch"-Abschnitte zu-/aufgeklappt wird (siehe
// isAboutSectionCollapsed, nur für die Dauer des Besuchs) - reines DOM-natives
// <details>-Verhalten, kein eigener Klick-Handler/Re-Render nötig.
// capture:true, da der native 'toggle'-Event bei <details> in vielen Browsern noch
// nicht bubbled (erst seit jüngeren Chrome/Firefox-Versionen standardisiert) - eine
// normale (bubble-basierte) Delegation auf app hätte hier nie gefeuert. Die
// Capture-Phase läuft dagegen unabhängig vom bubbles-Flag immer von oben nach unten
// durch den ganzen Baum, deshalb funktioniert die Delegation so zuverlässig überall.
app.addEventListener('toggle', (e) => {
  // "Heute nicht geplant": offen/zu übersteht so einen Re-Render (z.B. nach dem
  // Eintragen eines Werts), gilt aber nur für den jeweiligen Tag.
  if (e.target.matches?.('details.unplanned')) {
    state.unplannedOpenFor = e.target.open ? formatKey(state.currentDate) : null;
    return;
  }
  if (e.target.matches?.('details.habit-form-more') && state.habitForm) {
    state.habitForm.moreOpen = e.target.open;
    return;
  }
  const details = e.target.closest('details[data-collapse-key]');
  if (!details) return;
  if (details.open) openAboutSections.add(details.dataset.collapseKey);
  else openAboutSections.delete(details.dataset.collapseKey);
}, true);

// Menü schließen, wenn außerhalb davon geklickt wird.
document.addEventListener('click', (e) => {
  if (!state.menuOpen) return;
  if (e.target.closest('.menu-panel, .menu-btn')) return;
  state.menuOpen = false;
  render();
});
// Dasselbe für das Zeilen-Menü in "Heute" bei Klicks außerhalb von #app (innerhalb
// greift schon der Light-Dismiss-Capture-Listener, siehe "Zeilen-Menü per Long-Press").
document.addEventListener('click', (e) => {
  if (!state.rowMenu) return;
  if (e.target.closest('.row-menu, [data-menu]')) return;
  state.rowMenu = null;
  render();
});

app.addEventListener('keydown', (e) => {
  if (e.target?.dataset?.action === 'number-input' && e.key === 'Enter') {
    e.preventDefault();
    handleSaveNumber(formatKey(state.currentDate), e.target.dataset.habit, e.target.value);
    return;
  }
  if (e.key === 'Escape' && state.rowMenu) {
    closeRowMenu();
    return;
  }
  if (e.key === 'Escape' && state.menuOpen) {
    state.menuOpen = false;
    render();
    document.querySelector('.menu-btn')?.focus();
    return;
  }
  const modalBox = document.querySelector('.modal-box');
  if (modalBox) {
    if (e.key === 'Escape' && modalBox.classList.contains('step-dialog')) {
      closeStepDialog();
      render();
      if (state.leaveFormConfirm) return; // focusModalIfOpen hat den Fokus schon in der Rückfrage
      (document.getElementById('step-dialog-title') || document.querySelector('[data-action="step-edit-open"]'))?.focus();
      return;
    }
    if (e.key === 'Escape') {
      closeModals();
      render();
      restoreModalFocus();
      return;
    }
    // Fokus-Trap: Tab/Shift+Tab bleibt innerhalb des offenen Modals, statt in die
    // dahinterliegende (verdeckte, aber technisch noch im DOM befindliche) Seite
    // weiterzuwandern.
    if (e.key === 'Tab') {
      const focusable = [...modalBox.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  // Generalisierte Tastatur-Aktivierung für per data-action klickbare, aber nicht
  // nativ fokussierbare Elemente (v.a. die Kalenderzellen, die tabindex="0" bekommen
  // haben) — löst denselben echten Klick aus, den die Maus auch auslösen würde, statt
  // die ~60 bestehenden Klick-Aktionen für Tastatur-Nutzung zu duplizieren. Auf
  // tabindex="0" beschränkt, damit z.B. Enter in einem normalen Input (das zufällig in
  // einem [data-action]-Vorfahren sitzt) nicht versehentlich mit-ausgelöst wird.
  if (e.key === 'Enter' || e.key === ' ') {
    const el = e.target.closest('[data-action][tabindex="0"]');
    if (el) {
      e.preventDefault();
      el.click();
    }
  }
});

// Tastatur am Computer: ← → blättern wie Wischen, Strg/⌘+Enter speichert das offene Formular,
// die Notiz bzw. das Feedback. Bewusst keine Kürzel mit einzelnen Buchstaben: Screenreader-
// Nutzer lösten sie beim Lesen aus Versehen aus (WCAG 2.1.4). Auf document statt #app: nach
// einem Neuzeichnen hat nichts den Fokus, die Tasten kommen dann bei <body> an.
const CTRL_ENTER_ACTIONS = ['note-save', 'habit-save', 'section-form-save', 'feedback-submit'];
document.addEventListener('keydown', (e) => {
  if (timePicker || e.defaultPrevented || !state.session || !currentDek) return;
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (!SWIPEABLE_VIEWS.includes(state.view) || state.loading || isOverlayOpen() || document.querySelector('.modal-box')
      || !app.querySelector('.view-body') || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    shiftPeriod(e.key === 'ArrowRight' ? 1 : -1);
    render();
    return;
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !document.querySelector('.modal-box')) {
    const btn = CTRL_ENTER_ACTIONS.map((a) => app.querySelector(`[data-action="${a}"]`)).find((b) => b && !b.disabled && b.getClientRects().length);
    if (!btn) return;
    e.preventDefault();
    btn.click();
  }
});

// --- Swipe-Navigation (Heute/Woche/Monat/Jahr: vorheriger/nächster Zeitraum) --------
let touchStartX = null;
let touchStartY = null;
const SWIPE_THRESHOLD = 50;
// Höher als SWIPE_THRESHOLD: ein Wisch auf einer Unterseite (z.B. "Verwalten") verlässt
// die Seite komplett statt nur den Zeitraum zu wechseln - dort ist "aus Versehen
// ausgelöst" ärgerlicher als bei Heute/Woche/Monat/Jahr, deshalb absichtlich weniger
// empfindlich.
const SWIPE_THRESHOLD_SUBPAGE = 100;
const SWIPEABLE_VIEWS = ['today', 'week', 'month', 'year'];

// Auf Unterseiten (Verwalten/Über Logbuch) ersetzt ein Wisch nach rechts (dieselbe
// Richtung, die in den Tab-Ansichten "vorheriger Zeitraum" bedeutet) den ←-Button -
// gängige Geste für "zurück", passend zum sonstigen Swipe-Vokabular der App.
app.addEventListener('touchstart', (e) => {
  // Ein Wisch, der innerhalb einer eigenen horizontal scrollbaren Zeile beginnt (z.B. die
  // Feld-Buttons, wenn deren Bezeichnungen den Platz sprengen) oder auf dem Schieberegler
  // selbst beginnt (der Drag muss den Wert setzen, nicht den Tag wechseln), soll dort
  // wirken statt die Ansicht zu wechseln. Ebenso in einer Textarea (Notiz-Editor):
  // dort markiert ein waagerechtes Ziehen Text.
  if ((!SWIPEABLE_VIEWS.includes(state.view) && !isSubpageView(state.view)) || e.touches.length !== 1 || e.target.closest('.habit-options, .tabs, .slider-row, textarea')) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

app.addEventListener('touchend', (e) => {
  const subpage = isSubpageView(state.view);
  if (touchStartX === null || (!SWIPEABLE_VIEWS.includes(state.view) && !subpage)) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  touchStartX = null;
  touchStartY = null;
  if (Math.abs(dx) < (subpage ? SWIPE_THRESHOLD_SUBPAGE : SWIPE_THRESHOLD) || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const dir = dx < 0 ? 1 : -1;
  state.rowMenu = null;

  if (subpage) {
    if (dir === -1) { subpageBack(); render(); }
    return;
  }
  shiftPeriod(dir);
  render();
}, { passive: true });

// Vorheriger/nächster Zeitraum der aktuellen Ansicht - gemeinsam für Wischen und die
// ‹ ›-Pfeile. Merkt sich die Richtung für die Rutsch-Animation (renderApp): ohne sie
// änderte sich beim Wischen nur still der Inhalt, und zwei Tage in "Heute" sehen sich oft
// zum Verwechseln ähnlich.
let pendingPeriodSlide = 0;
function shiftPeriod(dir) {
  if (dir > 0 && atCurrentPeriod()) return; // Zukunft gesperrt, siehe isFutureKey
  if (state.view === 'today') {
    state.currentDate = addDays(state.currentDate, dir);
  } else if (state.view === 'week') {
    state.weekAnchor = addDays(state.weekAnchor, dir * 7);
  } else if (state.view === 'month') {
    const d = new Date(state.monthAnchor);
    d.setMonth(d.getMonth() + dir);
    state.monthAnchor = d;
  } else if (state.view === 'year') {
    state.yearAnchor += dir;
  } else {
    return;
  }
  pendingPeriodSlide = dir;
}

// --- Zeilen-Menü per Long-Press/Rechtsklick (Heute) ------------------------
// Reine Abkürzung zum ⋮-Button (siehe renderRowMenuButton), nie der einzige Weg - auf
// Feld-Zeilen und Gruppen-Überschriften (dort statt des Auf-/Zuklappens). Touch/Stift über einen eigenen Timer (iOS Safari feuert beim Long-Press kein
// 'contextmenu'), Maus über den Rechtsklick ('contextmenu'). Ausgenommen sind alle
// Stellen, an denen Gedrückthalten schon etwas anderes bedeutet: Eingabefelder
// (Einfügen/Cursor setzen), der Schieberegler (Halten = Ziehen beginnen) und das Menü
// selbst. Der Feldname ist bewusst NICHT ausgenommen - Android macht aus einem langen
// Drücken keinen Klick mehr, ohne Long-Press-Behandlung passierte dort sonst gar nichts.
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;
let longPress = null;
let lastPointerType = 'mouse';
// Nach einem Long-Press auf einen Wert-Button würde das Loslassen zusätzlich einen
// normalen Klick auslösen und damit ungewollt den Wert setzen - der erste Klick nach
// dem Öffnen wird deshalb verschluckt (Capture-Listener unten). Bei jedem neuen
// pointerdown zurückgesetzt, falls der Klick ausnahmsweise gar nicht kommt - sonst
// würde stattdessen der nächste echte Klick verschluckt.
let suppressNextClick = false;

function rowMenuKeyAt(target) {
  if (state.view !== 'today' || target.closest('input, textarea, select, .slider-row, .row-menu, .note-editor')) return null;
  return target.closest('.habit-row, .number-box, .section-head')?.querySelector('.row-menu-trigger')?.dataset.menu ?? null;
}
function cancelLongPress() {
  if (!longPress) return;
  clearTimeout(longPress.timer);
  longPress = null;
}

app.addEventListener('pointerdown', (e) => {
  suppressNextClick = false;
  lastPointerType = e.pointerType;
  cancelLongPress();
  if (e.pointerType === 'mouse') return;
  const menuKey = rowMenuKeyAt(e.target);
  if (!menuKey) return;
  longPress = {
    pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
    timer: setTimeout(() => {
      longPress = null;
      suppressNextClick = true;
      haptic();
      openRowMenu(menuKey);
    }, LONG_PRESS_MS),
  };
});
app.addEventListener('pointermove', (e) => {
  if (!longPress || e.pointerId !== longPress.pointerId) return;
  if (Math.hypot(e.clientX - longPress.startX, e.clientY - longPress.startY) > LONG_PRESS_MOVE_TOLERANCE) cancelLongPress();
});
// pointercancel: der Browser übernimmt die Geste selbst (z.B. Scrollen der Seite).
app.addEventListener('pointerup', cancelLongPress);
app.addEventListener('pointercancel', cancelLongPress);

app.addEventListener('click', (e) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  // Light-Dismiss: bei offenem Zeilen-Menü schließt ein Tipp irgendwo außerhalb nur das
  // Menü und löst sonst nichts aus - weder direkt das Menü eines anderen Feldes noch z.B.
  // einen Wert, wenn man eigentlich nur das Menü loswerden wollte. Ausnahmen: das Menü
  // selbst und der eigene Auslöser (⋮ bzw. Feldname, normales Zuklappen). Nur für Zeige-Geräte
  // (e.detail > 0): per Tastatur ausgelöste Klicks (detail 0) sind nach einem bewussten
  // Wegnavigieren gemeint und laufen normal durch - die schließen das Menü dann über den
  // Klick-Handler (state.rowMenu = null bei jeder anderen Aktion).
  if (state.rowMenu && e.detail > 0
      && !e.target.closest(`.row-menu, [data-menu="${state.rowMenu}"]`)) {
    e.stopPropagation();
    e.preventDefault();
    closeRowMenu();
  }
}, true);

// Rechtsklick mit der Maus - und auf Android, wo der Long-Press zusätzlich ein
// 'contextmenu' feuert (je nach Gerät vor oder nach dem eigenen Timer), damit dort
// weder das Browser-Kontextmenü erscheint noch das Menü doppelt geöffnet wird.
app.addEventListener('contextmenu', (e) => {
  const menuKey = rowMenuKeyAt(e.target);
  if (!menuKey) return;
  e.preventDefault();
  if (lastPointerType !== 'mouse') {
    cancelLongPress();
    suppressNextClick = true;
  }
  if (state.rowMenu !== menuKey) openRowMenu(menuKey);
});

// --- Felder-Reihenfolge per Drag (Tab "Felder") ---------------------------
// Während des Ziehens wird NIE render() aufgerufen (das würde den gesamten #app-Inhalt
// ersetzen und damit die Pointer-Capture/laufende Geste kaputtmachen) — stattdessen nur
// direkte Style-Änderungen an den vorhandenen Zeilen. Erst beim Loslassen wird die neue
// Reihenfolge in state.habits übernommen, gespeichert und einmal sauber neu gerendert.
let dragState = null;
// "Scharfschalt"-Phase vor dem eigentlichen Drag: ein schneller Scroll-Wisch, der
// zufällig über dem schmalen Drag-Handle beginnt, soll NICHT sofort die Reihenfolge
// durcheinanderbringen. Erst nach kurzem, ruhigem Halten (ohne nennenswerte Bewegung)
// wird tatsächlich gezogen – ein normaler Scroll-Wisch bricht das vorher ab.
let dragArm = null;
const DRAG_ARM_DELAY_MS = 150;
// 16 statt vorher 10: ein aufsetzender Finger wackelt leicht, mit 10px brach das
// Greifen oft ab und man musste 2-3 Mal ansetzen.
const DRAG_ARM_MOVE_TOLERANCE = 16;

app.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-action="drag-handle"]');
  if (!handle) return;
  // Gezogen wird ein .manage-item: ein Feld oder (auf oberster Ebene) eine ganze Gruppe
  // als Block - innerhalb ihres Behälters (oberste Ebene bzw. Felder einer Gruppe).
  const row = handle.closest('.manage-item');
  const rows = [...row.parentElement.children].filter((r) => r.classList.contains('manage-item'));
  const fromIndex = rows.indexOf(row);

  dragArm = { pointerId: e.pointerId, row, rows, fromIndex, startY: e.clientY, startX: e.clientX };
  dragArm.timer = setTimeout(() => {
    if (!dragArm) return;
    const armed = dragArm;
    dragArm = null;
    // Elemente sind unterschiedlich hoch (ein Gruppen-Block vs. eine Feld-Zeile) - deshalb
    // die Original-Positionen aller Geschwister merken statt einer einheitlichen
    // Zeilenhöhe. slot = Platz, den das gezogene Element samt Abstand einnimmt; um genau
    // den rücken die übersprungenen Geschwister auf.
    // Eine Gruppe wird beim Ziehen auf ihre Kopfzeile zusammengeklappt - ein großer Block
    // ist sonst sperrig. Vor dem Messen, da sich dadurch alle Positionen verschieben; der
    // Griff sitzt in der Kopfzeile und bleibt dabei unter dem Finger.
    if (armed.row.classList.contains('manage-section')) armed.row.classList.add('manage-section--drag-collapsed');
    const rects = armed.rows.map((r) => r.getBoundingClientRect());
    const tops = rects.map((rc) => rc.top + window.scrollY);
    const heights = rects.map((rc) => rc.height);
    const i = armed.fromIndex;
    const slot = i < armed.rows.length - 1 ? tops[i + 1] - tops[i] : i > 0 ? tops[i] + heights[i] - (tops[i - 1] + heights[i - 1]) : heights[i];
    dragState = { pointerId: armed.pointerId, row: armed.row, rows: armed.rows, fromIndex: i, toIndex: i, startY: armed.startY, startScrollY: window.scrollY, lastClientY: armed.startY, tops, heights, slot };
    dragState.row.setPointerCapture(dragState.pointerId);
    dragState.row.classList.add('manage-row--dragging');
    haptic(); // spürbare Rückmeldung, dass das Feld jetzt "in der Hand" ist
  }, DRAG_ARM_DELAY_MS);
});

app.addEventListener('pointermove', (e) => {
  if (dragArm && e.pointerId === dragArm.pointerId) {
    const dx = e.clientX - dragArm.startX;
    const dy = e.clientY - dragArm.startY;
    if (Math.hypot(dx, dy) > DRAG_ARM_MOVE_TOLERANCE) {
      clearTimeout(dragArm.timer);
      dragArm = null;
    }
    return;
  }
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  dragState.lastClientY = e.clientY;
  updateDragPosition();
  updateDragAutoScroll();
});

// Position der gezogenen Zeile + Verschieben der übrigen. Rechnet die inzwischen
// gescrollte Strecke mit ein (scrollY - startScrollY), da die Seite beim Ziehen am Rand
// von selbst weiterscrollt (siehe updateDragAutoScroll) - sonst bliebe die Zeile beim
// Scrollen nicht unter dem Finger.
function updateDragPosition() {
  // Auf die Liste begrenzt: weiter als bis zum ersten/letzten Platz lässt sich die Zeile
  // nicht ziehen (vorher schoss sie beliebig weit darüber hinaus und sprang erst beim
  // Loslassen zurück).
  const { tops, heights, fromIndex: from, rows } = dragState;
  const last = rows.length - 1;
  const minDelta = tops[0] - tops[from];
  const maxDelta = tops[last] + heights[last] - (tops[from] + heights[from]);
  const rawDelta = dragState.lastClientY - dragState.startY + (window.scrollY - dragState.startScrollY);
  const deltaY = Math.max(minDelta, Math.min(maxDelta, rawDelta));
  dragState.row.style.transform = `translateY(${deltaY}px)`;

  // Zielplatz über die in Zugrichtung vorne liegende Kante: nach unten zählt die
  // Unterkante, nach oben die Oberkante - sobald sie die Mitte eines Geschwisters
  // überquert, tauschen beide. Nicht die Mitte des gezogenen Elements: bei einem großen
  // Block (Gruppe) kam die wegen der Begrenzung auf die Liste nie an der Mitte des
  // letzten/ersten kleinen Elements vorbei, er blieb einen Platz zu früh hängen.
  const dragTop = tops[from] + deltaY;
  const dragBottom = dragTop + heights[from];
  let toIndex = from;
  if (deltaY > 0) {
    for (let i = from + 1; i < rows.length; i++) if (dragBottom > tops[i] + heights[i] / 2) toIndex = i;
  } else if (deltaY < 0) {
    for (let i = from - 1; i >= 0; i--) if (dragTop < tops[i] + heights[i] / 2) toIndex = i;
  }
  if (toIndex === dragState.toIndex) return;
  dragState.toIndex = toIndex;
  rows.forEach((r, i) => {
    if (r === dragState.row) return;
    let shift = 0;
    if (toIndex > from && i > from && i <= toIndex) shift = -dragState.slot;
    else if (toIndex < from && i < from && i >= toIndex) shift = dragState.slot;
    r.style.transition = 'transform 150ms ease';
    r.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

// Automatisches Scrollen, solange man die Zeile nahe an den oberen (unter dem
// angepinnten Seitenkopf) oder unteren Bildschirmrand hält - sonst ließ sich ein Feld
// nur in Etappen weit nach oben/unten verschieben. Je näher am Rand, desto schneller.
// Läuft per requestAnimationFrame, damit es auch weiterscrollt, wenn der Finger still
// am Rand steht (dann kommen keine pointermove-Events).
const DRAG_SCROLL_ZONE = 90;
const DRAG_SCROLL_MAX_SPEED = 10; // px pro Frame
let dragScrollFrame = null;
function dragScrollSpeed() {
  const top = stickyHeaderBottom();
  const bottom = window.visualViewport?.height ?? window.innerHeight;
  const y = dragState.lastClientY;
  if (y < top + DRAG_SCROLL_ZONE) return -DRAG_SCROLL_MAX_SPEED * Math.min(1, (top + DRAG_SCROLL_ZONE - y) / DRAG_SCROLL_ZONE);
  if (y > bottom - DRAG_SCROLL_ZONE) return DRAG_SCROLL_MAX_SPEED * Math.min(1, (y - (bottom - DRAG_SCROLL_ZONE)) / DRAG_SCROLL_ZONE);
  return 0;
}
function updateDragAutoScroll() {
  if (dragScrollFrame !== null) return;
  const step = () => {
    dragScrollFrame = null;
    if (!dragState) return;
    const speed = dragScrollSpeed();
    if (!speed) return;
    // Nicht über die Liste hinaus scrollen - ist ihr Ende bzw. Anfang schon im Bild,
    // gibt es in der Richtung keinen Platz mehr, zu dem man ziehen könnte.
    const list = dragState.row.parentElement.getBoundingClientRect();
    const top = stickyHeaderBottom();
    const bottom = window.visualViewport?.height ?? window.innerHeight;
    if ((speed > 0 && list.bottom <= bottom) || (speed < 0 && list.top >= top)) return;
    const before = window.scrollY;
    window.scrollBy(0, speed);
    if (window.scrollY === before) return; // Anfang/Ende der Seite erreicht
    updateDragPosition();
    dragScrollFrame = requestAnimationFrame(step);
  };
  dragScrollFrame = requestAnimationFrame(step);
}
function stopDragAutoScroll() {
  if (dragScrollFrame !== null) cancelAnimationFrame(dragScrollFrame);
  dragScrollFrame = null;
}

app.addEventListener('pointerup', async (e) => {
  if (dragArm && e.pointerId === dragArm.pointerId) {
    clearTimeout(dragArm.timer);
    dragArm = null;
    return;
  }
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  stopDragAutoScroll();
  const { row, rows, fromIndex, toIndex } = dragState;
  row.releasePointerCapture(e.pointerId);
  row.classList.remove('manage-row--dragging', 'manage-section--drag-collapsed');
  rows.forEach((r) => { r.style.transform = ''; r.style.transition = ''; });
  dragState = null;
  if (toIndex === fromIndex) return;

  const reordered = [...rows];
  const [movedEl] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, movedEl);
  await commitLayoutOrder(reordered.map((r) => ({ type: r.dataset.orderType, id: r.dataset.orderId })));
});

// --- Deep-Links aus Push-Benachrichtigungen --------------------------------
// Jede Benachrichtigung trägt ihr Ziel als URL-Parameter (?view=week&date=YYYY-MM-DD,
// siehe send-notifications) - date ist der Tag, auf den sie sich bezieht, damit ein
// späterer Klick (z.B. Wochenübersicht erst Montagmorgen geöffnet) trotzdem den
// gemeinten Zeitraum zeigt statt den dann aktuellen. Zwei Wege hier an: beim
// Kaltstart über location.search, bei schon offener App per postMessage vom Service
// Worker (sw.js, notificationclick) - dort bewusst kein Neuladen, das würde ggf. ein
// erneutes Entsperren des Schlüssels erzwingen. Setzt nur Ansicht + Zeitraum, das
// funktioniert unabhängig davon, ob die App gerade noch gesperrt ist.
// "In Chrome öffnen" aus einem anderen Browser (otherBrowserBox) kommt mit ?onb=<Modus>:
// Chrome hat einen eigenen Speicher - ohne das begänne das Einrichten wieder auf der
// Startseite. Steht hier, nach den let-Deklarationen, die setOnbInProgress braucht.
(() => {
  const mode = new URLSearchParams(location.search).get('onb');
  if (!['guided', 'short'].includes(mode)) return;
  history.replaceState(history.state, '', location.pathname + location.hash);
  if (signedInHereBefore() || isStandaloneDisplay()) return;
  setOnbMode(mode);
  setOnbInProgress(true);
  rememberOnbIncludesInstall();
  state.authMode = 'signup';
})();
const DEEP_LINK_VIEWS = ['today', 'week', 'month', 'year'];
function parseDeepLink(search) {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  if (!DEEP_LINK_VIEWS.includes(view)) return null;
  const dateParam = params.get('date');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam ?? '') ? parseDateKey(dateParam) : null;
  // field: Feld-ID bei Erinnerungen an ein bestimmtes Feld - "Heute" scrollt dann dorthin.
  const fieldParam = params.get('field');
  const field = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fieldParam ?? '') ? fieldParam : null;
  return { view, date: date && !isNaN(date) ? date : startOfDay(new Date()), field };
}
// Feld-ID aus einem Deep-Link, zu der gescrollt werden soll, sobald "Heute" mit geladenen
// Feldern wirklich angezeigt wird - beim Kaltstart kann davor noch Entsperren/Laden liegen,
// deshalb von render() aus eingelöst statt direkt beim Öffnen des Links.
let pendingFieldFocus = null;
function consumePendingFieldFocus() {
  if (!pendingFieldFocus || !state.session || !currentDek || state.loading || state.passwordRecovery
      || state.recoveryKeyToShow || !state.userSettings.onboardingCompleted || state.view !== 'today') return;
  const habit = state.habits.find((h) => h.defId === pendingFieldFocus);
  pendingFieldFocus = null;
  if (habit && !habit.archivedAt) focusTodayField(habit.id, { editInput: true });
}
function applyDeepLink({ view, date, field }) {
  pendingFieldFocus = view === 'today' ? field : null;
  state.view = view;
  state.currentDate = startOfDay(date);
  state.weekAnchor = startOfWeek(date);
  const monthStart = startOfDay(date);
  monthStart.setDate(1);
  state.monthAnchor = monthStart;
  state.yearAnchor = date.getFullYear();
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'logbuch-navigate') return;
    const link = parseDeepLink(new URL(e.data.url, location.href).search);
    if (!link) return;
    applyDeepLink(link);
    // Offene Overlays schließen, sonst läge das Ziel unsichtbar darunter. Während des
    // Tutorials nichts anfassen (dort ist state.habitForm Teil des geführten Ablaufs) -
    // die gesetzte Ansicht greift dann einfach nach dessen Abschluss.
    if (state.userSettings.onboardingCompleted) {
      state.menuOpen = false;
      state.rowMenu = null;
      state.habitForm = null;
      state.habitDeleteConfirm = null;
      state.sectionForm = null;
      if (state.deleteConfirm || state.passwordChange || state.spareKeyCheck || state.emailChange || state.resetConfirm || state.regenKeyConfirm || state.logoutConfirm) { closeModals(); modalTriggerSelector = null; }
    }
    window.scrollTo(0, 0); // vor render() - das scrollt ggf. danach zum Feld (consumePendingFieldFocus)
    render();
  });
}

// --- Auth-Status & Start ---------------------------------------------------
// authFlowInFlight: von den Login/Signup-Submit-Handlern VOR dem signUp/
// signInWithPassword-Aufruf gesetzt (nicht erst danach — onAuthStateChange kann schon
// in der Lücke dazwischen feuern) und erst nach completeAuthFlow() wieder gelöscht.
// Solange gesetzt, überlässt onAuthStateChange dem Submit-Handler komplett das
// Entsperren + Laden (dort ist das Passwort im Klartext verfügbar) — sonst würde
// onAuthStateChange parallel einen zweiten, redundanten Cache-Entsperr-Versuch
// starten und dabei ggf. kurz den Passwort-Abfrage-Screen aufblitzen lassen, obwohl
// das Passwort gerade eben schon eingegeben wurde.
let authFlowInFlight = false;

async function completeAuthFlow(userId, password, { verifyPassword = false } = {}) {
  accountGoneHandled = false;
  await unlockEncryption(userId, password, { verifyPassword });
  state.loading = true;
  render();
  await Promise.all([loadEntries(), loadHabits(), loadUserSettings(), loadSections(), loadFeatureAccess()]);
  state.loading = false;
  saveFieldNamesForPush(); // erst nach loadUserSettings - die Textvorlage hängt an der Sprache
  repadOldEntries();
  resumeStepChanges();
  checkPushStatus().then(render);
  render();
  maybeShowSpareKey();
}

supabase.auth.onAuthStateChange(async (event, session) => {
  state.session = session;
  if (session) rememberSignedInHere();
  state.authError = null;
  if (event === 'PASSWORD_RECOVERY') {
    state.passwordRecovery = true;
    render();
    return;
  }
  if (authFlowInFlight) { render(); return; }
  if (session) {
    // Schon entsperrt und dasselbe Konto: z.B. die stündliche Token-Erneuerung oder die
    // Rückkehr in die App - sichtbar ändert sich nichts. Bewusst KEIN render(): der würde
    // die ganze Ansicht neu aufbauen und dabei Getipptes, aber noch nicht Gespeichertes
    // (z.B. den Namen im Feld-Formular) verwerfen.
    if (currentDek && currentDekUserId === session.user.id) return;
    // Schlüssel eines ANDEREN Kontos geladen (z.B. in einem anderen Tab umgemeldet):
    // alles davon verwerfen, sonst würde mit fremdem Schlüssel unter diesem Konto
    // gespeichert.
    if (currentDek) clearLoadedAccountState();
    // Kein Passwort verfügbar (Session-Wiederherstellung, z.B. Browser-Reload) - nur
    // der lokale Cache kann hier helfen, sonst muss renderUnlockPrompt() greifen.
    state.loading = true;
    sessionRestoreInFlight = true;
    render();
    // Ohne Verbindung lässt sich der Cache nicht gegen die aktuelle Kennung prüfen -
    // dann lieber das Passwort abfragen als womöglich mit einem veralteten Schlüssel
    // zu speichern (laden ließe sich ohne Verbindung ohnehin nichts).
    let cached = null;
    let row = null;
    try {
      try {
        row = await fetchEncryptionRow(session.user.id);
        const result = await usableCachedDek(session.user.id, row);
        cached = result.dek;
        if (result.stale) state.unlockError = t('unlock.keyChanged');
      } catch { /* -> renderUnlockPrompt */ }
      if (cached) {
        setCurrentDek(cached, row.dek_id, session.user.id);
        spareKeyPending = !row.recovery_key_confirmed;
        await Promise.all([loadEntries(), loadHabits(), loadUserSettings(), loadSections(), loadFeatureAccess()]);
        saveFieldNamesForPush(); // siehe completeAuthFlow
        repadOldEntries();
        resumeStepChanges();
        checkPushStatus().then(render);
      }
    } finally {
      // Auch bei einem unerwarteten Fehler, sonst bliebe der Startbildschirm für immer stehen.
      state.loading = false;
      sessionRestoreInFlight = false;
    }
    maybeShowSpareKey();
  } else {
    clearLoadedAccountState();
  }
  render();
});

// Verwirft alles aus dem Konto Geladene samt Schlüssel - beim Abmelden und bei einem
// veralteten Schlüssel (checkDekStillCurrent). Auch offene Formulare, Entwürfe, Dialoge
// und die zuletzt offene Unterseite gehören zum Konto - sonst sähe sie, wer sich danach
// auf demselben Gerät anmeldet (z.B. einen Feldnamen im offenen Feld-Formular).
function clearLoadedAccountState() {
  state.entries = {};
  state.habits = [];
  state.unsupportedHabits = [];
  state.noteEditor = null;
  state.rowMenu = null;
  state.resetConfirm = null;
  state.sections = [];
  state.sectionForm = null;
  state.sectionDeleteConfirm = null;
  state.habitForm = null;
  state.habitFormSaving = false;
  state.habitDeleteConfirm = null;
  state.deleteConfirm = null;
  state.passwordChange = null;
  state.spareKeyCheck = null;
  state.emailChange = null;
  state.regenKeyConfirm = false;
  state.logoutConfirm = false;
  state.menuOpen = false;
  state.recoveryKeyToShow = null;
  state.unplannedOpenFor = null;
  state.feedback = { message: '', anonymous: false, busy: false };
  state.view = 'today';
  state.previousTabView = 'today';
  undecryptableEntryDates = new Set();
  syncedEntries.clear();
  clearCurrentDek();
  spareKeyPending = false;
  state.unlockError = null;
  state.tutorialStep = null;
  state.tutorialSkipConfirm = false;
}

// Verhindert versehentliches Verlassen/Reload mitten im geführten Feld-Anlegen
// (Tutorial Schritt 3 mit offenem Formular, siehe CLAUDE.md).
window.addEventListener('beforeunload', (e) => {
  if (state.tutorialStep === TUTORIAL_STEP_FIELD && state.habitForm) { e.preventDefault(); e.returnValue = ''; }
});

resetIOSZoomOnStandaloneStart();
state.confirmLanding = ARRIVED_VIA_SIGNUP_CONFIRM && isMobileDevice() && !isStandaloneDisplay() && !isInstallGateSkipped();
applyLocale(detectInitialLocale());
applyTheme(getThemeOverride());
if (ARRIVED_VIA_EMAIL_CHANGE) state.notice = { type: 'ok', text: t('emailChange.landedDone') };
if (MAIL_LINK_ERROR) {
  state.notice = { type: 'error', text: t(MAIL_LINK_ERROR === 'otp_expired' ? 'mailLink.expired' : 'mailLink.failed') };
  // Sonst käme die Meldung bei jedem Neuladen wieder.
  history.replaceState(history.state, '', location.pathname + location.search);
}
applyTextSize(getTextSize());
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!getThemeOverride()) applyTheme(null); // nur relevant, wenn "System" aktiv ist
  });
} catch { /* z.B. sehr alter Browser ohne addEventListener auf MediaQueryList */ }

const initialDeepLink = parseDeepLink(location.search);
if (initialDeepLink) {
  applyDeepLink(initialDeepLink);
  // Parameter wieder entfernen, sonst spränge ein späteres Neuladen erneut dorthin.
  history.replaceState(history.state, '', location.pathname + location.hash);
}

const { data: { session } } = await supabase.auth.getSession();
state.session = session;
state.loading = false;
render();
