-- Supabase vergibt bis 2026-10-30 über Default-Privilegien automatisch ALLE Rechte an
-- anon/authenticated für neue public-Tabellen - zusätzlich zu den expliziten GRANTs in
-- 20260927200000_add_habit_sections.sql. Hier auf genau das zurückgeschnitten, was die
-- App braucht: kein Zugriff für anon (Logbuch greift nie ohne Login auf Daten zu), und
-- für authenticated nur SELECT/INSERT/UPDATE/DELETE (kein TRUNCATE - das umginge RLS -,
-- kein TRIGGER/REFERENCES).
REVOKE ALL ON TABLE "public"."habit_sections" FROM anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE "public"."habit_sections" FROM authenticated;
