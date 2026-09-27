-- Verschlüsselte Feld-Definitionen, Etappe 1 (Server-Seite, abwärtskompatibel).
--
-- Ziel: der Betreiber soll nicht mehr sehen, WORÜBER jemand Buch führt. Bisher standen
-- Feldname, Stufen-Bezeichnungen, Einheit usw. im Klartext in habit_definitions, und
-- der aus dem Namen abgeleitete slug zusätzlich in habit_entries.filled_slugs.
--
-- Neu: habit_definitions.enc = {iv, ciphertext}, verschlüsselt mit demselben DEK wie
-- habit_entries.data (clientseitig, siehe logbuch.html). Darin stehen alle Eigenschaften,
-- die der Server nicht braucht (Datenschlüssel/slug, Name, Bezeichnungen, Einheit,
-- min/max, good, Darstellung, Ziel-Quote, Gruppen-Mitglieder). Im Klartext bleibt nur,
-- was get_due_notifications braucht: kind, reminder_minute, schedule, archived_at
-- (plus sort_order/created_at). Die Umstellung bestehender Zeilen macht die App beim
-- nächsten Öffnen (nur sie hat den Schlüssel) - bis dahin gelten für unverschlüsselte
-- Zeilen die bisherigen Regeln.

ALTER TABLE "public"."habit_definitions" ADD COLUMN "enc" jsonb;

ALTER TABLE "public"."habit_definitions" ALTER COLUMN "slug" DROP NOT NULL;
ALTER TABLE "public"."habit_definitions" ALTER COLUMN "name" DROP NOT NULL;

ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_enc_shape_check" CHECK (
    enc IS NULL OR (jsonb_typeof(enc) = 'object' AND enc ? 'iv' AND enc ? 'ciphertext')
  );

-- Schutzregel: eine verschlüsselte Zeile darf KEINEN Klartext mehr enthalten. Rutscht
-- durch einen Fehler in der App doch etwas mit durch, lehnt die Datenbank das Speichern
-- ab, statt es still abzulegen. display_style/slider_show_value sind NOT NULL mit
-- Default und müssen deshalb auf genau diesem neutralen Default stehen.
ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_enc_no_plaintext_check" CHECK (
    enc IS NULL OR (
      slug IS NULL AND name IS NULL AND min IS NULL AND max IS NULL AND labels IS NULL
      AND good IS NULL AND unit IS NULL AND goal_threshold IS NULL AND group_members IS NULL
      AND display_style = 'buttons' AND slider_show_value
    )
  );

