// Läuft alle 15 Minuten (per pg_cron, siehe supabase/migrations/) und verschickt die
// Push-Benachrichtigungen, die gerade fällig sind. WER gerade WAS bekommt, entscheidet
// komplett die SQL-Funktion public.get_due_notifications() (siehe deren Migration für
// die genauen Regeln) – pro Nutzer in dessen eigener Zeitzone und nur für Abos, bei
// denen tatsächlich etwas fällig ist. Diese Function übersetzt das Ergebnis nur noch
// in Nachrichten und verschickt sie:
// 1. Sammel-Erinnerung zur Standard-Erinnerungszeit (bewusst generisch, ohne
//    Feldnamen – bei vielen Feldern sonst eine sehr lange Nachricht).
// 2. Erinnerung für Felder mit eigener Zeit (nennt die Felder, meist ein einzelnes
//    bewusst herausgehobenes wie Gewicht morgens).
// 3. Sonntags "Wochenübersicht ist da", am Monatsletzten "Monatsübersicht ist da".
//
// habit_entries.data ist clientseitig verschlüsselt – die Vollständigkeits-Prüfung
// läuft deshalb (in der SQL-Funktion) über die unverschlüsselte Spalte
// habit_entries.filled_slugs (nur Slugs der befüllten Felder, keine Werte).

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:example@example.com';
// Schützt die Function davor, von außen aufgerufen zu werden: der Anon-Key im Frontend
// reicht der Supabase-Gateway-JWT-Prüfung (verify_jwt) allein schon, um die Function
// aufzurufen — ohne diesen zusätzlichen Header könnte jede*r sie beliebig oft triggern
// und würde dabei JEDES MAL alle fälligen Nutzer benachrichtigen (Spam-Push-Risiko).
// Nur der Cron-Job kennt das zugehörige Vault-Secret 'cron_secret' (siehe
// CLAUDE.md "Secrets" → Vault-Secrets).
const CRON_SECRET = Deno.env.get('CRON_SECRET')!;

// Wie viele Abos gleichzeitig beliefert werden – parallel statt nacheinander, damit
// ein Lauf auch bei vielen fälligen Nutzern im Zeitlimit der Function bleibt, aber
// begrenzt, um den Push-Diensten (FCM/Apple/Mozilla) nicht zu viele gleichzeitige
// Verbindungen aufzuzwingen.
const SEND_CONCURRENCY = 25;
// Seitengröße beim Abrufen der fälligen Abos – muss unter api.max_rows (1000, siehe
// supabase/config.toml) bleiben, sonst kappt PostgREST die Antwort still.
const PAGE_SIZE = 500;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

interface PushMessage {
  title: string;
  body: string;
  url: string;
}

// Eine Zeile aus get_due_notifications(): ein Push-Abo plus was ihm gerade zusteht.
interface DueRow {
  subscription_id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  locale: string;
  local_date: string; // 'YYYY-MM-DD', "heute" in der Zeitzone des Nutzers
  default_reminder: boolean;
  custom_missing: string[];
  week_summary: boolean;
  month_summary: boolean;
}

// Ziel-URL einer Benachrichtigung: Ansicht + der Tag, auf den sie sich bezieht (nicht
// "heute zum Klick-Zeitpunkt" - eine Wochenübersicht, die erst Montagmorgen angetippt
// wird, soll trotzdem die gemeinte, schon abgelaufene Woche zeigen). Ausgewertet von
// sw.js (notificationclick) und parseDeepLink in logbuch.html.
function deepLink(view: 'today' | 'week' | 'month', dateKey: string): string {
  return `./logbuch.html?view=${view}&date=${dateKey}`;
}

// Eigene, bewusst einfachere Übersetzungstabelle als die t()-Maschinerie im Frontend
// (logbuch.html) — anderes Laufzeit-Environment (Deno statt Browser), kein
// gemeinsam nutzbares Modul zwischen Edge Function und Frontend, und nur 4 Texte.
const PUSH_TEXTS = {
  de: {
    title: 'Logbuch',
    defaultReminder: 'Erinnerung: Noch nicht alle Werte für heute eingetragen.',
    customReminder: (names: string) => `Erinnerung: ${names} noch nicht eingetragen.`,
    weekSummary: 'Deine Wochenübersicht ist da.',
    monthSummary: 'Deine Monatsübersicht ist da.',
  },
  en: {
    title: 'Logbuch',
    defaultReminder: 'Reminder: not all values for today have been entered yet.',
    customReminder: (names: string) => `Reminder: ${names} not entered yet.`,
    weekSummary: 'Your weekly summary is ready.',
    monthSummary: 'Your monthly summary is ready.',
  },
};

function messagesFor(row: DueRow): PushMessage[] {
  const texts = PUSH_TEXTS[row.locale === 'en' ? 'en' : 'de'];
  const date = row.local_date;
  const messages: PushMessage[] = [];
  if (row.default_reminder) {
    messages.push({ title: texts.title, body: texts.defaultReminder, url: deepLink('today', date) });
  }
  if (row.custom_missing.length) {
    messages.push({ title: texts.title, body: texts.customReminder(row.custom_missing.join(', ')), url: deepLink('today', date) });
  }
  if (row.week_summary) {
    messages.push({ title: texts.title, body: texts.weekSummary, url: deepLink('week', date) });
  }
  if (row.month_summary) {
    messages.push({ title: texts.title, body: texts.monthSummary, url: deepLink('month', date) });
  }
  return messages;
}

// Führt `fn` für alle `items` aus, höchstens `limit` gleichzeitig.
async function forEachConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  // Ein fester Zeitpunkt für alle Seiten dieses Laufs (siehe Migration
  // 20260925160000_paginate_get_due_notifications.sql).
  const now = new Date().toISOString();
  const rows: DueRow[] = [];
  let after: string | null = null;
  while (true) {
    const { data, error } = await supabase.rpc('get_due_notifications', {
      p_now: now,
      p_after: after,
      p_limit: PAGE_SIZE,
    });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
    const page = (data ?? []) as DueRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    after = page[page.length - 1].subscription_id;
  }

  const results: Array<{ user_id: string; ok: boolean; detail: string }> = [];

  // Pro Abo nacheinander (Reihenfolge Erinnerung vor Übersicht bleibt erhalten), über
  // die Abos hinweg parallel.
  await forEachConcurrent(rows, SEND_CONCURRENCY, async (row) => {
    const subscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth_key },
    };
    for (const msg of messagesFor(row)) {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(msg));
        results.push({ user_id: row.user_id, ok: true, detail: msg.body });
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        const body = (err as { body?: string })?.body;
        results.push({
          user_id: row.user_id,
          ok: false,
          detail: `${String(err)} | statusCode=${statusCode} body=${body}`,
        });
        // Abgelaufene/ungültige Subscription aufräumen – weitere Nachrichten an sie
        // wären ebenso zwecklos.
        if (statusCode === 404 || statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', row.subscription_id);
          return;
        }
      }
    }
  });

  return new Response(JSON.stringify({ due: rows.length, results }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
