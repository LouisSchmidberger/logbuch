-- Begriffe neu geordnet (2026-09-27): was bisher "Gruppe" hieß (kind='group', ein Feld,
-- das aus anderen Feldern einen Wert berechnet), ist jetzt der Feldtyp "Berechnet"
-- (kind='computed'); "Gruppe" heißen in der App ab jetzt die einklappbaren Abschnitte
-- (intern weiterhin habit_sections). Damit "group" im Code/in der DB nicht dauerhaft
-- etwas anderes bedeutet als "Gruppe" in der App, wird der Typ hier umbenannt.
-- Nur Klartext-Spalte kind betroffen - die verschlüsselte payload bleibt unverändert.

ALTER TABLE "public"."habit_definitions" DROP CONSTRAINT "habit_definitions_kind_check";
ALTER TABLE "public"."habit_definitions" DROP CONSTRAINT "habit_definitions_kind_fields_check";
ALTER TABLE "public"."habit_definitions" DROP CONSTRAINT "habit_definitions_schedule_check";

UPDATE "public"."habit_definitions" SET kind = 'computed' WHERE kind = 'group';

ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_kind_check" CHECK ((kind = ANY (ARRAY['scale'::text, 'number'::text, 'computed'::text, 'text'::text])));

ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_kind_fields_check" CHECK (enc IS NOT NULL OR (
    ((kind = 'scale'::text) AND (min IS NOT NULL) AND (max IS NOT NULL) AND (group_members IS NULL) AND ((good IS NOT NULL) OR (goal_threshold IS NULL))) OR
    ((kind = 'number'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (goal_threshold IS NULL) AND (group_members IS NULL)) OR
    ((kind = 'computed'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (unit IS NULL) AND (group_members IS NOT NULL)) OR
    ((kind = 'text'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (unit IS NULL) AND (goal_threshold IS NULL) AND (group_members IS NULL))
  ));

ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_schedule_check" CHECK (
    schedule IS NULL OR (
      kind <> 'computed'
      AND jsonb_typeof(schedule) = 'object'
      AND schedule->>'type' IN ('weekly', 'monthly', 'yearly', 'interval')
    )
  );

-- get_due_notifications: berechnete Felder sind nie selbst befüllbar und zählen deshalb
-- nie als "fehlend" (vorher: kind <> 'group'). Sonst unverändert gegenüber
-- 20260927180000_encrypt_habit_definitions_prep.sql.
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
        where h.user_id = c.user_id and h.archived_at is null and h.kind <> 'computed'
          and h.reminder_minute is null
          and not (c.filled ? h.id::text or (h.slug is not null and c.filled ? h.slug))
          and public.habit_scheduled_on(h.schedule, c.today)
      ) as default_reminder,
      coalesce((
        select array_agg(h.id::text order by h.sort_order) from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind <> 'computed'
          and h.reminder_minute = c.slot
          and not (c.filled ? h.id::text or (h.slug is not null and c.filled ? h.slug))
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
