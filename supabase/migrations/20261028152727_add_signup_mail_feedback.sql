-- Rückmeldung "Lag die Bestätigungsmail im Spam?" (Nutzer-Entscheidung 2026-10-28): eine
-- freiwillige Ja/Nein-Frage auf der Seite, die der Bestätigungslink öffnet. Damit der
-- Betreiber sieht, ob und bei welchem Mail-Anbieter die Mail im Spam landet.
--
-- Datensparsam: gespeichert werden nur die Antwort, der Anbieter (nur große, bekannte -
-- eine eigene Domain wie "mueller-familie.de" verriete die Person, wird zu 'andere') und der
-- Monat. Keine Verbindung zum Konto: dass jemand schon geantwortet hat, steht getrennt in
-- signup_mail_feedback_given (nur fürs Einmal-Limit, ohne Antwort).

CREATE TABLE public.signup_mail_feedback (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  month date NOT NULL DEFAULT date_trunc('month', now())::date,
  in_spam boolean NOT NULL,
  provider text NOT NULL
);

CREATE TABLE public.signup_mail_feedback_given (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE
);

-- Für Nutzer weder les- noch schreibbar (RLS ohne Policies, GRANTs nur an service_role, wie
-- bei feedback) - einziger Weg hinein ist record_signup_mail_feedback().
ALTER TABLE public.signup_mail_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_mail_feedback_given ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.signup_mail_feedback, public.signup_mail_feedback_given FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.signup_mail_feedback, public.signup_mail_feedback_given TO service_role;

-- Den Anbieter ermittelt der Server aus der Konto-Adresse (nicht vom Client übernommen, sonst
-- ließe sich die Statistik mit beliebigem Text füllen). Nur einmal pro Konto und nur in der
-- ersten Woche nach der Registrierung.
CREATE FUNCTION public.record_signup_mail_feedback(p_in_spam boolean)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  v_email text;
  v_created timestamptz;
  v_provider text;
begin
  if auth.uid() is null or p_in_spam is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select u.email, u.created_at into v_email, v_created from auth.users u where u.id = auth.uid();
  if v_created is null or v_created < now() - interval '7 days' then
    return;
  end if;
  insert into public.signup_mail_feedback_given (user_id) values (auth.uid()) on conflict do nothing;
  if not found then
    return;
  end if;
  v_provider := lower(split_part(coalesce(v_email, ''), '@', 2));
  if not v_provider = any (array[
    'gmail.com', 'googlemail.com', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de',
    'outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'live.com', 'live.de', 'msn.com',
    'yahoo.com', 'yahoo.de', 'icloud.com', 'me.com', 'mac.com', 'posteo.de', 'posteo.net',
    'mailbox.org', 'freenet.de', 'aol.com', 'aol.de', 'proton.me', 'protonmail.com', 'mail.de',
    'arcor.de', 'online.de', 'vodafone.de', 'bluewin.ch', 'gmx.com', 'tutanota.com', 'tuta.io'
  ]) then
    v_provider := 'andere';
  end if;
  insert into public.signup_mail_feedback (in_spam, provider) values (p_in_spam, v_provider);
end;
$function$;

REVOKE ALL ON FUNCTION public.record_signup_mail_feedback(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_signup_mail_feedback(boolean) TO authenticated, service_role;
