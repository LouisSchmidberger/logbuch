-- Kennzahlen für den Betreiber (Nutzer-Entscheidung 2026-10-29): ein grober Überblick über
-- Nutzer und ihr Verhalten, abrufbar im Hub über die Edge Function ops-stats.
-- Regeln: nur Summen, nur aus Daten, die der Betreiber laut Datenschutz-Text in "Über
-- Logbuch" ohnehin sehen kann (Konten, Anmeldedatum, an welchen Tagen etwas eingetragen ist,
-- Anzahl Felder, Push-Abo), kein Mitzählen in der App. Aktivität über entry_date (die
-- Speicher-Uhrzeit gibt es bewusst nicht mehr, siehe encrypt_habit_definitions_prep).

-- Kennzahlen für die 7 bzw. 30 Tage bis einschließlich p_day.
create or replace function public.ops_stats(p_day date)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = ''
as $$
  with active7 as (
    select distinct user_id from public.habit_entries
    where entry_date between p_day - 6 and p_day
  )
  select jsonb_build_object(
    'day', p_day,
    -- bestätigte Konten (unbestätigte räumt cleanup_unconfirmed_users nach einer Weile weg)
    'accounts', (select count(*) from auth.users where email_confirmed_at is not null),
    'new_7d', (select count(*) from auth.users
               where email_confirmed_at is not null
                 and (created_at at time zone 'Europe/Berlin')::date between p_day - 6 and p_day),
    'active_7d', (select count(*) from active7),
    'active_30d', (select count(distinct user_id) from public.habit_entries
                   where entry_date between p_day - 29 and p_day),
    -- aktive (nicht archivierte, nicht berechnete) Felder je in 7 Tagen aktivem Konto
    'fields_avg', (select round(avg(n), 1) from (
                     select count(h.id) as n from active7 a
                     left join public.habit_definitions h
                       on h.user_id = a.user_id and h.archived_at is null and h.kind <> 'computed'
                     group by a.user_id) per_user),
    'push_accounts', (select count(distinct user_id) from public.push_subscriptions)
  );
$$;

revoke all on function public.ops_stats(date) from public, anon, authenticated;
grant execute on function public.ops_stats(date) to service_role;

-- Verlauf: eine Zeile pro Tag (sonst ließe sich "aktiv in 7 Tagen" später nicht nachrechnen).
create table public.ops_daily_stats (
  day date primary key,
  stats jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.ops_daily_stats enable row level security;
-- Keine Policies und bewusst KEINE Rechte für authenticated (anders als bei Nutzer-Tabellen):
-- nur die Edge Function (service_role) liest, nur der Cron-Job schreibt.
revoke all on table public.ops_daily_stats from anon, authenticated;
grant select on table public.ops_daily_stats to service_role;

-- Jede Nacht der abgeschlossene Vortag (Berliner Zeit); ein zweiter Lauf überschreibt.
select cron.schedule(
  'ops-daily-stats',
  '30 2 * * *',
  $cron$
    insert into public.ops_daily_stats (day, stats)
    select d, public.ops_stats(d) from (select (now() at time zone 'Europe/Berlin')::date - 1 as d) x
    on conflict (day) do update set stats = excluded.stats, created_at = now();
  $cron$
);
