-- Recipes get their own type vocabulary (sauce, base, side, drink as well as the meals), kept
-- apart from `meal_type`, which the planner's slots still use. The column keeps its name. The
-- cast goes through text because Postgres has no direct cast between two enums; every existing
-- value is in both lists. The GIN index on the column is rebuilt by the type change.
CREATE TYPE "public"."recipe_type" AS ENUM('breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'side', 'drink', 'sauce', 'base');--> statement-breakpoint
ALTER TABLE "recipe" ALTER COLUMN "meal_types" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "recipe" ALTER COLUMN "meal_types" SET DATA TYPE recipe_type[] USING "meal_types"::text[]::recipe_type[];--> statement-breakpoint
ALTER TABLE "recipe" ALTER COLUMN "meal_types" SET DEFAULT '{}'::recipe_type[];
