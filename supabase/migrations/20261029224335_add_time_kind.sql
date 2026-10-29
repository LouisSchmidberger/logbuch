-- Uhrzeit-Felder (Nutzer-Entscheidung 2026-10-29): eigener Feld-Typ 'time' - ein Zeitpunkt pro
-- Tag (z.B. "ins Bett"), Wert in den verschlüsselten Einträgen. Für get_due_notifications ein
-- ganz normales Feld (leer = fehlt), deshalb ändert sich dort nichts; die Dauer zwischen zwei
-- Uhrzeiten ist ein berechnetes Feld (kind 'computed', Art steht verschlüsselt in enc).
-- Nur Erweiterung: die Live-Version (ohne 'time') lässt solche Felder aus (isSupportedHabit).
ALTER TABLE "public"."habit_definitions" DROP CONSTRAINT "habit_definitions_kind_check";
ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_kind_check" CHECK ((kind = ANY (ARRAY['scale'::text, 'number'::text, 'computed'::text, 'text'::text, 'counter'::text, 'time'::text])));
