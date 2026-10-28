-- Bis zu vier Erinnerungszeiten pro Tagesfeld, auch für Zähler (Nutzer-Entscheidung
-- 2026-10-28). Ein Zähler mit Ziel "mindestens" erinnert zur i-ten Zeit nur, wenn das i-te
-- Zwischenziel noch nicht erreicht ist; ohne ein solches Ziel erinnert er zu jeder Zeit.
--
-- Datenschutz (Nutzer-Entscheidung 2026-10-28): der Server erfährt nur, wie viele
-- Erinnerungs-Stufen eines Zählers heute erreicht sind (habit_entries.reminder_progress,
-- z.B. {"<Feld-ID>": 1}) - nicht den Zählerstand, nicht das Ziel, nicht den Namen. Der
-- Client rechnet die Stufe aus (siehe reminderProgress in logbuch.js).

-- 1. Zeiten: reminder_minutes (aufsteigend, 1-4 Einträge im 15-Minuten-Raster) - null, wenn
--    das Feld keine oder nur eine Zeit hat (dann gilt wie bisher reminder_minute).
CREATE FUNCTION public.habit_reminder_minutes_valid(p_minutes integer[])
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
begin
  if p_minutes is null then return true; end if;
  if cardinality(p_minutes) not between 1 and 4 or array_ndims(p_minutes) <> 1 then return false; end if;
  for i in 1 .. cardinality(p_minutes) loop
    if p_minutes[i] is null or p_minutes[i] not between 0 and 1425 or p_minutes[i] % 15 <> 0 then
      return false;
    end if;
    if i > 1 and p_minutes[i] <= p_minutes[i - 1] then return false; end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$function$;

