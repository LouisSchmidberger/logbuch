-- Zeitraum-Felder (Nutzer-Entscheidung 2026-10-11): ein Feld hat einen Zeitraum - Tag (wie
-- bisher), Woche, Monat oder Jahr. Ein Zeitraum-Feld hat einen Wert pro Zeitraum, an jedem
-- Tag darin setzbar; gespeichert im Eintrag des ersten Tags des Zeitraums (Montag,
-- Monatserster, 1.1.) unter dem Feldschlüssel - keine eigene Tabelle, damit Verschlüsselung,
-- Zusammenführen zweier Geräte, Export und Löschen unverändert bleiben.
--
-- Klartext, weil get_due_notifications sie braucht (wie schedule): period und der Tag der
-- Erinnerung im Zeitraum. Verrät dem Betreiber nur "wöchentliches Feld", keinen Inhalt.
ALTER TABLE "public"."habit_definitions"
  ADD COLUMN "period" text NOT NULL DEFAULT 'day',
  ADD COLUMN "period_reminder_day" smallint;

-- period_reminder_day: an welchem Tag des Zeitraums erinnert wird, null = Standard
-- (Sonntag / Monatsletzter / 31.12.). Woche: ISO-Wochentag 1-7 (7 = Sonntag); Monat: 1-31
-- oder -1 = letzter Tag (gibt es den Tag im Monat nicht, gilt der letzte); Jahr: MMTT
-- (z.B. 1231). Geprüft, weil get_due_notifications über alle Nutzer in einem Rutsch läuft
-- (siehe docs/datenmodell.md -> Robustheit).
ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_period_check" CHECK (
    (period = 'day' AND period_reminder_day IS NULL)
    OR (period = 'week' AND (period_reminder_day IS NULL OR period_reminder_day BETWEEN 1 AND 7))
    OR (period = 'month' AND (period_reminder_day IS NULL OR period_reminder_day = -1 OR period_reminder_day BETWEEN 1 AND 31))
    OR (period = 'year' AND (period_reminder_day IS NULL OR (
          period_reminder_day / 100 BETWEEN 1 AND 12 AND period_reminder_day % 100 BETWEEN 1 AND 31)))
  );
-- Zeitraum-Felder: keine Wiederholung (eigenes Konzept), kein "Berechnet" (Tages- und
-- Zeitraum-Werte zu mitteln ergibt nichts Sinnvolles), keine Gruppe (eigener Bereich in "Heute").
ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_period_combination_check" CHECK (
    period = 'day' OR (schedule IS NULL AND kind <> 'computed' AND section_id IS NULL)
  );

-- Erster Tag des Zeitraums, der ein Datum enthält - dort steht der Wert eines Zeitraum-Felds.
-- Gegenstück zu periodStart() in logbuch.js, muss synchron bleiben.
CREATE OR REPLACE FUNCTION public.habit_period_start(p_period text, p_date date)
  RETURNS date
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
begin
  return case p_period
    when 'week' then p_date - (extract(isodow from p_date)::int - 1)
    when 'month' then date_trunc('month', p_date)::date
    when 'year' then date_trunc('year', p_date)::date
    else p_date
  end;
end;
$function$;

-- Ob an p_date die Erinnerung eines Zeitraum-Felds fällig ist (Tag laut period_reminder_day,
-- null = Standard: Sonntag / Monatsletzter / 31.12.). plpgsql statt sql aus demselben Grund
-- wie habit_scheduled_on (kein Vorab-Ausrechnen nicht zutreffender CASE-Zweige); ein
-- unerwarteter Wert gilt als Standardtag, statt die Abfrage abzubrechen.
CREATE OR REPLACE FUNCTION public.habit_period_reminder_due(p_period text, p_day smallint, p_date date)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  v_last int := extract(day from (date_trunc('month', p_date) + interval '1 month - 1 day'))::int;
  v_month int;
  v_day int;
begin
  if p_period = 'week' then
    return extract(isodow from p_date)::int = coalesce(p_day, 7);
  elsif p_period = 'month' then
    return extract(day from p_date)::int = case when p_day is null or p_day = -1 or p_day > v_last then v_last else p_day end;
  elsif p_period = 'year' then
    v_month := coalesce(p_day / 100, 12);
    v_day := coalesce(p_day % 100, 31);
    if v_month not between 1 and 12 then v_month := 12; v_day := 31; end if;
    return extract(month from p_date)::int = v_month
       and extract(day from p_date)::int = least(v_day, v_last);
  end if;
  return false;
end;
$function$;

DROP FUNCTION public.get_due_notifications(timestamptz, uuid, integer);

-- Gegenüber 20260928100000_add_section_reminders.sql:
-- - Tagesfelder (period = 'day') wie bisher; Standard-, Gruppen- und Feld-Erinnerung zählen
--   nur sie.
-- - Zeitraum-Felder: am Erinnerungstag des Zeitraums zur eigenen Zeit oder Standardzeit, wenn
--   im ersten Tag des Zeitraums noch kein Wert steht - immer mit Namen (in custom_missing),
--   da einzeln und selten.
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
          and h.period = 'day'
          and h.reminder_minute is null
          and not exists (select 1 from public.habit_sections s
                          where s.id = h.section_id and s.reminder_minute is not null)
          and not (c.filled ? h.id::text or (h.slug is not null and c.filled ? h.slug))
          and public.habit_scheduled_on(h.schedule, c.today)
      ) as default_reminder,
      coalesce((
        select array_agg(h.id::text order by h.sort_order) from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind <> 'computed'
          and (
            (h.period = 'day'
              and h.reminder_minute = c.slot
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
            and h.archived_at is null and h.kind <> 'computed'
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
REVOKE ALL ON FUNCTION public.habit_period_start(text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.habit_period_reminder_due(text, smallint, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.habit_period_start(text, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.habit_period_reminder_due(text, smallint, date) TO authenticated, service_role;
