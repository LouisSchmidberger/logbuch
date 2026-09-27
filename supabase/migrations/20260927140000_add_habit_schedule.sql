-- Wiederholung pro Feld: an welchen Tagen ein Feld "dran" ist. NULL = täglich (bisheriges
-- Verhalten). Sonst eins von:
--   {"type":"weekly",   "days":[0,2,4]}                       Wochentage, 0 = Montag … 6 = Sonntag
--   {"type":"monthly",  "day":15}                             Tag im Monat, -1 = letzter Tag
--   {"type":"yearly",   "month":12, "day":24}                 Datum im Jahr
--   {"type":"interval", "every":2, "unit":"week", "start":"2026-09-28"}   alle X Tage/Wochen ab Start
-- Ein Tag, den es im jeweiligen Monat nicht gibt (31. im April, 29.2. außerhalb von
-- Schaltjahren), fällt auf den Monatsletzten statt auszufallen. Gruppen haben keinen
-- eigenen Plan (sie erscheinen, sobald eines ihrer Mitglieder dran ist).
ALTER TABLE "public"."habit_definitions" ADD COLUMN "schedule" jsonb;

ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_schedule_check" CHECK (
    schedule IS NULL OR (
      kind <> 'group'
      AND jsonb_typeof(schedule) = 'object'
      AND schedule->>'type' IN ('weekly', 'monthly', 'yearly', 'interval')
    )
  );

-- Gegenstück zu isScheduledOn() in logbuch.html - beide müssen dieselben Regeln
-- umsetzen. Unbekannte/kaputte Pläne gelten als "dran" (lieber einmal zu oft erinnern
-- als ein Feld still aus den Erinnerungen fallen lassen).
CREATE FUNCTION public.habit_scheduled_on(p_schedule jsonb, p_date date)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select case
    when p_schedule is null then true
    when p_schedule->>'type' = 'weekly' then
      coalesce(p_schedule->'days' @> to_jsonb(extract(isodow from p_date)::int - 1), true)
    when p_schedule->>'type' = 'monthly' then
      extract(day from p_date)::int = least(
        case when (p_schedule->>'day')::int = -1 then 31 else (p_schedule->>'day')::int end,
        extract(day from (date_trunc('month', p_date) + interval '1 month - 1 day'))::int)
    when p_schedule->>'type' = 'yearly' then
      extract(month from p_date)::int = (p_schedule->>'month')::int
      and extract(day from p_date)::int = least(
        (p_schedule->>'day')::int,
        extract(day from (date_trunc('month', p_date) + interval '1 month - 1 day'))::int)
    when p_schedule->>'type' = 'interval' then
      p_date >= (p_schedule->>'start')::date
      and (p_date - (p_schedule->>'start')::date)
          % ((p_schedule->>'every')::int * case when p_schedule->>'unit' = 'week' then 7 else 1 end) = 0
    else true
  end
$function$;

-- get_due_notifications: Felder, die am lokalen "heute" des Nutzers nicht dran sind,
-- zählen weder als fehlend noch lösen sie ihre eigene Erinnerungszeit aus. Sonst
-- unverändert gegenüber 20260925160000_paginate_get_due_notifications.sql (gleiche
-- Signatur, daher CREATE OR REPLACE - Rechte bleiben erhalten).
CREATE OR REPLACE FUNCTION public.get_due_notifications(
    p_now   timestamptz DEFAULT now(),
    p_after uuid        DEFAULT NULL,
    p_limit integer     DEFAULT 500
  )
  RETURNS TABLE (
    subscription_id  uuid,
    user_id          uuid,
    endpoint         text,
    p256dh           text,
    auth_key         text,
    locale           text,
    local_date       date,
    default_reminder boolean,
    custom_missing   text[],
    week_summary     boolean,
    month_summary    boolean
  )
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  with local_time as (
    select s.user_id, s.locale, s.summary_notifications, s.default_reminder_minute,
           p_now at time zone s.timezone as ts
    from public.user_settings s
    where exists (select 1 from public.push_subscriptions p where p.user_id = s.user_id)
  ),
  slotted as (
    select lt.*,
           lt.ts::date as today,
           ((extract(hour from lt.ts)::int * 60 + extract(minute from lt.ts)::int) / 15) * 15 as slot
    from local_time lt
  ),
  -- Früh aussieben: nur Nutzer, bei denen in diesem Slot überhaupt irgendetwas fällig
  -- sein KANN (Standardzeit oder eigene Zeit eines heute geplanten aktiven Feldes) –
  -- nur für die laufen die teureren Eintrags-Abfragen unten.
  candidates as (
    select sl.*,
           sl.slot = sl.default_reminder_minute as is_default_slot,
           coalesce((select e.filled_slugs from public.habit_entries e
                     where e.user_id = sl.user_id and e.entry_date = sl.today), '[]'::jsonb) as filled
    from slotted sl
    where sl.slot = sl.default_reminder_minute
       or exists (select 1 from public.habit_definitions h
                  where h.user_id = sl.user_id and h.archived_at is null and h.reminder_minute = sl.slot
                    and public.habit_scheduled_on(h.schedule, sl.today))
  ),
  due as (
    select c.user_id, c.locale, c.today,
      c.is_default_slot and exists (
        select 1 from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind <> 'group'
          and h.reminder_minute is null and not (c.filled ? h.slug)
          and public.habit_scheduled_on(h.schedule, c.today)
      ) as default_reminder,
      coalesce((
        select array_agg(h.name order by h.sort_order) from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind <> 'group'
          and h.reminder_minute = c.slot and not (c.filled ? h.slug)
          and public.habit_scheduled_on(h.schedule, c.today)
      ), '{}') as custom_missing,
      c.is_default_slot and c.summary_notifications and extract(isodow from c.today) = 7
        and exists (select 1 from public.habit_entries e
                    where e.user_id = c.user_id and e.entry_date between c.today - 6 and c.today
                      and jsonb_array_length(e.filled_slugs) > 0) as week_summary,
      c.is_default_slot and c.summary_notifications and extract(day from c.today + 1) = 1
        and exists (select 1 from public.habit_entries e
                    where e.user_id = c.user_id
                      and e.entry_date between date_trunc('month', c.today)::date and c.today
                      and jsonb_array_length(e.filled_slugs) > 0) as month_summary
    from candidates c
  )
  select p.id, d.user_id, p.endpoint, p.p256dh, p.auth_key, d.locale, d.today,
         d.default_reminder, d.custom_missing, d.week_summary, d.month_summary
  from due d
  join public.push_subscriptions p on p.user_id = d.user_id
  where (d.default_reminder or cardinality(d.custom_missing) > 0 or d.week_summary or d.month_summary)
    and (p_after is null or p.id > p_after)
  order by p.id
  limit p_limit;
$function$;
