// Nimmt Feedback aus der App entgegen (Menü → "Feedback geben"), speichert es in
// public.feedback und schickt es per Mail (Resend) an den Betreiber. Einziger Weg in
// die Feedback-Tabelle – die ist für Nutzer weder les- noch schreibbar (siehe
// Migration 20260925170000_add_feedback.sql).
//
// Wie delete-account: der Nutzer wird ausschließlich aus dem mitgeschickten
// Access-Token ermittelt, nie aus einer vom Client übergebenen ID. Das Limit (5 pro
// 24h) prüft record_feedback() atomar in der Datenbank – ein clientseitiges Limit
// allein ließe sich per direktem API-Aufruf umgehen.
//
// Bei Feedback MIT Absender wird dessen Konto-E-Mail als Reply-To gesetzt ("Antworten"
// im Mailprogramm geht direkt an ihn), ohne Absender gibt es keinen Rückkanal.
//
// Secrets (nie im Repo – es ist öffentlich): RESEND_FEEDBACK_KEY (eigener Resend-Key
// nur für diesen Zweck, getrennt sperrbar) und FEEDBACK_TO_EMAIL (Empfängeradresse).

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_FEEDBACK_KEY = Deno.env.get('RESEND_FEEDBACK_KEY');
const FEEDBACK_TO_EMAIL = Deno.env.get('FEEDBACK_TO_EMAIL');
// Absender muss auf der bei Resend verifizierten Domain liegen (siehe CLAUDE.md,
// Custom SMTP).
const FEEDBACK_FROM = 'Logbuch Feedback <feedback@mail.louis-schmidberger.de>';
const MAX_LENGTH = 5000; // identisch mit dem CHECK in der Tabelle und maxlength im Frontend

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Wird per supabase.functions.invoke() direkt aus dem Browser aufgerufen – ohne
// CORS-Header blockiert der Browser schon die Preflight-Anfrage (siehe delete-account).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function sendMail(message: string, locale: string, replyTo: string | null) {
  if (!RESEND_FEEDBACK_KEY || !FEEDBACK_TO_EMAIL) {
    throw new Error('RESEND_FEEDBACK_KEY oder FEEDBACK_TO_EMAIL nicht gesetzt');
  }
  const sender = replyTo ? `von ${replyTo}` : 'ohne Absender';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_FEEDBACK_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FEEDBACK_FROM,
      to: [FEEDBACK_TO_EMAIL],
      subject: `Logbuch-Feedback (${sender})`,
      // Bewusst reiner Text statt HTML: der Inhalt ist Nutzereingabe und soll nie als
      // Markup interpretiert werden.
      text: `${message}\n\n---\nAbsender: ${replyTo ?? '(ohne Absender)'}\nApp-Sprache: ${locale}`,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
  const user = userData.user;

  let payload: { message?: unknown; anonymous?: unknown; locale?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message || message.length > MAX_LENGTH) return json({ error: 'invalid_message' }, 400);
  const anonymous = payload.anonymous === true;
  const locale = payload.locale === 'en' ? 'en' : 'de';

  const { data: stored, error: dbErr } = await supabaseAdmin.rpc('record_feedback', {
    p_user_id: user.id,
    p_message: message,
    p_locale: locale,
    p_anonymous: anonymous,
  });
  if (dbErr) return json({ error: dbErr.message }, 500);
  if (stored === false) return json({ error: 'rate_limited' }, 429);

  // Mail-Versand ist "best effort": das Feedback ist zu diesem Zeitpunkt schon sicher
  // gespeichert (im Dashboard nachlesbar) – ein Resend-Ausfall soll den Nutzer nicht
  // zu einem erneuten Absenden (= Duplikat) verleiten.
  try {
    await sendMail(message, locale, anonymous ? null : user.email ?? null);
  } catch (err) {
    console.error('Feedback gespeichert, Mail fehlgeschlagen:', String(err));
  }

  return json({ ok: true });
});
