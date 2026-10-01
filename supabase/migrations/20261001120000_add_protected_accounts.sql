-- Konten, die sich nicht löschen lassen (z.B. das echte Konto des Betreibers, damit es beim
-- häufigen Löschen von Testkonten nicht versehentlich mit erwischt wird). Welche Konten
-- das sind, steht bewusst NICHT im (öffentlichen) Repo: Einträge per SQL direkt in der
-- Datenbank anlegen bzw. entfernen.
--
-- Zwei Sicherungen: delete-account prüft die Tabelle vorher und meldet "geschützt"; und
-- der Fremdschlüssel ohne "on delete cascade" lässt die Datenbank jedes Löschen der
-- auth.users-Zeile ablehnen (auch aus dem Dashboard), solange das Konto hier steht.
create table public.protected_accounts (
  user_id uuid primary key references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.protected_accounts enable row level security;
-- Keine Policies und keine Rechte für Nutzer: nur die Edge Function (service_role) liest.
revoke all on table public.protected_accounts from anon, authenticated;
grant select on table public.protected_accounts to service_role;
