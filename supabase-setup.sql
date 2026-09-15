-- Tabelle: ein Datensatz pro Nutzer und Tag, alle Habit-Werte in einem JSON-Feld.
-- `data` ist clientseitig verschlüsselt (Zero-Access-Architektur, siehe
-- user_encryption weiter unten und die Kommentare in logbuch.html) — kein Klartext
-- mehr, sondern {iv: "<base64>", ciphertext: "<base64>"}. `filled_slugs` ist bewusst
-- unverschlüsselt (nur die Namen der befüllten Felder, keine Werte) und wird
-- ausschließlich für die Vollständigkeits-Prüfung der Edge Function
-- send-notifications gebraucht, die "data" nicht lesen kann.
create table public.habit_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_date date not null,
  data jsonb not null default '{}'::jsonb,
  filled_slugs jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (user_id, entry_date)
);

-- Row Level Security: jede Zeile ist nur für den eigenen Nutzer sichtbar/änderbar
alter table public.habit_entries enable row level security;

create policy "select own entries" on public.habit_entries
  for select using (auth.uid() = user_id);

create policy "insert own entries" on public.habit_entries
  for insert with check (auth.uid() = user_id);

create policy "update own entries" on public.habit_entries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "delete own entries" on public.habit_entries
  for delete using (auth.uid() = user_id);

-- updated_at automatisch aktuell halten
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger habit_entries_set_updated_at
  before update on public.habit_entries
  for each row execute function public.set_updated_at();

-- Habit-Definitionen: pro Nutzer frei verwaltbare Felder (ersetzt die frühere feste
-- HABITS-Konstante im Frontend). "Löschen" passiert nie hart, nur über archived_at,
-- damit historische Einträge in habit_entries.data weiterhin interpretierbar bleiben.
-- Skala (min/max/labels) ist bewusst nur änderbar, solange noch keine Daten zu diesem
-- Feld existieren (siehe App-seitige Sperre) — sonst würden alte Werte plötzlich etwas
-- anderes bedeuten (siehe die manuellen Migrationen für zaehne/gekifft/gevaped davor).
--
-- Drei Feld-Typen (kind): 'scale' (Stufen, farblich bewertet via good high/low — die
-- ursprüngliche und weiterhin häufigste Art), 'number' (freier Zahlenwert wie Gewicht,
-- bewusst OHNE Gut/Schlecht-Bewertung/Farbe, dafür mit optionaler Einheit) und 'group'
-- (nicht direkt befüllbar, zeigt den live berechneten Durchschnitt seiner in
-- group_members referenzierten Skala-Felder — siehe habitScore in logbuch.html).
-- min/max/good sind daher nur bei kind='scale' gesetzt, labels/unit/group_members sind
-- je nach kind exklusiv (siehe Check unten).
create table public.habit_definitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  slug text not null,                 -- Key in habit_entries.data, z.B. 'morgenroutine'
  name text not null,
  kind text not null default 'scale' check (kind in ('scale', 'number', 'group')),
  min int,
  max int,
  labels jsonb,                       -- null = Zahlenwerte, sonst Array von Strings (Länge = max-min+1)
  good text check (good in ('high', 'low')),
  unit text,                          -- nur bei kind='number', z.B. 'kg'
  -- Nur bei kind='scale' mit labels=null relevant: 'buttons' (Standard, Auswahl-
  -- Buttons wie bisher) oder 'slider' (Schieberegler, min/max dann fix 0/<Stufenzahl>,
  -- nie mit Min/Max-Beschriftung im Eingabe-UI — nur slider_show_value steuert, ob der
  -- aktuelle Wert während der Eingabe sichtbar ist).
  display_style text not null default 'buttons' check (display_style in ('buttons', 'slider')),
  slider_show_value boolean not null default true,
  group_members jsonb,                -- nur bei kind='group': Array von Slugs anderer Skala-Felder
  reminder_minute smallint check (reminder_minute between 0 and 1439), -- Minuten seit Mitternacht, null = Standardzeit (siehe send-notifications)
  -- Bei kind='scale'/'group': ab welcher normalisierten Quote (0-1) ein Wert farblich
  -- als "voll erreicht" gilt (null = 1 = Standard 100%). Verschiebt NUR die Farbskala
  -- (scoreColor), nie die angezeigten Prozentzahlen selbst, und wirkt sich nicht auf die
  -- "Heute"-Ansicht aus (siehe applyGoal in logbuch.html) — für Felder wie "Kraftsport
  -- gemacht", bei denen eine 100%-Quote unrealistisch/nicht das eigentliche Ziel ist.
  goal_threshold real check (goal_threshold is null or (goal_threshold > 0 and goal_threshold <= 1)),
  sort_order int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, slug),
  check (max > min),
  check (
    (kind = 'scale'  and min is not null and max is not null and good is not null and group_members is null)
    or
    (kind = 'number' and min is null and max is null and labels is null and good is null and goal_threshold is null and group_members is null)
    or
    (kind = 'group'  and min is null and max is null and labels is null and good is null and unit is null and group_members is not null)
  )
);

alter table public.habit_definitions enable row level security;

create policy "select own habit_definitions" on public.habit_definitions
  for select using (auth.uid() = user_id);

create policy "insert own habit_definitions" on public.habit_definitions
  for insert with check (auth.uid() = user_id);

create policy "update own habit_definitions" on public.habit_definitions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "delete own habit_definitions" on public.habit_definitions
  for delete using (auth.uid() = user_id);

