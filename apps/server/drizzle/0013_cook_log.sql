CREATE TABLE IF NOT EXISTS "cook_log_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"recipe_id" uuid NOT NULL,
	"cooked_on" date NOT NULL,
	"logged_by" text,
	"servings" integer,
	"rating" smallint,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cook_log_entry_rating_range" CHECK ("cook_log_entry"."rating" between 1 and 5),
	CONSTRAINT "cook_log_entry_servings_positive" CHECK ("cook_log_entry"."servings" > 0)
);
--> statement-breakpoint
ALTER TABLE "recipe" ADD COLUMN "rating" smallint;--> statement-breakpoint
ALTER TABLE "recipe_file" ADD COLUMN "cook_log_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cook_log_entry" ADD CONSTRAINT "cook_log_entry_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cook_log_entry" ADD CONSTRAINT "cook_log_entry_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cook_log_entry" ADD CONSTRAINT "cook_log_entry_logged_by_user_id_fk" FOREIGN KEY ("logged_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cook_log_entry_recipe_idx" ON "cook_log_entry" USING btree ("recipe_id","cooked_on");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_file" ADD CONSTRAINT "recipe_file_cook_log_id_cook_log_entry_id_fk" FOREIGN KEY ("cook_log_id") REFERENCES "public"."cook_log_entry"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_file_cook_log_idx" ON "recipe_file" USING btree ("cook_log_id");--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_rating_range" CHECK ("recipe"."rating" between 1 and 5);--> statement-breakpoint
-- Tenant isolation for the log, as 0003 does for the recipe core (D31).
GRANT SELECT, INSERT, UPDATE, DELETE ON cook_log_entry TO hearth_app;
--> statement-breakpoint
ALTER TABLE cook_log_entry ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE cook_log_entry FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY cook_log_entry_household_isolation ON cook_log_entry
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
