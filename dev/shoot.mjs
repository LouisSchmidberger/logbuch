// Vorschau per Schritt-Liste steuern und Screenshots machen (siehe README.md).
//
//   node dev/shoot.mjs [--device=handy|schmal|iphone|pc] [--theme=light|dark]
//                      [--size=<Textgröße, wie in localStorage 'textSize'>] [--keep] Schritt …
//
// Schritte:
//   reset                 alles frisch (Datenbank, Schlüssel, Gerätespuren)
//   seeded                Konto mit Beispieldaten, angemeldet, auf "Heute"
//   signin                neues bestätigtes Konto, über die Anmeldemaske angemeldet
//   tap:<Text>            Knopf/Link mit diesem Text antippen
//   type:<Selektor>=<Text>
//   submit:<Selektor>     Formular abschicken
//   mail[:signup|recovery] letzten Link aus dem Vorschau-Postfach öffnen
//   goto:<Pfad>           z.B. goto:logbuch.html
//   eval:<JS>             im Browser ausführen
//   wait:<ms>
//   shot:<Name>           Screenshot (ganze Seite); shotview:<Name> nur sichtbarer Bereich
//   buttons               sichtbare Knöpfe auflisten (zum Weiterplanen)
//
// --keep: Browser-Profil (dev/.profile-<device>) zwischen Aufrufen behalten, damit man
// einen Ablauf in mehreren Aufrufen weiterführen kann. Ohne: jedes Mal frisch.
import { launch, open, resetAll, shot, tapText, type, settle, signInFresh, seededAccount } from './lib.mjs';

const opts = { device: 'handy', theme: 'light', size: null, keep: false };
const steps = [];
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--(\w+)(?:=(.*))?$/);
  if (m) opts[m[1]] = m[2] ?? true;
  else steps.push(arg);
}

const { browser, page, problems } = await launch({ device: opts.device, theme: opts.theme, profile: opts.keep ? opts.device : null });
const deviceState = opts.size ? { textSize: opts.size } : {};
try {
  if (opts.keep) await open(page).catch(() => {});
  for (const step of steps) {
    const i = step.indexOf(':');
    const [cmd, arg] = i === -1 ? [step, ''] : [step.slice(0, i), step.slice(i + 1)];
    console.log('→', step);
    switch (cmd) {
      case 'reset': await resetAll(page, deviceState); break;
      case 'seeded': await seededAccount(page, { deviceState: { installHintDismissed: 'true', ...deviceState } }); break;
      case 'signin': await signInFresh(page); break;
      case 'tap': await tapText(page, arg); break;
      case 'type': { // Trenner ist das erste '=' nach einer evtl. [attr="x"]-Klammer im Selektor
        const j = arg.indexOf('=', arg.lastIndexOf(']') + 1);
        await type(page, arg.slice(0, j), arg.slice(j + 1));
        break;
      }
      case 'submit': await page.$eval(arg, (f) => f.requestSubmit()); await settle(page, 500); break;
      case 'mail': {
        const link = await page.evaluate((k) => window.__logbuchPreview.admin.lastMailLink(k || undefined), arg);
        if (!link) throw new Error('Keine Mail im Vorschau-Postfach');
        // Wie aus dem Mailprogramm: neu geladene Seite, nicht nur ein Sprung im '#'-Teil.
        await page.goto('about:blank');
        await page.goto(link, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => window.__logbuchPreview);
        await settle(page, 500);
        break;
      }
      case 'goto': await open(page, arg); break;
      case 'eval': console.log(await page.evaluate(arg)); await settle(page); break;
      case 'wait': await new Promise((r) => setTimeout(r, Number(arg))); break;
      case 'shot': await shot(page, arg || 'bild'); break;
      case 'shotview': await shot(page, arg || 'bild', { fullPage: false }); break;
      case 'buttons':
        console.log(await page.evaluate(() => [...document.querySelectorAll('button, a, [role="button"], summary, input, select, textarea')]
          .filter((el) => el.getClientRects().length)
          .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}: ${(el.textContent.trim() || el.getAttribute('aria-label') || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 60)}`)
          .join('\n')));
        break;
      default: throw new Error(`Unbekannter Schritt: ${step}`);
    }
  }
} catch (err) {
  console.error('FEHLER:', err.message);
  process.exitCode = 1;
} finally {
  if (problems.length) console.log('Probleme in der Seite:\n' + problems.join('\n'));
  await browser.close();
}
