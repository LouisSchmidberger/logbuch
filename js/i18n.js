import { esc } from './navigation.js?v=90bbeaa075';
import { STRINGS } from './strings.js?v=90bbeaa075';

export let currentLocale = 'de';

export function t(key, params, escapeParams = true) {
  const table = STRINGS[currentLocale] || STRINGS.de;
  let str = table[key];
  if (str === undefined) {
    console.warn(`[i18n] fehlender Key "${key}" für Locale "${currentLocale}"`);
    str = STRINGS.de[key] ?? key;
  }
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (_, name) => {
    const v = params[name];
    return v === undefined ? `{${name}}` : escapeParams ? esc(String(v)) : String(v);
  });
}

// Für REINEN TEXT, der später selbst noch escaped wird: Meldungen (state.notice,
// authError, unlockError - renderNotice & Co. escapen den ganzen Text) und Werte, die
// per esc() in ein Attribut kommen. Mit t() würden die Parameter dort doppelt escaped
// ("&" erschiene als "&amp;"). Nur für Templates ohne HTML.
export function tPlain(key, params) {
  return t(key, params, false);
}

export function applyLocale(locale) {
  currentLocale = locale;
  document.documentElement.lang = locale;
}
// Zahlen im Text in der Schreibweise der Sprache ("6,5" statt "6.5"); Eingabefelder
// (type="number") machen das selbst.
export function formatNumber(n) {
  return new Intl.NumberFormat(currentLocale, { maximumFractionDigits: 2 }).format(n);
}

export function detectInitialLocale() {
  try {
    return (navigator.language || '').toLowerCase().startsWith('de') ? 'de' : 'en';
  } catch {
    return 'en';
  }
}

// Grobe, rein clientseitige Vermutung des Aufenthaltslands aus der Region-Angabe der
// Browser-/Systemsprache (z.B. "de-DE" -> "DE") - bewusst KEINE IP-Geolocation oder
// navigator.geolocation, das würde einen Drittanbieter-Roundtrip bzw. einen
// Berechtigungsdialog für eine reine Textanzeige bedeuten und widerspräche der
// Zero-Access-Ausrichtung der App (siehe docs/verschluesselung.md).
// Unabhängig von currentLocale (der von Nutzern selbst gewählten App-Sprache) - beide
// können auseinanderlaufen (z.B. App auf Englisch gestellt, System auf de-DE), siehe
// Verwendung in renderMentalHealthSection. Liefert null, wenn der Browser keine
// Region angibt (z.B. nur "de" ohne Länder-Suffix) - dann bleibt es beim
// länderunabhängigen Verweis, kein hartes Scheitern.
export function detectLikelyCountry() {
  try {
    const lang = navigator.language || (navigator.languages && navigator.languages[0]) || '';
    const match = /-([A-Za-z]{2})$/.exec(lang);
    return match ? match[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

// Prüft beim Start, ob DE und EN exakt dieselben Keys haben — deckt vergessene
// Übersetzungen sofort im Dev-Verlauf auf, statt sie erst live auffallen zu lassen.
// Vom Einstieg aufgerufen (docs/module.md: beim Laden läuft nichts außer Deklarationen).
export function initI18n() {
  const deKeys = new Set(Object.keys(STRINGS.de));
  const enKeys = new Set(Object.keys(STRINGS.en));
  const missingInEn = [...deKeys].filter((k) => !enKeys.has(k));
  const missingInDe = [...enKeys].filter((k) => !deKeys.has(k));
  if (missingInEn.length) console.error('[i18n] Keys fehlen in en:', missingInEn);
  if (missingInDe.length) console.error('[i18n] Keys fehlen in de:', missingInDe);
}
