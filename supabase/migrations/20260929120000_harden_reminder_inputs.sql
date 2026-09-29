-- Härtung aus dem Projekt-Review 2026-09-29: get_due_notifications läuft in EINER Abfrage
-- über alle Nutzer - ein einziger Wert, an dem sie scheitert, ließ bisher den ganzen
-- 15-Minuten-Lauf mit einem Fehler abbrechen (niemand bekam etwas). Die folgenden Spalten
-- kann jeder Nutzer für seine eigenen Zeilen frei schreiben (auch am Client vorbei per
-- API), deshalb prüft die Datenbank ihre Form jetzt selbst.

-- 1. Wiederholung (habit_definitions.schedule): vorher nur der type geprüft - ein Plan wie
--    {"type":"interval","every":0,...}, ein nicht-numerischer Tag oder ein kaputtes
--    Startdatum brachen habit_scheduled_on mit einem Fehler ab. Die Regeln hier spiegeln
--    exakt, was formToSchedule() in logbuch.html schreibt.
CREATE FUNCTION public.habit_schedule_valid(p_schedule jsonb)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  v_int text := '^-?[0-9]{1,3}$'; -- ganze Zahl, kurz genug für jeden ::int-Cast
  v_day text;
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
    when 'monthly' then
      v_day := p_schedule->>'day';
      return jsonb_typeof(p_schedule->'day') = 'number' and v_day ~ v_int
        and (v_day::int between 1 and 31 or v_day::int = -1);
    when 'yearly' then
      return jsonb_typeof(p_schedule->'month') = 'number' and (p_schedule->>'month') ~ v_int
        and (p_schedule->>'month')::int between 1 and 12
        and jsonb_typeof(p_schedule->'day') = 'number' and (p_schedule->>'day') ~ v_int
        and (p_schedule->>'day')::int between 1 and 31;
    when 'interval' then
      if not (jsonb_typeof(p_schedule->'every') = 'number' and (p_schedule->>'every') ~ v_int
              and (p_schedule->>'every')::int between 1 and 365
              and p_schedule->>'unit' in ('day', 'week')
              and coalesce(p_schedule->>'start', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
        return false;
      end if;
      -- Form stimmt, jetzt noch ob es das Datum gibt (2026-02-30 nicht).
      return to_char(to_date(p_schedule->>'start', 'YYYY-MM-DD'), 'YYYY-MM-DD') = p_schedule->>'start';
    else
      return false;
  end case;
exception when others then
  return false;
end;
$function$;

-- Wird in einer CHECK-Regel benutzt: authenticated braucht das Ausführungsrecht, anon nicht.
REVOKE ALL ON FUNCTION public.habit_schedule_valid(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.habit_schedule_valid(jsonb) TO authenticated, service_role;

ALTER TABLE "public"."habit_definitions" DROP CONSTRAINT "habit_definitions_schedule_check";
ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_schedule_check" CHECK (
    schedule IS NULL OR (kind <> 'computed' AND public.habit_schedule_valid(schedule))
  );

-- Zusätzlich defensiv (falls je ein Plan an der Regel oben vorbeikommt): ein ungültiger
-- Plan gilt als "dran" statt die Abfrage abzubrechen - lieber einmal zu oft erinnern als
-- ein Feld still aus den Erinnerungen fallen lassen. Jetzt plpgsql statt sql: eine
-- sql-Funktion wird in die aufrufende Abfrage eingebettet, und Postgres rechnet dabei
-- Teilausdrücke mit festen Werten womöglich schon vorab aus - auch in CASE-Zweigen, die
-- gar nicht dran wären. Die Regeln selbst sind unverändert (Gegenstück zu
-- isScheduledOn() in logbuch.html).
CREATE OR REPLACE FUNCTION public.habit_scheduled_on(p_schedule jsonb, p_date date)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  v_last_day int := extract(day from (date_trunc('month', p_date) + interval '1 month - 1 day'))::int;
  v_start date;
begin
  if p_schedule is null or not public.habit_schedule_valid(p_schedule) then
    return true;
  end if;
  case p_schedule->>'type'
    when 'weekly' then
      return p_schedule->'days' @> to_jsonb(extract(isodow from p_date)::int - 1);
    when 'monthly' then
      return extract(day from p_date)::int = least(
        case when (p_schedule->>'day')::int = -1 then 31 else (p_schedule->>'day')::int end,
        v_last_day);
    when 'yearly' then
      return extract(month from p_date)::int = (p_schedule->>'month')::int
        and extract(day from p_date)::int = least((p_schedule->>'day')::int, v_last_day);
    when 'interval' then
      v_start := (p_schedule->>'start')::date;
      return p_date >= v_start
        and (p_date - v_start)
            % ((p_schedule->>'every')::int * case when p_schedule->>'unit' = 'week' then 7 else 1 end) = 0;
    else
      return true;
  end case;
end;
$function$;

-- Nur get_due_notifications (service_role) braucht sie.
REVOKE ALL ON FUNCTION public.habit_scheduled_on(jsonb, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.habit_scheduled_on(jsonb, date) TO service_role;

-- 2. filled_slugs muss ein Array sein - die Wochen-/Monatsübersicht zählt es per
--    jsonb_array_length, das bei allem anderen einen Fehler wirft.
ALTER TABLE "public"."habit_entries"
  ADD CONSTRAINT "habit_entries_filled_slugs_array_check" CHECK (jsonb_typeof(filled_slugs) = 'array');

-- 3. Push-Abos: send-notifications schickt an jeden eingetragenen Endpoint eine Anfrage.
--    Ohne Grenzen könnte ein Konto beliebig viele beliebige Adressen eintragen (z.B.
--    absichtlich hängende Server) und damit den Versand für alle ausbremsen. Deshalb:
--    nur https, vernünftige Längen, höchstens 10 Geräte pro Konto (dazu ein Timeout beim
--    Senden in der Function selbst).
ALTER TABLE "public"."push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_shape_check" CHECK (
    endpoint ~ '^https://' AND length(endpoint) <= 1024
    AND length(p256dh) <= 256 AND length(auth_key) <= 256
  );

CREATE FUNCTION public.limit_push_subscriptions()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  -- Pro Konto serialisieren, damit zwei gleichzeitige Anmeldungen nicht beide "9" sehen.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('push:' || new.user_id::text));
  -- Ein upsert auf ein schon bekanntes Gerät (gleicher endpoint) ist kein neues Abo.
  if exists (select 1 from public.push_subscriptions p where p.endpoint = new.endpoint) then
    return new;
  end if;
  if (select count(*) from public.push_subscriptions p where p.user_id = new.user_id) >= 10 then
    raise exception 'push subscription limit reached' using errcode = '23514';
  end if;
  return new;
end;
$function$;

CREATE TRIGGER push_subscriptions_limit
  BEFORE INSERT ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.limit_push_subscriptions();

-- 4. feedback_rate_log: die Einträge sollen nach 24h weg sein (danach lässt sich Feedback
--    "ohne Absender" auch über Zeitpunkte keinem Konto mehr zuordnen). Bisher löschte nur
--    record_feedback() - also nur, wenn wieder jemand Feedback schickte. Jetzt stündlich.
SELECT cron.schedule(
  'feedback-rate-log-cleanup',
  '41 * * * *',
  $cron$ delete from public.feedback_rate_log where sent_at < now() - interval '24 hours'; $cron$
);

-- 5. Rechte der älteren Tabellen auf das zurückschneiden, was die App braucht (wie schon
--    bei habit_sections, siehe 20260927201000_habit_sections_revoke_extra_grants.sql):
--    kein Zugriff für anon (Logbuch greift nie ohne Login auf Daten zu), für authenticated
--    kein TRUNCATE (umginge RLS), TRIGGER, REFERENCES.
REVOKE ALL ON TABLE
  public.habit_definitions, public.habit_entries, public.push_subscriptions,
  public.user_encryption, public.user_settings
  FROM anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE
  public.habit_definitions, public.habit_entries, public.push_subscriptions,
  public.user_encryption, public.user_settings
  FROM authenticated;
