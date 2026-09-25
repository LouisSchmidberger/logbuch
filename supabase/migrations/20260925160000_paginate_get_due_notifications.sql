-- get_due_notifications() seitenweise abrufbar machen (Keyset-Pagination) + fester
-- Referenzzeitpunkt. Hintergrund: PostgREST kappt jede Antwort bei api.max_rows (1000,
-- siehe config.toml), auch RPC-Ergebnisse – ohne Seiten würden bei mehr fälligen Abos
-- in einem Slot die übrigen still abgeschnitten. Keyset (p.id > p_after) statt Offset,
-- damit eine zwischen zwei Seiten wegfallende Zeile (jemand trägt gerade ein) nicht
-- alle folgenden verschiebt und dabei ein Abo übersprungen wird. p_now: alle Seiten
-- eines Laufs rechnen mit exakt demselben Zeitpunkt (von send-notifications einmal
-- pro Lauf festgelegt), und die Funktion lässt sich mit beliebigen Zeitpunkten testen.
-- Regeln und Rechte sonst unverändert, siehe 20260925150000_add_get_due_notifications.sql.
DROP FUNCTION public.get_due_notifications();

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
  -- sein KANN (Standardzeit oder eigene Zeit eines aktiven Feldes) – nur für die laufen
  -- die teureren Eintrags-Abfragen unten.
  candidates as (
    select sl.*,
           sl.slot = sl.default_reminder_minute as is_default_slot,
           coalesce((select e.filled_slugs from public.habit_entries e
                     where e.user_id = sl.user_id and e.entry_date = sl.today), '[]'::jsonb) as filled
    from slotted sl
    where sl.slot = sl.default_reminder_minute
       or exists (select 1 from public.habit_definitions h
                  where h.user_id = sl.user_id and h.archived_at is null and h.reminder_minute = sl.slot)
  ),
  due as (
    select c.user_id, c.locale, c.today,
      c.is_default_slot and exists (
        select 1 from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind <> 'group'
          and h.reminder_minute is null and not (c.filled ? h.slug)
      ) as default_reminder,
      coalesce((
        select array_agg(h.name order by h.sort_order) from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind <> 'group'
          and h.reminder_minute = c.slot and not (c.filled ? h.slug)
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

REVOKE ALL ON FUNCTION public.get_due_notifications(timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_due_notifications(timestamptz, uuid, integer) TO service_role;
