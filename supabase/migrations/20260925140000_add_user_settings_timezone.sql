-- Zeitzone pro Nutzer (IANA-Name wie 'Europe/Berlin'), damit send-notifications
-- Erinnerungszeiten und "heute" in der Ortszeit des Nutzers statt fest in Berliner
-- Zeit auswertet. Die App gleicht den Wert bei jedem Start still mit der Zeitzone des
-- Geräts ab (folgt dem Gerät, z.B. auf Reisen). Default 'Europe/Berlin': entspricht
-- dem bisherigen Verhalten für alle Bestandsnutzer bis zu deren nächstem App-Start.
ALTER TABLE "public"."user_settings"
  ADD COLUMN "timezone" text NOT NULL DEFAULT 'Europe/Berlin';

-- Nur Zeitzonen zulassen, die Postgres selbst kennt: send-notifications rechnet per
-- `now() AT TIME ZONE timezone` in SQL - ein einziger ungültiger Wert würde dort sonst
-- den gesamten Lauf für ALLE Nutzer abbrechen. Per Trigger statt CHECK, da ein CHECK
-- keine Unterabfrage auf pg_timezone_names erlaubt.
CREATE OR REPLACE FUNCTION public.validate_user_settings_timezone()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'invalid timezone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$function$;

CREATE TRIGGER validate_user_settings_timezone
  BEFORE INSERT OR UPDATE OF timezone ON public.user_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_user_settings_timezone();
