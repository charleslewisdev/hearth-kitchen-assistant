-- Custom SQL migration file, put your code below! --
-- Defense-in-depth tenant isolation (Decision 31).
--
-- Postgres superusers and table owners BYPASS Row-Level Security, so the owner
-- role that runs migrations (and Better Auth) cannot be the role that reads/writes
-- domain rows if RLS is to mean anything. We create an unprivileged `hearth_app`
-- role; the repository layer does `SET LOCAL ROLE hearth_app` + sets the household
-- GUC per transaction, so domain queries are genuinely subject to the policy below.
-- Even a query that forgets its `WHERE household_id = ...` clause is still scoped.
-- The role is NOLOGIN on purpose: it is only ever reached via SET ROLE from the
-- owner connection, never by a direct login.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hearth_app') THEN
    CREATE ROLE hearth_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO hearth_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON recipes TO hearth_app;
--> statement-breakpoint
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recipes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recipes_household_isolation ON recipes
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
