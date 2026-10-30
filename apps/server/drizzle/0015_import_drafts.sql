CREATE TYPE "public"."draft_confidence" AS ENUM('high', 'low');--> statement-breakpoint
CREATE TYPE "public"."import_reading" AS ENUM('photo_ocr', 'pdf_text', 'pdf_ocr');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"recipe_id" uuid,
	"created_by" text,
	"reading" "import_reading" NOT NULL,
	"source_text" text NOT NULL,
	"title" text NOT NULL,
	"title_confidence" "draft_confidence" NOT NULL,
	"title_raw" text,
	"servings" integer NOT NULL,
	"servings_confidence" "draft_confidence" NOT NULL,
	"servings_raw" text,
	"ingredients_confidence" "draft_confidence" NOT NULL,
	"steps_confidence" "draft_confidence" NOT NULL,
	"description" text,
	"prep_minutes" integer,
	"cook_minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_draft_ingredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"amount_to_check" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_draft_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_draft" ADD CONSTRAINT "import_draft_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_draft" ADD CONSTRAINT "import_draft_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_draft" ADD CONSTRAINT "import_draft_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_draft_ingredient" ADD CONSTRAINT "import_draft_ingredient_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_draft_ingredient" ADD CONSTRAINT "import_draft_ingredient_draft_id_import_draft_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."import_draft"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_draft_step" ADD CONSTRAINT "import_draft_step_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_draft_step" ADD CONSTRAINT "import_draft_step_draft_id_import_draft_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."import_draft"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_draft_household_idx" ON "import_draft" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_draft_recipe_idx" ON "import_draft" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_draft_ingredient_draft_idx" ON "import_draft_ingredient" USING btree ("draft_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_draft_step_draft_idx" ON "import_draft_step" USING btree ("draft_id","position");--> statement-breakpoint
-- Tenant isolation for import drafts, as 0003 does for the recipe core (D31).
GRANT SELECT, INSERT, UPDATE, DELETE ON import_draft, import_draft_ingredient, import_draft_step TO hearth_app;
--> statement-breakpoint
ALTER TABLE import_draft ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_draft FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY import_draft_household_isolation ON import_draft
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
ALTER TABLE import_draft_ingredient ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_draft_ingredient FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY import_draft_ingredient_household_isolation ON import_draft_ingredient
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
ALTER TABLE import_draft_step ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_draft_step FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY import_draft_step_household_isolation ON import_draft_step
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
