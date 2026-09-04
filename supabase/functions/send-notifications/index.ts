// Datei nach dem Deployment ablegen unter: supabase/functions/send-notifications/index.ts
//
// Läuft stündlich (per pg_cron, siehe supabase-setup.sql) und schickt Erinnerungen an
// Nutzer, deren Felder gerade "fällig" sind:
// 1. Alle aktiven Felder OHNE eigene `reminder_hour` werden gemeinsam zur
//    Standard-Erinnerungszeit des Nutzers geprüft (`user_settings.default_reminder_hour`,
//    Default 22 Uhr Berliner Zeit, im Menü der App änderbar) — EINE Sammel-Nachricht,
//    wenn heute noch nicht alle davon ausgefüllt sind (nicht erst wenn der ganze Tag
//    leer ist), egal ob Skala- oder Zahlenwert-Feld.
// 2. Jedes Feld MIT eigener `reminder_hour` wird unabhängig davon genau zu dieser
//    Stunde geprüft (z.B. Gewicht typischerweise morgens statt zur Standardzeit).
// Zusätzlich zur Standard-Erinnerungszeit: sonntags "Wochenübersicht ist da", am
// Monatsletzten "Monatsübersicht ist da".
//
// Läuft stündlich statt nur zu festen Zeitpunkten, weil die zuständige Stunde jetzt
// weder auf 8/22 noch auf einen für alle Nutzer gleichen Wert beschränkt ist, sondern
// pro Nutzer (Standardzeit) und pro Feld (eigene Zeit) frei gewählt sein kann. Jede der
// 24 stündlichen Ausführungen bestimmt ihre Berliner Stunde frisch per Intl — das deckt
// Sommer-/Winterzeit weiterhin automatisch ab, ganz ohne feste UTC-Zeitpunkte-Liste.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:example@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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

interface HabitDef {
  user_id: string;
  slug: string;
  name: string;
  reminder_hour: number | null;
}

Deno.serve(async () => {
  const berlin = getBerlinParts(new Date());
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

  const { data: defs, error: defErr } = await supabase
    .from('habit_definitions')
    .select('user_id, slug, name, reminder_hour')
    .is('archived_at', null);
  if (defErr) {
    return new Response(JSON.stringify({ error: defErr.message }), { status: 500 });
  }
  const defsByUser = new Map<string, HabitDef[]>();
  for (const d of (defs ?? []) as HabitDef[]) {
    const list = defsByUser.get(d.user_id) ?? [];
    list.push(d);
    defsByUser.set(d.user_id, list);
  }

  const { data: settings, error: settingsErr } = await supabase
    .from('user_settings')
    .select('user_id, default_reminder_hour');
  if (settingsErr) {
    return new Response(JSON.stringify({ error: settingsErr.message }), { status: 500 });
  }
  const defaultHourByUser = new Map<string, number>();
  for (const s of settings ?? []) defaultHourByUser.set(s.user_id, s.default_reminder_hour);

  // Für einen Nutzer die Namen der heute noch fehlenden Felder aus `group`, oder null,
  // wenn nichts fehlt (bzw. die Gruppe leer ist).
  function missingNames(group: HabitDef[], dayData: Record<string, unknown>): string[] {
    return group.filter((d) => dayData[d.slug] === undefined).map((d) => d.name);
  }

  const results: Array<{ user_id: string; ok: boolean; detail: string }> = [];

  for (const sub of subs ?? []) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth_key },
    };
    const dayData = entryByUser.get(sub.user_id) ?? {};
    const defsForUser = defsByUser.get(sub.user_id) ?? [];
    const defaultHour = defaultHourByUser.get(sub.user_id) ?? 22;
    const messages: PushMessage[] = [];

    const groups: HabitDef[][] = [];
    if (berlin.hour === defaultHour) {
      groups.push(defsForUser.filter((d) => d.reminder_hour === null));
    }
    groups.push(defsForUser.filter((d) => d.reminder_hour === berlin.hour));

    for (const group of groups) {
      if (!group.length) continue;
      const missing = missingNames(group, dayData);
      if (missing.length) {
        messages.push({
          title: 'Logbuch',
          body: `Erinnerung: ${missing.join(', ')} noch nicht eingetragen.`,
          url: './logbuch.html',
        });
      }
    }

    if (berlin.hour === defaultHour) {
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
        const body = (err as { body?: string })?.body;
        results.push({
          user_id: sub.user_id,
          ok: false,
          detail: `${String(err)} | statusCode=${statusCode} body=${body}`,
        });
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
