-- Feedback aus der App an den Betreiber (Menü → "Feedback geben"). Einziger Weg
-- hinein ist die Edge Function submit-feedback (prüft Login + Limit, speichert über
-- record_feedback() unten, verschickt eine Mail) – deshalb für anon/authenticated
-- weder les- noch schreibbar (RLS an, keine Policies, GRANTs nur an service_role).
-- Bewusst nicht Teil des Datenexports (Nutzer-Entscheidung 2026-09-25).
--
-- "Ohne Absender" (anonymous): feedback.user_id bleibt NULL, das Limit läuft dann
-- über das getrennte feedback_rate_log (nur Konto + Zeitpunkt, kein Inhalt). Einträge
-- dort werden nach 24h gelöscht (in record_feedback) – danach ist ein anonymes
-- Feedback auch über die Zeitpunkte nicht mehr einem Konto zuzuordnen.
CREATE TABLE public.feedback (
  id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  message    text        NOT NULL CHECK (char_length(message) BETWEEN 1 AND 5000),
  locale     text        NOT NULL CHECK (locale IN ('de', 'en')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.feedback_rate_log (
  id      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.feedback_rate_log ENABLE ROW LEVEL SECURITY;
CREATE INDEX feedback_rate_log_user_sent_idx ON public.feedback_rate_log (user_id, sent_at);
CREATE INDEX feedback_rate_log_sent_idx ON public.feedback_rate_log (sent_at);

-- Bewusst abweichend von der üblichen Regel (GRANT auch an authenticated): die App
-- greift nie direkt auf diese Tabellen zu.
REVOKE ALL ON public.feedback, public.feedback_rate_log FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feedback, public.feedback_rate_log TO service_role;

-- Prüft das Limit (max. 5 Nachrichten pro Konto in 24h) und speichert atomar – die
-- Advisory-Lock pro Nutzer verhindert, dass zwei gleichzeitige Anfragen beide die
-- Zählung "4" sehen und so das Limit überschreiten. Liefert false, wenn das Limit
-- erreicht ist.
CREATE OR REPLACE FUNCTION public.record_feedback(
    p_user_id   uuid,
    p_message   text,
    p_locale    text,
    p_anonymous boolean
  )
  RETURNS boolean
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('feedback:' || p_user_id::text));
  delete from public.feedback_rate_log where sent_at < now() - interval '24 hours';
  if (select count(*) from public.feedback_rate_log where user_id = p_user_id) >= 5 then
    return false;
  end if;
  insert into public.feedback_rate_log (user_id) values (p_user_id);
  insert into public.feedback (user_id, message, locale)
    values (case when p_anonymous then null else p_user_id end, p_message, p_locale);
  return true;
end;
$function$;

REVOKE ALL ON FUNCTION public.record_feedback(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_feedback(uuid, text, text, boolean) TO service_role;
