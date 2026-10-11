-- "Was ist neu" (Nutzer-Entscheidung 2026-10-11): nach einem Update einmalig ein Fenster mit
-- den Neuerungen. Welcher Eintrag (CHANGELOG in logbuch.js, Kennung = Datum) zuletzt gesehen
-- wurde, gilt pro Konto - einmal weggetippt, auf allen Geräten weg. null = noch nie gesehen.
-- Nur von der App gelesen/geschrieben (eigene Zeile, bestehende RLS), nicht von
-- get_due_notifications - die Längenprüfung ist reine Vorsicht.
ALTER TABLE "public"."user_settings"
  ADD COLUMN "last_seen_changelog" text,
  ADD CONSTRAINT "user_settings_last_seen_changelog_check"
    CHECK (last_seen_changelog IS NULL OR char_length(last_seen_changelog) <= 32);
