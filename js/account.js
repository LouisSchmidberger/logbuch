import { supabase } from './config.js?v=8aaa0e5b67';
import { clearCachedDek, decryptData } from './crypto.js?v=8aaa0e5b67';
import { formatKey } from './dates.js?v=8aaa0e5b67';
import { clearCurrentDek, currentDek, runtime, state } from './state.js?v=8aaa0e5b67';
import { t, tPlain } from './i18n.js?v=8aaa0e5b67';
import { errorNotice } from './format.js?v=8aaa0e5b67';
import { accessGroup, fetchAllRows } from './data.js?v=8aaa0e5b67';
import { endPushForThisDevice } from './device.js?v=8aaa0e5b67';
import { render } from './main-view.js?v=8aaa0e5b67';

// --- Datenexport (Auskunftsrecht/Datenportabilität) -------------------------
// Exportiert die eigenen Rohdaten (nicht das App-interne, transformierte Modell) direkt
// aus dem Browser — RLS scoped die Abfragen automatisch auf den eigenen user_id, kein
// Server-Roundtrip über eine eigene Function nötig.
export async function handleExportData() {
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

  // Feld-Definitionen ebenso: der ganze entschlüsselte Inhalt von enc statt des Chiffretexts.
  // Bewusst alles statt einer Auswahl - eine Auswahl vergaß neue Eigenschaften (z.B. die
  // Antworten von "Mehrere ankreuzen", ohne die deren Einträge im Export unlesbar waren).
  const decryptedDefs = await Promise.all(
    defsRes.data.map(async (row) => {
      if (!row.enc) return row;
      const { enc, ...rest } = row;
      try {
        const { key, ...props } = await decryptData(currentDek, enc);
        return { ...rest, slug: key, ...props };
      } catch {
        return { ...rest, decrypt_error: true };
      }
    })
  );

  const exportObj = {
    exported_at: new Date().toISOString(),
    habit_definitions: decryptedDefs,
    habit_sections: await Promise.all(sectionsRes.data.map(async ({ enc, ...rest }) => {
      try { return { ...rest, ...(await decryptData(currentDek, enc)) }; } catch { return { ...rest, decrypt_error: true }; }
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
  runtime.onbModeThisVisit = null;
  runtime.onbInProgressThisVisit = false;
  runtime.installGateSkippedThisVisit = false;
}

export async function handleDeleteAccount() {
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
export const SIGNUP_MIN_FILL_MS = 1500;