-- Die bisherigen Typ-Regeln prüfen Klartext-Spalten - gelten jetzt nur noch für
-- unverschlüsselte Zeilen (bei verschlüsselten stehen die Werte in enc).
ALTER TABLE "public"."habit_definitions"
  DROP CONSTRAINT "habit_definitions_kind_fields_check";
ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_kind_fields_check" CHECK (enc IS NOT NULL OR (
    ((kind = 'scale'::text) AND (min IS NOT NULL) AND (max IS NOT NULL) AND (group_members IS NULL) AND ((good IS NOT NULL) OR (goal_threshold IS NULL))) OR
    ((kind = 'number'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (goal_threshold IS NULL) AND (group_members IS NULL)) OR
    ((kind = 'group'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (unit IS NULL) AND (group_members IS NOT NULL)) OR
    ((kind = 'text'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (unit IS NULL) AND (goal_threshold IS NULL) AND (group_members IS NULL))
  ));

-- filled_slugs enthält ab jetzt die IDs der befüllten Felder (habit_definitions.id)
-- statt ihrer slugs - der slug ist aus dem Namen abgeleitet ("gekifft") und verschwindet
-- mit der Verschlüsselung aus der Tabelle. Bestehende Einträge werden hier umgeschrieben,
-- solange die slugs noch lesbar sind. Slugs ohne passendes Feld (endgültig gelöschte
-- Felder) fallen dabei weg - sie verrieten sonst weiter den alten Namen und spielen für
-- Erinnerungen keine Rolle.
UPDATE public.habit_entries e
SET filled_slugs = coalesce((
  select jsonb_agg(h.id::text order by s.ord)
  from jsonb_array_elements_text(e.filled_slugs) with ordinality as s(slug, ord)
  join public.habit_definitions h on h.user_id = e.user_id and h.slug = s.slug
), '[]'::jsonb)
WHERE jsonb_array_length(e.filled_slugs) > 0;

-- Speicher-Uhrzeit der Einträge entfernen: verriet, wann jemand typischerweise einträgt,
-- und wird von nichts gebraucht (Aktivitäts-Auswertungen gehen über entry_date).
DROP TRIGGER habit_entries_set_updated_at ON public.habit_entries;
DROP FUNCTION public.set_updated_at();
ALTER TABLE public.habit_entries DROP COLUMN updated_at;

-- get_due_notifications: vergleicht über Feld-IDs und liefert für eigene
-- Erinnerungszeiten die IDs statt der Namen (send-notifications schickt sie weiter,
-- sw.js setzt die Namen auf dem Gerät ein). Übergangsweise zählt auch noch ein alter
-- slug in filled_slugs als befüllt, solange die Definition unverschlüsselt ist - falls
-- jemand noch kurz eine alte App-Version offen hat, die slugs schreibt. Sonst
-- unverändert gegenüber 20260927140000_add_habit_schedule.sql.
CREATE OR REPLACE FUNCTION public.get_due_notifications(
    p_now   timestamptz DEFAULT now(),
    p_after uuid        DEFAULT NULL,
    p_limit integer     DEFAULT 500
  )
  RETURNS TABLE (
    subscription_id  uuid,
    user_id          uuid,
    endpoint         text,
    p256dh           text,
    auth_key         text,
    locale           text,
    local_date       date,
    default_reminder boolean,
    custom_missing   text[],
    week_summary     boolean,
    month_summary    boolean
  )
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  with local_time as (
    select s.user_id, s.locale, s.summary_notifications, s.default_reminder_minute,
           p_now at time zone s.timezone as ts
    from public.user_settings s
    where exists (select 1 from public.push_subscriptions p where p.user_id = s.user_id)
  ),
  slotted as (
    select lt.*,
           lt.ts::date as today,
           ((extract(hour from lt.ts)::int * 60 + extract(minute from lt.ts)::int) / 15) * 15 as slot
    from local_time lt
  ),
  -- Früh aussieben: nur Nutzer, bei denen in diesem Slot überhaupt irgendetwas fällig
  -- sein KANN (Standardzeit oder eigene Zeit eines heute geplanten aktiven Feldes) –
  -- nur für die laufen die teureren Eintrags-Abfragen unten.
  candidates as (
    select sl.*,
           sl.slot = sl.default_reminder_minute as is_default_slot,
           coalesce((select e.filled_slugs from public.habit_entries e
                     where e.user_id = sl.user_id and e.entry_date = sl.today), '[]'::jsonb) as filled
    from slotted sl
    where sl.slot = sl.default_reminder_minute
       or exists (select 1 from public.habit_definitions h
                  where h.user_id = sl.user_id and h.archived_at is null and h.reminder_minute = sl.slot
                    and public.habit_scheduled_on(h.schedule, sl.today))
  ),
  due as (
    select c.user_id, c.locale, c.today,
      c.is_default_slot and exists (
        select 1 from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind <> 'group'
          and h.reminder_minute is null
          and not (c.filled ? h.id::text or (h.slug is not null and c.filled ? h.slug))
          and public.habit_scheduled_on(h.schedule, c.today)
      ) as default_reminder,
      coalesce((
        select array_agg(h.id::text order by h.sort_order) from public.habit_definitions h
        where h.user_id = c.user_id and h.archived_at is null and h.kind <> 'group'
          and h.reminder_minute = c.slot
          and not (c.filled ? h.id::text or (h.slug is not null and c.filled ? h.slug))
          and public.habit_scheduled_on(h.schedule, c.today)
      ), '{}') as custom_missing,
      c.is_default_slot and c.summary_notifications and extract(isodow from c.today) = 7
        and exists (select 1 from public.habit_entries e
                    where e.user_id = c.user_id and e.entry_date between c.today - 6 and c.today
                      and jsonb_array_length(e.filled_slugs) > 0) as week_summary,
      c.is_default_slot and c.summary_notifications and extract(day from c.today + 1) = 1
        and exists (select 1 from public.habit_entries e
                    where e.user_id = c.user_id
                      and e.entry_date between date_trunc('month', c.today)::date and c.today
                      and jsonb_array_length(e.filled_slugs) > 0) as month_summary
    from candidates c
  )
  select p.id, d.user_id, p.endpoint, p.p256dh, p.auth_key, d.locale, d.today,
         d.default_reminder, d.custom_missing, d.week_summary, d.month_summary
  from due d
  join public.push_subscriptions p on p.user_id = d.user_id
  where (d.default_reminder or cardinality(d.custom_missing) > 0 or d.week_summary or d.month_summary)
    and (p_after is null or p.id > p_after)
  order by p.id
  limit p_limit;
$function$;
