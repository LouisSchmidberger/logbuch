-- Bereiche: einklappbare Abschnitte, in die Nutzer ihre Felder (und Gruppen) sortieren
-- können - reine Anordnung, keine eigene Berechnung. Der Name steckt verschlüsselt in enc
-- ({iv, ciphertext}, gleicher DEK wie Felder/Einträge, Inhalt {name}) - ein Bereichsname
-- wie "Sexualität" verrät genauso viel wie ein Feldname.
CREATE TABLE "public"."habit_sections" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    uuid                     NOT NULL DEFAULT auth.uid(),
  "enc"        jsonb                    NOT NULL,
  "sort_order" integer                  NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "habit_sections_pkey" PRIMARY KEY (id),
  CONSTRAINT "habit_sections_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT "habit_sections_enc_shape_check" CHECK (jsonb_typeof(enc) = 'object' AND enc ? 'iv' AND enc ? 'ciphertext')
);

ALTER TABLE "public"."habit_sections" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select own habit_sections" ON "public"."habit_sections"
  FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY "insert own habit_sections" ON "public"."habit_sections"
  FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "update own habit_sections" ON "public"."habit_sections"
  FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "delete own habit_sections" ON "public"."habit_sections"
  FOR DELETE TO authenticated USING ((auth.uid() = user_id));

-- Explizite Rechte (Supabase vergibt für neue public-Tabellen ab 2026-10-30 keine
-- automatischen mehr); bewusst nicht an anon - Logbuch greift nie ohne Login zu.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."habit_sections" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."habit_sections" TO service_role;

-- Zuordnung Feld -> Bereich: bewusst im Klartext (nur zwei zufällige IDs, verrät nichts
-- Inhaltliches) statt in der verschlüsselten Feld-payload - so löst die Datenbank die
-- Zuordnung beim Löschen eines Bereichs selbst (ON DELETE SET NULL), und Umhängen
-- braucht kein erneutes Verschlüsseln des Felds. sort_order eines Felds gilt innerhalb
-- seines Bereichs bzw. (ohne Bereich) auf oberster Ebene zusammen mit den Bereichen.
ALTER TABLE "public"."habit_definitions"
  ADD COLUMN "section_id" uuid REFERENCES "public"."habit_sections"(id) ON DELETE SET NULL;

-- Ein Feld darf nur in einem Bereich desselben Nutzers liegen. Per Trigger statt
-- Constraint (Constraints können keine andere Tabelle prüfen); RLS verhindert zwar
-- ohnehin, fremde Bereiche zu SEHEN, aber nicht, eine fremde (erratene) ID einzutragen.
CREATE FUNCTION public.check_habit_section_owner()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  if new.section_id is not null and not exists (
    select 1 from public.habit_sections s where s.id = new.section_id and s.user_id = new.user_id
  ) then
    raise exception 'section % does not belong to this user', new.section_id using errcode = '23503';
  end if;
  return new;
end;
$function$;

CREATE TRIGGER habit_definitions_check_section_owner
  BEFORE INSERT OR UPDATE OF section_id ON public.habit_definitions
  FOR EACH ROW EXECUTE FUNCTION public.check_habit_section_owner();
