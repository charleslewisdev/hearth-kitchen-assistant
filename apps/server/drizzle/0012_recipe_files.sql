CREATE TYPE "public"."recipe_file_kind" AS ENUM('photo', 'source_page', 'source_pdf');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recipe_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"recipe_id" uuid NOT NULL,
	"kind" "recipe_file_kind" NOT NULL,
	"content_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recipe" ADD COLUMN "cover_file_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_file" ADD CONSTRAINT "recipe_file_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_file" ADD CONSTRAINT "recipe_file_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_file" ADD CONSTRAINT "recipe_file_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_file_recipe_idx" ON "recipe_file" USING btree ("recipe_id","kind","position");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe" ADD CONSTRAINT "recipe_cover_file_id_recipe_file_id_fk" FOREIGN KEY ("cover_file_id") REFERENCES "public"."recipe_file"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Tenant isolation for the new table, as 0003 does for the recipe core (D31).
GRANT SELECT, INSERT, UPDATE, DELETE ON recipe_file TO hearth_app;
--> statement-breakpoint
ALTER TABLE recipe_file ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recipe_file FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recipe_file_household_isolation ON recipe_file
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