-- Wird in einer CHECK-Regel benutzt: authenticated braucht das Ausführungsrecht, anon nicht.
REVOKE ALL ON FUNCTION public.habit_reminder_minutes_valid(integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.habit_reminder_minutes_valid(integer[]) TO authenticated, service_role;

ALTER TABLE "public"."habit_definitions" ADD COLUMN "reminder_minutes" integer[];
ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_reminder_minutes_check" CHECK (public.habit_reminder_minutes_valid(reminder_minutes));

-- Verträglichkeit mit der älteren App (Live und Beta teilen die Datenbank): die kennt nur
-- reminder_minute. Ändert sie die Zeit, gilt nur noch diese eine (reminder_minutes fällt
-- weg); reminder_minute ist immer die erste Zeit, damit sie sie richtig anzeigt.
CREATE FUNCTION public.habit_definitions_sync_reminder_minutes()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  if tg_op = 'UPDATE'
     and new.reminder_minute is distinct from old.reminder_minute
     and new.reminder_minutes is not distinct from old.reminder_minutes then
    new.reminder_minutes := null;
  end if;
  if new.reminder_minutes is not null then
    new.reminder_minute := new.reminder_minutes[1];
  end if;
  return new;
end;
$function$;

CREATE TRIGGER habit_definitions_sync_reminder_minutes
  BEFORE INSERT OR UPDATE ON public.habit_definitions
  FOR EACH ROW EXECUTE FUNCTION public.habit_definitions_sync_reminder_minutes();

-- 2. Erreichte Erinnerungs-Stufen der Zähler an diesem Tag: {"<Feld-ID>": 0-4}.
--    get_due_notifications liest das für alle Nutzer in einem Rutsch - ein ungültiger Wert
--    (keine ganze Zahl) darf den Lauf nicht abbrechen, deshalb die Prüfung.
CREATE FUNCTION public.habit_reminder_progress_valid(p_progress jsonb)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
begin
  if jsonb_typeof(p_progress) <> 'object' then return false; end if;
  return (select count(*) from jsonb_object_keys(p_progress)) <= 500
    and not exists (
      select 1 from jsonb_each(p_progress) e
      where jsonb_typeof(e.value) <> 'number' or e.value::text !~ '^[0-4]$');
exception when others then
  return false;
end;
$function$;

REVOKE ALL ON FUNCTION public.habit_reminder_progress_valid(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.habit_reminder_progress_valid(jsonb) TO authenticated, service_role;

ALTER TABLE "public"."habit_entries" ADD COLUMN "reminder_progress" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "public"."habit_entries"
  ADD CONSTRAINT "habit_entries_reminder_progress_check" CHECK (public.habit_reminder_progress_valid(reminder_progress));

-- 3. get_due_notifications: gegenüber 20261011140000_add_counter_kind.sql
--    - Zeiten eines Felds: reminder_minutes, sonst reminder_minute (habit_reminder_times)
--    - neue Spalte counter_due: Zähler mit eigener Zeit, deren Stufe zu dieser Zeit noch
--      nicht erreicht ist (eigener Text, siehe send-notifications). Zähler bleiben aus
--      Standard- und Gruppen-Erinnerung heraus.
CREATE FUNCTION public.habit_reminder_times(p_minutes integer[], p_minute integer)
  RETURNS integer[]
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select case when p_minutes is not null then p_minutes
              when p_minute is not null then array[p_minute]
              else '{}'::integer[] end;
$function$;

REVOKE ALL ON FUNCTION public.habit_reminder_times(integer[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.habit_reminder_times(integer[], integer) TO service_role;

DROP FUNCTION public.get_due_notifications(timestamptz, uuid, integer);

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
    month_summary    boolean,
    counter_due      text[]
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
  -- sein KANN (Standardzeit, eine Zeit eines heute geplanten aktiven Feldes oder Zeit
  -- einer Gruppe) – nur für die laufen die teureren Eintrags-Abfragen unten.
  candidates as (
    select sl.*,
           sl.slot = sl.default_reminder_minute as is_default_slot,
           coalesce(e.filled_slugs, '[]'::jsonb) as filled,
           coalesce(e.reminder_progress, '{}'::jsonb) as progress
    from slotted sl
    left join public.habit_entries e on e.user_id = sl.user_id and e.entry_date = sl.today
    where sl.slot = sl.default_reminder_minute
       or exists (select 1 from public.habit_definitions h
                  where h.user_id = sl.user_id and h.archived_at is null
                    and sl.slot = any(public.habit_reminder_times(h.reminder_minutes, h.reminder_minute))
                    and public.habit_scheduled_on(h.schedule, sl.today))
       or exists (select 1 from public.habit_sections s
                  where s.user_id = sl.user_id and s.reminder_minute = sl.slot)
  ),
  due as (
    select c.user_id, c.locale, c.today,
      c.is_default_slot and exists (
        select 1 from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind NOT IN ('computed', 'counter')
          and h.period = 'day'
          and h.reminder_minute is null
          and not exists (select 1 from public.habit_sections s
                          where s.id = h.section_id and s.reminder_minute is not null)
          and not (c.filled ? h.id::text or (h.slug is not null and c.filled ? h.slug))
          and public.habit_scheduled_on(h.schedule, c.today)
      ) as default_reminder,
      coalesce((
        select array_agg(h.id::text order by h.sort_order) from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind NOT IN ('computed', 'counter')
          and (
            (h.period = 'day'
              and c.slot = any(public.habit_reminder_times(h.reminder_minutes, h.reminder_minute))
              and not (c.filled ? h.id::text or (h.slug is not null and c.filled ? h.slug))
              and public.habit_scheduled_on(h.schedule, c.today))
            or (h.period <> 'day'
              and coalesce(h.reminder_minute, c.default_reminder_minute) = c.slot
              and public.habit_period_reminder_due(h.period, h.period_reminder_day, c.today)
              and not coalesce((select e.filled_slugs from public.habit_entries e
                                where e.user_id = c.user_id
                                  and e.entry_date = public.habit_period_start(h.period, c.today)), '[]'::jsonb)
                      ? h.id::text)
          )
      ), '{}') as custom_missing,
      coalesce((
        select jsonb_agg(jsonb_build_object('id', s.id, 'fields', m.fields) order by s.sort_order)
        from public.habit_sections s
        cross join lateral (
          select array_agg(h.id::text order by h.sort_order) as fields
          from public.habit_definitions h
          where h.user_id = c.user_id and h.section_id = s.id
            and h.archived_at is null and h.kind NOT IN ('computed', 'counter')
            and h.period = 'day'
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
                      and jsonb_array_length(e.filled_slugs) > 0) as month_summary,
      -- i-te Zeit eines Zählers: fällig, solange weniger als i Stufen erreicht sind.
      coalesce((
        select array_agg(h.id::text order by h.sort_order) from public.habit_definitions h
        cross join lateral (
          select array_position(public.habit_reminder_times(h.reminder_minutes, h.reminder_minute), c.slot) as pos
        ) t
        where h.user_id = c.user_id and h.archived_at is null and h.kind = 'counter'
          and h.period = 'day'
          and t.pos is not null
          and coalesce((c.progress ->> h.id::text)::int, 0) < t.pos
          and public.habit_scheduled_on(h.schedule, c.today)
      ), '{}') as counter_due
    from candidates c
  )
  select p.id, d.user_id, p.endpoint, p.p256dh, p.auth_key, d.locale, d.today,
         d.default_reminder, d.custom_missing, d.section_missing, d.week_summary, d.month_summary,
         d.counter_due
  from due d
  join public.push_subscriptions p on p.user_id = d.user_id
  where (d.default_reminder or cardinality(d.custom_missing) > 0 or jsonb_array_length(d.section_missing) > 0
         or d.week_summary or d.month_summary or cardinality(d.counter_due) > 0)
    and (p_after is null or p.id > p_after)
  order by p.id
  limit p_limit;
$function$;

-- Liefert Push-Endpoints aller Nutzer - nur für service_role (wie bisher).
REVOKE ALL ON FUNCTION public.get_due_notifications(timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_due_notifications(timestamptz, uuid, integer) TO service_role;
