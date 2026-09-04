-- Tabelle: ein Datensatz pro Nutzer und Tag, alle Habit-Werte in einem JSON-Feld
create table public.habit_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_date date not null,
  data jsonb not null default '{}'::jsonb,
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
-- Zwei Feld-Typen (kind): 'scale' (Stufen, farblich bewertet via good high/low — die
-- ursprüngliche und weiterhin häufigste Art) und 'number' (freier Zahlenwert wie
-- Gewicht, bewusst OHNE Gut/Schlecht-Bewertung/Farbe, dafür mit optionaler Einheit).
-- min/max/good sind daher nur bei kind='scale' gesetzt, labels/unit sind je nach kind
-- exklusiv (siehe Check unten).
create table public.habit_definitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  slug text not null,                 -- Key in habit_entries.data, z.B. 'morgenroutine'
  name text not null,
  kind text not null default 'scale' check (kind in ('scale', 'number')),
  min int,
  max int,
  labels jsonb,                       -- null = Zahlenwerte, sonst Array von Strings (Länge = max-min+1)
  good text check (good in ('high', 'low')),
  unit text,                          -- nur bei kind='number', z.B. 'kg'
  reminder_hour smallint check (reminder_hour between 0 and 23), -- null = Standardzeit (siehe send-notifications)
  sort_order int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, slug),
  check (max > min),
  check (
    (kind = 'scale'  and min is not null and max is not null and good is not null)
    or
    (kind = 'number' and min is null and max is null and labels is null and good is null)
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

-- Neue Nutzer bekommen automatisch die bisherigen Standardfelder vorbelegt (weiterhin
-- frei archivierbar/umbenennbar danach — das ist nur der Startzustand). Gewicht ist
-- dabei ein ganz normales kind='number'-Feld wie jedes andere auch.
create or replace function public.seed_default_habits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.habit_definitions (user_id, slug, name, kind, unit, min, max, labels, good, sort_order) values
    (new.id, 'weight',         'Gewicht',                    'number', 'kg', null, null, null,                                  null,   0),
    (new.id, 'morgenroutine',  'Morgenroutine',              'scale',  null, 1, 5, null,                                    'high', 1),
    (new.id, 'zaehne',         'Zähne geputzt',              'scale',  null, 0, 2, null,                                    'high', 2),
    (new.id, 'ernaehrung',     'Gesund ernährt',             'scale',  null, 1, 5, null,                                    'high', 3),
    (new.id, 'getrunken',      'Genug getrunken',            'scale',  null, 1, 5, null,                                    'high', 4),
    (new.id, 'kraftsport',     'Kraftsport gemacht',         'scale',  null, 0, 1, '["Nein","Ja"]'::jsonb,                   'high', 5),
    (new.id, 'ausdauersport',  'Ausdauersport gemacht',      'scale',  null, 0, 1, '["Nein","Ja"]'::jsonb,                   'high', 6),
    (new.id, 'gelernt',        'Etwas Neues gelernt',        'scale',  null, 0, 1, '["Nein","Ja"]'::jsonb,                   'high', 7),
    (new.id, 'gekifft',        'Gekifft',                    'scale',  null, 0, 2, '["Nein","Ein bisschen","Ja"]'::jsonb,    'low',  8),
    (new.id, 'gevaped',        'Gevaped',                    'scale',  null, 0, 2, '["Nein","Ein bisschen","Ja"]'::jsonb,    'low',  9),
    (new.id, 'sex',            'Sex gehabt',                 'scale',  null, 0, 1, '["Nein","Ja"]'::jsonb,                   'high', 10),
    (new.id, 'gefuehlslage',   'Gefühlslage',                'scale',  null, 1, 5, null,                                    'high', 11),
    (new.id, 'guterTag',       'Guter Tag',                  'scale',  null, 1, 5, null,                                    'high', 12),
    (new.id, 'bettzeit',       'Ins Bett zur geplanten Zeit', 'scale', null, 0, 1, '["Nein","Ja"]'::jsonb,                  'high', 13);
  return new;
end;
$$;

create trigger on_auth_user_created_seed_habits
  after insert on auth.users
  for each row execute function public.seed_default_habits();

-- Nutzer-Einstellungen: aktuell nur die Standard-Erinnerungszeit (Stunde, Berliner
-- Zeit), die für alle Felder ohne eigene reminder_hour gilt. Änderbar im Menü der App.
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_reminder_hour smallint not null default 22 check (default_reminder_hour between 0 and 23),
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

-- Stündlicher Aufruf der Edge Function "send-notifications": die Function bestimmt sich
-- selbst per Intl die aktuelle Berliner Stunde (inkl. Sommer-/Winterzeit) und prüft dann
-- pro Nutzer und Feld, ob gerade dessen Erinnerungszeit ist — Standard 8 Uhr für
-- Zahlenwert-Felder / 22 Uhr für Skala-Felder, oder eine je Feld frei wählbare eigene
-- Stunde (habit_definitions.reminder_hour). Stündlich statt fester UTC-Zeitpunkte, weil
-- sich die zuständige Stunde jetzt nicht mehr auf zwei feste Zeiten (8/22) beschränkt.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'send-notifications-hourly',
  '0 * * * *',
  $$
  select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-notifications',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 20000
  ) as request_id;
  $$
);
