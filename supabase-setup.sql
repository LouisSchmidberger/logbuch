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

-- Vier tägliche Aufrufe der Edge Function "send-notifications":
--   6 & 7 Uhr UTC  → Kandidaten für die 8-Uhr-Gewichtserinnerung (Berliner Zeit)
--   20 & 21 Uhr UTC → Kandidaten für die 22-Uhr-Habit-/Zusammenfassungs-Erinnerung
-- Die Function selbst prüft die Berliner Zeit inkl. Sommer-/Winterzeit und macht nur beim
-- jeweils passenden Durchlauf weiter — kein manuelles Nachjustieren bei der Zeitumstellung.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'send-notifications-06utc',
  '0 6 * * *',
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

select cron.schedule(
  'send-notifications-07utc',
  '0 7 * * *',
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

select cron.schedule(
  'send-notifications-20utc',
  '0 20 * * *',
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

select cron.schedule(
  'send-notifications-21utc',
  '0 21 * * *',
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
