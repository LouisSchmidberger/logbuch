-- "Alle N Tage" wieder als Wiederholung (Nutzer-Entscheidung 2026-10-28, Anlass: Tabletten,
-- Pflaster o.ä. mit festem Abstand, der nicht zur Woche passt - alle 2, 3 oder 14 Tage).
-- Gegenüber 20261012170557_schedule_weekdays_only kommt nur {type:'interval', every, unit:
-- 'day', start} hinzu (dieselbe Form wie vor dem 12.10., nur noch in Tagen). Gegenstück zu
-- isScheduledOn() in logbuch.js - beide müssen dieselbe Regel umsetzen.
--
-- habit_definitions_schedule_check ruft habit_schedule_valid auf und gilt damit automatisch.

CREATE OR REPLACE FUNCTION public.habit_schedule_valid(p_schedule jsonb)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  v_int text := '^-?[0-9]{1,3}$'; -- ganze Zahl, kurz genug für jeden ::int-Cast
begin
  if p_schedule is null then return true; end if;
  if jsonb_typeof(p_schedule) <> 'object' then return false; end if;
  case p_schedule->>'type'
    when 'weekly' then
      return jsonb_typeof(p_schedule->'days') = 'array'
        and jsonb_array_length(p_schedule->'days') between 1 and 7
        and not exists (
          select 1 from jsonb_array_elements(p_schedule->'days') d
          where jsonb_typeof(d) <> 'number' or d::text !~ v_int or d::text::int not between 0 and 6);
    when 'interval' then
      if not (jsonb_typeof(p_schedule->'every') = 'number' and (p_schedule->>'every') ~ v_int
              and (p_schedule->>'every')::int between 2 and 365
              and p_schedule->>'unit' = 'day'
              and coalesce(p_schedule->>'start', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
        return false;
      end if;
      -- Echtes Datum (kein 2026-02-31): to_date rollt sonst still über.
      return to_char(to_date(p_schedule->>'start', 'YYYY-MM-DD'), 'YYYY-MM-DD') = p_schedule->>'start';
    else
      return false;
  end case;
exception when others then
  return false;
end;
$function$;

-- Ein ungültiger Plan gilt weiter als "dran" (lieber einmal zu oft erinnern als ein Feld
-- still aus den Erinnerungen fallen lassen). Vor dem Starttag ist ein Intervall nicht dran.
CREATE OR REPLACE FUNCTION public.habit_scheduled_on(p_schedule jsonb, p_date date)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  v_start date;
begin
  if p_schedule is null or not public.habit_schedule_valid(p_schedule) then
    return true;
  end if;
  if p_schedule->>'type' = 'interval' then
    v_start := (p_schedule->>'start')::date;
    return p_date >= v_start and (p_date - v_start) % (p_schedule->>'every')::int = 0;
  end if;
  return p_schedule->'days' @> to_jsonb(extract(isodow from p_date)::int - 1);
end;
$function$;
