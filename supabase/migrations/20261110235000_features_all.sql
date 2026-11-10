-- Freigabe für alle (Nutzer-Entscheidung 2026-11-10): Startpaket, "Darf leer bleiben", Wochenbeginn, Ziele.
update public.feature_flags set stage = 'all', updated_at = now() where key in ('starterpack', 'optional', 'weekstart', 'goals');
