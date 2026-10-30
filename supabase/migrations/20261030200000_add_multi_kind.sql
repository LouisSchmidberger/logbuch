-- Mehrfachauswahl (Nutzer-Entscheidung 2026-10-30): eigener Feld-Typ 'multi' - mehrere Optionen
-- pro Tag ankreuzen (z.B. "was heute war"), Wert = Array der Options-Ids in den verschlüsselten
-- Einträgen, [] = "nichts davon". Die Optionen selbst stehen verschlüsselt in enc. Für
-- get_due_notifications ein ganz normales Feld (leer = fehlt), deshalb ändert sich dort nichts.
-- Nur Erweiterung: die Live-Version (ohne 'multi') lässt solche Felder aus (isSupportedHabit).
-- Sichtbar im Formular erst ab der Stufe des Schalters 'multi' (docs/freigabe.md).
ALTER TABLE "public"."habit_definitions" DROP CONSTRAINT "habit_definitions_kind_check";
ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_kind_check" CHECK ((kind = ANY (ARRAY['scale'::text, 'number'::text, 'computed'::text, 'text'::text, 'counter'::text, 'time'::text, 'multi'::text])));

insert into public.feature_flags (key, stage, note) values ('multi', 'owner', 'Feld-Typ Mehrfachauswahl');
