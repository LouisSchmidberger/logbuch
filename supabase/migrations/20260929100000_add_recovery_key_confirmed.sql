-- Ob der Nutzer seinen aktuellen Ersatzschlüssel (Recovery-Key) gesehen und das Speichern
-- bestätigt hat. Der Schlüssel selbst liegt nirgends im Klartext - ist er unbestätigt
-- (neues Konto, Reset ohne Recovery-Key, im Menü neu erzeugt, aber vor dem Bestätigen
-- geschlossen), erzeugt die App beim nächsten Öffnen einen neuen und zeigt ihn an.
-- Bestehende Konten gelten als bestätigt: die bisherige Anzeige ließ sich nur über die
-- Bestätigungs-Checkbox schließen. Neue Zeilen setzt die App ausdrücklich auf false.
alter table public.user_encryption
  add column recovery_key_confirmed boolean not null default true;
alter table public.user_encryption
  alter column recovery_key_confirmed set default false;
