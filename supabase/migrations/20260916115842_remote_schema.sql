SET local check_function_bodies = off;

CREATE EXTENSION "pg_cron";

CREATE EXTENSION "pg_net" SCHEMA "public";

CREATE TABLE "public"."habit_definitions" (
  "id"                uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "slug"              text                     NOT NULL,
  "name"              text                     NOT NULL,
  "min"               integer,
  "max"               integer,
  "labels"            jsonb,
  "good"              text,
  "sort_order"        integer                  NOT NULL DEFAULT 0,
  "archived_at"       timestamp with time zone,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "kind"              text                     NOT NULL DEFAULT 'scale'::text,
  "unit"              text,
  "reminder_minute"   smallint,
  "goal_threshold"    real,
  "display_style"     text                     NOT NULL DEFAULT 'buttons'::text,
  "slider_show_value" boolean                  NOT NULL DEFAULT true,
  "group_members"     jsonb,
  CONSTRAINT "habit_definitions_check" CHECK ((max > min)),
  CONSTRAINT "habit_definitions_display_style_check" CHECK ((display_style = ANY (ARRAY['buttons'::text, 'slider'::text]))),
  CONSTRAINT "habit_definitions_goal_threshold_check"
    CHECK (((goal_threshold IS NULL) OR ((goal_threshold > (0)::double precision) AND (goal_threshold <= (1)::double precision)))),
  CONSTRAINT "habit_definitions_good_check" CHECK ((good = ANY (ARRAY['high'::text, 'low'::text]))),
  CONSTRAINT "habit_definitions_kind_check" CHECK ((kind = ANY (ARRAY['scale'::text, 'number'::text, 'group'::text]))),
  CONSTRAINT "habit_definitions_kind_fields_check" CHECK ((((kind = 'scale'::text) AND (min IS NOT NULL) AND (max IS NOT NULL) AND (good IS
    NOT NULL) AND (group_members IS NULL)) OR
    ((kind = 'number'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (goal_threshold IS NULL) AND (group_members IS NULL)) OR
    ((kind = 'group'::text) AND (min IS NULL) AND (max IS NULL) AND (labels IS NULL) AND (good IS NULL) AND (unit IS NULL) AND (group_members IS NOT NULL)))),
  CONSTRAINT "habit_definitions_pkey" PRIMARY KEY (id),
  CONSTRAINT "habit_definitions_reminder_minute_check" CHECK (((reminder_minute >= 0) AND (reminder_minute <= 1439))),
  "user_id"           uuid                     NOT NULL DEFAULT auth.uid(),
  CONSTRAINT "habit_definitions_user_id_slug_key" UNIQUE (user_id, slug)
);

ALTER TABLE "public"."habit_definitions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."habit_entries" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "entry_date"   date                     NOT NULL,
  "data"         jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "filled_slugs" jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT "habit_entries_pkey" PRIMARY KEY (id),
  "user_id"      uuid                     NOT NULL DEFAULT auth.uid(),
  CONSTRAINT "habit_entries_user_id_entry_date_key" UNIQUE (user_id, entry_date)
);

ALTER TABLE "public"."habit_entries"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."push_subscriptions" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "endpoint"   text                     NOT NULL,
  "p256dh"     text                     NOT NULL,
  "auth_key"   text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "push_subscriptions_endpoint_key" UNIQUE (endpoint),
  CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY (id),
  "user_id"    uuid                     NOT NULL DEFAULT auth.uid()
);

ALTER TABLE "public"."push_subscriptions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."user_encryption" (
  "user_id"              uuid                     NOT NULL,
  "salt"                 text                     NOT NULL,
  "kdf_iterations"       integer                  NOT NULL DEFAULT 250000,
  "wrap_iv"              text                     NOT NULL,
  "wrapped_dek"          text                     NOT NULL,
  "recovery_wrap_iv"     text                     NOT NULL,
  "wrapped_dek_recovery" text                     NOT NULL,
  "created_at"           timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "user_encryption_pkey" PRIMARY KEY (user_id)
);

