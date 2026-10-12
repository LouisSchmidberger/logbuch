-- Feste Tage nur noch als Wochentage (Nutzer-Entscheidung 2026-10-12): monatlich, jährlich
-- und "alle X Tage/Wochen" entfallen - Zeitraum-Felder (Woche/Monat/Jahr) decken das ab, und
-- kein Feld nutzte sie (vor dieser Migration geprüft: alle Pläne null). Das Formular bietet
-- sie schon nicht mehr an; hier ziehen Prüfung und Erinnerungs-Regel nach (Gegenstück zu
-- isScheduledOn() in logbuch.js).
--
-- habit_definitions_schedule_check ruft habit_schedule_valid auf und gilt damit ab jetzt
-- automatisch nur noch für 'weekly'.

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
  if jsonb_typeof(p_schedule) <> 'object' or p_schedule->>'type' is distinct from 'weekly' then
    return false;
  end if;
  return jsonb_typeof(p_schedule->'days') = 'array'
    and jsonb_array_length(p_schedule->'days') between 1 and 7
    and not exists (
      select 1 from jsonb_array_elements(p_schedule->'days') d
      where jsonb_typeof(d) <> 'number' or d::text !~ v_int or d::text::int not between 0 and 6);
exception when others then
  return false;
end;
$function$;

-- Ein ungültiger Plan gilt weiter als "dran" (lieber einmal zu oft erinnern als ein Feld
-- still aus den Erinnerungen fallen lassen).
CREATE OR REPLACE FUNCTION public.habit_scheduled_on(p_schedule jsonb, p_date date)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
begin
  if p_schedule is null or not public.habit_schedule_valid(p_schedule) then
    return true;
  end if;
  return p_schedule->'days' @> to_jsonb(extract(isodow from p_date)::int - 1);
end;
$function$;
