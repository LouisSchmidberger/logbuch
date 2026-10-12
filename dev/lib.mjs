// Gemeinsame Bausteine für Screenshot-Skripte der Vorschau (siehe README.md).
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = process.env.PREVIEW_URL || 'http://localhost:5180/';
export let OUT_DIR = process.env.PREVIEW_OUT || fileURLToPath(new URL('./screenshots/', import.meta.url));
// Eigener, geleerter Unterordner je Rundgang (siehe rundgang.mjs).
export function useOutDir(sub) {
  OUT_DIR = join(process.env.PREVIEW_OUT || fileURLToPath(new URL('./screenshots/', import.meta.url)), sub);
  rmSync(OUT_DIR, { recursive: true, force: true });
  shotNo = null;
  return OUT_DIR;
}

const BROWSERS = [
  process.env.PREVIEW_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].filter(Boolean);

// Geräte-Profile: die App richtet sich nach Handy zuerst (CLAUDE.md "Mobil zuerst").
export const DEVICES = {
  handy: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' },
  schmal: { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    ua: 'Mozilla/5.0 (Linux; Android 13; SM-A136B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' },
  // Opera auf Android: für die Hinweise zu Browsern ohne eigenständige App (otherBrowserBox).
  opera: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 OPR/85.0.0.0' },
  iphone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  pc: { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, ua: null },
};

// profile: Name eines dauerhaften Browser-Profils unter dev/.profile-<name> (übersteht
// das Beenden - für Abläufe über mehrere Aufrufe); ohne: jedes Mal ein frisches Profil.
export async function launch({ device = 'handy', theme = 'light', headless = true, profile = null } = {}) {
  const executablePath = BROWSERS.find((p) => existsSync(p));
  if (!executablePath) throw new Error('Kein Chrome/Edge gefunden - Pfad über PREVIEW_BROWSER angeben.');
  const browser = await puppeteer.launch({ executablePath, headless, args: ['--no-first-run', '--no-default-browser-check'],
    userDataDir: profile ? fileURLToPath(new URL(`./.profile-${profile}/`, import.meta.url)) : undefined });
  const page = await browser.newPage();
  const d = DEVICES[device];
  await page.setViewport({ width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, isMobile: d.isMobile, hasTouch: d.hasTouch });
  if (d.ua) await page.setUserAgent(d.ua);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  const problems = [];
  page.on('pageerror', (err) => problems.push(`Seitenfehler: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`Konsole: ${msg.text()}`); });
  page.on('dialog', (dlg) => dlg.dismiss());
  return { browser, page, problems };
}

// App öffnen und warten, bis die Vorschau-Werkzeuge bereit sind.
export async function open(page, path = '') {
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__logbuchPreview, { timeout: 10000 });
  await settle(page);
}

export async function settle(page, ms = 250) {
  await page.waitForNetworkIdle({ idleTime: 150, timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, ms));
}

// Komplett frischer Zustand (Datenbank, Schlüssel-Cache, Gerätespuren), optional mit
// Gerätespuren vorbelegt (z.B. { installGateSkipped: 'true', textSize: 'xl' }).
export async function resetAll(page, deviceState = {}) {
  await open(page);
  await page.evaluate(async (ds) => {
    await window.__logbuchPreview.resetAll();
    for (const [k, v] of Object.entries(ds)) localStorage.setItem(k, v);
  }, deviceState);
  await open(page);
}

// Nummern laufen über mehrere Aufrufe weiter (Reihenfolge eines Ablaufs bleibt sichtbar);
// zum Neuanfang den Ordner leeren.
let shotNo = null;
export async function shot(page, name, { fullPage = true } = {}) {
  mkdirSync(OUT_DIR, { recursive: true });
  shotNo ??= readdirSync(OUT_DIR).filter((f) => f.endsWith('.png')).length;
  const file = join(OUT_DIR, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
  await settle(page);
  await page.screenshot({ path: file, fullPage });
  console.log('Screenshot:', file);
  return file;
}

// Knopf/Link über seinen sichtbaren Text antippen (robuster als CSS-Selektoren, die sich
// beim Umbau ändern). exact=false: Text muss nur enthalten sein.
export async function tapText(page, text, { exact = false, selector = 'button, a, [role="button"], label, summary' } = {}) {
  const handle = await page.evaluateHandle((text, exact, selector) => {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const all = [...document.querySelectorAll(selector)].filter((el) => el.offsetParent !== null || el.getClientRects().length);
    // Genauer Treffer vor Teil-Treffer, Knöpfe vor Labels - sonst träfe z.B. "Keine Wertung"
    // das Label, in dessen Erklärtext der Begriff auch vorkommt.
    const isButton = (el) => el.matches('button, [role="button"]');
    const exactHits = all.filter((el) => norm(el.textContent) === text);
    const partHits = exact ? [] : all.filter((el) => norm(el.textContent).includes(text));
    return exactHits.find(isButton) || exactHits[0] || partHits.find(isButton) || partHits[0] || null;
  }, text, exact, selector);
  const el = handle.asElement();
  if (!el) {
    const visible = await page.evaluate((selector) => [...document.querySelectorAll(selector)]
      .filter((el) => el.getClientRects().length).map((el) => el.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean), selector);
    throw new Error(`Nichts zum Antippen mit Text "${text}". Sichtbar: ${JSON.stringify(visible)}`);
  }
  await el.click();
  await settle(page);
}

export async function type(page, selector, text) {
  await page.waitForSelector(selector, { visible: true });
  await page.$eval(selector, (el) => { el.value = ''; });
  await page.type(selector, text);
}

// Neues Konto anlegen, bestätigt, und über die echte Anmeldemaske anmelden.
export async function signInFresh(page, { email = 'test@beispiel.de', password = 'vorschau-passwort-123' } = {}) {
  await page.evaluate((e, p) => window.__logbuchPreview.admin.createConfirmedUser(e, p), email, password);
  await page.evaluate(() => localStorage.setItem('signedInHere', 'true')); // -> direkt zur Anmeldemaske
  await open(page);
  await type(page, '#email', email);
  await type(page, '#password', password);
  await page.$eval('#auth-form', (f) => f.requestSubmit());
  await page.waitForFunction(() => !document.querySelector('#auth-form'), { timeout: 20000 });
  await settle(page, 500);
}

// Konto mit Beispieldaten, Tutorial und Ersatzschlüssel erledigt, auf "Heute".
export async function seededAccount(page, opts = {}) {
  await resetAll(page, { installGateSkipped: 'true', ...(opts.deviceState || {}) });
  await signInFresh(page, opts);
  await page.evaluate((days) => window.__logbuchPreview.seedDemo({ days }), opts.days ?? 21);
  await open(page);
}
