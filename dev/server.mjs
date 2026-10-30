// Lokaler Vorschau-Server (siehe dev/README.md): liefert die echten App-Dateien aus, nur
// - vendor/supabase-js-*.js  -> dev/mock-supabase.js (nachgebautes Supabase, kein Netz)
// - logbuch.js               -> mit einer angehängten Zeile, die dev/preview-hook.js lädt
// Die Dateien im Repo bleiben unverändert; auf GitHub Pages gibt es diesen Server nicht,
// dort lässt sich die Vorschau also auch nicht einschalten.
//
// Start: node dev/server.mjs [port]   (Standard 5180, nur auf 127.0.0.1 erreichbar)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2]) || 5180;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
};

const HOOK = `
;import('./dev/preview-hook.js').then((m) => m.install({
  state, render, saveDayNow, encryptData, DEF_PLAINTEXT_CLEARED, supabase, dek: () => currentDek,
  // für dev/tests.mjs (reine Rechenlogik)
  internals: {
    sinceComputedDay, durationComputedDay, numberComputedDay, formatSeriesValue, isScheduledOn, isFutureKey,
    timeValueOn, featureVisible, remapSince, stepChangeMapValue, parseDateKey, formatKey, addDays,
  },
}));
`;

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/logbuch.html';
    let file = normalize(join(ROOT, path));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
    if (/^\/vendor\/supabase-js-[^/]+\.js$/.test(path)) file = join(ROOT, 'dev', 'mock-supabase.js');
    let body = await readFile(file);
    if (path === '/logbuch.js') body = Buffer.concat([body, Buffer.from(HOOK)]);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store', // jede Änderung sofort sichtbar
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err.code === 'ENOENT' ? 'Nicht gefunden' : String(err));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Logbuch-Vorschau: http://localhost:${PORT}/  (nachgebautes Supabase, Daten nur in diesem Browser)`);
  console.log(`Postfach (Bestätigungs-/Reset-Links): http://localhost:${PORT}/dev/postfach.html`);
});
