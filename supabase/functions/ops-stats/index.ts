// Kennzahlen für den Betreiber, abgerufen vom Hub (Nutzer-Entscheidung 2026-10-29).
// Liefert nur Summen (public.ops_stats + Verlauf aus public.ops_daily_stats), siehe Migration
// 20261029170523_ops_stats.sql für die Regeln.
//
// Kein Supabase-Login: der Hub schickt "Authorization: Bearer <OPS_STATS_TOKEN>" (Secret, nie
// im Repo). Deshalb ohne JWT-Prüfung deployen: supabase functions deploy ops-stats --no-verify-jwt
// Der Token öffnet nur diese Summen - bewusst nicht der Service-Key im Hub (der öffnete die
// ganze Datenbank samt E-Mail-Adressen). Neuer Token = alter sofort ungültig.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPS_STATS_TOKEN = Deno.env.get('OPS_STATS_TOKEN');
const HISTORY_DAYS = 400;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Vergleich in konstanter Zeit (verrät über die Antwortzeit nicht, wie viele Zeichen stimmen).
async function tokenMatches(given: string) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, OPS_STATS_TOKEN!].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') return json({ error: 'method' }, 405);
  if (!OPS_STATS_TOKEN || OPS_STATS_TOKEN.length < 32) return json({ error: 'not configured' }, 503);
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !(await tokenMatches(auth.slice(7)))) return json({ error: 'unauthorized' }, 401);

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }); // YYYY-MM-DD
  const [live, history] = await Promise.all([
    supabaseAdmin.rpc('ops_stats', { p_day: today }),
    supabaseAdmin.from('ops_daily_stats').select('day, stats').order('day', { ascending: false }).limit(HISTORY_DAYS),
  ]);
  if (live.error || history.error) {
    console.error('[ops-stats]', live.error?.message, history.error?.message);
    return json({ error: 'query failed' }, 500);
  }
  return json({ live: live.data, history: (history.data ?? []).map((r) => r.stats) });
});
