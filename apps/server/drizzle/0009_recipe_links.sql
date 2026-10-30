ALTER TABLE "recipe_ingredient" ADD COLUMN "linked_recipe_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_linked_recipe_id_recipe_id_fk" FOREIGN KEY ("linked_recipe_id") REFERENCES "public"."recipe"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_ingredient_linked_recipe_idx" ON "recipe_ingredient" USING btree ("linked_recipe_id");