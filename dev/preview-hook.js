// Werkzeuge der lokalen Vorschau im Browser (siehe dev/README.md). Der Vorschau-Server
// hängt an das ausgelieferte logbuch.js eine Zeile an, die install() mit einigen inneren
// Funktionen der App aufruft - nur lokal, die Datei im Repo bleibt unverändert. So legen
// die Beispieldaten denselben Weg zurück wie echte Eingaben (gleiche Verschlüsselung,
// gleiches Format), statt dass hier ein zweiter Nachbau davon entsteht, der veraltet.
//
// In der Browser-Konsole bzw. per Skript: window.__logbuchPreview.seedDemo() usw.

import { previewAdmin } from './mock-supabase.js';

// Gerätespuren, die das Verhalten beim Start ändern (siehe CLAUDE.md "State that lives on
// the device") - für einen sauberen Neuanfang mit weg.
const DEVICE_KEYS = [
  'onboardingMode', 'onboardingInProgress', 'onboardingWithInstall', 'signedInHere',
  'installGateSkipped', 'installHintDismissed', 'todayIntroPending',
];

// Fester Zufall, damit Screenshots von Lauf zu Lauf gleich aussehen.
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function install(app) {
  const api = {
    admin: previewAdmin,
    state: app.state, // zum Nachsehen in Skripten (z.B. Feld-IDs für Deep-Links)

    // Alles weg: nachgebaute Datenbank, Schlüssel-Cache, Gerätespuren. Danach neu laden.
    async resetAll() {
      previewAdmin.reset();
      for (const k of DEVICE_KEYS) localStorage.removeItem(k);
      Object.keys(localStorage).filter((k) => k.startsWith('sectionCollapsed:')).forEach((k) => localStorage.removeItem(k));
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('logbuch-keys');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    },

    // Füllt das angemeldete, entsperrte Konto mit Beispiel-Feldern und `days` Tagen
    // Einträgen, schließt Tutorial und Ersatzschlüssel ab. Danach neu laden.
    async seedDemo({ days = 21 } = {}) {
      const dek = app.dek();
      const session = app.state.session;
      if (!dek || !session) throw new Error('Erst anmelden und entsperren');
      const sb = app.supabase;
      const uid = session.user.id;
      const enc = (obj) => app.encryptData(dek, obj);

      const { data: section, error: secErr } = await sb.from('habit_sections')
        .insert({ user_id: uid, sort_order: 1, enc: await enc({ name: 'Morgens' }) }).select().single();
      if (secErr) throw secErr;

      const base = { unit: null, min: null, max: null, labels: null, good: null, displayStyle: 'buttons', sliderShowValue: true, groupMembers: null, goalThreshold: null, aggregate: null, hideInStats: false, archivedInStats: false };
      const fields = [
        { key: 'fschlaf', name: 'Schlafstunden', kind: 'number', section: true, unit: 'h' },
        { key: 'fstimmung', name: 'Stimmung', kind: 'scale', section: true, min: 1, max: 5, good: 'high' },
        { key: 'fenergie', name: 'Energie', kind: 'scale', min: 0, max: 10, good: 'high', displayStyle: 'slider' },
        { key: 'fsport', name: 'Sport', kind: 'scale', min: 0, max: 1, good: 'high', labels: ['Nein', 'Ja'], schedule: { type: 'weekly', days: [0, 2, 4] } },
        { key: 'fkopf', name: 'Kopfschmerzen', kind: 'scale', min: 0, max: 3, good: 'low', labels: ['keine', 'leicht', 'mittel', 'stark'] },
        { key: 'fwasser', name: 'Wassergläser', kind: 'number' },
        { key: 'fwohl', name: 'Wohlbefinden', kind: 'computed', groupMembers: ['fstimmung', 'fenergie'], good: null },
        { key: 'fdank', name: 'Dankbar für', kind: 'text' },
      ];
      let topOrder = 1; // 1 = die Gruppe
      let sectionOrder = 0;
      for (const f of fields) {
        const payload = { ...base, ...f };
        delete payload.kind; delete payload.section; delete payload.schedule;
        const { error } = await sb.from('habit_definitions').insert({
          user_id: uid,
          kind: f.kind,
          schedule: f.schedule ?? null,
          reminder_minute: null,
          section_id: f.section ? section.id : null,
          sort_order: f.section ? ++sectionOrder : ++topOrder,
          enc: await enc(payload),
          ...app.DEF_PLAINTEXT_CLEARED,
        });
        if (error) throw error;
      }

      const rnd = seededRandom(42);
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (let i = days; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        if (i > 0 && rnd() < 0.08) continue; // ab und zu ein vergessener Tag
        const day = {};
        day.fschlaf = Math.round((5.5 + rnd() * 3) * 2) / 2;
        day.fstimmung = 1 + Math.floor(rnd() * 5);
        if (i > 0) { // heute noch nicht alles eingetragen - zeigt die "noch offen"-Punkte
          day.fenergie = Math.floor(rnd() * 11);
          day.fkopf = rnd() < 0.7 ? 0 : 1 + Math.floor(rnd() * 3);
          day.fwasser = 3 + Math.floor(rnd() * 6);
          if ([1, 3, 5].includes(d.getDay())) day.fsport = rnd() < 0.7 ? 1 : 0;
          if (rnd() < 0.4) day.fdank = pick(['Gutes Gespräch mit Mia', 'Sonne beim Spaziergang', 'Ruhiger Abend', 'Leckeres Essen']);
          if (rnd() < 0.15) day._notes = { _day: pick(['Lange gearbeitet.', 'Besuch da.', 'Erkältet.']) };
        }
        app.state.entries = { ...app.state.entries, [dateKey(d)]: day };
        await app.saveDayNow(dateKey(d));
      }

      await sb.from('user_settings').update({ onboarding_completed: true }).eq('user_id', uid);
      await sb.from('user_encryption').update({ recovery_key_confirmed: true }).eq('user_id', uid);
      localStorage.removeItem('onboardingInProgress');
      localStorage.removeItem('todayIntroPending');
    },
  };
  window.__logbuchPreview = api;
  window.dispatchEvent(new Event('logbuch-preview-ready'));
}
