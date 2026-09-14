// Datei nach dem Deployment ablegen unter: supabase/functions/delete-account/index.ts
//
// Löscht das eigene Konto (Recht auf Löschung, Art. 17 DSGVO) samt aller Daten. Wird vom
// Frontend per supabase.functions.invoke('delete-account') aufgerufen — der Client hängt
// dabei automatisch das Access-Token der aktuellen Session als Authorization-Header an.
//
// auth.admin.deleteUser() erfordert den Service-Role-Key (kann nicht clientseitig
// aufgerufen werden), deshalb diese Function. Sicherheit kommt NICHT aus einem Secret
// wie bei send-notifications, sondern daraus, dass hier ausschließlich der aus dem
// mitgeschickten Access-Token ermittelte Nutzer gelöscht wird — nie eine vom Client
// übergebene ID. Alle anderen Tabellen (habit_entries, habit_definitions, user_settings,
// push_subscriptions) haben `on delete cascade` auf user_id -> auth.users(id) und werden
// dadurch automatisch mitgelöscht.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(userData.user.id);
  if (deleteErr) {
    return new Response(JSON.stringify({ error: deleteErr.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
