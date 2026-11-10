-- Review G8 (2026-11-10): Rechte enger, ohne Verhaltensänderung.
-- 1. Sequenzen der beiden Protokoll-Tabellen: anon/authenticated hatten über die
--    Standard-Rechte USAGE/SELECT/UPDATE, brauchen sie aber nie (geschrieben wird nur über
--    Edge Functions mit service_role).
revoke all on sequence public.feedback_rate_log_id_seq from anon, authenticated;
revoke all on sequence public.signup_mail_feedback_id_seq from anon, authenticated;

-- 2. Trigger-Funktionen mit SECURITY DEFINER: niemand muss sie direkt aufrufen (Trigger
--    laufen unabhängig von EXECUTE). search_path leer, alle Namen sind voll qualifiziert.
revoke execute on function public.seed_default_user_settings() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
alter function public.seed_default_user_settings() set search_path = '';
