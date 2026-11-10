import { supabase } from './config.js?v=90bbeaa075';
import { PBKDF2_ITERATIONS, base64ToBuf, bufToBase64, bufToHex, cacheDek, clearCachedDek, deriveKek, encryptData, generateDek, generateRecoveryKeyBytes, hexToBuf, importRecoveryKeyAsCryptoKey, loadCachedDek, unwrapDek, wrapDek } from './crypto.js?v=90bbeaa075';
import { invalidateTodayAutoCollapse, saveFieldNamesForPush } from './fields.js?v=90bbeaa075';
import { formatKey, parseDateKey, startOfDay, startOfWeek } from './dates.js?v=90bbeaa075';
import { currentDek, currentDekId, restoreModalFocus, runtime, setCurrentDek, state } from './state.js?v=90bbeaa075';
import { currentLocale, detectInitialLocale, t } from './i18n.js?v=90bbeaa075';
import { errorNotice, translateAuthError, translateDbError } from './format.js?v=90bbeaa075';
import { loadEntries, loadHabits, loadSections } from './data.js?v=90bbeaa075';
import { dropPendingDaySaves, renderUnlessTyping } from './save.js?v=90bbeaa075';
import { isOnbInProgress, setOnbInProgress } from './auth-view.js?v=90bbeaa075';
import { setTodayIntroPending } from './row-view.js?v=90bbeaa075';
import { render } from './main-view.js?v=90bbeaa075';
import { clearLoadedAccountState } from './session.js?v=90bbeaa075';

// --- Verschlüsselungs-Lebenszyklus -------------------------------------------
export async function fetchEncryptionRow(userId) {
  const { data, error } = await supabase.from('user_encryption').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function unwrapDekWithPassword(row, password) {
  const kek = await deriveKek(password, base64ToBuf(row.salt), row.kdf_iterations);
  return unwrapDek(row.wrapped_dek, row.wrap_iv, kek);
}

export async function unwrapDekWithRecoveryKey(row, recoveryKeyHex) {
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
export async function setupEncryption(userId, password, { replace = false } = {}) {
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
  runtime.spareKeyPending = true;
}

// Der lokal gecachte DEK, sofern er noch der aktuelle des Kontos ist (row = dessen
// user_encryption-Zeile). Nach einem Passwort-Reset ohne Recovery-Key hat das Konto einen
// neuen DEK - ein Gerät mit altem Cache würde sonst weiter mit dem alten Schlüssel
// speichern, und alle übrigen Geräte könnten diese Einträge nicht lesen. Ein veralteter
// Cache wird deshalb gelöscht (stale: true, dann muss das Passwort her). Caches von vor
// der Kennung (dekId null) werden einmalig übernommen und bekommen sie nachgetragen
// (Nutzer-Entscheidung: kein erneutes Passwort für alle nach dem Update).
export async function usableCachedDek(userId, row) {
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
export async function unlockEncryption(userId, password, { verifyPassword = false } = {}) {
  const row = await fetchEncryptionRow(userId);
  const { dek: cached } = await usableCachedDek(userId, row);
  if (cached) { setCurrentDek(cached, row.dek_id, userId); runtime.spareKeyPending = !row.recovery_key_confirmed; return; }

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
  runtime.spareKeyPending = !row.recovery_key_confirmed;
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

export async function handleEmailChangeSubmit() {
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

export async function handleSpareKeyCheckSubmit() {
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

export async function handlePasswordChangeSubmit() {
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
export function unlockErrorText(err) {
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
  if (!currentDek || !currentDekId || !state.session || runtime.authFlowInFlight) return;
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
  if (!currentDek || !state.session || runtime.authFlowInFlight || state.loading || isEditingSomething()) return;
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
export async function regenerateRecoveryKey({ onlyIfUnconfirmed = false } = {}) {
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
  if (!data.length) { runtime.spareKeyPending = false; return; } // schon anderswo bestätigt
  runtime.spareKeyPending = true;
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
export async function maybeShowSpareKey() {
  if (!runtime.spareKeyPending || spareKeyInFlight || !currentDek || !state.session
    || state.recoveryKeyToShow || state.loading || !state.userSettings.onboardingCompleted) return;
  spareKeyInFlight = true;
  try { await regenerateRecoveryKey({ onlyIfUnconfirmed: true }); } finally { spareKeyInFlight = false; }
}
// Bestätigt nur, wenn in der Datenbank noch genau der angezeigte Schlüssel steht. Hat ein
// anderes Gerät ihn inzwischen ersetzt (dort ebenfalls angezeigt oder im Menü neu
// erzeugt), wäre der hier gezeigte ungültig - dann erklären und einen neuen zeigen, statt
// ihn als gesichert zu markieren.
export async function confirmSpareKey() {
  const shown = state.recoveryKeyToShow;
  state.recoveryKeyToShow = null;
  render();
  if (!runtime.spareKeyPending || !state.session || !shown) return;
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
  runtime.spareKeyPending = false;
  const finishedOnboarding = isOnbInProgress();
  setOnbInProgress(false); // Einrichten abgeschlossen
  if (finishedOnboarding) {
    setTodayIntroPending(true); // danach einmal die Karte(n) in "Heute"
    render();
  }
}

// Was beim Start einmal laufen muss (Event-Listener u.ä.). Nicht beim Laden des Moduls, sondern
// vom Einstieg (logbuch.js) aufgerufen, in fester Reihenfolge, wenn alle Module geladen sind.
export function initKeys() {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { hiddenSince = Date.now(); return; }
    const awayMs = hiddenSince ? Date.now() - hiddenSince : 0;
    hiddenSince = null;
    await checkDekStillCurrent();
    const rolledOver = rollOverToNewDay();
    if (awayMs >= RETURN_REFRESH_AFTER_MS) await refreshAfterReturn();
    else if (rolledOver && !isEditingSomething()) renderUnlessTyping();
  });
}
