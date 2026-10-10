// Feste Rundgänge mit Screenshots (siehe README.md).
//
//   node dev/rundgang.mjs <onboarding|onboarding-kurz|app|alle> [--device=handy|schmal|iphone|pc]
//                         [--theme=light|dark] [--size=small|large|xlarge]
//
// Bilder landen in dev/screenshots/<rundgang>-<gerät>[-<theme>][-<größe>]/, nummeriert in
// Ablauf-Reihenfolge. Die Rundgänge tippen über sichtbare Texte (tapText) - ändert sich ein
// Knopftext, hier nachziehen; die Fehlermeldung listet, was stattdessen sichtbar war.
import { launch, resetAll, shot, tapText, type, settle, seededAccount, useOutDir } from './lib.mjs';

const PASSWORD = 'vorschau-passwort-123';

async function signupAndConfirm(page, { guided }) {
  await resetAll(page, deviceState());
  await shot(page, 'startseite');
  await tapText(page, 'Ich bin neu hier');
  await shot(page, 'einstiegsfrage');
  await tapText(page, guided ? 'Schritt für Schritt' : 'Kurz und knapp');
  if (guided) { // "Kurz und knapp" überspringt "So läuft's ab"
    await shot(page, 'so-laeufts-ab');
    await tapText(page, 'Los geht');
  }
  if (await page.$('#email') === null) {
    await shot(page, 'installation');
    await tapText(page, 'Ich bleib erst mal');
  }
  await shot(page, 'registrieren');
  await type(page, '#email', 'neu@beispiel.de');
  await type(page, '#password', PASSWORD);
  await new Promise((r) => setTimeout(r, 1600)); // Bot-Filter: nicht schneller als SIGNUP_MIN_FILL_MS
  await page.$eval('#auth-form', (f) => f.requestSubmit());
  await settle(page, 500);
  await shot(page, 'postfach');
  const link = await page.evaluate(() => window.__logbuchPreview.admin.lastMailLink('signup'));
  await page.goto('about:blank');
  await page.goto(link, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__logbuchPreview);
  await settle(page, 500);
  await shot(page, 'nach-bestaetigungslink');
  await type(page, '#unlock-password', PASSWORD);
  await tapText(page, 'Weiter');
  await settle(page, 1500);
}

async function onboarding(page, { guided }) {
  await signupAndConfirm(page, { guided });
  await shot(page, 'tutorial-1');
  await tapText(page, 'Los geht');
  await shot(page, 'tutorial-erinnerungen');
  await tapText(page, 'Lieber nicht');
  await shot(page, 'feld-1-name');
  await type(page, '#habit-form-name', 'Stimmung');
  await tapText(page, 'Weiter');
  await shot(page, 'feld-2-typ');
  await tapText(page, 'Skala');
  await tapText(page, 'Weiter');
  await shot(page, 'feld-3-rest');
  await tapText(page, 'Feld anlegen');
  await shot(page, 'geschafft');
  await tapText(page, 'Loslegen');
  await settle(page, 800);
  await shot(page, 'ersatzschluessel');
  await tapText(page, 'Aufschreiben');
  await shot(page, 'ersatzschluessel-aufschreiben');
  await tapText(page, 'Ich habe ihn aufbewahrt');
  await shot(page, 'ersatzschluessel-rueckfrage');
  await tapText(page, 'Ja, aufgeschrieben');
  await settle(page, 500);
  await shot(page, 'heute-erster-tag');
}

async function app(page) {
  await seededAccount(page, { deviceState: { installHintDismissed: 'true', ...deviceState() } });
  await shot(page, 'heute');
  for (const tab of ['Woche', 'Monat', 'Jahr', 'Gesamt']) {
    await tapText(page, tab, { exact: true });
    await shot(page, tab.toLowerCase());
  }
  await tapText(page, 'Heute', { exact: true });
  await tapText(page, 'Menü');
  await shot(page, 'menue', { fullPage: false });
  await tapText(page, 'Felder verwalten');
  await shot(page, 'felder-verwalten');
  await tapText(page, 'Neues Feld');
  await shot(page, 'neues-feld');
  await page.keyboard.press('Escape');
  await settle(page);
  await tapText(page, 'Menü');
  await tapText(page, 'Einstellungen');
  await shot(page, 'einstellungen');
  await page.keyboard.press('Escape');
  await settle(page);
  await tapText(page, 'Menü');
  await tapText(page, 'Über Logbuch');
  await shot(page, 'ueber-logbuch');
}

const FLOWS = {
  onboarding: (p) => onboarding(p, { guided: true }),
  'onboarding-kurz': (p) => onboarding(p, { guided: false }),
  app,
};

const opts = { device: 'handy', theme: 'light', size: '' };
const names = [];
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--(\w+)=(.*)$/);
  if (m) opts[m[1]] = m[2];
  else names.push(arg);
}
function deviceState() { return opts.size ? { textSize: opts.size } : {}; }
const selected = names.includes('alle') ? Object.keys(FLOWS) : names;
if (!selected.length || selected.some((n) => !FLOWS[n])) {
  console.error(`Rundgang angeben: ${Object.keys(FLOWS).join(', ')} oder alle`);
  process.exit(1);
}

for (const name of selected) {
  const dir = useOutDir([name, opts.device, opts.theme !== 'light' && opts.theme, opts.size].filter(Boolean).join('-'));
  const { browser, page, problems } = await launch({ device: opts.device, theme: opts.theme });
  try {
    await FLOWS[name](page);
    console.log(`✓ ${name} → ${dir}`);
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`);
    await shot(page, 'FEHLER').catch(() => {});
    process.exitCode = 1;
  } finally {
    if (problems.length) console.log('Probleme in der Seite:\n' + problems.join('\n'));
    await browser.close();
  }
}