-- Kein automatisches Feld-Seeding mehr (bis 2026-09-15: 13 feste Standardfelder +
-- Gewicht). Neue Nutzer starten bewusst leer und werden stattdessen durch das
-- Onboarding-Tutorial (siehe logbuch.html renderTutorial) zu ihren eigenen, selbst
-- gewählten Feldern geführt.

-- Nutzer-Einstellungen: Standard-Erinnerungszeit (Minuten seit Mitternacht, Berliner
-- Zeit, 15-Minuten-Raster) für alle Felder ohne eigene reminder_minute, änderbar im
-- Menü der App; onboarding_completed steuert, ob ein Account noch das Tutorial sieht
-- (false bei neuen Accounts, siehe seed_default_user_settings unten).
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_reminder_minute smallint not null default 1320 check (default_reminder_minute between 0 and 1439),
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "select own user_settings" on public.user_settings
  for select using (auth.uid() = user_id);

create policy "insert own user_settings" on public.user_settings
  for insert with check (auth.uid() = user_id);

create policy "update own user_settings" on public.user_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.seed_default_user_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created_seed_settings
  after insert on auth.users
  for each row execute function public.seed_default_user_settings();

-- Verschlüsselung (Zero-Access-Architektur, siehe Kommentare in logbuch.html): pro
-- Nutzer ein zufälliger Data Encryption Key (DEK), der clientseitig alle Werte in
-- habit_entries.data ver-/entschlüsselt. Der DEK selbst liegt NIE hier — nur zwei
-- "verpackte" (wrapped) Varianten davon: einmal mit einem aus dem Passwort
-- abgeleiteten Schlüssel, einmal mit einem zufälligen Recovery-Key, den ausschließlich
-- der Nutzer kennt (einmalig angezeigt, nie serverseitig gespeichert). Anders als bei
-- den übrigen Tabellen KEIN automatischer Seed-Trigger bei Registrierung — die
-- Einrichtung passiert bewusst erst beim ersten echten Login (braucht das Passwort im
-- Klartext, das ist serverseitig nie verfügbar).
create table public.user_encryption (
  user_id uuid primary key references auth.users(id) on delete cascade,
  salt text not null,                   -- base64, PBKDF2-Salt (Passwort-Pfad)
  kdf_iterations int not null default 250000,
  wrap_iv text not null,                -- base64, AES-GCM-IV (Passwort-Pfad)
  wrapped_dek text not null,            -- base64, DEK verpackt mit dem Passwort-Schlüssel
  recovery_wrap_iv text not null,       -- base64, AES-GCM-IV (Recovery-Key-Pfad)
  wrapped_dek_recovery text not null,   -- base64, DEK verpackt mit dem Recovery-Key
  created_at timestamptz not null default now()
);

alter table public.user_encryption enable row level security;

create policy "select own user_encryption" on public.user_encryption
  for select using (auth.uid() = user_id);

create policy "insert own user_encryption" on public.user_encryption
  for insert with check (auth.uid() = user_id);

create policy "update own user_encryption" on public.user_encryption
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Push-Subscriptions: pro Gerät/Browser ein Eintrag
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

create policy "select own subscriptions" on public.push_subscriptions
  for select using (auth.uid() = user_id);

create policy "insert own subscriptions" on public.push_subscriptions
  for insert with check (auth.uid() = user_id);

create policy "update own subscriptions" on public.push_subscriptions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "delete own subscriptions" on public.push_subscriptions
  for delete using (auth.uid() = user_id);

-- Zugangsdaten sicher im Vault ablegen (statt im Klartext im Cron-Job)
select vault.create_secret('https://qdadoqcnqmrauhshvcts.supabase.co', 'project_url');
select vault.create_secret('sb_publishable_c8VJ-dqy-WD_y01aQy1Dzw_LJE-Ornr', 'publishable_key');
-- Eigenes Secret NUR für den Cron-Aufruf der Function (siehe unten) — verhindert, dass
-- irgendwer mit dem (im Frontend öffentlich sichtbaren) publishable_key die Function
-- selbst aufruft. ERSETZEN durch einen frisch generierten Zufallswert (z.B.
-- `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) und
-- DENSELBEN Wert zusätzlich als Function Secret setzen: `supabase secrets set
-- CRON_SECRET=<wert>`. Niemals den Wert aus diesem Kommentar wiederverwenden.
select vault.create_secret('REPLACE_ME_WITH_FRESH_RANDOM_SECRET', 'cron_secret');

-- Alle 15 Minuten Aufruf der Edge Function "send-notifications": die Function
-- bestimmt sich selbst per Intl die aktuellen Berliner Minuten seit Mitternacht (inkl.
-- Sommer-/Winterzeit) und prüft dann pro Nutzer, ob gerade dessen Standard-
-- Erinnerungszeit ist (user_settings.default_reminder_minute, Default 1320 = 22:00)
-- bzw. pro Feld, ob dessen eigene reminder_minute erreicht ist. Alle 15 Minuten statt
-- fester UTC-Zeitpunkte, weil sich die zuständige Zeit nicht mehr auf feste
-- Zeitpunkte beschränkt (15-Minuten-Raster). Der x-cron-secret-Header authentifiziert
-- den Aufruf gegenüber der Function (siehe oben).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'send-notifications-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-notifications',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'),
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 20000
  ) as request_id;
  $$
);
