ALTER TABLE "import_draft" ADD COLUMN "servings_high" integer;--> statement-breakpoint
ALTER TABLE "recipe" ADD COLUMN "servings_high" integer;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD COLUMN "quantity_high" numeric;--> statement-breakpoint
ALTER TABLE "import_draft" ADD CONSTRAINT "import_draft_servings_high_above_servings" CHECK ("import_draft"."servings_high" is null or "import_draft"."servings_high" > "import_draft"."servings");--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_servings_high_above_servings" CHECK ("recipe"."servings_high" is null or "recipe"."servings_high" > "recipe"."servings");--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_quantity_high_above_quantity" CHECK ("recipe_ingredient"."quantity_high" is null or ("recipe_ingredient"."quantity" is not null and "recipe_ingredient"."quantity_high" > "recipe_ingredient"."quantity"));