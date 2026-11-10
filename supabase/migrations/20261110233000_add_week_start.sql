-- G2 Wochenbeginn einstellbar (Nutzer-Entscheidung 2026-11-10, docs/datenmodell.md → Zeiträume).
-- week_start = ISO-Wochentag des ersten Tags der Woche: 1 Montag (Standard), 7 Sonntag, 6 Samstag.
-- week_start_pending: ein laufender Umzug der Wochen-Einträge (App setzt ihn vor dem Umzug, das
-- Ende setzt week_start und leert ihn - so lässt sich ein abgebrochener Umzug fortsetzen).
-- CHECKs, weil get_due_notifications week_start für alle Nutzer in einem Lauf liest.
alter table public.user_settings
  add column week_start smallint not null default 1 check (week_start in (1, 6, 7)),
  add column week_start_pending smallint check (week_start_pending in (1, 6, 7));

-- Letzter Tag der Woche (ISO-Wochentag) zum Wochenbeginn: Mo -> So (7), So -> Sa (6), Sa -> Fr (5).
create function public.habit_week_last_isodow(p_week_start smallint)
returns int language sql immutable set search_path to ''
as $$ select ((p_week_start + 5) % 7) + 1 $$;

-- Wie habit_period_start / habit_period_reminder_due, mit Wochenbeginn. Die Fassungen ohne
-- bleiben für die alte App-Version und ältere Aufrufer (Woche = Montag). JS-Gegenstück:
-- periodStart / periodReminderDefault - synchron halten.
create function public.habit_period_start(p_period text, p_date date, p_week_start smallint)
returns date language plpgsql immutable set search_path to ''
as $function$
begin
  if p_period = 'week' then
    return p_date - ((extract(isodow from p_date)::int - p_week_start + 7) % 7);
  end if;
  return public.habit_period_start(p_period, p_date);
end;
$function$;

create function public.habit_period_reminder_due(p_period text, p_day smallint, p_date date, p_week_start smallint)
returns boolean language plpgsql immutable set search_path to ''
as $function$
begin
  if p_period = 'week' then
    return extract(isodow from p_date)::int = coalesce(p_day, public.habit_week_last_isodow(p_week_start));
  end if;
  return public.habit_period_reminder_due(p_period, p_day, p_date);
end;
$function$;

revoke all on function public.habit_week_last_isodow(smallint) from public, anon;
revoke all on function public.habit_period_start(text, date, smallint) from public, anon;
revoke all on function public.habit_period_reminder_due(text, smallint, date, smallint) from public, anon;
grant execute on function public.habit_week_last_isodow(smallint) to authenticated, service_role;
grant execute on function public.habit_period_start(text, date, smallint) to authenticated, service_role;
grant execute on function public.habit_period_reminder_due(text, smallint, date, smallint) to authenticated, service_role;

-- get_due_notifications: gegenüber 20261110232000_add_optional_field.sql nur der Wochenbeginn
-- (Zeitraum-Start und Erinnerungstag der Wochenfelder, Tag der Wochenübersicht = letzter Tag der
-- Woche). Mit Standard 1 für alle bisherigen Nutzer unverändert.
CREATE OR REPLACE FUNCTION public.get_due_notifications(p_now timestamp with time zone DEFAULT now(), p_after uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 500)
 RETURNS TABLE(subscription_id uuid, user_id uuid, endpoint text, p256dh text, auth_key text, locale text, local_date date, default_reminder boolean, custom_missing text[], section_missing jsonb, week_summary boolean, month_summary boolean, counter_due text[])
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with local_time as (
    select s.user_id, s.locale, s.summary_notifications, s.default_reminder_minute, s.week_start,
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
          and not h.optional
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
              and public.habit_period_reminder_due(h.period, h.period_reminder_day, c.today, c.week_start)
              and not coalesce((select e.filled_slugs from public.habit_entries e
                                where e.user_id = c.user_id
                                  and e.entry_date = public.habit_period_start(h.period, c.today, c.week_start)), '[]'::jsonb)
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
            and not h.optional
            and not (c.filled ? h.id::text or (h.slug is not null and c.filled ? h.slug))
            and public.habit_scheduled_on(h.schedule, c.today)
        ) m
        where s.user_id = c.user_id and s.reminder_minute = c.slot and m.fields is not null
      ), '[]'::jsonb) as section_missing,
      c.is_default_slot and c.summary_notifications and extract(isodow from c.today) = public.habit_week_last_isodow(c.week_start)
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

insert into public.feature_flags (key, stage, note) values ('weekstart', 'owner', 'Wochenbeginn einstellbar');
