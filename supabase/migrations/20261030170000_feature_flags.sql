-- Schalter pro Funktion (siehe docs/freigabe.md): eine neue Funktion geht mit dem normalen
-- Live-Gang raus, sichtbar ist sie aber erst ab ihrer Stufe - 'owner' (nur der Betreiber),
-- 'testers' (Tester + Betreiber), 'all'. Nutzer lesen beide Tabellen nur; ändern kann sie
-- nur der Betreiber (Dashboard/SQL, service_role) - sonst könnte sich jeder selbst zum
-- Tester machen.

create table public.feature_flags (
  key text primary key check (key ~ '^[a-z0-9_-]{1,40}$'),
  stage text not null default 'off' check (stage in ('off', 'owner', 'testers', 'all')),
  note text,
  updated_at timestamptz not null default now()
);
alter table public.feature_flags enable row level security;
create policy "feature_flags lesbar" on public.feature_flags for select to authenticated using (true);
grant select on public.feature_flags to authenticated;
grant all on public.feature_flags to service_role;

create table public.user_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  access_group text not null check (access_group in ('owner', 'tester')),
  created_at timestamptz not null default now()
);
alter table public.user_access enable row level security;
create policy "eigene Gruppe lesbar" on public.user_access for select to authenticated using (user_id = (select auth.uid()));
grant select on public.user_access to authenticated;
grant all on public.user_access to service_role;

insert into public.feature_flags (key, stage, note) values ('since', 'owner', 'Berechnetes Feld "Tage seit"');
