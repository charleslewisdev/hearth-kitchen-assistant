ALTER TABLE "meal_plan_entry" ADD COLUMN "list_servings" integer;--> statement-breakpoint
ALTER TABLE "meal_plan_entry" ADD CONSTRAINT "meal_plan_entry_list_servings_positive" CHECK ("meal_plan_entry"."list_servings" is null or "meal_plan_entry"."list_servings" > 0);--> statement-breakpoint
-- Meals already on the list are taken to hold their current serving count: nothing records what it
-- was at the build, and assuming so asks nothing about past weeks.
UPDATE "meal_plan_entry" SET "list_servings" = "servings" WHERE "added_to_list_at" IS NOT NULL;
