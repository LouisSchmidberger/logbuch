-- Tägliches Aufräumen:
-- 1. Konten, deren E-Mail-Adresse nie bestätigt wurde. Aus Systemsicht harmlos, aber
--    Datensparsamkeit: eine vertippte Adresse ist oft die echte Adresse einer fremden
--    Person, die sich nie registriert hat - die soll nicht dauerhaft gespeichert bleiben.
--    Gelöscht wird 24h nach der LETZTEN Bestätigungsmail (confirmation_sent_at, nicht
--    created_at - sonst träfe es jemanden, der sich gerade eine neue Mail hat schicken
--    lassen); der Link darin ist ohnehin nur 1h gültig (auth.email.otp_expiry). Wer sich
--    danach doch noch anmelden will, registriert sich einfach neu. Nur Konten, die sich
--    nie angemeldet haben; alle abhängigen Zeilen hängen per ON DELETE CASCADE an
--    auth.users und verschwinden mit.
-- 2. Die Laufprotokolle von pg_cron (cron.job_run_details) - wachsen sonst mit jedem
--    15-Minuten-Lauf der Erinnerungen unbegrenzt weiter; 14 Tage reichen zur Fehlersuche.
CREATE FUNCTION public.delete_stale_unconfirmed_users()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  deleted integer;
begin
  delete from auth.users u
  where u.email_confirmed_at is null
    and u.last_sign_in_at is null
    and coalesce(u.confirmation_sent_at, u.created_at) < now() - interval '24 hours';
  get diagnostics deleted = row_count;
  return deleted;
end;
$function$;

REVOKE ALL ON FUNCTION public.delete_stale_unconfirmed_users() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_stale_unconfirmed_users() TO service_role;

SELECT cron.schedule(
  'daily-cleanup',
  '17 3 * * *',
  $cron$
    select public.delete_stale_unconfirmed_users();
    delete from cron.job_run_details where end_time < now() - interval '14 days';
  $cron$
);
