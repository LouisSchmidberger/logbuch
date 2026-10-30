-- feature_flags und user_access hatten noch die Supabase-Standardrechte (alles für anon und
-- authenticated). Schreiben hielt RLS ab (nur Lese-Regeln), TRUNCATE prüft RLS aber nicht, und
-- anon braucht beide nie (CLAUDE.md: neue Tabellen mit expliziten GRANTs, kein anon). Gelesen wird
-- nur angemeldet (loadFeatureAccess); geändert nur über Dashboard/SQL (service_role).
revoke all on table public.feature_flags from anon, authenticated;
revoke all on table public.user_access from anon, authenticated;
grant select on table public.feature_flags to authenticated;
grant select on table public.user_access to authenticated;
grant all on table public.feature_flags to service_role;
grant all on table public.user_access to service_role;
