import { createClient } from '../vendor/supabase-js-2.117.2.js';

// --- Konfiguration -----------------------------------------------------
const SUPABASE_URL = 'https://qdadoqcnqmrauhshvcts.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_c8VJ-dqy-WD_y01aQy1Dzw_LJE-Ornr';
export const VAPID_PUBLIC_KEY = 'BDsrR2NV5vEE4Ati-Dda7tNom6GTtWmKvzytspTc7x1LP6ur1np90oAPphhIAoCtnaw3nGELgBXxYNyiSkLVEEY';
// Supabase-seitiger Fehler (nicht unserer): PostgREST lehnt ein gerade frisch
// ausgestelltes Token gelegentlich als "JWT issued at future" (PGRST303) ab - Uhren-
// Abweichung zwischen Auth und PostgREST bzw. ein bekannter Zeit-Cache-Bug, behoben
// erst in PostgREST 14.18/16.3 (Projekt lief am 2026-09-27 auf v14.5). Trifft v.a. das
// erste Laden nach dem Öffnen (Token wird dann erneuert) - und hätte genauso gut ein
// Speichern treffen können, dann wäre der Wert verloren gewesen. Deshalb zentral hier
// statt an jeder Abfrage: bei genau diesem Fehler bis zu zweimal nach kurzer Pause neu
// versuchen. Sicher auch für Schreibzugriffe, da PostgREST die Anfrage dann vor der
// Ausführung abgewiesen hat. Nur REST-Aufrufe (Edge Functions laufen nicht über
// PostgREST). supabase-js übergibt den Body als String, der sich erneut senden lässt.
const JWT_FUTURE_RETRY_DELAYS_MS = [1000, 2000];
async function fetchWithJwtFutureRetry(input, init) {
  let res = await fetch(input, init);
  const isRest = String(input instanceof Request ? input.url : input).includes('/rest/v1/');
  for (const delay of isRest ? JWT_FUTURE_RETRY_DELAYS_MS : []) {
    if (res.status !== 401) break;
    const body = await res.clone().json().catch(() => null);
    if (body?.code !== 'PGRST303') break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    res = await fetch(input, init);
  }
  return res;
}
// Kam die Seite über den Bestätigungslink aus der Registrierungs-Mail? supabase-js liest
// den Teil nach '#' gleich beim Start aus und entfernt ihn - deshalb vorher merken
// (siehe renderConfirmLanding).
export const ARRIVED_VIA_SIGNUP_CONFIRM = /(^#|&)type=signup(&|$)/.test(location.hash);
// Rückkehr über den Link aus der Mail von "E-Mail ändern" (Anmeldung mit type=email_change).
export const ARRIVED_VIA_EMAIL_CHANGE = /(^#|&)type=email_change(&|$)/.test(location.hash);
// Link aus einer Mail (Registrierung, Passwort vergessen, E-Mail ändern) abgelaufen oder schon
// benutzt: Supabase leitet dann mit error_code statt einer Anmeldung zurück (otp_expired -
// auch, wenn ein Virenscanner des Mail-Anbieters den Link vorab geöffnet hat). Ohne Meldung
// sähe es aus, als hätte der Knopf in der Mail nichts getan. Welche Mail es war, steht nicht
// darin, deshalb eine Meldung, die für alle passt.
export const MAIL_LINK_ERROR = (() => {
  const hash = new URLSearchParams(location.hash.slice(1));
  return hash.get('error_code') || hash.get('error');
})();
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: fetchWithJwtFutureRetry } });

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
