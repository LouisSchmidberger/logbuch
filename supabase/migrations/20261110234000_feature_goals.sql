-- Schalter für Ziele als Bereich und Wochensumme (docs/freigabe.md): erst nur der Betreiber.
insert into public.feature_flags (key, stage, note) values ('goals', 'owner', 'Ziele: Bereich (z. B. 7–9 h) und Wochensumme, auch für berechnete Zahlen-Felder');
