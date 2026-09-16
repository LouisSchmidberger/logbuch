ALTER TABLE "public"."user_settings"
  ADD COLUMN "locale" text NOT NULL DEFAULT 'de';

ALTER TABLE "public"."user_settings"
  ADD CONSTRAINT "user_settings_locale_check" CHECK (("locale" = ANY (ARRAY['de'::text, 'en'::text])));
