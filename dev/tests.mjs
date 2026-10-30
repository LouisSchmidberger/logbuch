// Automatische Tests der Rechenlogik (siehe README.md). Laufen im echten logbuch.js in der
// Vorschau: der Vorschau-Server reicht die getesteten Funktionen über den Vorschau-Haken
// durch (internals in dev/server.mjs) - logbuch.js selbst bleibt unverändert, und getestet
// wird genau der Code, der live läuft.
//
//   node dev/tests.mjs          (Vorschau-Server muss laufen: node dev/server.mjs)
//
// Neue Rechenlogik -> hier einen Fall dazu, neue Funktion -> in internals aufnehmen.
import { launch, open } from './lib.mjs';

const { browser, page, problems } = await launch({ device: 'handy' });
let failed = 0;
try {
  await open(page);
  const results = await page.evaluate(() => {
    const { state, internals: f } = window.__logbuchPreview;
    const out = [];
    const eq = (name, actual, expected) => {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      out.push({ name, ok, actual, expected });
    };
    const day = (offset) => f.formatKey(f.addDays(new Date(), offset)); // offset 0 = heute
    const saved = { habits: state.habits, entries: state.entries };
    try {
      // --- Tage seit ---------------------------------------------------------
      const period = { id: 'p', kind: 'scale', min: 1, max: 4, labels: ['keine', 'leicht', 'mittel', 'stark'], good: null, period: 'day' };
      const sinceStart = { id: 's1', kind: 'computed', aggregate: 'since', members: ['p'], since: { values: [2, 3, 4], atLeast: null, mode: 'start' } };
      const sinceLast = { id: 's2', kind: 'computed', aggregate: 'since', members: ['p'], since: { values: [2, 3, 4], atLeast: null, mode: 'last' } };
      const sport = { id: 'n', kind: 'number', period: 'day' };
      const sinceNum = { id: 's3', kind: 'computed', aggregate: 'since', members: ['n'], since: { values: null, atLeast: 2, mode: 'last' } };
      state.habits = [period, sinceStart, sinceLast, sport, sinceNum];
      const e = {};
      for (const i of [50, 49, 48, 22, 21, 19, 18]) e[day(-i)] = { p: 3 }; // vor 20 vergessen
      e[day(-10)] = { p: 1 }; // "keine" zählt nicht
      e[day(-5)] = { n: 1 }; e[day(-3)] = { n: 2 };
      state.entries = e;
      const v = (h, i) => f.sinceComputedDay(h, day(i)).value;
      eq('seit Beginn: heute Tag 23', v(sinceStart, 0), 23);
      eq('seit Beginn: vergessener Tag beginnt nicht neu', v(sinceStart, -19), 4);
      eq('seit Beginn: Ende des vorigen Zyklus', v(sinceStart, -23), 28);
      eq('seit Beginn: Beginn selbst ist Tag 1', v(sinceStart, -22), 1);
      eq('seit dem letzten Mal: 18 Tage', v(sinceLast, 0), 18);
      eq('seit dem letzten Mal: am Tag selbst 0', v(sinceLast, -18), 0);
      eq('"keine" zählt nicht', v(sinceLast, -10), 8);
      eq('vor dem ersten Eintrag kein Wert', v(sinceLast, -60), null);
      eq('Zukunft kein Wert', v(sinceLast, 1), null);
      eq('Zahl "ab 2": 1 zählt nicht, 2 schon', [v(sinceNum, -4), v(sinceNum, 0)], [null, 3]);
      eq('Anzeige seit Beginn', f.formatSeriesValue(sinceStart, 23), 'Tag 23');
      eq('Anzeige seit dem letzten Mal', [0, 1, 5].map((n) => f.formatSeriesValue(sinceLast, n)), ['heute', '1 Tag', '5 Tage']);

      // --- Stufen ändern nimmt die zählenden Stufen mit ------------------------
      const sc = { from: { min: 1, max: 4 }, to: { min: 1, max: 3 }, map: { 1: 1, 2: 2, 3: 2, 4: 3 } };
      eq('Stufen ändern: 2,3,4 -> 2,3', f.remapSince({ values: [2, 3, 4], mode: 'start' }, sc, false, true).values, [2, 3]);
      eq('Stufen ändern rückgängig: 2,3 -> 2,3,4', f.remapSince({ values: [2, 3], mode: 'start' }, sc, true, true).values, [2, 3, 4]);
      eq('Stufen ändern: entfernte Stufe fällt weg', f.remapSince({ values: [4] }, { ...sc, map: { 4: null } }, false, true).values, []);

      // --- Dauer ---------------------------------------------------------------
      const bed = { id: 'b', kind: 'time' }, up = { id: 'u', kind: 'time' };
      const dur = { id: 'd', kind: 'computed', aggregate: 'duration', members: ['b', 'u'] };
      state.habits = [bed, up, dur];
      state.entries = { [day(-2)]: { b: 1410 }, [day(-1)]: { u: 420, b: 1470 }, [day(0)]: { u: 450 } };
      eq('Dauer über Mitternacht (23:30 -> 7:00)', f.durationComputedDay(dur, day(-1)).value, 7.5);
      eq('Dauer: Bettzeit nach Mitternacht (0:30 -> 7:30)', f.durationComputedDay(dur, day(0)).value, 7);

      // --- Summe aus Zahlen: fehlendes Mitglied zählt als 0, keins = kein Wert ----
      const a = { id: 'a', kind: 'number' }, b2 = { id: 'b2', kind: 'number' };
      const sum = { id: 'sum', kind: 'computed', aggregate: 'sum', members: ['a', 'b2'] };
      state.habits = [a, b2, sum];
      state.entries = { [day(0)]: { a: 2 }, [day(-1)]: {} };
      eq('Summe mit fehlendem Mitglied', f.numberComputedDay(sum, day(0)).value, 2);
      eq('Summe ohne Einträge', f.numberComputedDay(sum, day(-1)).value, null);

      // --- Zeitpläne (synchron halten mit public.habit_scheduled_on!) -------------
      const mon = f.parseDateKey('2026-10-26'); // Montag
      eq('wöchentlich Mo/Mi: Montag dran', f.isScheduledOn({ type: 'weekly', days: [0, 2] }, mon), true);
      eq('wöchentlich Mo/Mi: Dienstag nicht', f.isScheduledOn({ type: 'weekly', days: [0, 2] }, f.addDays(mon, 1)), false);
      eq('alle 3 Tage ab Mo: Do dran, Fr nicht', [3, 4].map((i) => f.isScheduledOn({ type: 'interval', every: 3, unit: 'day', start: '2026-10-26' }, f.addDays(mon, i))), [true, false]);
      eq('alle 3 Tage: vor dem Start nicht', f.isScheduledOn({ type: 'interval', every: 3, unit: 'day', start: '2026-10-26' }, f.addDays(mon, -3)), false);
      eq('täglich', f.isScheduledOn(null, mon), true);

      // --- Uhrzeit auf dem Tag ---------------------------------------------------
      eq('0:30 heute, eingetragen auf gestern = 1470', f.timeValueOn('2026-10-29', new Date(2026, 9, 30, 0, 30)), 1470);
      eq('Zukunft erkannt', [f.isFutureKey(day(1)), f.isFutureKey(day(0))], [true, false]);

      // --- Schalter ---------------------------------------------------------------
      const g = [null, 'tester', 'owner'];
      eq('Stufe off', g.map((x) => f.featureVisible('off', x)), [false, false, false]);
      eq('Stufe owner', g.map((x) => f.featureVisible('owner', x)), [false, false, true]);
      eq('Stufe testers', g.map((x) => f.featureVisible('testers', x)), [false, true, true]);
      eq('Stufe all', g.map((x) => f.featureVisible('all', x)), [true, true, true]);
      eq('unbekannter Schalter ist aus', f.featureVisible(undefined, 'owner'), false);
    } finally {
      state.habits = saved.habits;
      state.entries = saved.entries;
    }
    return out;
  });
  for (const r of results) {
    if (r.ok) console.log(`  ok    ${r.name}`);
    else { failed++; console.log(`  FEHLER ${r.name}\n         erwartet ${JSON.stringify(r.expected)}, bekommen ${JSON.stringify(r.actual)}`); }
  }
  console.log(failed ? `\n${failed} von ${results.length} Tests fehlgeschlagen` : `\nAlle ${results.length} Tests bestanden`);
} catch (err) {
  failed++;
  console.error('FEHLER:', err.message);
}
if (problems.length) { failed++; console.log('Probleme in der Seite:\n' + problems.join('\n')); }
await browser.close();
process.exit(failed ? 1 : 0);
