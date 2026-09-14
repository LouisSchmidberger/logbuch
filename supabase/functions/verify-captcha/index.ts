// Datei nach dem Deployment ablegen unter: supabase/functions/verify-captcha/index.ts
//
// Prüft einen Cloudflare-Turnstile-Token serverseitig, BEVOR ein neuer Account
// angelegt wird (siehe renderAuth in logbuch.html, signUp-Zweig). Ersetzt Supabase's
// eingebauten CAPTCHA-Schutz (Authentication -> Attack Protection), der als
// Alles-oder-nichts-Schalter Registrierung, Login UND Passwort-Reset gleichzeitig
// abgedeckt hätte — bei Nutzer*innen mit Adblocker/Tracking-Schutz (blockieren
// challenges.cloudflare.com häufig) hätte das auch das ganz normale Einloggen
// verhindert, nicht nur Registrierungs-Missbrauch. Hier läuft die Prüfung deshalb NUR
// beim Signup, Login/Reset bleiben ohne Captcha.
//
// Sicherheitshinweis: dieser eigene Weg ist etwas schwächer als Supabase's eingebauter
// Schutz, der direkt am Auth-Endpunkt selbst ansetzt (unumgehbar) — wer den öffentlichen
// Supabase-Signup-Endpunkt direkt aufruft (nicht über das Frontend), umgeht diese
// Function komplett, da Supabase serverseitig keinen Token mehr verlangt. Reicht aber
// aus, um naive automatisierte Massen-Registrierung über das normale Frontend zu
// verhindern, was hier das eigentliche Ziel ist.

const TURNSTILE_SECRET_KEY = Deno.env.get('TURNSTILE_SECRET_KEY')!;

Deno.serve(async (req) => {
  let token: string | undefined;
  try {
    ({ token } = await req.json());
  } catch {
    // kein gültiges JSON
  }
  if (!token) {
    return new Response(JSON.stringify({ success: false, error: 'missing token' }), { status: 400 });
  }

  const params = new URLSearchParams();
  params.set('secret', TURNSTILE_SECRET_KEY);
  params.set('response', token);
  const remoteIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for');
  if (remoteIp) params.set('remoteip', remoteIp);

  const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const verifyData = await verifyRes.json();

  return new Response(JSON.stringify({ success: !!verifyData.success }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
