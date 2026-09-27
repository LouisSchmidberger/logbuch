-- Neuer Feld-Typ kind='text': freie Text-Antwort pro Tag (z.B. "Wofür bin ich heute
-- dankbar?"). Die Antwort selbst liegt wie jeder Wert verschlüsselt in
-- habit_entries.data unter dem Slug; die Definition braucht keine Skala-/Einheiten-/
-- Gruppen-Spalten, eine eigene Erinnerungszeit (reminder_minute) ist erlaubt.
-- get_due_notifications schließt nur kind='group' aus, Text-Felder laufen dort also
-- automatisch wie jedes andere Feld mit.
ALTER TABLE "public"."habit_definitions"
  DROP CONSTRAINT "habit_definitions_kind_check";

ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_kind_check" CHECK ((kind = ANY (ARRAY['scale'::text, 'number'::text, 'group'::text, 'text'::text])));

ALTER TABLE "public"."habit_definitions"
  DROP CONSTRAINT "habit_definitions_kind_fields_check";

ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_kind_fields_check" CHECK ((((kind = 'scale'::text) AND (min IS NOT NULL) AND (max IS NOT NULL) AND (group_members IS NULL) AND ((good IS NOT NULL) OR (goal_threshold IS NULL))) OR
    ((kind = 'number'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (goal_threshold IS NULL) AND (group_members IS NULL)) OR
    ((kind = 'group'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (unit IS NULL) AND (group_members IS NOT NULL)) OR
    ((kind = 'text'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (unit IS NULL) AND (goal_threshold IS NULL) AND (group_members IS NULL))));