ALTER TABLE "public"."user_encryption"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."user_settings" (
  "user_id"                 uuid                     NOT NULL,
  "default_reminder_minute" smallint                 NOT NULL DEFAULT 1320,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "onboarding_completed"    boolean                  NOT NULL DEFAULT false,
  CONSTRAINT "user_settings_default_reminder_minute_check" CHECK (((default_reminder_minute >= 0) AND (default_reminder_minute <= 1439))),
  CONSTRAINT "user_settings_pkey" PRIMARY KEY (user_id)
);

ALTER TABLE "public"."user_settings"
  ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
  RETURNS event_trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog'
  AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.seed_default_user_settings()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
begin
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

ALTER TABLE "public"."user_encryption"
  ADD CONSTRAINT "user_encryption_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."user_settings"
  ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE TRIGGER on_auth_user_created_seed_settings
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_default_user_settings();

CREATE TRIGGER habit_entries_set_updated_at
  BEFORE UPDATE ON public.habit_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE POLICY "insert own user_encryption" ON "public"."user_encryption"
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "select own user_encryption" ON "public"."user_encryption"
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));

CREATE POLICY "update own user_encryption" ON "public"."user_encryption"
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "insert own user_settings" ON "public"."user_settings"
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "select own user_settings" ON "public"."user_settings"
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));

CREATE POLICY "update own user_settings" ON "public"."user_settings"
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

CREATE EVENT TRIGGER "ensure_rls"
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION "public"."rls_auto_enable"();

COMMENT ON EXTENSION "pg_cron" IS 'Job scheduler for PostgreSQL';

COMMENT ON EXTENSION "pg_net" IS 'Async HTTP';

GRANT EXECUTE ON FUNCTION "public"."rls_auto_enable"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."seed_default_user_settings"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."set_updated_at"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."habit_definitions" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."habit_entries" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."push_subscriptions" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."user_encryption" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."user_settings" TO "anon", "authenticated", "postgres", "service_role";

SELECT cron.schedule_in_database('send-notifications-15min', '*/15 * * * *', '
  select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = ''project_url'') || ''/functions/v1/send-notifications'',
      headers := jsonb_build_object(
        ''Content-type'', ''application/json'',
        ''apikey'', (select decrypted_secret from vault.decrypted_secrets where name = ''publishable_key''),
        ''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')
      ),
      body := ''{}''::jsonb,
      timeout_milliseconds := 20000
  ) as request_id;
  ', 'postgres', NULL, true);

ALTER TABLE "public"."habit_definitions"
  ADD CONSTRAINT "habit_definitions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE POLICY "delete own habit_definitions" ON "public"."habit_definitions"
  FOR DELETE
  TO PUBLIC
  USING ((auth.uid() = user_id));

CREATE POLICY "insert own habit_definitions" ON "public"."habit_definitions"
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "select own habit_definitions" ON "public"."habit_definitions"
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));

CREATE POLICY "update own habit_definitions" ON "public"."habit_definitions"
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

ALTER TABLE "public"."habit_entries"
  ADD CONSTRAINT "habit_entries_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE POLICY "delete own entries" ON "public"."habit_entries"
  FOR DELETE
  TO PUBLIC
  USING ((auth.uid() = user_id));

CREATE POLICY "insert own entries" ON "public"."habit_entries"
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "select own entries" ON "public"."habit_entries"
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));

CREATE POLICY "update own entries" ON "public"."habit_entries"
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

ALTER TABLE "public"."push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE POLICY "delete own subscriptions" ON "public"."push_subscriptions"
  FOR DELETE
  TO PUBLIC
  USING ((auth.uid() = user_id));

CREATE POLICY "insert own subscriptions" ON "public"."push_subscriptions"
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "select own subscriptions" ON "public"."push_subscriptions"
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));

CREATE POLICY "update own subscriptions" ON "public"."push_subscriptions"
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

