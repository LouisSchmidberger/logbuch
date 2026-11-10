// --- Dark Mode ---------------------------------------------------------
// Folgt standardmäßig prefers-color-scheme (siehe @media-Regeln in logbuch.css).
// Ein manueller Override (System/Hell/Dunkel) im Burger-Menü setzt zusätzlich
// data-theme auf <html> und wird NICHT über user_settings synchronisiert
// (anders als die Sprache) — bewusst geräte-lokal in localStorage, analog zum
// bestehenden installHintDismissed-Flag, kein DB-Roundtrip nötig.
// = --surface (Farbe des angehefteten Kopfs): Statusleiste und Kopf wirken wie eine Fläche.
const THEME_COLOR_BY_MODE = { light: '#eae7df', dark: '#29261f' };

export function getThemeOverride() {
  try { return localStorage.getItem('themeOverride'); } catch { return null; } // 'light' | 'dark' | null (= System)
}

function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

function syncThemeColorMeta(mode) {
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR_BY_MODE[mode]);
}

export function applyTheme(override) {
  if (override) document.documentElement.setAttribute('data-theme', override);
  else document.documentElement.removeAttribute('data-theme');
  syncThemeColorMeta(override || (systemPrefersDark() ? 'dark' : 'light'));
}

export function setThemeOverride(value) {
  try {
    if (value) localStorage.setItem('themeOverride', value);
    else localStorage.removeItem('themeOverride');
  } catch { /* z.B. privater Modus — Override wirkt dann nur für die laufende Sitzung */ }
  applyTheme(value);
}

// Textgröße, pro Gerät wie das Theme (localStorage 'textSize': 'small' | 'large' | 'xlarge'
// | nicht gesetzt = Normal; "Klein" für alle, die lieber mehr auf einmal sehen). Setzt nur die Grundgröße auf <html> - alle Schriftgrößen im CSS
// stehen in rem und wachsen mit. Zwei-Finger-Zoom ist kein Ersatz (vergrößert wie eine
// Lupe, man muss seitlich schieben), und in der installierten App fehlt die
// Browser-Leiste mit ihrer eigenen Schriftgrößen-Einstellung.
export const TEXT_SIZES = ['small', '', 'large', 'xlarge'];
export function getTextSize() {
  try { const v = localStorage.getItem('textSize'); return TEXT_SIZES.includes(v) ? v : ''; } catch { return ''; }
}
export function applyTextSize(size) {
  if (size) document.documentElement.setAttribute('data-text-size', size);
  else document.documentElement.removeAttribute('data-text-size');
}
export function setTextSize(size) {
  try {
    if (size) localStorage.setItem('textSize', size);
    else localStorage.removeItem('textSize');
  } catch { /* dann eben nur für diese Sitzung */ }
  applyTextSize(size);
}

// Streifenmuster (siehe scorePatternStyle) ist bewusst Standard, nicht opt-in — die
// meisten Menschen mit Rot-Grün-Farbschwäche wissen selbst nicht genau, dass/wie stark
// sie betroffen sind, würden ein verstecktes "Barrierefreiheit"-Menü also gar nicht
// erst aufsuchen. Wer das Muster rein optisch nicht möchte, kann es hier abschalten —
// geräte-lokal wie der Theme-Override, keine inhaltliche Account-Einstellung.
// "Stand des Tages zeigen" (3 von 7 eingetragen): standardmäßig aus - eine Zahl, die noch
// nicht voll ist, kann sich wie eine Pflicht anfühlen. Geräte-lokal wie Muster und Theme.
export function isDayProgressShown() {
  try { return localStorage.getItem('dayProgressShown') === 'true'; } catch { return false; }
}
export function setDayProgressShown(shown) {
  try {
    if (shown) localStorage.setItem('dayProgressShown', 'true');
    else localStorage.removeItem('dayProgressShown');
  } catch { /* dann eben nur für diese Sitzung */ }
}
export function isPatternDisabled() {
  try { return localStorage.getItem('scorePatternDisabled') === 'true'; } catch { return false; }
}
export function setPatternDisabled(disabled) {
  try {
    if (disabled) localStorage.setItem('scorePatternDisabled', 'true');
    else localStorage.removeItem('scorePatternDisabled');
  } catch { /* z.B. privater Modus — wirkt dann nur für die laufende Sitzung */ }
}

// Haptisches Feedback beim Setzen/Entfernen eines Werts - damit ein versehentlich
// eingetragener oder verstellter Wert (z.B. ein beim Scrollen gestreifter
// Schieberegler) eher auffällt. Standardmäßig an, aber abschaltbar: Vibration kann für
// manche unangenehm sein (z.B. bei sensorischer Empfindlichkeit). Geräte-lokal wie
// Theme/Streifenmuster. Nur Android: Safari auf iOS bietet Webseiten keine
// Vibration-API an - der Schalter erscheint dort deshalb gar nicht erst.
export function hapticsSupported() {
  return typeof navigator.vibrate === 'function';
}
export function isHapticsDisabled() {
  try { return localStorage.getItem('hapticsDisabled') === 'true'; } catch { return false; }
}
export function setHapticsDisabled(disabled) {
  try {
    if (disabled) localStorage.setItem('hapticsDisabled', 'true');
    else localStorage.removeItem('hapticsDisabled');
  } catch { /* z.B. privater Modus — wirkt dann nur für die laufende Sitzung */ }
}
export function haptic() {
  if (!hapticsSupported() || isHapticsDisabled()) return;
  try { navigator.vibrate(12); } catch { /* nicht erlaubt (z.B. ohne vorherige Nutzer-Geste) - egal */ }
}
