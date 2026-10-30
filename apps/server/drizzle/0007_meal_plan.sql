CREATE TABLE IF NOT EXISTS "household_settings" (
	"household_id" text PRIMARY KEY NOT NULL,
	"week_start" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "household_settings_week_start_range" CHECK ("household_settings"."week_start" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meal_plan_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"plan_date" date NOT NULL,
	"meal" "meal_type" NOT NULL,
	"recipe_id" uuid NOT NULL,
	"servings" integer NOT NULL,
	"added_to_list_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_entry_servings_positive" CHECK ("meal_plan_entry"."servings" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "household_settings" ADD CONSTRAINT "household_settings_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_plan_entry" ADD CONSTRAINT "meal_plan_entry_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_plan_entry" ADD CONSTRAINT "meal_plan_entry_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_plan_entry_household_date_idx" ON "meal_plan_entry" USING btree ("household_id","plan_date");