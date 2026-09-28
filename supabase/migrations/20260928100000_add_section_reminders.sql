-- Erinnerungszeit pro Gruppe (habit_sections): Felder einer Gruppe mit eigener Zeit fallen
-- aus der Sammel-Erinnerung zur Standardzeit heraus und werden stattdessen gesammelt zur
-- Zeit der Gruppe erinnert - eine Nachricht pro Gruppe. Ein Feld mit eigener
-- reminder_minute behält diese auch innerhalb einer solchen Gruppe (spezifischste Zeit
-- gewinnt: Feld > Gruppe > Standard).
-- Im Klartext wie habit_definitions.reminder_minute: der Server braucht sie für den
-- Versand. Neu sichtbar für den DB-Owner ist damit nur "diese Gruppe hat eine Erinnerung
-- um X Uhr" - Name und Inhalt bleiben verschlüsselt.

ALTER TABLE "public"."habit_sections"
  ADD COLUMN "reminder_minute" integer,
  ADD CONSTRAINT "habit_sections_reminder_minute_check" CHECK (
    reminder_minute IS NULL OR (reminder_minute >= 0 AND reminder_minute <= 1439 AND reminder_minute % 15 = 0)
  );

-- Rückgabetyp ändert sich (neue Spalte section_missing) - CREATE OR REPLACE reicht dafür nicht.
DROP FUNCTION public.get_due_notifications(timestamptz, uuid, integer);

-- Gegenüber 20260927220000_rename_group_kind_to_computed.sql:
-- - candidates: auch Nutzer mit einer Gruppe, deren Zeit gerade dran ist.
-- - default_reminder: Felder in einer Gruppe mit eigener Zeit zählen nicht mehr mit.
-- - section_missing (neu): je Gruppe, deren Zeit gerade dran ist, die IDs der heute
--   geplanten, noch fehlenden Felder ohne eigene Zeit - [{id, fields: [...]}, ...] nach
--   sort_order der Gruppe. Gruppen ohne fehlendes Feld tauchen nicht auf.
CREATE FUNCTION public.get_due_notifications(
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
    section_missing  jsonb,
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
  -- sein KANN (Standardzeit, eigene Zeit eines heute geplanten aktiven Feldes oder Zeit
  -- einer Gruppe) – nur für die laufen die teureren Eintrags-Abfragen unten.
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
       or exists (select 1 from public.habit_sections s
                  where s.user_id = sl.user_id and s.reminder_minute = sl.slot)
  ),
  due as (
    select c.user_id, c.locale, c.today,
      c.is_default_slot and exists (
        select 1 from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind <> 'computed'
          and h.reminder_minute is null
          and not exists (select 1 from public.habit_sections s
                          where s.id = h.section_id and s.reminder_minute is not null)
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
      coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'fields', m.fields) order by s.sort_order)
        from public.habit_sections s
        cross join lateral (
          select array_agg(h.id::text order by h.sort_order) as fields
          from public.habit_definitions h
          where h.user_id = c.user_id and h.section_id = s.id
            and h.archived_at is null and h.kind <> 'computed'
            and h.reminder_minute is null
            and not (c.filled ? h.id::text or (h.slug is not null and c.filled ? h.slug))
            and public.habit_scheduled_on(h.schedule, c.today)
        ) m
        where s.user_id = c.user_id and s.reminder_minute = c.slot and m.fields is not null
      ), '[]'::jsonb) as section_missing,
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
         d.default_reminder, d.custom_missing, d.section_missing, d.week_summary, d.month_summary
  from due d
  join public.push_subscriptions p on p.user_id = d.user_id
  where (d.default_reminder or cardinality(d.custom_missing) > 0 or jsonb_array_length(d.section_missing) > 0
         or d.week_summary or d.month_summary)
    and (p_after is null or p.id > p_after)
  order by p.id
  limit p_limit;
$function$;

-- Liefert Push-Endpoints aller Nutzer - nur für service_role (wie bisher).
REVOKE ALL ON FUNCTION public.get_due_notifications(timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_due_notifications(timestamptz, uuid, integer) TO service_role;
