-- Schalter für das Startpaket außerhalb des Tutorials (docs/freigabe.md): erst nur der Betreiber.
insert into public.feature_flags (key, stage, note) values ('starterpack', 'owner', 'Startpaket jederzeit über "Neues Feld" und im leeren "Heute"');
