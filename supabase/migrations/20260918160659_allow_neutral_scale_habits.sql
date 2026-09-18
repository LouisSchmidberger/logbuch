-- Erlaubt kind='scale'-Felder ohne Gut/Schlecht-Bewertung (good = NULL), z.B. für
-- reines Tracken ohne Wertung. goal_threshold bleibt dabei zwingend NULL, da eine
-- Ziel-Quote ohne Bewertungsrichtung keinen Sinn ergibt.
ALTER TABLE "public"."habit_definitions"
  DROP CONSTRAINT "habit_definitions_kind_fields_check";

ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_kind_fields_check" CHECK ((((kind = 'scale'::text) AND (min IS NOT NULL) AND (max IS NOT NULL) AND (group_members IS NULL) AND ((good IS NOT NULL) OR (goal_threshold IS NULL))) OR
    ((kind = 'number'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (goal_threshold IS NULL) AND (group_members IS NULL)) OR
    ((kind = 'group'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (unit IS NULL) AND (group_members IS NOT NULL))));
