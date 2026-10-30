-- Schalter für die Vorlagen beim Anlegen eines Felds (docs/freigabe.md): erst nur der Betreiber.
insert into public.feature_flags (key, stage, note) values ('templates', 'owner', 'Vorlagen beim Anlegen eines Felds');
