-- Ergänzung zu 20260927180000_encrypt_habit_definitions_prep.sql: filled_slugs soll nur
-- noch Feld-IDs enthalten. Eine noch offene alte App-Version schreibt aber weiter slugs
-- (aus dem Namen abgeleitet, z.B. "gekifft"). Dieser Trigger übersetzt sie beim Speichern
-- in die ID - solange die Definition unverschlüsselt ist und ihren slug noch im Klartext
-- trägt. Nicht zuordenbare Einträge (Feld gelöscht oder schon verschlüsselt) fallen weg,
-- statt als Namens-Rest liegen zu bleiben. SECURITY INVOKER: RLS beschränkt den Zugriff
-- auf habit_definitions ohnehin auf die eigenen Felder, und das sind genau die gesuchten.
CREATE FUNCTION public.normalize_filled_slugs()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  if new.filled_slugs is not null and jsonb_typeof(new.filled_slugs) = 'array'
     and exists (select 1 from jsonb_array_elements_text(new.filled_slugs) s
                 where s !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    new.filled_slugs := coalesce((
      select jsonb_agg(distinct x)
      from (
        select case
          when s ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then s
          else (select h.id::text from public.habit_definitions h
                where h.user_id = new.user_id and h.slug = s)
        end as x
        from jsonb_array_elements_text(new.filled_slugs) s
      ) q
      where x is not null
    ), '[]'::jsonb);
  end if;
  return new;
end;
$function$;

CREATE TRIGGER habit_entries_normalize_filled_slugs
  BEFORE INSERT OR UPDATE OF filled_slugs ON public.habit_entries
  FOR EACH ROW EXECUTE FUNCTION public.normalize_filled_slugs();

-- Was eine alte App seit der vorigen Migration schon wieder als slug geschrieben hat,
-- einmal nachziehen (der Trigger oben übernimmt die Übersetzung).
UPDATE public.habit_entries e
SET filled_slugs = e.filled_slugs
WHERE exists (select 1 from jsonb_array_elements_text(e.filled_slugs) s
              where s !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
