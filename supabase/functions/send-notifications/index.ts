// Datei nach dem Deployment ablegen unter: supabase/functions/send-notifications/index.ts
//
// Läuft alle 15 Minuten (per pg_cron, siehe supabase/migrations/) und schickt
// Erinnerungen an Nutzer, deren Felder gerade "fällig" sind:
// 1. Alle aktiven Felder OHNE eigene `reminder_minute` werden gemeinsam zur
//    Standard-Erinnerungszeit des Nutzers geprüft (`user_settings.default_reminder_minute`,
//    Minuten seit Mitternacht Berliner Zeit, Default 1320 = 22:00, im Menü der App
//    in 15-Minuten-Schritten änderbar) — EINE Sammel-Nachricht, wenn heute noch nicht
//    alle davon ausgefüllt sind (nicht erst wenn der ganze Tag leer ist), egal ob
//    Skala- oder Zahlenwert-Feld.
// 2. Jedes Feld MIT eigener `reminder_minute` wird unabhängig davon genau zu dieser
//    Zeit geprüft (z.B. Gewicht typischerweise morgens statt zur Standardzeit).
// Zusätzlich zur Standard-Erinnerungszeit: sonntags "Wochenübersicht ist da", am
// Monatsletzten "Monatsübersicht ist da".
//
// Läuft alle 15 Minuten statt nur zu festen Zeitpunkten, weil die zuständige Zeit
// jetzt weder auf 8/22 Uhr noch auf einen für alle Nutzer gleichen Wert beschränkt
// ist, sondern pro Nutzer (Standardzeit) und pro Feld (eigene Zeit) frei in
// 15-Minuten-Schritten gewählt sein kann. Jede Ausführung bestimmt ihre Berliner
// Minuten-seit-Mitternacht frisch per Intl — das deckt Sommer-/Winterzeit weiterhin
// automatisch ab (der Berlin-UTC-Offset ist immer eine volle Stunde, die
// 15-Minuten-Ausrichtung bleibt also unabhängig von der Umstellung erhalten), ganz
// ohne feste UTC-Zeitpunkte-Liste.
//
// habit_entries.data ist seit der clientseitigen Verschlüsselung nur noch Chiffretext
// ({iv, ciphertext}) — diese Function kann sie nicht lesen. Für die
// Vollständigkeits-Prüfung dient stattdessen die unverschlüsselte Klartext-Spalte
// habit_entries.filled_slugs (nur die Slugs der befüllten Felder, keine Werte).

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
// und würde dabei JEDES MAL alle Nutzer verarbeiten (Spam-Push-Risiko, unnötige Last).
// Nur der Cron-Job kennt das zugehörige Vault-Secret 'cron_secret' (siehe
// CLAUDE.md "Secrets" → Vault-Secrets).
const CRON_SECRET = Deno.env.get('CRON_SECRET')!;

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
    minute: '2-digit',
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
    minutesSinceMidnight: Number(parts.hour === '24' ? '0' : parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday, // 'Sun', 'Mon', ...
  };
}

interface PushMessage {
  title: string;
  body: string;
  url: string;
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
type Locale = keyof typeof PUSH_TEXTS;

interface HabitDef {
  user_id: string;
  slug: string;
  name: string;
  kind: string;
  reminder_minute: number | null;
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

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

  // `data` ist seit der clientseitigen Verschlüsselung nur noch Chiffretext
  // ({iv, ciphertext}) — die Function kann und darf sie nicht lesen. Für die
  // Vollständigkeits-Prüfung reicht die unverschlüsselte Klartext-Liste der an dem
  // Tag befüllten Slugs (nur Vorhandensein, keine Werte).
  const { data: todayEntries, error: entryErr } = await supabase
    .from('habit_entries')
    .select('user_id, filled_slugs')
    .eq('entry_date', todayKey);
  if (entryErr) {
    return new Response(JSON.stringify({ error: entryErr.message }), { status: 500 });
  }
  const filledSlugsByUser = new Map<string, string[]>();
  for (const e of todayEntries ?? []) filledSlugsByUser.set(e.user_id, e.filled_slugs ?? []);

