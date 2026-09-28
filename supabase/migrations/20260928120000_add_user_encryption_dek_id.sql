-- Kennung des aktuellen DEK (Data Encryption Key). Nicht geheim, rein zufällig, verrät
-- nichts über den Schlüssel selbst - wechselt nur, wenn ein neuer DEK erzeugt wird
-- (Einrichtung bzw. Passwort-Reset "Recovery-Key auch verloren"). Die App speichert sie
-- neben dem lokal gecachten DEK und prüft vor dessen Nutzung, ob er noch der aktuelle
-- ist - sonst würde ein Gerät nach so einem Reset mit dem alten Schlüssel weiter
-- speichern, und die übrigen Geräte könnten diese Einträge nicht mehr lesen.
alter table public.user_encryption
  add column dek_id uuid not null default gen_random_uuid();
