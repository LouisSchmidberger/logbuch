-- Wochen-/Monatsübersicht-Benachrichtigungen pro Nutzer abschaltbar (send-notifications).
-- Default true: bestehende Nutzer bekommen sie weiterhin wie bisher.
ALTER TABLE "public"."user_settings"
  ADD COLUMN "summary_notifications" boolean NOT NULL DEFAULT true;
