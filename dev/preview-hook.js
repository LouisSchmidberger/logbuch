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
  'installGateSkipped', 'installHintDismissed', 'todayIntroPending', 'groupTipDismissed',
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
    render: app.render, // nach Änderungen an state von Hand neu zeichnen

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

      // Zwei Gruppen mit ungruppierten Feldern dazwischen - so sieht man, wo eine Gruppe endet.
      const sectionIds = {};
      for (const [key, name, order] of [['morgens', 'Morgens', 1], ['abends', 'Abends', 10]]) {
        const { data, error } = await sb.from('habit_sections')
          .insert({ user_id: uid, sort_order: order, enc: await enc({ name }) }).select().single();
        if (error) throw error;
        sectionIds[key] = data.id;
      }

      const base = { unit: null, min: null, max: null, labels: null, good: null, displayStyle: 'buttons', sliderShowValue: true, groupMembers: null, goalThreshold: null, aggregate: null, hideInStats: false, archivedInStats: false };
      const fields = [
        { key: 'fschlaf', name: 'Schlafstunden', kind: 'number', section: 'morgens', unit: 'h' },
        { key: 'fstimmung', name: 'Stimmung', kind: 'scale', section: 'morgens', min: 1, max: 5, good: 'high' },
        { key: 'fenergie', name: 'Energie', kind: 'scale', min: 1, max: 10, good: 'high', displayStyle: 'slider' },
        { key: 'fsport', name: 'Sport', kind: 'scale', min: 1, max: 2, good: 'high', labels: ['Nein', 'Ja'], goalThreshold: 3 / 7 },
        { key: 'fwasser', name: 'Wassergläser', kind: 'number' },
        { key: 'fwohl', name: 'Wohlbefinden', kind: 'computed', groupMembers: ['fstimmung', 'fenergie'], good: null },
        { key: 'fkopf', name: 'Kopfschmerzen', kind: 'scale', section: 'abends', min: 1, max: 4, good: 'low', labels: ['keine', 'leicht', 'mittel', 'stark'] },
        { key: 'fdank', name: 'Dankbar für', kind: 'text', section: 'abends' },
        // Zeitraum-Felder: Wert im ersten Tag des Zeitraums (siehe periodStart in logbuch.js)
        { key: 'fputz', name: 'Zimmer geputzt', kind: 'scale', min: 1, max: 2, good: 'high', labels: ['Nein', 'Ja'], period: 'week' },
        { key: 'fmonat', name: 'Monatsrückblick', kind: 'text', period: 'month' },
      ];
      let topOrder = 1; // 1 = Gruppe "Morgens", 10 = "Abends"
      const inSection = { morgens: 0, abends: 0 };
      for (const f of fields) {
        const payload = { ...base, ...f };
        delete payload.kind; delete payload.section; delete payload.schedule; delete payload.period;
        const { error } = await sb.from('habit_definitions').insert({
          user_id: uid,
          kind: f.kind,
          schedule: f.schedule ?? null,
          reminder_minute: null,
          section_id: f.section ? sectionIds[f.section] : null,
          sort_order: f.section ? ++inSection[f.section] : ++topOrder,
          period: f.period || 'day',
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
          day.fenergie = 1 + Math.floor(rnd() * 10);
          day.fkopf = rnd() < 0.7 ? 1 : 2 + Math.floor(rnd() * 3);
          day.fwasser = 3 + Math.floor(rnd() * 6);
          day.fsport = [1, 3, 5].includes(d.getDay()) && rnd() < 0.8 ? 2 : 1;
          if (rnd() < 0.4) day.fdank = pick(['Gutes Gespräch mit Mia', 'Sonne beim Spaziergang', 'Ruhiger Abend', 'Leckeres Essen']);
          if (rnd() < 0.15) day._notes = { _day: pick(['Lange gearbeitet.', 'Besuch da.', 'Erkältet.']) };
        }
        app.state.entries = { ...app.state.entries, [dateKey(d)]: day };
        await app.saveDayNow(dateKey(d));
      }

      // Zeitraum-Werte: frühere Wochen meist geputzt, die laufende noch offen; Rückblick nur für
      // den Vormonat.
      const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      for (let w = 1; w * 7 <= days + 6; w++) {
        const d = new Date(monday); d.setDate(monday.getDate() - 7 * w);
        app.state.entries = { ...app.state.entries, [dateKey(d)]: { ...(app.state.entries[dateKey(d)] || {}), fputz: rnd() < 0.75 ? 2 : 1 } };
        await app.saveDayNow(dateKey(d));
      }
      const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      app.state.entries = { ...app.state.entries, [dateKey(prevMonth)]: { ...(app.state.entries[dateKey(prevMonth)] || {}), fmonat: 'Viel draußen gewesen, neuer Sport-Rhythmus.' } };
      await app.saveDayNow(dateKey(prevMonth));

      await sb.from('user_settings').update({ onboarding_completed: true }).eq('user_id', uid);
      await sb.from('user_encryption').update({ recovery_key_confirmed: true }).eq('user_id', uid);
      localStorage.removeItem('onboardingInProgress');
      localStorage.removeItem('todayIntroPending');
    },
  };
  window.__logbuchPreview = api;
  window.dispatchEvent(new Event('logbuch-preview-ready'));
}
