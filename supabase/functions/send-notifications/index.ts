// Datei nach dem Deployment ablegen unter: supabase/functions/send-notifications/index.ts
//
// Läuft einmal täglich (per pg_cron, siehe supabase-setup.sql) und:
// 1. schickt eine Erinnerung an alle Nutzer, die heute noch nichts eingetragen haben
// 2. schickt sonntags einen Hinweis, dass die Wochenübersicht bereit ist
// 3. schickt am letzten Tag des Monats einen Hinweis, dass die Monatsübersicht bereit ist

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:example@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function formatKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Liefert Datum/Uhrzeit korrekt umgerechnet auf Berliner Zeit (inkl. Sommer-/Winterzeit,
// von der Intl-API automatisch anhand der IANA-Zeitzonendatenbank berücksichtigt).
function getBerlinParts(date: Date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    weekday: parts.weekday, // 'Sun', 'Mon', ...
  };
}

interface PushMessage {
  title: string;
  body: string;
  url: string;
}

Deno.serve(async () => {
  const berlin = getBerlinParts(new Date());

  // Der Cron-Job ruft diese Function viermal täglich auf (6, 7, 20 & 21 Uhr UTC), um die
  // Sommer-/Winterzeit-Verschiebung für beide Erinnerungszeiten (8 & 22 Uhr Berliner Zeit)
  // abzudecken. Nur der Durchlauf, der wirklich auf 8 oder 22 Uhr Berliner Zeit trifft,
  // macht weiter — die anderen brechen sofort ab.
  if (berlin.hour !== 8 && berlin.hour !== 22) {
    return new Response(
      JSON.stringify({ skipped: true, reason: `Berliner Stunde ist ${berlin.hour}, weder 8 noch 22` }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  const todayKey = berlin.dateKey;
  const isSunday = berlin.weekday === 'Sun';
  const isLastDayOfMonth = new Date(berlin.year, berlin.month, 0).getDate() === berlin.day;

  const { data: subs, error: subErr } = await supabase
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth_key');
  if (subErr) {
    return new Response(JSON.stringify({ error: subErr.message }), { status: 500 });
  }

  const { data: todayEntries, error: entryErr } = await supabase
    .from('habit_entries')
    .select('user_id, data')
    .eq('entry_date', todayKey);
  if (entryErr) {
    return new Response(JSON.stringify({ error: entryErr.message }), { status: 500 });
  }

  const entryByUser = new Map<string, Record<string, unknown>>();
  for (const e of todayEntries ?? []) entryByUser.set(e.user_id, e.data ?? {});

  // Aktive (nicht archivierte) Feld-Slugs je Nutzer, für den 22-Uhr-"überhaupt was
  // eingetragen?"-Check — jeder Nutzer verwaltet seine Felder selbst (siehe
  // habit_definitions), Gewicht zählt hier bewusst nicht mit (eigene 8-Uhr-Prüfung).
  const habitIdsByUser = new Map<string, string[]>();
  if (berlin.hour === 22) {
    const { data: defs, error: defErr } = await supabase
      .from('habit_definitions')
      .select('user_id, slug')
      .is('archived_at', null);
    if (defErr) {
      return new Response(JSON.stringify({ error: defErr.message }), { status: 500 });
    }
    for (const d of defs ?? []) {
      const list = habitIdsByUser.get(d.user_id) ?? [];
      list.push(d.slug);
      habitIdsByUser.set(d.user_id, list);
    }
  }

  const results: Array<{ user_id: string; ok: boolean; detail: string }> = [];

  for (const sub of subs ?? []) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth_key },
    };
    const dayData = entryByUser.get(sub.user_id) ?? {};
    const messages: PushMessage[] = [];

    if (berlin.hour === 8) {
      if (dayData.weight === undefined || dayData.weight === null) {
        messages.push({
          title: 'Logbuch',
          body: 'Erinnerung: Trag heute noch dein Gewicht ein.',
          url: './logbuch.html',
        });
      }
    }

    if (berlin.hour === 22) {
      const habitIds = habitIdsByUser.get(sub.user_id) ?? [];
      const hasHabitEntry = habitIds.some((id) => dayData[id] !== undefined);
      if (!hasHabitEntry) {
        messages.push({
          title: 'Logbuch',
          body: 'Erinnerung: Trage heute noch deine Habits ein.',
          url: './logbuch.html',
        });
      }
      if (isSunday) {
        messages.push({ title: 'Logbuch', body: 'Deine Wochenübersicht ist da.', url: './logbuch.html' });
      }
      if (isLastDayOfMonth) {
        messages.push({ title: 'Logbuch', body: 'Deine Monatsübersicht ist da.', url: './logbuch.html' });
      }
    }

    for (const msg of messages) {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(msg));
        results.push({ user_id: sub.user_id, ok: true, detail: msg.body });
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        results.push({ user_id: sub.user_id, ok: false, detail: String(err) });
        // Abgelaufene/ungültige Subscription aufräumen
        if (statusCode === 404 || statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        }
      }
    }
  }

  return new Response(JSON.stringify({ processed: subs?.length ?? 0, results }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
