// Abgleich JS <-> SQL: Regeln, die es doppelt gibt (CLAUDE.md "Zeitplan-Regeln doppelt"), müssen
// in der App und in der Datenbank dasselbe ergeben. Das Skript rechnet dieselben Fälle einmal in
// logbuch.js (über die Vorschau) und einmal in Postgres und meldet jeden Unterschied.
//
//   node dev/sync-tests.mjs     (Vorschau-Server muss laufen; lokale Datenbank: npx supabase db start)
//
// Gegen die Live-Datenbank läuft es bewusst nicht: die Migrationen sollen hier geprüft werden,
// bevor sie live gehen (CI, .github/workflows/ci.yml).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, open } from './lib.mjs';

// --- Fälle ---------------------------------------------------------------------------------
// Datumsbereich über Monats- und Jahreswechsel und einen Schalttag.
const DATES = [];
for (const [start, n] of [['2026-12-20', 20], ['2028-02-25', 8], ['2026-03-26', 6]]) {
  const d = new Date(start + 'T12:00:00Z');
  for (let i = 0; i < n; i++) DATES.push(new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10));
}
const SCHEDULES = [
  null,
  { type: 'weekly', days: [0, 2, 4] },
  { type: 'weekly', days: [5, 6] },
  { type: 'weekly', days: [0, 1, 2, 3, 4, 5, 6] },
  { type: 'interval', every: 2, unit: 'day', start: '2026-12-24' },
  { type: 'interval', every: 3, unit: 'day', start: '2028-02-26' },
  { type: 'interval', every: 7, unit: 'day', start: '2026-03-01' },
];
const PERIODS = ['day', 'week', 'month', 'year'];
const WEEK_STARTS = [1, 7, 6]; // Montag, Sonntag, Samstag (ISO)

const cases = [];
for (const s of SCHEDULES) for (const d of DATES) cases.push({ fn: 'scheduled', schedule: s, date: d });
for (const p of PERIODS) for (const w of WEEK_STARTS) for (const d of DATES) cases.push({ fn: 'periodStart', period: p, weekStart: w, date: d });

// --- JS ----------------------------------------------------------------------------------
const { browser, page, problems } = await launch({ device: 'handy' });
let js;
try {
  await open(page);
  js = await page.evaluate((cases) => {
    const f = window.__logbuchPreview.internals;
    return cases.map((c) => {
      const date = f.parseDateKey(c.date);
      if (c.fn === 'scheduled') return f.isScheduledOn(c.schedule, date);
      return f.formatKey(f.periodStartWith(c.period, date, c.weekStart));
    });
  }, cases);
} finally {
  await browser.close();
}
if (problems.length) { console.log('Probleme in der Seite:\n' + problems.join('\n')); process.exit(1); }

// --- SQL ---------------------------------------------------------------------------------
const lit = (v) => v === null ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
const rows = cases.map((c, i) => c.fn === 'scheduled'
  ? `select ${i} as i, public.habit_scheduled_on(${c.schedule ? lit(JSON.stringify(c.schedule)) + '::jsonb' : 'null'}, ${lit(c.date)}::date)::text as v`
  : `select ${i} as i, public.habit_period_start(${lit(c.period)}, ${lit(c.date)}::date, ${c.weekStart}::smallint)::text as v`);
const file = join(mkdtempSync(join(tmpdir(), 'logbuch-sync-')), 'cases.sql');
writeFileSync(file, rows.join('\nunion all\n') + '\norder by i;\n');
const out = execFileSync('npx', ['supabase', 'db', 'query', '--output-format', 'json', '-f', file],
  { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
const parsed = JSON.parse(out.slice(out.indexOf('{') === -1 || out.indexOf('[') < out.indexOf('{') ? out.indexOf('[') : out.indexOf('{')));
const sqlRows = Array.isArray(parsed) ? parsed : (parsed.rows || Object.values(parsed).find(Array.isArray));
const sql = sqlRows.map((r) => r.v === 'true' ? true : r.v === 'false' ? false : r.v);

// --- Vergleich ---------------------------------------------------------------------------
let failed = 0;
cases.forEach((c, i) => {
  if (js[i] === sql[i]) return;
  failed++;
  if (failed <= 30) console.log(`  FEHLER ${JSON.stringify(c)}: JS ${JSON.stringify(js[i])}, SQL ${JSON.stringify(sql[i])}`);
});
console.log(failed ? `\n${failed} von ${cases.length} Fällen weichen ab` : `JS und SQL stimmen in allen ${cases.length} Fällen überein`);
process.exit(failed ? 1 : 0);