  const { data: defs, error: defErr } = await supabase
    .from('habit_definitions')
    .select('user_id, slug, name, kind, reminder_minute')
    .is('archived_at', null);
  if (defErr) {
    return new Response(JSON.stringify({ error: defErr.message }), { status: 500 });
  }
  const defsByUser = new Map<string, HabitDef[]>();
  // Gruppierte Felder (kind='group') sind nie direkt befüllbar und tauchen deshalb
  // nie in filled_slugs auf — ohne diesen Ausschluss würden sie die Sammel-Erinnerung
  // dauerhaft fälschlich als "fehlend" auslösen.
  for (const d of (defs ?? []) as HabitDef[]) {
    if (d.kind === 'group') continue;
    const list = defsByUser.get(d.user_id) ?? [];
    list.push(d);
    defsByUser.set(d.user_id, list);
  }

  const { data: settings, error: settingsErr } = await supabase
    .from('user_settings')
    .select('user_id, default_reminder_minute, locale');
  if (settingsErr) {
    return new Response(JSON.stringify({ error: settingsErr.message }), { status: 500 });
  }
  const defaultMinuteByUser = new Map<string, number>();
  const localeByUser = new Map<string, Locale>();
  for (const s of settings ?? []) {
    defaultMinuteByUser.set(s.user_id, s.default_reminder_minute);
    localeByUser.set(s.user_id, s.locale === 'en' ? 'en' : 'de');
  }

  // Für einen Nutzer die Namen der heute noch fehlenden Felder aus `group`, oder null,
  // wenn nichts fehlt (bzw. die Gruppe leer ist).
  function missingNames(group: HabitDef[], filledSlugs: string[]): string[] {
    return group.filter((d) => !filledSlugs.includes(d.slug)).map((d) => d.name);
  }

  const results: Array<{ user_id: string; ok: boolean; detail: string }> = [];

  for (const sub of subs ?? []) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth_key },
    };
    const filledSlugs = filledSlugsByUser.get(sub.user_id) ?? [];
    const defsForUser = defsByUser.get(sub.user_id) ?? [];
    const defaultMinute = defaultMinuteByUser.get(sub.user_id) ?? 1320;
    const texts = PUSH_TEXTS[localeByUser.get(sub.user_id) ?? 'de'];
    const messages: PushMessage[] = [];

    // Sammel-Erinnerung zur Standardzeit: bewusst generisch (nicht jedes fehlende Feld
    // einzeln benannt) — das wäre bei vielen Feldern schnell eine sehr lange Nachricht.
    if (berlin.minutesSinceMidnight === defaultMinute) {
      const defaultGroup = defsForUser.filter((d) => d.reminder_minute === null);
      if (missingNames(defaultGroup, filledSlugs).length) {
        messages.push({
          title: texts.title,
          body: texts.defaultReminder,
          url: deepLink('today', todayKey),
        });
      }
    }

    // Eigene Zeit je Feld: hier macht die konkrete Nennung Sinn, meist nur ein
    // einzelnes bewusst herausgehobenes Feld (z.B. Gewicht morgens).
    const customGroup = defsForUser.filter((d) => d.reminder_minute === berlin.minutesSinceMidnight);
    const missingCustom = missingNames(customGroup, filledSlugs);
    if (missingCustom.length) {
      messages.push({
        title: texts.title,
        body: texts.customReminder(missingCustom.join(', ')),
        url: deepLink('today', todayKey),
      });
    }

    if (berlin.minutesSinceMidnight === defaultMinute) {
      if (isSunday) {
        messages.push({ title: texts.title, body: texts.weekSummary, url: deepLink('week', todayKey) });
      }
      if (isLastDayOfMonth) {
        messages.push({ title: texts.title, body: texts.monthSummary, url: deepLink('month', todayKey) });
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
